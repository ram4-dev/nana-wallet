/**
 * Solana consent-enrollment policy rules (task 2.7, solana-devnet-provider).
 *
 * Enrollment for Solana wallets attaches a composed policy to the exact
 * readback-verified signer. Each rule uses Privy's Solana policy DSL:
 *   - recipient allowlist via `solana_system_program_instruction` Transfer.to
 *   - per-transfer lamport ceiling via Transfer.lamports
 *   - static expiry via `system` current_unix_timestamp (lt)
 *
 * Rule shape (verified live against the Privy API): a rule is FLAT —
 * `{ name, method, action, conditions[] }`, exactly like the EVM builder in
 * src/wallet/enrollment-policy.ts. The older
 * `{ action, resource: { method, chain }, conditions }` wrapper is REJECTED
 * with 400 invalid_policy_format:
 *   Required at "rules[0].name"; Required at "rules[0].method";
 *   Unrecognized key(s) in object: 'resource'
 *
 * CHAIN SCOPING: Solana conditions carry NO chain/cluster field — only EVM
 * rules have `chain_id`. A Solana rule therefore cannot scope a cluster, and
 * there is deliberately no `chain` on the rule. Devnet scoping comes from the
 * wallet and the provider configuration, NOT from the policy.
 *
 * These shapes are pinned by tests/unit/grants-policy-provisioner.test.ts
 * (task 1.11) and verified against Privy's documented Solana examples.
 */

export type SolanaEnrollmentRule = {
  name: string;
  method: "signAndSendTransaction";
  action: "ALLOW";
  conditions: Array<Record<string, unknown>>;
};

/**
 * Builds the single ALLOW rule for a Solana signer enrollment: recipient
 * allowlist AND per-transfer lamport ceiling (static expiry is added by the
 * provisioner per grant; enrollment policies use the same field sources).
 */
export function buildSolanaEnrollmentRules(input: {
  recipients: string[];
  /** Per-transfer ceiling in lamports (decimal string). */
  maxLamports: string;
}): SolanaEnrollmentRule[] {
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    throw new Error(
      "buildSolanaEnrollmentRules: at least one recipient is required.",
    );
  }
  return [
    {
      name: "Solana transfer allowlist",
      method: "signAndSendTransaction",
      action: "ALLOW",
      conditions: [
        {
          field_source: "solana_system_program_instruction",
          field: "Transfer.to",
          operator: "in",
          value: input.recipients,
        },
        {
          field_source: "solana_system_program_instruction",
          field: "Transfer.lamports",
          operator: "lte",
          value: input.maxLamports,
        },
      ],
    },
  ];
}
