/**
 * Wallet-policy state fixture (design §4.1).
 *
 * Task 2.11 turns the claim path's `W0` read into a GATE: from now on a claim is
 * refused unless the wallet's `recipient_policy_state` row satisfies all six
 * §4.1 predicates. Every pre-existing claim suite was written before that gate
 * existed and seeds no state row at all, so they are not "failing tests to
 * adjust" — their fixtures stop describing a claimable wallet. Seeding the
 * verified row is how those suites keep isolating the behaviour they were
 * written for; the refusal itself is pinned in
 * `tests/integration/grant-consumption-revision.test.ts`.
 *
 * The defaults ARE the verified state; `overrides` exists so a suite can break
 * exactly one predicate and attribute the refusal to it.
 */
import type { DatabaseClient } from "../../../src/db/client.js";

/**
 * The rule hash the fixture stores on BOTH revisions. Its value is irrelevant to
 * the gate (the predicate is equality, not a specific digest) and it is not a
 * `composedRulesHash` output on purpose: a claim never compares the remote rules,
 * only that the applied revision IS the desired one.
 */
export const VERIFIED_POLICY_RULES_HASH = "0".repeat(64);

export type WalletPolicyStateOverrides = {
  status?: string;
  desiredRevision?: number;
  appliedRevision?: number;
  desiredRulesHash?: string | null;
  appliedRulesHash?: string | null;
  appliedPolicyId?: string | null;
  appliedSignerId?: string | null;
  verifiedAt?: Date | null;
};

/**
 * Upsert the wallet's policy state inside the OWNER's transaction, because
 * `recipient_policy_state` is owner-only under RLS (`015`): a system-context
 * write is denied, and a plain pool query silently matches zero rows.
 */
export async function seedWalletPolicyState(
  database: DatabaseClient,
  userId: string,
  walletId: string,
  overrides: WalletPolicyStateOverrides = {},
): Promise<void> {
  const row = {
    status: "applied",
    desiredRevision: 1,
    appliedRevision: 1,
    desiredRulesHash: VERIFIED_POLICY_RULES_HASH,
    appliedRulesHash: VERIFIED_POLICY_RULES_HASH,
    appliedPolicyId: "policy-verified",
    appliedSignerId: "signer-verified",
    verifiedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };

  await database.withUserTransaction(userId, (client) =>
    client.query(
      `INSERT INTO recipient_policy_state
         (wallet_id, user_id, desired_revision, applied_revision, desired_rules_hash,
          applied_rules_hash, applied_policy_id, applied_signer_id, status, verified_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       ON CONFLICT (wallet_id) DO UPDATE SET
         desired_revision = EXCLUDED.desired_revision,
         applied_revision = EXCLUDED.applied_revision,
         desired_rules_hash = EXCLUDED.desired_rules_hash,
         applied_rules_hash = EXCLUDED.applied_rules_hash,
         applied_policy_id = EXCLUDED.applied_policy_id,
         applied_signer_id = EXCLUDED.applied_signer_id,
         status = EXCLUDED.status,
         verified_at = EXCLUDED.verified_at`,
      [
        walletId,
        userId,
        row.desiredRevision,
        row.appliedRevision,
        row.desiredRulesHash,
        row.appliedRulesHash,
        row.appliedPolicyId,
        row.appliedSignerId,
        row.status,
        row.verifiedAt,
      ],
    ),
  );
}

/**
 * Lose the wallet's verified binding the way task 2.12 records it: the applied
 * evidence is cleared and the status goes blocked, while the row itself stays
 * (the `recipient_app` grant on this table is `SELECT, INSERT, UPDATE` — there is
 * deliberately no DELETE, so "unbind" can never mean "erase").
 */
export async function invalidateWalletPolicyState(
  database: DatabaseClient,
  userId: string,
  walletId: string,
): Promise<void> {
  await seedWalletPolicyState(database, userId, walletId, {
    status: "blocked_conflict",
    appliedRulesHash: null,
    appliedPolicyId: null,
    appliedSignerId: null,
    verifiedAt: null,
  });
}
