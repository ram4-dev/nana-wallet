/**
 * Task 1.1 — cross-user RLS denial on all five recipient-policy-sync tables.
 *
 * WHY THIS SUITE IS SEPARATE FROM THE SCHEMA SUITE
 * ------------------------------------------------
 * The schema suite proves the objects exist and that the invariants hold. It
 * cannot prove isolation, because a policy that exists but scopes nothing looks
 * identical to a correct one from a catalog read. This suite drives the real
 * runtime shape instead: two provisioned users, each transaction running as
 * `recipient_app` with `app.user_id` set by `withUserTransaction`, and the
 * denial asserted as a *behavioral* fact (zero visible rows, rejected writes)
 * with a positive control that the owner still sees its own rows.
 *
 * `recipient_policy_leases` is deliberately different: it is the cross-process
 * wallet serialization row and is owned by the system context, so a user
 * transaction must be denied entirely (design §2.6 mirrors
 * `reconciliation_leases_system_only`). The positive control there is a system
 * transaction, not a user transaction.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("recipient policy sync RLS (migration 015)", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  /** user A + wallet A, and user B who must never observe them. */
  async function provisionPair(): Promise<{
    userA: string;
    walletA: string;
    userB: string;
    walletB: string;
  }> {
    const a = await provision(database);
    const b = await provision(database);
    return {
      userA: a.userId,
      walletA: a.walletId,
      userB: b.userId,
      walletB: b.walletId,
    };
  }

  it("denies cross-user reads and writes on recipient_policy_state", async () => {
    const { userA, walletA, userB } = await provisionPair();

    await database.withUserTransaction(userA, (client) =>
      client.query(
        `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision, status)
         VALUES ($1, $2, 4, 'pending')`,
        [walletA, userA],
      ),
    );

    const seenByA = await database.withUserTransaction(userA, (client) =>
      client.query<{ wallet_id: string }>(
        `SELECT wallet_id FROM recipient_policy_state WHERE wallet_id = $1`,
        [walletA],
      ),
    );
    expect(seenByA.rowCount).toBe(1);

    const seenByB = await database.withUserTransaction(userB, (client) =>
      client.query<{ wallet_id: string }>(
        `SELECT wallet_id FROM recipient_policy_state WHERE wallet_id = $1`,
        [walletA],
      ),
    );
    expect(seenByB.rowCount).toBe(0);

    // Cross-user UPDATE matches no row: the USING clause hides it.
    const updated = await database.withUserTransaction(userB, (client) =>
      client.query(
        `UPDATE recipient_policy_state SET status = 'applied' WHERE wallet_id = $1`,
        [walletA],
      ),
    );
    expect(updated.rowCount).toBe(0);

    // Claiming another user's identity is rejected by WITH CHECK.
    await expect(
      database.withUserTransaction(userB, (client) =>
        client.query(
          `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision)
           VALUES ($1, $2, 1)`,
          [walletA, userA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("denies cross-user access on recipient_policy_sync_intent and keeps the reconciler scan available", async () => {
    const { userA, walletA, userB } = await provisionPair();

    const inserted = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO recipient_policy_sync_intent
           (wallet_id, user_id, desired_revision, origin, composed_rules, composed_hash)
         VALUES ($1, $2, 1, 'screen', '[]'::jsonb, 'hash') RETURNING id`,
        [walletA, userA],
      ),
    );
    const intentId = inserted.rows[0]!.id;

    const seenByB = await database.withUserTransaction(userB, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM recipient_policy_sync_intent WHERE id = $1`,
        [intentId],
      ),
    );
    expect(seenByB.rowCount).toBe(0);

    await expect(
      database.withUserTransaction(userB, (client) =>
        client.query(
          `INSERT INTO recipient_policy_sync_intent
             (wallet_id, user_id, desired_revision, origin, composed_rules, composed_hash)
           VALUES ($1, $2, 2, 'screen', '[]'::jsonb, 'hash')`,
          [walletA, userA],
        ),
      ),
    ).rejects.toThrow();

    // The reconciler runs in system context (no app.user_id) and must be able
    // to enumerate due intents across users. Without this policy nothing could
    // ever reconcile a wallet the reconciler does not own.
    const scanned = await database.withSystemTransaction((client) =>
      client.query<{ id: string }>(
        `SELECT id FROM recipient_policy_sync_intent WHERE id = $1`,
        [intentId],
      ),
    );
    expect(scanned.rowCount).toBe(1);
  });

  it("denies cross-user access on contact_action_proposals", async () => {
    const { userA, walletA, userB } = await provisionPair();

    const inserted = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO contact_action_proposals
           (user_id, wallet_id, action, address, proposal_hash, origin, expires_at)
         VALUES ($1, $2, 'create', 'addr-a', 'hash', 'text', now() + interval '10 minutes')
         RETURNING id`,
        [userA, walletA],
      ),
    );
    const proposalId = inserted.rows[0]!.id;

    const seenByB = await database.withUserTransaction(userB, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM contact_action_proposals WHERE id = $1`,
        [proposalId],
      ),
    );
    expect(seenByB.rowCount).toBe(0);

    // A foreign consumer cannot consume another user's proposal, even knowing
    // its exact id: the conditional UPDATE matches nothing.
    const consumed = await database.withUserTransaction(userB, (client) =>
      client.query(
        `UPDATE contact_action_proposals SET status = 'consumed', consumed_at = now()
          WHERE id = $1 AND status = 'open'`,
        [proposalId],
      ),
    );
    expect(consumed.rowCount).toBe(0);

    await expect(
      database.withUserTransaction(userB, (client) =>
        client.query(
          `INSERT INTO contact_action_proposals
             (user_id, wallet_id, action, address, proposal_hash, origin, expires_at)
           VALUES ($1, $2, 'create', 'addr-b', 'hash', 'text', now() + interval '10 minutes')`,
          [userA, walletA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("denies cross-user access on recipient_policy_audit", async () => {
    const { userA, walletA, userB } = await provisionPair();

    const inserted = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `INSERT INTO recipient_policy_audit (wallet_id, user_id, desired_revision, event)
         VALUES ($1, $2, 1, 'intent_recorded') RETURNING id`,
        [walletA, userA],
      ),
    );
    const auditId = inserted.rows[0]!.id;

    const seenByB = await database.withUserTransaction(userB, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM recipient_policy_audit WHERE id = $1`,
        [auditId],
      ),
    );
    expect(seenByB.rowCount).toBe(0);

    await expect(
      database.withUserTransaction(userB, (client) =>
        client.query(
          `INSERT INTO recipient_policy_audit (wallet_id, user_id, event)
           VALUES ($1, $2, 'intent_recorded')`,
          [walletA, userA],
        ),
      ),
    ).rejects.toThrow();
  });

  it("keeps recipient_policy_leases system-context only", async () => {
    const { userA, walletA } = await provisionPair();

    // A user transaction may not even create a lease for its own wallet: the
    // lease protects cross-process serialization and is never user-owned data.
    await expect(
      database.withUserTransaction(userA, (client) =>
        client.query(
          `INSERT INTO recipient_policy_leases
             (wallet_id, user_id, lease_token, owner_id, expires_at)
           VALUES ($1, $2, 'tok', 'owner-a', now() + interval '60 seconds')`,
          [walletA, userA],
        ),
      ),
    ).rejects.toThrow();

    // System context acquires it.
    const acquired = await database.withSystemTransaction((client) =>
      client.query<{ wallet_id: string }>(
        `INSERT INTO recipient_policy_leases
           (wallet_id, user_id, lease_token, owner_id, expires_at)
         VALUES ($1, $2, 'tok-system', 'owner-system', now() + interval '60 seconds')
         RETURNING wallet_id`,
        [walletA, userA],
      ),
    );
    expect(acquired.rowCount).toBe(1);

    // ...and the user context still sees nothing, even for its own wallet.
    const seenByUser = await database.withUserTransaction(userA, (client) =>
      client.query<{ wallet_id: string }>(
        `SELECT wallet_id FROM recipient_policy_leases WHERE wallet_id = $1`,
        [walletA],
      ),
    );
    expect(seenByUser.rowCount).toBe(0);

    const seenBySystem = await database.withSystemTransaction((client) =>
      client.query<{ wallet_id: string }>(
        `SELECT wallet_id FROM recipient_policy_leases WHERE wallet_id = $1`,
        [walletA],
      ),
    );
    expect(seenBySystem.rowCount).toBe(1);
  });
});

/**
 * Provisioning runs as the migration owner (the raw pool), matching the
 * existing integration-suite convention: `recipient_app` is not granted
 * `users_ensure_for_privy_did`, and fixtures are not the subject under test.
 */
async function provision(
  database: DatabaseClient,
): Promise<{ userId: string; walletId: string }> {
  const user = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:rps-rls-${randomUUID()}`, "RPS RLS Test"],
  );
  const userId = user.rows[0]!.id;
  const wallet = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  return { userId, walletId: wallet.rows[0]!.id };
}
