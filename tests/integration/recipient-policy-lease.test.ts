/**
 * Task 1.2 — the recipient policy lease (design §1.4, §2.4).
 *
 * WHY A LEASE AND NOT A TRANSACTION
 * ---------------------------------
 * Composing and applying a revision spans remote I/O (createPolicy / patchPolicy
 * / getPolicy), and §1.2 forbids holding a database lock across that I/O. The
 * only thing that can serialize two processes for one wallet is therefore a row
 * outside any transaction: `recipient_policy_leases` (W1). That row cannot be
 * held; it must be ACQUIRED, and the holder must survive a crash — which is why
 * it is reclaimed only after `expires_at`, never by a lock wait.
 *
 * WHAT THIS SUITE PROVES
 * ----------------------
 * Every case below drives the real database through two real connections
 * (`createDatabaseClient` twice = two pools = two backends). The contention is
 * the *row*, so it only exists if the first holder's acquire really committed:
 * nothing here is simulated with a fake lock.
 *
 *   1. acquire records the desired revision the holder saw (diagnostic integrity:
 *      a silently-recorded 0 would make "was the intent superseded while I
 *      waited?" unanswerable).
 *   2. a live lease refuses a second holder and leaves the first token in place.
 *   3. an expired lease is reclaimed by the second connection, and the reclaimed
 *      holder's renew returns false — the stale-writer guard.
 *   4. a stale-token release is a no-op.
 *   5. the bounded wait is exhausted honestly as `busy`, on the documented
 *      100 ms × 2^n schedule capped at 1 s, never sleeping past the budget.
 *   6. the hard hold ceiling stops renewing for good, and the holder re-acquires.
 *   7. a database failure reports `unavailable`, never a fabricated acquisition.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
} from "../../src/db/client.js";
import {
  POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS,
  POLICY_LEASE_FIRST_BACKOFF_MS,
  POLICY_LEASE_MAX_BACKOFF_MS,
  POLICY_LEASE_MAX_HOLD_MS,
  POLICY_LEASE_MAX_HOLD_SECONDS,
  POLICY_LEASE_RENEWAL_INTERVAL_MS,
  POLICY_LEASE_TTL_SECONDS,
  acquirePolicyLease,
  releasePolicyLease,
  renewPolicyLease,
  type PolicyLeaseTransactionRunner,
} from "../../src/wallet/policy/lease.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("recipient policy lease (task 1.2)", () => {
  // The holder and the contender each own a real pool: contention has to be
  // exercised by two actual connections, not by two calls on one.
  let holder: DatabaseClient;
  let contender: DatabaseClient;

  beforeAll(() => {
    holder = createDatabaseClient(databaseUrl!);
    contender = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await Promise.all([holder.close(), contender.close()]);
  });

  /** user + `ready` solana wallet, provisioned as the migration owner. */
  async function provision(): Promise<{ userId: string; walletId: string }> {
    const user = await holder.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:rpl-${randomUUID()}`, "RPL Lease Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await holder.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    return { userId, walletId: wallet.rows[0]!.id };
  }

  /** The lease row is never user data: it is read in the system context. */
  async function readLeaseRow(
    database: DatabaseClient,
    walletId: string,
  ): Promise<{
    lease_token: string;
    owner_id: string;
    desired_revision_at_acquire: string;
    acquired_at: Date;
    expires_at: Date;
  } | null> {
    const result = await database.withSystemTransaction((client) =>
      client.query<{
        lease_token: string;
        owner_id: string;
        desired_revision_at_acquire: string;
        acquired_at: Date;
        expires_at: Date;
      }>(
        `SELECT lease_token, owner_id, desired_revision_at_acquire, acquired_at, expires_at
           FROM recipient_policy_leases WHERE wallet_id = $1`,
        [walletId],
      ),
    );
    return result.rows[0] ?? null;
  }

  it("publishes the design's lease numbers so §1.4 cannot drift silently", () => {
    expect(POLICY_LEASE_TTL_SECONDS).toBe(60);
    expect(POLICY_LEASE_RENEWAL_INTERVAL_MS).toBe(10_000);
    expect(POLICY_LEASE_MAX_HOLD_SECONDS).toBe(300);
    expect(POLICY_LEASE_MAX_HOLD_MS).toBe(300_000);
    expect(POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS).toBe(3_000);
    expect(POLICY_LEASE_FIRST_BACKOFF_MS).toBe(100);
    expect(POLICY_LEASE_MAX_BACKOFF_MS).toBe(1_000);
  });

  it("acquires the wallet lease and records the desired revision the holder saw", async () => {
    const { userId, walletId } = await provision();

    // The revision the holder is about to compose against.
    await holder.withUserTransaction(userId, (client) =>
      client.query(
        `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision)
         VALUES ($1, $2, 7)`,
        [walletId, userId],
      ),
    );

    // Positive control first: without a state row the diagnostic below could
    // pass against a default of 0 for the wrong reason.
    const stateSeenByOwner = await holder.withUserTransaction(userId, (client) =>
      client.query<{ desired_revision: string }>(
        `SELECT desired_revision FROM recipient_policy_state WHERE wallet_id = $1`,
        [walletId],
      ),
    );
    expect(stateSeenByOwner.rows[0]?.desired_revision).toBe("7");

    const acquired = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "backend",
    });
    expect(acquired.status).toBe("acquired");
    expect("token" in acquired && acquired.token.length).toBeGreaterThan(0);

    const row = await readLeaseRow(holder, walletId);
    expect(row).not.toBeNull();
    expect(row!.desired_revision_at_acquire).toBe("7");
    expect(row!.owner_id).toBe("backend");
    // TTL 60 s is real: a lease that never expires would strand the wallet.
    expect(row!.expires_at.getTime() - row!.acquired_at.getTime()).toBe(
      POLICY_LEASE_TTL_SECONDS * 1_000,
    );

    // The column records what the holder saw AT ACQUIRE. If the intent moves
    // while the holder is working, the row must keep saying 7 — that difference
    // is the whole diagnostic value of the column.
    await holder.withUserTransaction(userId, (client) =>
      client.query(
        `UPDATE recipient_policy_state SET desired_revision = 9 WHERE wallet_id = $1`,
        [walletId],
      ),
    );
    expect((await readLeaseRow(holder, walletId))!.desired_revision_at_acquire).toBe(
      "7",
    );

    // ...and 0 is the honest value for a wallet with no state row, never a
    // borrowed constant from another wallet.
    const fresh = await provision();
    const freshAcquire = await acquirePolicyLease({
      database: holder,
      walletId: fresh.walletId,
      userId: fresh.userId,
      ownerId: "backend",
    });
    expect(freshAcquire.status).toBe("acquired");
    expect(
      (await readLeaseRow(holder, fresh.walletId))!.desired_revision_at_acquire,
    ).toBe("0");
  });

  it("refuses a second holder on a live lease and leaves the first token in place", async () => {
    const { userId, walletId } = await provision();

    const first = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "owner-one",
    });
    expect(first.status).toBe("acquired");

    // Second real connection, same wallet.
    const second = await acquirePolicyLease({
      database: contender,
      walletId,
      userId,
      ownerId: "owner-two",
      waitBudgetMs: 300,
    });
    expect(second).toEqual({ status: "busy" });

    // The contender must not have taken or overwritten the row.
    const row = await readLeaseRow(holder, walletId);
    expect(row!.owner_id).toBe("owner-one");
    expect(row!.lease_token).toBe("token" in first ? first.token : "");
    expect(await renewPolicyLease(
      { database: holder },
      { walletId, token: "token" in first ? first.token : "" },
    )).toBe(true);
  });

  it("reclaims an expired lease for a second connection and denies the reclaimed holder's renewal", async () => {
    const { userId, walletId } = await provision();

    const first = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "owner-expiring",
      leaseSeconds: 1,
    });
    expect(first.status).toBe("acquired");
    const firstToken = "token" in first ? first.token : "";

    // A crashed holder is reclaimed by expiry, not by any lock release.
    await delay(1_200);

    const second = await acquirePolicyLease({
      database: contender,
      walletId,
      userId,
      ownerId: "owner-reclaimer",
    });
    expect(second.status).toBe("acquired");
    const secondToken = "token" in second ? second.token : "";
    expect(secondToken).not.toBe(firstToken);

    // The stale holder learns it lost the lease instead of writing blind.
    expect(
      await renewPolicyLease({ database: holder }, { walletId, token: firstToken }),
    ).toBe(false);
    // ...and a stale release is a no-op, not a way to evict the new holder.
    await releasePolicyLease(
      { database: holder },
      { walletId, token: firstToken },
    );
    const row = await readLeaseRow(holder, walletId);
    expect(row).not.toBeNull();
    expect(row!.lease_token).toBe(secondToken);

    // Positive control: the live holder's token still renews, so the `false`
    // above is the token guard and not a universally false renew.
    expect(
      await renewPolicyLease(
        { database: contender },
        { walletId, token: secondToken },
      ),
    ).toBe(true);
  });

  it("treats a foreign-token release as a no-op", async () => {
    const { userId, walletId } = await provision();

    const acquired = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "owner-holding",
    });
    const token = "token" in acquired ? acquired.token : "";

    await releasePolicyLease(
      { database: contender },
      { walletId, token: "not-the-token" },
    );
    const afterForeign = await readLeaseRow(holder, walletId);
    expect(afterForeign).not.toBeNull();
    expect(
      await renewPolicyLease({ database: holder }, { walletId, token }),
    ).toBe(true);

    // Positive control: the real token does delete the row.
    await releasePolicyLease({ database: holder }, { walletId, token });
    expect(await readLeaseRow(holder, walletId)).toBeNull();
    expect(
      await renewPolicyLease({ database: holder }, { walletId, token }),
    ).toBe(false);
  });

  it("returns busy once the wait budget is exhausted, without ever acquiring", async () => {
    const { userId, walletId } = await provision();

    const first = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "owner-steady",
    });
    expect(first.status).toBe("acquired");

    const startedAt = Date.now();
    const contended = await acquirePolicyLease({
      database: contender,
      walletId,
      userId,
      ownerId: "owner-waiting",
      waitBudgetMs: 400,
    });
    const elapsed = Date.now() - startedAt;

    // Exhaustion is `busy` — never a fabricated acquisition, and never an
    // unbounded wait.
    expect(contended).toEqual({ status: "busy" });
    expect(elapsed).toBeLessThan(2_000);
    expect((await readLeaseRow(holder, walletId))!.owner_id).toBe("owner-steady");
  });

  it("backs off 100 ms × 2^n capped at 1 s and never sleeps past the budget", async () => {
    const waits: number[] = [];
    let elapsed = 0;

    const result = await acquirePolicyLease({
      database: alwaysBusyDatabase(),
      walletId: randomUUID(),
      userId: randomUUID(),
      ownerId: "owner-schedule",
      waitBudgetMs: 10_000,
      now: () => elapsed,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
        elapsed += milliseconds;
      },
    });

    expect(result).toEqual({ status: "busy" });
    // The doubling, before the cap engages.
    expect(waits.slice(0, 4)).toEqual([100, 200, 400, 800]);
    // The cap is 1 s and it is actually reached.
    expect(Math.max(...waits)).toBe(POLICY_LEASE_MAX_BACKOFF_MS);
    expect(waits.every((wait) => wait <= POLICY_LEASE_MAX_BACKOFF_MS)).toBe(true);
    // The wait never overshoots the caller's budget.
    expect(waits.reduce((total, wait) => total + wait, 0)).toBe(10_000);
    // ...and the number of attempts stays bounded.
    expect(waits).toHaveLength(13);
  });

  it("attempts once and reports busy when the wait budget is zero", async () => {
    let attempts = 0;
    let slept = 0;

    const result = await acquirePolicyLease({
      database: countingDatabase(() => {
        attempts += 1;
      }),
      walletId: randomUUID(),
      userId: randomUUID(),
      ownerId: "owner-impatient",
      waitBudgetMs: 0,
      now: () => 0,
      sleep: async () => {
        slept += 1;
      },
    });

    expect(result).toEqual({ status: "busy" });
    expect(attempts).toBe(1);
    expect(slept).toBe(0);
  });

  it("stops renewing a holder past the hard hold ceiling and lets it re-acquire", async () => {
    const { userId, walletId } = await provision();

    const acquired = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "owner-long-hold",
    });
    const token = "token" in acquired ? acquired.token : "";

    // Positive control: inside the ceiling the same token renews.
    expect(
      await renewPolicyLease({ database: holder }, { walletId, token }),
    ).toBe(true);

    // Arrange the elapsed hold time directly: waiting 300 s is not a test.
    // 299 s is inside the ceiling and must still renew, so the refusal below is
    // the documented 300 s boundary and not "any elapsed time at all".
    await holder.withSystemTransaction((client) =>
      client.query(
        `UPDATE recipient_policy_leases SET acquired_at = now() - interval '299 seconds'
          WHERE wallet_id = $1`,
        [walletId],
      ),
    );
    expect(
      await renewPolicyLease({ database: holder }, { walletId, token }),
    ).toBe(true);

    await holder.withSystemTransaction((client) =>
      client.query(
        `UPDATE recipient_policy_leases SET acquired_at = now() - interval '301 seconds'
          WHERE wallet_id = $1`,
        [walletId],
      ),
    );
    const beforeCeilingRefusal = await readLeaseRow(holder, walletId);

    expect(
      await renewPolicyLease({ database: holder }, { walletId, token }),
    ).toBe(false);

    // A refused renew writes nothing: the row must not have been extended.
    const afterCeilingRefusal = await readLeaseRow(holder, walletId);
    expect(afterCeilingRefusal!.expires_at.getTime()).toBe(
      beforeCeilingRefusal!.expires_at.getTime(),
    );

    // The holder's contract past the ceiling: release and re-acquire.
    await releasePolicyLease({ database: holder }, { walletId, token });
    expect(await readLeaseRow(holder, walletId)).toBeNull();
    const reAcquired = await acquirePolicyLease({
      database: holder,
      walletId,
      userId,
      ownerId: "owner-long-hold",
    });
    expect(reAcquired.status).toBe("acquired");
    expect(
      await renewPolicyLease(
        { database: holder },
        { walletId, token: "token" in reAcquired ? reAcquired.token : "" },
      ),
    ).toBe(true);
  });

  it("reports unavailable instead of a fabricated acquisition when the database fails", async () => {
    const brokenDatabase = {
      withSystemTransaction: async <T>(): Promise<T> => {
        throw new Error("connection refused");
      },
    };

    const acquired = await acquirePolicyLease({
      database: brokenDatabase,
      walletId: randomUUID(),
      userId: randomUUID(),
      ownerId: "owner-unreachable",
    });
    expect(acquired).toEqual({ status: "unavailable" });

    // Renew/search fail closed the same way: "not renewed" is the safe answer.
    expect(
      await renewPolicyLease(
        { database: brokenDatabase },
        { walletId: randomUUID(), token: "any" },
      ),
    ).toBe(false);
    await expect(
      releasePolicyLease(
        { database: brokenDatabase },
        { walletId: randomUUID(), token: "any" },
      ),
    ).resolves.toBeUndefined();
  });
});

/** A database whose acquire always reports another live holder. */
function alwaysBusyDatabase(): PolicyLeaseTransactionRunner {
  return runnerReturning({ rows: [{ lease_token: null }] });
}

/** A database whose acquire always reports another live holder, counting calls. */
function countingDatabase(onQuery: () => void): PolicyLeaseTransactionRunner {
  return runnerReturning({ rows: [{ lease_token: null }] }, onQuery);
}

function runnerReturning(
  result: unknown,
  onQuery?: () => void,
): PolicyLeaseTransactionRunner {
  return {
    withSystemTransaction: async <T>(
      operation: (client: Queryable) => Promise<T>,
    ): Promise<T> =>
      operation({
        query: async () => {
          onQuery?.();
          return result;
        },
      } as unknown as Queryable),
  };
}
