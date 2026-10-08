/**
 * WU3 task 2.3 — composed Solana grant policy provisioner (ADR-2).
 *
 * One composed signer policy per wallet (Privy caps `policy_ids` at one per
 * signer). Each ACTIVE grant contributes its own conditioned ALLOW rule:
 * recipient allowlist AND per-transfer max AND static expiry timestamp.
 * There is deliberately NO cumulative-window rule: Privy has no rolling
 * cumulative cap, so the grants ledger stays the sole cumulative authority.
 *
 * Rule shape (verified live against the Privy API): FLAT
 * `{ name, method, action, conditions[] }` — a `resource: { method, chain }`
 * wrapper and any extra `metadata` key are rejected with 400
 * invalid_policy_format. Solana conditions carry no chain/cluster field (only
 * EVM has `chain_id`), so devnet scoping comes from the wallet + provider
 * config, NOT the policy.
 *
 * Lifecycle (fail-closed, readback-verified):
 *   1. Attach: signer readback; if the signer has no policy, create one and
 *      attach it via `additional_signers` as a complete-list mutation that
 *      preserves every unrelated signer entry.
 *   2. Recompute: rules = union over active grants (serialized per wallet),
 *      then PATCH.
 *   3. Readback: GET the policy after PATCH before reporting success. Both the
 *      policy id and the exact rule set are compared; any divergence reports
 *      `policyId: null` so the binding is treated as unchanged and every
 *      affected grant stays non-executable until a re-sync.
 *   4. Revoke: recompute the union without the revoked grant and PATCH.
 *      Sibling rules and the policy id are preserved; the policy is never
 *      deleted while siblings are active. The revoke PATCH is readback-verified
 *      against the exact remaining rules, fail-closed on mismatch.
 */

export type GrantPolicyInput = {
  grantId: string;
  walletId: string;
  recipients: string[];
  /** Per-transfer ceiling in smallest units (decimal string). */
  maxPerTransfer: string;
  /** Static expiry (epoch seconds); Privy has no rolling cumulative window. */
  expiresAt: number;
};

export type GrantPolicyRule = {
  name: string;
  method: "signAndSendTransaction";
  action: "ALLOW";
  conditions: Array<Record<string, unknown>>;
};

export type PrivyPolicyAdminClient = {
  /** Policy ids already attached to this wallet's signer. */
  getSignerPolicyIds(walletId: string): Promise<string[]>;
  createPolicy(input: {
    walletId: string;
    name: string;
    rules: GrantPolicyRule[];
  }): Promise<{ id: string }>;
  getPolicy(policyId: string): Promise<{ id: string; rules: unknown[] }>;
  patchPolicy(
    policyId: string,
    patch: { name?: string; rules: GrantPolicyRule[] },
  ): Promise<{ id: string }>;
  /** Active grants for a wallet, straight from the ledger. */
  listActiveGrants(
    walletId: string,
    userId: string,
    chain: string,
  ): Promise<LedgerGrantRecord[]>;
  attachPolicyToSigner(input: {
    walletId: string;
    policyId: string;
    /**
     * `additional_signers` PATCH is a complete-list mutation: the adapter must
     * preserve every unrelated signer entry.
     */
    preserveExistingSigners: boolean;
  }): Promise<void>;
};

/** Ledger-shaped active grant row (mirrors `GrantPolicyInput` for recompute). */
export type LedgerGrantRecord = GrantPolicyInput;

/** Exact structural readback comparison, independent of object key order. */
function sameRules(a: unknown, b: unknown): boolean {
  return isDeepStrictEqual(a, b);
}

export type ProvisionPolicyResult = {
  policyId: string | null;
  error?: string;
  /** Grants covered by the recomputed (failed) policy update. */
  affectedGrants?: string[];
};

export type RevokePolicyRulesResult = {
  revoked: boolean;
  policyId: string | null;
  error?: string;
};

/**
 * Compose conditioned ALLOW rules, one per grant. Per-grant isolation survives
 * composition: each rule is scoped to its own recipient allowlist, per-transfer
 * ceiling, and static expiry, and carries a grant-derived name. No
 * cumulative-window rule is ever fabricated — the ledger is the sole cumulative
 * authority.
 *
 * Shape (verified live against the Privy API): a rule is FLAT —
 * `{ name, method, action, conditions[] }`, exactly like the EVM builder in
 * src/wallet/enrollment-policy.ts. Privy rejects both the older
 * `resource: { method, chain }` wrapper and any extra `metadata` key with
 * 400 invalid_policy_format (Unrecognized key(s) in object). Rule names are
 * capped at 50 characters.
 *
 * CHAIN SCOPING: Solana conditions carry NO chain/cluster field — only EVM
 * rules have `chain_id`. A Solana rule therefore cannot scope a cluster, and
 * there is deliberately no `chain` on the rule. Devnet scoping comes from the
 * wallet and the provider configuration, NOT from the policy.
 */
export function composeGrantRules(
  grants: GrantPolicyInput[],
): GrantPolicyRule[] {
  return grants.map((grant) => ({
    name: `solana-grant-${grant.grantId}`.slice(0, 50),
    method: "signAndSendTransaction",
    action: "ALLOW",
    conditions: [
      {
        field_source: "solana_system_program_instruction",
        field: "Transfer.to",
        operator: "in",
        value: grant.recipients,
      },
      {
        field_source: "solana_system_program_instruction",
        field: "Transfer.lamports",
        operator: "lte",
        value: grant.maxPerTransfer,
      },
      {
        field_source: "system",
        field: "current_unix_timestamp",
        operator: "lt",
        value: grant.expiresAt,
      },
    ],
  }));
}

/**
 * Deterministic union merge: ledger grants keep their order; a grant id present
 * in both the ledger and the incoming set is replaced in place by the incoming
 * (fresher) version; incoming-only grants are appended.
 */
function mergeGrants(
  ledger: GrantPolicyInput[],
  incoming: GrantPolicyInput[],
): GrantPolicyInput[] {
  const incomingById = new Map(incoming.map((g) => [g.grantId, g]));
  const merged = ledger.map((g) => incomingById.get(g.grantId) ?? g);
  const ledgerIds = new Set(ledger.map((g) => g.grantId));
  for (const g of incoming) {
    if (!ledgerIds.has(g.grantId)) merged.push(g);
  }
  return merged;
}

export type ProvisionerOptions = {
  /**
   * Serialize provision-vs-revoke recomputes per wallet (ADR-2 per-wallet
   * mutual exclusion, the in-process analogue of the ledger's `pg_advisory`
   * lock). On by default.
   */
  serializePerWallet?: boolean;
};

export function createSolanaGrantPolicyProvisioner(
  admin: PrivyPolicyAdminClient,
  options: ProvisionerOptions = {},
) {
  const serializePerWallet = options.serializePerWallet ?? true;

  // Per-wallet mutex tails. Grants provisioned through this instance that may
  // not yet be visible in the ledger readback (post-provision, pre-commit) are
  // kept in-flight so a concurrent revoke recomputes the full union.
  const perWalletLocks = new Map<string, Promise<void>>();
  const inFlightGrants = new Map<string, Map<string, GrantPolicyInput>>();

  function withWalletLock<T>(
    walletId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    if (!serializePerWallet) return operation();
    const previous = perWalletLocks.get(walletId);
    const result = previous ? previous.then(operation, operation) : operation();
    const release = (): void => {
      if (perWalletLocks.get(walletId) === tail)
        perWalletLocks.delete(walletId);
    };
    const tail = result.then(release, release);
    perWalletLocks.set(walletId, tail);
    return result;
  }

  /** Union over ledger grants plus in-flight provisions for the wallet. */
  async function activeUnion(
    walletId: string,
    userId: string,
    chain: string,
  ): Promise<GrantPolicyInput[]> {
    const ledger = await admin.listActiveGrants(walletId, userId, chain);
    const inFlight = Array.from(inFlightGrants.get(walletId)?.values() ?? []);
    return mergeGrants(ledger, inFlight);
  }

  return {
    /**
     * Provision (or re-provision) one grant: recompute the union over active
     * grants with this grant upserted, PATCH, and readback before success.
     * Fails closed: an uncertain PATCH reports `policyId: null` with the
     * affected grant ids so the caller keeps every affected grant
     * non-executable until a successful re-sync.
     */
    provisionPolicy(input: {
      grantId: string;
      walletId: string;
      userId: string;
      chain: string;
      recipients: string[];
      maxPerTransfer: string;
      /** Stored ledger expiry (epoch seconds), never derived from a rolling window. */
      expiresAt: number;
    }): Promise<ProvisionPolicyResult> {
      const grant: GrantPolicyInput = {
        grantId: input.grantId,
        walletId: input.walletId,
        recipients: input.recipients,
        maxPerTransfer: input.maxPerTransfer,
        // Stored ledger expiry only; never synthesized from a rolling window.
        expiresAt: input.expiresAt,
      };
      const execute = async (): Promise<ProvisionPolicyResult> => {
        const union = mergeGrants(
          await activeUnion(input.walletId, input.userId, input.chain),
          [grant],
        );
        const rules = composeGrantRules(union);
        const attached = await admin.getSignerPolicyIds(input.walletId);
        let policyId = attached[0];
        try {
          if (!policyId) {
            policyId = (
              await admin.createPolicy({
                walletId: input.walletId,
                name: `solana-grant-policy-${input.walletId}`,
                rules: [],
              })
            ).id;
            // `additional_signers` is a complete-list mutation: the adapter
            // must preserve every unrelated signer entry.
            await admin.attachPolicyToSigner({
              walletId: input.walletId,
              policyId,
              preserveExistingSigners: true,
            });
            // Post-attach signer readback: the attach is only trusted once
            // the signer itself reports the new policy id. Fail closed.
            const postAttach = await admin.getSignerPolicyIds(input.walletId);
            if (!postAttach.includes(policyId)) {
              throw new Error(
                `Post-attach signer readback does not report policy ${policyId}; attach is unverified.`,
              );
            }
          }
          await admin.patchPolicy(policyId, { rules });
          // Readback before success: the policy must exist AND its rule set
          // must match the composed rules exactly. Fail closed on drift.
          const readback = await admin.getPolicy(policyId);
          if (
            !readback ||
            readback.id !== policyId ||
            !sameRules(readback.rules, rules)
          ) {
            throw new Error(
              `Policy readback after PATCH returned a different id or non-matching rules (expected ${policyId}).`,
            );
          }
        } catch (error) {
          // Fail closed: binding unchanged, caller degrades ALL affected grants.
          const message =
            error instanceof Error ? error.message : String(error);
          return {
            policyId: null,
            error: message,
            affectedGrants: union.map((g) => g.grantId),
          };
        }
        const walletGrants = inFlightGrants.get(input.walletId) ?? new Map();
        walletGrants.set(grant.grantId, grant);
        inFlightGrants.set(input.walletId, walletGrants);
        return { policyId };
      };
      return withWalletLock(input.walletId, execute);
    },

    /**
     * Remove one grant's rules by recomputing the union without it. Sibling
     * rules and the policy id are preserved; the policy is never deleted while
     * siblings remain active. An uncertain PATCH keeps the binding (retryable)
     * and reports `revoked: false`; the caller's grant state blocks execution.
     */
    revokePolicyRules(input: {
      grantId: string;
      walletId: string;
      userId: string;
      chain: string;
    }): Promise<RevokePolicyRulesResult> {
      const execute = async (): Promise<RevokePolicyRulesResult> => {
        const attached = await admin.getSignerPolicyIds(input.walletId);
        if (attached.length === 0) {
          // No policy binding: nothing to remove on the provider surface.
          return { revoked: true, policyId: null };
        }
        const policyId = attached[0];
        const remaining = (
          await activeUnion(input.walletId, input.userId, input.chain)
        ).filter((g) => g.grantId !== input.grantId);
        try {
          await admin.patchPolicy(policyId, {
            rules: composeGrantRules(remaining),
          });
          // Readback-verify the revoke: the policy must exist AND hold
          // exactly the remaining rule set. Fail closed on drift.
          const remainingRules = composeGrantRules(remaining);
          const readback = await admin.getPolicy(policyId);
          if (
            !readback ||
            readback.id !== policyId ||
            !sameRules(readback.rules, remainingRules)
          ) {
            throw new Error(
              `Policy readback after revoke PATCH returned a different id or non-matching rules (expected ${policyId}).`,
            );
          }
        } catch (error) {
          // Uncertain revoke: keep the binding (retryable); grant state blocks
          // execution either way.
          const message =
            error instanceof Error ? error.message : String(error);
          return { revoked: false, policyId, error: message };
        }
        inFlightGrants.get(input.walletId)?.delete(input.grantId);
        return { revoked: true, policyId };
      };
      return withWalletLock(input.walletId, execute);
    },
  };
}
import { isDeepStrictEqual } from "node:util";
