/**
 * WU3 task 2.3, reduced by task 1.8 — the Solana grant rule builder.
 *
 * This module used to hold the second full-rule writer: `provisionPolicy` and
 * `revokePolicyRules` recomputed the whole rule union and PATCHed it onto the
 * policy, which is exactly the "complete rule set replacement" failure of design
 * §0 C1 — the grant PATCH erased the enrollment allowlist rule. Task 1.8 removed
 * both entry points and routed their callers through the composer service, so
 * what remains here is the PURE rule builder and the provider port types it is
 * defined against. Nothing in this module reaches a provider any more.
 *
 * Rule shape (verified live against the Privy API): a rule is FLAT —
 * `{ name, method, action, conditions[] }`, exactly like the EVM builder in
 * src/wallet/enrollment-policy.ts. Privy rejects both the older
 * `resource: { method, chain }` wrapper and any extra `metadata` key with
 * 400 invalid_policy_format. Solana conditions carry no chain/cluster field (only
 * EVM has `chain_id`), so devnet scoping comes from the wallet + provider
 * config, NOT from the policy.
 *
 * Composing a rule SET is the composer's decision (design §3.1/§3.3); this
 * module only knows how one grant is expressed as one ALLOW rule.
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
