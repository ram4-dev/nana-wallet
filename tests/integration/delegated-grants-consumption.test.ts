import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  appendGrantAudit,
  consumedInWindow,
  DelegatedGrantService,
  type DelegatedGrantRow,
} from "../../src/wallet/grants/consumption.js";
import {
  PrivyPolicySyncService,
  type GrantPolicyProvisioner,
} from "../../src/wallet/grants/privy-policy-sync.js";
import { seedWalletPolicyState } from "./helpers/policy-state.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const WINDOW_SECONDS = 3_600;
const MAX_PER_TRANSFER = "1_000_000";
const MAX_CUMULATIVE = "5_000_000";

function fakeProvisioner(): GrantPolicyProvisioner {
  return {
    async provisionPolicy(input) {
      return { policyId: `policy-${input.grantId.slice(0, 8)}` };
    },
    async revokePolicy() {
      // No provider side effect in this fixture.
    },
  };
}

async function provisionUser(database: DatabaseClient): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:dgc-cons-${randomUUID()}`, "DGC Consumption"],
  );
  return result.rows[0]!.id;
}

async function provisionWallet(
  database: DatabaseClient,
  userId: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  const walletId = result.rows[0]!.id;
  // Task 2.11 turned the claim's `W0` read into a gate, so a claimable wallet is
  // now a wallet whose applied policy is verified (design §4.1). This suite is
  // about caps, expiry, revocation and idempotency, so it seeds the verified
  // state and keeps isolating those; the refusal it does not test any more is
  // pinned in `grant-consumption-revision.test.ts`.
  await seedWalletPolicyState(database, userId, walletId);
  return walletId;
}

describe("delegated grant consumption & audit (DGC-3)", () => {
  let database: DatabaseClient;
  let service: DelegatedGrantService;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    service = new DelegatedGrantService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  /**
   * Raw ledger creation: the provider enforcement surface is deliberately absent,
   * which is the state the ledger must refuse to execute against.
   */
  async function createGrant(
    userId: string,
    walletId: string,
    overrides: { expiresAt?: Date } = {},
  ): Promise<DelegatedGrantRow> {
    return service.createGrant({
      userId,
      walletId,
      action: "transfer",
      chain: "solana",
      maxPerTransfer: MAX_PER_TRANSFER,
      maxCumulative: MAX_CUMULATIVE,
      windowSeconds: WINDOW_SECONDS,
      recipients: [RECIPIENT],
      expiresAt: overrides.expiresAt ?? new Date(Date.now() + 7 * 86_400_000),
    });
  }

  /** Ledger creation followed by a real policy sync (the production lifecycle). */
  async function createPolicyReadyGrant(
    userId: string,
    walletId: string,
    overrides: { expiresAt?: Date } = {},
  ): Promise<DelegatedGrantRow> {
    const grant = await createGrant(userId, walletId, overrides);
    const sync = new PrivyPolicySyncService(database, fakeProvisioner());
    const outcome = await sync.syncGrant(grant.id, userId, walletId);
    if (!outcome.policyId) throw new Error("fixture policy sync failed");
    const synced = await service.getGrant(grant.id, userId);
    if (!synced) throw new Error("synced grant disappeared");
    return synced;
  }

  async function auditEvents(userId: string, grantId: string) {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{
        event: string;
        reason: string | null;
        amount: string | null;
      }>(
        `SELECT event, reason, amount FROM grant_audit_log
           WHERE grant_id = $1 ORDER BY created_at, event`,
        [grantId],
      ),
    );
    return result.rows;
  }

  it("creates a grant with a created audit row and NO fabricated policy_synced row", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    expect(grant.state).toBe("active");
    expect(grant.maxPerTransfer).toBe("1000000");
    // Fail-closed: no provider enforcement surface exists yet.
    expect(grant.providerPolicyId).toBeNull();

    // The audit trail must not claim a policy sync that never happened.
    expect(
      (await auditEvents(userId, grant.id)).map((row) => row.event),
    ).toEqual(["created"]);

    const listed = await service.listGrants(userId);
    expect(listed.some((row) => row.id === grant.id)).toBe(true);
  });

  it("records policy_synced only from a real sync outcome, with the policy id", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);

    expect(grant.providerPolicyId).toBe(`policy-${grant.id.slice(0, 8)}`);
    const synced = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "policy_synced",
    );
    expect(synced).toHaveLength(1);
    const detail = await database.withUserTransaction(userId, (client) =>
      client.query<{ detail: { policyId?: string } | null }>(
        `SELECT detail FROM grant_audit_log
           WHERE grant_id = $1 AND event = 'policy_synced'`,
        [grant.id],
      ),
    );
    expect(detail.rows[0]?.detail?.policyId).toBe(
      `policy-${grant.id.slice(0, 8)}`,
    );
  });

  it("aggregates only unreleased ledger reservations inside the rolling window (AD-10)", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    const fresh = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, grant.windowSeconds),
    );
    expect(fresh).toBe("0");

    // AD-10: the window sum reads UNRELEASED grant_claim_ledger rows.
    // Seed two real held reservations; also append the historical 'used'
    // audit rows to prove the sum no longer reads grant_audit_log.
    const seedReservation = async (amount: string): Promise<void> => {
      await database.withUserTransaction(userId, (client) =>
        client.query(
          `INSERT INTO grant_claim_ledger (grant_id, user_id, idempotency_key, amount)
                   VALUES ($1, $2, $3, $4)`,
          [grant.id, userId, `seed-${randomUUID()}`, amount.replace(/_/g, "")],
        ),
      );
      await database.withUserTransaction(userId, (client) =>
        appendGrantAudit(
          database,
          { grantId: grant.id, userId, event: "used", amount },
          client,
        ),
      );
    };
    await seedReservation("2_000_000");
    await seedReservation("1_500_000");

    const consumed = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, WINDOW_SECONDS),
    );
    // Both held reservations count: 2M + 1.5M.
    expect(consumed).toBe("3500000");

    // Release the first reservation: it must STOP counting (the audit-row
    // sum would still be 3.5M — proving the query reads the ledger).
    await database.withUserTransaction(userId, (client) =>
      client.query(
        `UPDATE grant_claim_ledger SET released_at = now(), released_reason = 'not_dispatched'
             WHERE grant_id = $1 AND amount = 2000000`,
        [grant.id],
      ),
    );
    const afterRelease = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, WINDOW_SECONDS),
    );
    expect(afterRelease).toBe("1500000");
  });

  it("rejects audit UPDATE and DELETE (append-only trigger)", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(
          `UPDATE grant_audit_log SET amount = '0' WHERE grant_id = $1`,
          [grant.id],
        ),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);

    await expect(
      database.withUserTransaction(userId, (client) =>
        client.query(`DELETE FROM grant_audit_log WHERE grant_id = $1`, [
          grant.id,
        ]),
      ),
    ).rejects.toThrow(/append-only|permission denied/i);
  });

  it("revocation marks the grant and appends a revoked audit row", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    await service.revokeGrant(grant.id, userId);

    const row = await database.withUserTransaction(userId, (client) =>
      client.query<{ state: string; revoked_at: string | null }>(
        `SELECT state, revoked_at FROM delegated_grants WHERE id = $1`,
        [grant.id],
      ),
    );
    expect(row.rows[0]?.state).toBe("revoked");
    expect(row.rows[0]?.revoked_at).not.toBeNull();

    const audit = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string }>(
        `SELECT event FROM grant_audit_log WHERE grant_id = $1 AND event = 'revoked'`,
        [grant.id],
      ),
    );
    expect(audit.rowCount).toBe(1);
  });

  it("atomically consumes budget: two concurrent claims cannot exceed the cap", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);
    // Cap allows exactly one more transfer of MAX_PER_TRANSFER: seed a
    // HELD 4M ledger reservation (AD-10: the claim window total counts
    // unreleased grant_claim_ledger rows, not audit rows). The audit row
    // mirrors it for the append-only trail.
    await database.withUserTransaction(userId, (client) =>
      client.query(
        `INSERT INTO grant_claim_ledger (grant_id, user_id, idempotency_key, amount)
                 VALUES ($1, $2, $3, $4)`,
        [grant.id, userId, `seed-cap-${randomUUID()}`, "4000000"],
      ),
    );
    await database.withUserTransaction(userId, (client) =>
      appendGrantAudit(
        database,
        {
          grantId: grant.id,
          userId,
          event: "used",
          amount: "4_000_000",
        },
        client,
      ),
    );

    const claim = () =>
      service.claimConsumption({
        grantId: grant.id,
        userId,
        amount: MAX_PER_TRANSFER,
        idempotencyKey: `claim-${randomUUID()}`,
      });

    const results = await Promise.allSettled([claim(), claim()]);
    const fulfilled = results.filter(
      (r) => r.status === "fulfilled" && r.value.consumed,
    );
    const rejected = results.filter(
      (r) => r.status === "fulfilled" && !r.value.consumed,
    );
    expect(fulfilled.length).toBe(1);
    expect(rejected.length).toBe(1);

    // The losing claim is audited with its reason, never silently dropped.
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("cumulative_cap_exceeded");
    expect(rejections[0]?.amount).toBe("1000000");
  });

  it("reused idempotency key returns the original result and does not double-consume", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);
    const idempotencyKey = `idem-${randomUUID()}`;

    const first = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "1_000_000",
      idempotencyKey,
    });
    expect(first.consumed).toBe(true);
    expect(first.amount).toBe("1000000");

    const replay = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "1_000_000",
      idempotencyKey,
    });
    // The original execution result is returned, not a fresh rejection.
    expect(replay.consumed).toBe(true);
    expect(replay.replay).toBe(true);
    expect(replay.amount).toBe("1000000");

    const consumed = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, WINDOW_SECONDS),
    );
    expect(consumed).toBe("1000000");

    // Exactly one `used` row and no `rejected` row from the replay.
    const events = (await auditEvents(userId, grant.id)).map(
      (row) => row.event,
    );
    expect(events.filter((event) => event === "used")).toHaveLength(1);
    expect(events).not.toContain("rejected");
  });

  it("refuses a grant without its provider policy binding and audits the reason", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createGrant(userId, walletId);

    const claim = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "100_000",
      idempotencyKey: `claim-${randomUUID()}`,
    });

    expect(claim.consumed).toBe(false);
    expect(claim.reason).toBe("policy_not_ready");
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("policy_not_ready");
    // Fail-closed consumes nothing.
    const consumed = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grant.id, WINDOW_SECONDS),
    );
    expect(consumed).toBe("0");
  });

  it("rechecks expiration on the locked row and audits the rejection", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    // Policy-ready but already expired: only the locked expiry re-check stands
    // between this grant and an unauthorized execution.
    const grant = await createPolicyReadyGrant(userId, walletId, {
      expiresAt: new Date(Date.now() - 60_000),
    });

    const claim = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "100_000",
      idempotencyKey: `claim-${randomUUID()}`,
    });

    expect(claim.consumed).toBe(false);
    expect(claim.reason).toBe("grant_expired");
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("grant_expired");

    // The spec pins that no grant state is mutated on an expiry rejection.
    const row = await database.withUserTransaction(userId, (client) =>
      client.query<{ state: string }>(
        `SELECT state FROM delegated_grants WHERE id = $1`,
        [grant.id],
      ),
    );
    expect(row.rows[0]?.state).toBe("active");
  });

  it("audits a per-transfer cap rejection with its reason and amount", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);

    const claim = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "2_000_000",
      idempotencyKey: `claim-${randomUUID()}`,
    });

    expect(claim.reason).toBe("per_transfer_cap_exceeded");
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("per_transfer_cap_exceeded");
    expect(rejections[0]?.amount).toBe("2000000");
  });

  it("audits a revoked-grant rejection", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);

    await service.revokeGrant(grant.id, userId);
    const claim = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "100_000",
      idempotencyKey: `claim-${randomUUID()}`,
    });

    expect(claim.consumed).toBe(false);
    expect(claim.reason).toBe("grant_revoked");
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("grant_revoked");
  });

  it("rejects a zero amount as invalid_amount, audits NULL, and creates no claim row", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);

    const claim = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "0",
      idempotencyKey: `claim-${randomUUID()}`,
    });

    expect(claim.consumed).toBe(false);
    expect(claim.reason).toBe("invalid_amount");
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("invalid_amount");
    // The malformed value is never persisted: the audit amount is NULL.
    expect(rejections[0]?.amount).toBeNull();
    const claimRows = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM grant_claim_ledger WHERE grant_id = $1`,
        [grant.id],
      ),
    );
    expect(claimRows.rowCount).toBe(0);
  });

  it("rejects a malformed amount as invalid_amount, audits NULL, and creates no claim row", async () => {
    const userId = await provisionUser(database);
    const walletId = await provisionWallet(database, userId);
    const grant = await createPolicyReadyGrant(userId, walletId);

    const claim = await service.claimConsumption({
      grantId: grant.id,
      userId,
      amount: "1__0",
      idempotencyKey: `claim-${randomUUID()}`,
    });

    expect(claim.consumed).toBe(false);
    expect(claim.reason).toBe("invalid_amount");
    const rejections = (await auditEvents(userId, grant.id)).filter(
      (row) => row.event === "rejected",
    );
    expect(rejections).toHaveLength(1);
    expect(rejections[0]?.reason).toBe("invalid_amount");
    expect(rejections[0]?.amount).toBeNull();
    const claimRows = await database.withUserTransaction(userId, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM grant_claim_ledger WHERE grant_id = $1`,
        [grant.id],
      ),
    );
    expect(claimRows.rowCount).toBe(0);
  });

  it("cross-user access to a grant is impossible (RLS through service path)", async () => {
    const userIdA = await provisionUser(database);
    const walletA = await provisionWallet(database, userIdA);
    const grant = await createPolicyReadyGrant(userIdA, walletA);

    const userIdB = await provisionUser(database);
    const listed = await service.listGrants(userIdB);
    expect(listed.some((row) => row.id === grant.id)).toBe(false);
    await expect(service.revokeGrant(grant.id, userIdB)).rejects.toThrow();
  });
});
