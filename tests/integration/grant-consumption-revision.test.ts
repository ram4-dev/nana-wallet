/**
 * Task 2.11 — the `policy_unverified` claim gate (design §4.1, §4.2).
 *
 * WHAT THIS SUITE IS FOR
 * ----------------------
 * Task 1.9 prepended the `recipient_policy_state … FOR SHARE` read to the claim's
 * `W0` slot as a LOCK; this unit turns the same read into a GATE. Three separate
 * claims are being made, and each needs its own kind of proof:
 *
 *   1. **A claim fails closed when the wallet's applied policy is not verified.**
 *      A DB-level claim is the last place budget is granted, so "the row is
 *      absent or unverified" must be a refusal WITH an audit row, not a default.
 *      The refusal is audited in the same transaction, so a refused execution is
 *      never invisible (that is what the `rejected` row is read back for here).
 *   2. **The verified path still claims.** Without this positive control the
 *      refusals above would pass on an implementation that refuses everything,
 *      which is why the fixture's own six predicates are re-read and asserted.
 *   3. **`FOR SHARE` still lets SIBLINGS through.** Read locks do not conflict
 *      with each other, so a claim on grant B must not wait behind a sibling
 *      claim's read of the same wallet row. That is a behavioural claim about a
 *      lock mode: it is proven by holding a real `FOR SHARE` on the state row
 *      from a second connection and requiring the claim to complete while the
 *      holder is still in its transaction.
 *
 * The revoked-scope case runs LAST and asserts the negative both ways: a revoked
 * grant is refused with `grant_revoked`, and once the wallet's verified state is
 * gone the same claim is refused at the gate instead of being re-authorized.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { DelegatedGrantService } from "../../src/wallet/grants/consumption.js";
import {
  invalidateWalletPolicyState,
  seedWalletPolicyState,
  VERIFIED_POLICY_RULES_HASH,
} from "./helpers/policy-state.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** Long enough for a sibling read to be taken and released, short enough that a
 * real block fails the case in seconds instead of hanging the run. */
const BLOCK_BUDGET_MS = 3_000;

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

suite("claim gate — policy_unverified (task 2.11)", () => {
  let database: DatabaseClient;
  let secondConnection: DatabaseClient;
  let grants: DelegatedGrantService;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    secondConnection = createDatabaseClient(databaseUrl!);
    grants = new DelegatedGrantService(database);
  });

  afterAll(async () => {
    // Fixture rows are intentionally left in place: `recipient_app` holds no
    // DELETE privilege on `recipient_policy_state` (`015` grants SELECT, INSERT,
    // UPDATE only), so "unbind" can never mean "erase". The rows are scoped to
    // fixture users no other suite reads.
    await Promise.all([database.close(), secondConnection.close()]);
  });

  // ---------------------------------------------------------------------------
  // Fixtures
  // ---------------------------------------------------------------------------

  async function provisionUser(): Promise<string> {
    const result = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:claim-gate-${randomUUID()}`, "Claim Gate"],
    );
    const userId = result.rows[0]!.id;
    return userId;
  }

  async function provisionWallet(userId: string): Promise<string> {
    const result = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    return result.rows[0]!.id;
  }

  /** One active grant with a provider policy binding (so the claim reaches the gate). */
  async function insertGrant(userId: string, walletId: string): Promise<string> {
    const result = await database.query<{ id: string }>(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, provider_policy_id, expires_at)
       VALUES ($1, $2, 'solana', '5000000', '20000000', 3600, $3::jsonb,
               'active', $4, now() + interval '30 days')
       RETURNING id`,
      [userId, walletId, JSON.stringify([RECIPIENT]), `policy-${randomUUID()}`],
    );
    return result.rows[0]!.id;
  }

  /** A wallet with a verified policy and TWO sibling grants to the same recipient. */
  async function provisionClaimable(): Promise<{
    userId: string;
    walletId: string;
    grantId: string;
    siblingGrantId: string;
  }> {
    const userId = await provisionUser();
    const walletId = await provisionWallet(userId);
    const grantId = await insertGrant(userId, walletId);
    const siblingGrantId = await insertGrant(userId, walletId);
    await seedWalletPolicyState(database, userId, walletId);
    return { userId, walletId, grantId, siblingGrantId };
  }

  const claim = (userId: string, grantId: string, idempotencyKey = randomUUID()) =>
    grants.claimConsumption({
      grantId,
      userId,
      amount: "1000000",
      idempotencyKey,
    });

  async function rejectionReasons(userId: string, grantId: string) {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{ reason: string | null }>(
        `SELECT reason FROM grant_audit_log
          WHERE grant_id = $1 AND event = 'rejected'
          ORDER BY created_at`,
        [grantId],
      ),
    );
    return result.rows.map((row) => row.reason);
  }

  async function ledgerCount(userId: string, grantId: string) {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM grant_claim_ledger WHERE grant_id = $1`,
        [grantId],
      ),
    );
    return result.rows[0]!.count;
  }

  // ---------------------------------------------------------------------------
  // The gate refuses
  // ---------------------------------------------------------------------------

  it("refuses a wallet with NO state row and audits the refusal", async () => {
    const userId = await provisionUser();
    const walletId = await provisionWallet(userId);
    const grantId = await insertGrant(userId, walletId);

    const outcome = await claim(userId, grantId);

    expect(outcome).toEqual({ consumed: false, reason: "policy_unverified" });
    // The refusal is attributable: the `rejected` row carries the reason and the
    // ledger holds nothing (no budget was consumed by the refused claim).
    expect(await rejectionReasons(userId, grantId)).toEqual([
      "policy_unverified",
    ]);
    expect(await ledgerCount(userId, grantId)).toBe(0);
  });

  it("refuses a wallet whose applied revision has fallen behind the desired one", async () => {
    const userId = await provisionUser();
    const walletId = await provisionWallet(userId);
    const grantId = await insertGrant(userId, walletId);
    // One revision ahead of what was applied. The schema itself forbids
    // `status='applied'` with `applied_revision < desired_revision`
    // (`recipient_policy_state_applied_complete_ck`), so the reachable
    // behind-state is `syncing`: the remote policy no longer describes the
    // wallet's desired state and the claim must not authorize against it.
    await seedWalletPolicyState(database, userId, walletId, {
      status: "syncing",
      desiredRevision: 2,
      appliedRevision: 1,
    });

    expect(await claim(userId, grantId)).toEqual({
      consumed: false,
      reason: "policy_unverified",
    });
    expect(await rejectionReasons(userId, grantId)).toEqual([
      "policy_unverified",
    ]);
  });

  it("refuses a wallet whose readback was never verified", async () => {
    const userId = await provisionUser();
    const walletId = await provisionWallet(userId);
    const grantId = await insertGrant(userId, walletId);
    await seedWalletPolicyState(database, userId, walletId, {
      verifiedAt: null,
    });

    expect(await claim(userId, grantId)).toEqual({
      consumed: false,
      reason: "policy_unverified",
    });
  });

  // ---------------------------------------------------------------------------
  // The gate lets a verified wallet through
  // ---------------------------------------------------------------------------

  it("claims normally for a verified wallet, with the fixture's own predicates asserted", async () => {
    const { userId, walletId, grantId } = await provisionClaimable();

    // Positive control: the fixture really is the §4.1 six-predicate state, so a
    // pass below cannot be blamed on a fixture that would pass any gate.
    const state = await database.query<{
      status: string;
      desired_revision: string;
      applied_revision: string;
      desired_rules_hash: string | null;
      applied_rules_hash: string | null;
      applied_policy_id: string | null;
      applied_signer_id: string | null;
      verified_at: Date | null;
    }>(
      `SELECT status, desired_revision, applied_revision, desired_rules_hash,
              applied_rules_hash, applied_policy_id, applied_signer_id, verified_at
         FROM recipient_policy_state WHERE wallet_id = $1`,
      [walletId],
    );
    expect(state.rows[0]).toMatchObject({
      status: "applied",
      applied_policy_id: "policy-verified",
      applied_signer_id: "signer-verified",
    });
    expect(state.rows[0]!.applied_revision).toBe(state.rows[0]!.desired_revision);
    expect(state.rows[0]!.applied_rules_hash).toBe(VERIFIED_POLICY_RULES_HASH);
    expect(state.rows[0]!.applied_rules_hash).toBe(
      state.rows[0]!.desired_rules_hash,
    );
    expect(state.rows[0]!.verified_at).not.toBeNull();

    const outcome = await claim(userId, grantId);

    expect(outcome).toEqual({ consumed: true, amount: "1000000" });
    expect(await rejectionReasons(userId, grantId)).toEqual([]);
    expect(await ledgerCount(userId, grantId)).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // FOR SHARE keeps siblings claimable
  // ---------------------------------------------------------------------------

  it("does not block a sibling claim while another claim holds the state read", async () => {
    const { userId, walletId, grantId, siblingGrantId } =
      await provisionClaimable();
    const holderIsReading = deferred();
    const releaseHolder = deferred();

    // The sibling's `W0` read, held open: exactly what a concurrent claim on the
    // OTHER grant of this wallet holds for the duration of its transaction.
    const holder = secondConnection.withUserTransaction(userId, async (client) => {
      await client.query(
        `SELECT 1 FROM recipient_policy_state
          WHERE user_id = $1 AND wallet_id = $2 FOR SHARE`,
        [userId, walletId],
      );
      holderIsReading.resolve();
      await releaseHolder.promise;
    });

    await holderIsReading.promise;
    const outcome = await Promise.race([
      claim(userId, siblingGrantId),
      new Promise<"blocked">((resolve) =>
        setTimeout(() => resolve("blocked"), BLOCK_BUDGET_MS),
      ),
    ]);
    // Released unconditionally so a failing case cannot hang the run; the
    // assertion below is the one that fails, by name.
    releaseHolder.resolve();
    await holder;

    expect(
      outcome,
      "the claim waited on a sibling claim's FOR SHARE read: read locks must not conflict, only the apply transaction's FOR UPDATE may",
    ).toEqual({ consumed: true, amount: "1000000" });
    // The sibling's own grant stayed untouched by the other claim.
    expect(await ledgerCount(userId, grantId)).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // A revoked scope is never authorized
  // ---------------------------------------------------------------------------

  it("never returns consumed:true for a revoked scope, and fails closed after the state is gone", async () => {
    const { userId, walletId, grantId } = await provisionClaimable();

    await grants.revokeGrant(grantId, userId);

    expect(await claim(userId, grantId)).toEqual({
      consumed: false,
      reason: "grant_revoked",
    });
    expect(await ledgerCount(userId, grantId)).toBe(0);

    // The verified binding disappears (what task 2.12 records for a proven
    // divergence). The same claim must not become authorized by the gap.
    await invalidateWalletPolicyState(database, userId, walletId);
    expect(await claim(userId, grantId, randomUUID())).toEqual({
      consumed: false,
      reason: "policy_unverified",
    });
    expect(await ledgerCount(userId, grantId)).toBe(0);
  });
});
