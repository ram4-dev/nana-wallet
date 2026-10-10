/**
 * Task 1.9 — the concurrency proof for the canonical lock order (design §1.7,
 * §12.2), exercised under TWO real connections with a per-transaction
 * `statement_timeout`.
 *
 * WHY THIS SUITE EXISTS AND WHY IT HAS A FALSIFICATION CASE
 * ---------------------------------------------------------
 * The claim path's `W0` read is prepended so the claim and the apply/removal
 * transactions cannot form a cycle. A unit test can assert the statement's
 * POSITION in the source, but a source position is not an interleaving: the only
 * way to know the order actually removes the deadlock is to run both chains at
 * the same time and watch PostgreSQL. A concurrency test is also exactly where a
 * vacuously-passing assertion hides, so this suite carries its own falsification:
 *
 *   * `proves the harness can detect 40P01` runs the PRE-FIX order (grant locks
 *     first, state read last) against the apply order and requires a real
 *     deadlock. If that case stops deadlocking, the "no 40P01" cases below stop
 *     proving anything and this suite says so.
 *   * `claim ‖ apply` and `claim ‖ removal` require the claim to be BLOCKED while
 *     the other transaction holds only `W0`. That cannot pass on a claim path
 *     without the prepended read: the claim would take `L1`/`L2` (which do not
 *     conflict with a state-row lock) and return while the other side still holds
 *     `W0`.
 *
 * Every wait is observed rather than slept through: the cases poll
 * `pg_stat_activity` for the blocked statement and fail with an explanation when
 * the expected wait never appears, instead of passing because nothing overlapped.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { DelegatedGrantService } from "../../src/wallet/grants/consumption.js";
import { RecipientPolicyRepository } from "../../src/wallet/policy/repository.js";
import { seedWalletPolicyState } from "./helpers/policy-state.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** Long enough that a real deadlock (1 s detection) reports 40P01, short enough
 * that a hang fails the case instead of the run. */
const STATEMENT_TIMEOUT = "5s";

type Settled<T> =
  | { status: "ok"; value: T }
  | { status: "failed"; code: string; message: string };

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Run one transaction and report its outcome instead of throwing, so a 40P01 is
 * an assertion failure with the exact code rather than an opaque crash. */
async function settle<T>(
  operation: () => Promise<T>,
): Promise<Settled<T>> {
  try {
    return { status: "ok", value: await operation() };
  } catch (error) {
    const code = (error as { code?: string }).code ?? "unknown";
    const message = error instanceof Error ? error.message : String(error);
    return { status: "failed", code, message };
  }
}

suite("wallet policy lock order under contention (task 1.9)", () => {
  let database: DatabaseClient;
  let secondConnection: DatabaseClient;
  let observer: DatabaseClient;
  let grants: DelegatedGrantService;
  let repository: RecipientPolicyRepository;
  const provisionedUserIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    secondConnection = createDatabaseClient(databaseUrl!);
    observer = createDatabaseClient(databaseUrl!);
    grants = new DelegatedGrantService(database);
    repository = new RecipientPolicyRepository(database);
  });

  afterAll(async () => {
    for (const userId of provisionedUserIds) {
      await database.query(
        `DELETE FROM recipient_policy_sync_intent WHERE user_id = $1`,
        [userId],
      );
      await database.query(
        `DELETE FROM recipient_policy_state WHERE user_id = $1`,
        [userId],
      );
      await database.query(
        `DELETE FROM recipient_policy_leases WHERE user_id = $1`,
        [userId],
      );
      await database.query(`DELETE FROM recipients WHERE user_id = $1`, [userId]);
      // `delegated_grants`, `grant_claim_ledger` and `grant_audit_log` are left
      // in place: the audit table is append-only by trigger and carries a
      // foreign key to the grant, so the rows are immutable evidence by design.
      // They are scoped to fixture wallets no other suite reads.
    }
    await Promise.all([
      database.close(),
      secondConnection.close(),
      observer.close(),
    ]);
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function provision(
    walletId?: string,
    options: { policyState?: boolean } = {},
  ): Promise<{
    userId: string;
    walletId: string;
    grantId: string;
  }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:lor-${randomUUID()}`, "Lock Order Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    const grantedWalletId = walletId ?? wallet.rows[0]!.id;
    const grant = await database.query<{ id: string }>(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, provider_policy_id, expires_at)
       VALUES ($1, $2, 'solana', '5000000', '20000000', 3600, $3::jsonb,
               'active', $4, now() + interval '30 days')
       RETURNING id`,
      [userId, grantedWalletId, JSON.stringify([RECIPIENT]), `policy-${randomUUID()}`],
    );
    provisionedUserIds.push(userId);
    // The state row exists before any contention: the wallet has a policy, so a
    // claim MUST serialize on it. Since task 2.11 that read is also a GATE, so
    // the row is seeded VERIFIED (design §4.1) and the claim still reaches its
    // grant locks; the absent/unverified refusal is asserted at the end of this
    // file.
    if (options.policyState !== false) {
      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, grantedWalletId, client),
      );
      await seedWalletPolicyState(database, userId, grantedWalletId);
    }
    return { userId, walletId: grantedWalletId, grantId: grant.rows[0]!.id };
  }

  /**
   * Wait until the DATABASE reports a session blocked on a
   * `recipient_policy_state` statement, and return how many sessions were
   * blocked. Observed, never slept through: a `false` here fails the case with
   * the reason instead of letting a vacuous assertion pass.
   */
  async function waitForStateLockWaiter(timeoutMs = 4_000): Promise<number> {
    const deadline = Date.now() + timeoutMs;
    let seen = 0;
    while (Date.now() < deadline) {
      const result = await observer.query<{ waiting: number }>(
        `SELECT count(*)::int AS waiting
           FROM pg_stat_activity
          WHERE datname = current_database()
            AND wait_event_type = 'Lock'
            AND query LIKE '%recipient_policy_state%'`,
      );
      seen = result.rows[0]?.waiting ?? 0;
      if (seen > 0) return seen;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return seen;
  }

  const claimBudget = (
    userId: string,
    grantId: string,
    idempotencyKey = randomUUID(),
  ) =>
    grants.claimConsumption({
      grantId,
      userId,
      amount: "1000000",
      idempotencyKey,
    });

  // -------------------------------------------------------------------------
  // Falsification: the harness can detect 40P01
  // -------------------------------------------------------------------------

  it("proves a pre-fix lock order really deadlocks (the harness detects 40P01)", async () => {
    const { userId, walletId, grantId } = await provision();
    const reachedBarrier = deferred();

    // Chain A is the PRE-FIX claim order, written here on purpose: grant
    // advisory (L1) -> grant row (L2) -> state row (W0) LAST. This is the code
    // the prepended read replaces, and it is what a future writer would
    // reintroduce by moving the read down.
    const preFix = settle(() =>
      database.withUserTransaction(userId, async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
          `dgc-grant-${grantId}`,
        ]);
        await client.query(
          `SELECT id FROM delegated_grants WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [grantId, userId],
        );
        reachedBarrier.resolve();
        await new Promise((resolve) => setTimeout(resolve, 150));
        await client.query(
          `SELECT 1 FROM recipient_policy_state WHERE user_id = $1 AND wallet_id = $2 FOR SHARE`,
          [userId, walletId],
        );
        return "pre-fix chain committed";
      }),
    );

    // Chain B is the apply order: W0(U) first, then the grant row.
    const applyOrder = settle(() =>
      secondConnection.withUserTransaction(userId, async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await repository.lockPolicyState(userId, walletId, client);
        await reachedBarrier.promise;
        await client.query(
          `SELECT id FROM delegated_grants WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [grantId, userId],
        );
        return "apply chain committed";
      }),
    );

    const [preFixOutcome, applyOutcome] = await Promise.all([
      preFix,
      applyOrder,
    ]);
    const failures = [preFixOutcome, applyOutcome].filter(
      (outcome) => outcome.status === "failed",
    );

    // Exactly one side is chosen as the victim, and the victim is a real
    // deadlock: `40P01` is `deadlock_detected`. Both sides failing would mean the
    // chains are not inverses but something else is wrong, and neither failing
    // would mean this harness cannot detect a deadlock at all.
    expect(failures).toHaveLength(1);
    expect(failures[0]!.status === "failed" && failures[0]!.code).toBe("40P01");
    expect(
      failures[0]!.status === "failed" && failures[0]!.message,
    ).toContain("deadlock detected");

    // Positive control: the surviving chain really committed.
    const survivor = [preFixOutcome, applyOutcome].find(
      (outcome) => outcome.status === "ok",
    );
    expect(survivor!.status).toBe("ok");
  });

  // -------------------------------------------------------------------------
  // claim ‖ apply
  // -------------------------------------------------------------------------

  it("serializes claim against an apply-shaped transaction on W0 with no 40P01", async () => {
    const { userId, walletId, grantId } = await provision();
    const holdingState = deferred();
    const claimIsBlocked = deferred();

    // The apply-shaped transaction: W0(U) first, then the grant row. It is the
    // §1.3 apply chain (`W1 → tx{ W0(U) → L2 → L5 }`) driven through the
    // repository. The real apply orchestration arrives in slice 2; its lock
    // chain is what this case needs.
    const applySide = settle(() =>
      secondConnection.withUserTransaction(userId, async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await repository.lockPolicyState(userId, walletId, client);
        // Only W0 is held right now. Anything the claim waits for at this point
        // can only be this row.
        holdingState.resolve();
        await claimIsBlocked.promise;
        await client.query(
          `SELECT id FROM delegated_grants WHERE id = $1 AND user_id = $2 FOR UPDATE`,
          [grantId, userId],
        );
        await client.query(
          `UPDATE delegated_grants SET updated_at = now() WHERE id = $1 AND user_id = $2`,
          [grantId, userId],
        );
        return "apply-shaped transaction committed";
      }),
    );

    await holdingState.promise;
    const claimOutcome = settle(() => claimBudget(userId, grantId));

    const waiters = await waitForStateLockWaiter();
    expect(
      waiters,
      "the claim never blocked on recipient_policy_state: on a claim path without the prepended W0 read it takes L1/L2 and returns while the other transaction holds W0",
    ).toBeGreaterThan(0);
    claimIsBlocked.resolve();

    const [apply, claimResult] = await Promise.all([applySide, claimOutcome]);
    expect(apply.status).toBe("ok");
    expect(claimResult.status, JSON.stringify(claimResult)).toBe("ok");
    if (claimResult.status === "ok") {
      // One serialized outcome: the claim won budget AFTER the apply committed,
      // so it consumed exactly once and neither side deadlocked.
      expect(claimResult.value).toEqual({ consumed: true, amount: "1000000" });
    }
  });

  // -------------------------------------------------------------------------
  // claim ‖ removal
  // -------------------------------------------------------------------------

  it("serializes claim against the removal chain and never lets a claim win a revoked scope", async () => {
    const { userId, walletId, grantId } = await provision();
    const holdingLocks = deferred();
    const claimIsBlocked = deferred();

    // The removal chain, exactly as `applyRemoval` takes it:
    // W0(U) -> L1 (the same advisory key) -> L2 (ascending).
    const removalSide = settle(() =>
      secondConnection.withUserTransaction(userId, async (client) => {
        await client.query(`SET LOCAL statement_timeout = '${STATEMENT_TIMEOUT}'`);
        await repository.lockPolicyState(userId, walletId, client);
        await repository.lockGrantAdvisoryKeys([grantId], client);
        const locked = await repository.lockAffectedGrants(
          userId,
          walletId,
          [grantId],
          client,
        );
        expect(locked.map((row) => row.id)).toEqual([grantId]);
        holdingLocks.resolve();
        await claimIsBlocked.promise;
        // The removal's revocation, inside the same transaction. The claim is
        // waiting on W0, so it cannot observe the grant row before this commits.
        const revoked = await client.query<{ id: string }>(
          `UPDATE delegated_grants
              SET state = 'revoked', revoked_at = now(), updated_at = now()
            WHERE id = $1 AND user_id = $2 AND state = 'active'
            RETURNING id`,
          [grantId, userId],
        );
        expect(revoked.rowCount).toBe(1);
        return "removal committed the revocation";
      }),
    );

    await holdingLocks.promise;
    const idempotencyKey = randomUUID();
    const claimOutcome = settle(() =>
      claimBudget(userId, grantId, idempotencyKey),
    );

    const waiters = await waitForStateLockWaiter();
    expect(
      waiters,
      "the claim never blocked on recipient_policy_state behind the removal's W0",
    ).toBeGreaterThan(0);
    claimIsBlocked.resolve();

    const [removal, claimResult] = await Promise.all([removalSide, claimOutcome]);
    // No 40P01 on either side: the removal holds W0 first and the claim waits on
    // W0 first, so the two chains are serialized rather than inverted.
    expect(removal.status, JSON.stringify(removal)).toBe("ok");
    expect(claimResult.status, JSON.stringify(claimResult)).toBe("ok");

    if (claimResult.status === "ok") {
      // A claim can never succeed against a revoked scope: it either completes
      // before the revocation or it sees `revoked` and refuses. Here the removal
      // committed first, so the refusal is the only honest outcome.
      expect(claimResult.value).toEqual({ consumed: false, reason: "grant_revoked" });
    }

    // The refusal is visible in the trail, and no budget was consumed.
    const ledger = await observer.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM grant_claim_ledger
        WHERE grant_id = $1 AND idempotency_key = $2`,
      [grantId, idempotencyKey],
    );
    expect(ledger.rows[0]!.count).toBe(0);
    const rejection = await observer.query<{ reason: string }>(
      `SELECT reason FROM grant_audit_log
        WHERE grant_id = $1 AND event = 'rejected'
        ORDER BY created_at DESC LIMIT 1`,
      [grantId],
    );
    expect(rejection.rows[0]?.reason).toBe("grant_revoked");
  });

  // -------------------------------------------------------------------------
  // Task 2.11: the same read became a GATE
  // -------------------------------------------------------------------------

  it("refuses a wallet with no state row as policy_unverified (task 2.11)", async () => {
    // The prepended read used to be a lock only, so a wallet without a state row
    // stayed claimable. Task 2.11 inverts that: nothing about this wallet is
    // proven, so the budget is not granted.
    //
    // The row is left ABSENT rather than deleted: `recipient_app` holds no
    // DELETE privilege on `recipient_policy_state` (`015` grants SELECT, INSERT,
    // UPDATE only), which is why the naming case here is "no policy state" and
    // not "a deleted state".
    const { userId } = await provision(undefined, { policyState: false });
    const wallet = await database.query<{ id: string }>(
      `SELECT id FROM user_wallets WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [userId],
    );
    const walletId = wallet.rows[0]!.id;
    expect(walletId).toBeTruthy();
    const state = await database.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM recipient_policy_state WHERE user_id = $1`,
      [userId],
    );
    expect(state.rows[0]!.count).toBe(0);

    const grant = await database.query<{ id: string }>(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, provider_policy_id, expires_at)
       VALUES ($1, $2, 'solana', '5000000', '20000000', 3600, $3::jsonb,
               'active', $4, now() + interval '30 days')
       RETURNING id`,
      [userId, walletId, JSON.stringify([RECIPIENT]), `policy-${randomUUID()}`],
    );

    const outcome = await claimBudget(userId, grant.rows[0]!.id);
    expect(outcome).toEqual({ consumed: false, reason: "policy_unverified" });
    const rejection = await observer.query<{ reason: string | null }>(
      `SELECT reason FROM grant_audit_log
        WHERE grant_id = $1 AND event = 'rejected'
        ORDER BY created_at DESC LIMIT 1`,
      [grant.rows[0]!.id],
    );
    expect(rejection.rows[0]?.reason).toBe("policy_unverified");
  });
});
