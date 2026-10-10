/**
 * PEW-014: shared signer-enrollment policy values.
 *
 * READINESS SCOPE (user decision 2026-09-09): enrollment is enabled with the
 * provable per-transfer policy. The rolling aggregate is a PENDING FEATURE: no
 * aggregation resource or condition is created, the limit is NOT enforced, and
 * the gap is surfaced honestly via aggregationReady:false /
 * aggregateOvershootCaveat — never hidden. Activating it requires the parent to
 * prove wallet-identity grouping with the provider.
 *
 * The Ethereum/Arc rule builder that used to live here (`ENROLLMENT_CHAIN_ID`,
 * `ENROLLMENT_USDC_CONTRACT`, `ENROLLMENT_GAS_CEILING`, the eth_signTransaction
 * rule shape and its ABI condition types) is gone together with the EVM
 * enrollment path: Solana is the only chain this build serves, and its policy
 * rules are built by `grants/solana-enrollment-rules.ts`.
 */

export const ENROLLMENT_WINDOW_SECONDS = 3600;

/** Pending-feature reason for the rolling aggregation (NOT enforced yet; user-authorized scope). */
export const AGGREGATION_BLOCK_REASON =
  "provider per-wallet aggregation scope unproven (group_by only supports request fields; wallet identity not documented)";
