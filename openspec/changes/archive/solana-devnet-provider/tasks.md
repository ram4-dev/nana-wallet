# Tasks: Solana Devnet Provider (Slice 2)

## Review Workload Forecast

Estimated changed lines: >400; risk: High; chained PRs: No.
Delivery: `exception-ok`, one PR to `main` as explicitly requested (size exception).
Chain strategy: `size-exception`; decision needed: No. Rebase onto `origin/main`
`c4d56c3`; later slices branch from merged `main`.

WU1 RED tests; WU2 provider/resolver/wiring; WU3 policy/binding/migrations/UI;
WU4 verification and receipt. Proof is focused GREEN plus full checks; rollback
disables the selector and leaves fail-closed behavior.

## 1. Tests first (Strict TDD — RED)

- [x] 1.1 Provider contract with injected `SolanaRpc` and signer doubles.
- [x] 1.2 Non-devnet calls fail before RPC.
- [x] 1.3 Invalid base58, zero, and self recipients fail.
- [x] 1.4 Outcomes, finality, abort/deadline, stable reference, one dispatch,
  unsigned serialization, no send/keypair.
- [x] 1.5 Runtime selection, boot guards, and `walletReads` route.
- [x] 1.6 Composed policy tests: union, expiry, exact readback, sibling-safe
  revoke, wallet lock, Solana ledger-chain scoping and fail-closed ambiguity.
- [x] 1.7 Per-user resolver tests: ready row, exact id/address, failures; EVM same.
- [x] 1.8 Canonical signer tests: exact persisted id; null/conflict/duplicate
  fail closed; preserve unrelated signers.
- [x] 1.9 Chain-routing tests cover wallet HTTP, conversation and LiveKit.
- [x] 1.10 Enrollment RED: persist snapshot, delegated consent, exact-one-new-id;
  verified-id and post-commit retry; zero/multiple conflict; signed attach/readback
  before persistence; 0.01 SOL unit/cap, response, and UI; preserve snapshot.
- [x] 1.11 Policy DSL RED: exact Solana field sources/transfer fields, expiry
  `lt`, instruction default-deny and ALT rejection.

## 2. Implementation (GREEN)

- [x] 2.1 Pin `@solana/web3.js@1.98.4`.
- [x] 2.2 Implement provider reads, preview, Privy dispatch, outcomes, finality.
- [x] 2.3 Implement composed-policy adapter for ledger chain `solana` on the
  devnet provider, with exact Privy DSL, 10,000,000-lamport hard cap, wallet
  lock, readback, unit validation, and SOL UI/API wiring.
- [x] 2.4 Register devnet explorer.
- [x] 2.5 Wire selector, boot guard, and wallet reads without changing branches.
- [x] 2.6 Add authenticated Solana sync (one valid wallet → ready row, no signer
  write); runtime-check Privy discovery and preserve Ethereum behavior.
- [x] 2.7 Migrations 010/011: add canonical signer, durable enrollment
  snapshot, and nullable `signer_grants.per_transfer_lamports`; preserve EVM
  `per_transfer_atomic6`. Backfill signer only from unique verified evidence;
  prepare/complete uses durable snapshot-diff and exact readback.
- [x] 2.8 Propagate devnet network intent separately from ledger chain-family
  `solana` through `WalletForUser`, deferred providers, wallet API, conversation,
  and LiveKit session wiring.
- [x] 2.9 Research gate: Solana policy fields and limits verified in dated D-4
  primary research and current Privy docs; enforce exact DSL in 1.11/2.3.

## 3. Verification

- [x] 3.1 Focused tests for policy DSL, enrollment, migration and drift.
- [x] 3.2 Lint, typecheck, full tests with Postgres.
- [x] 3.3 `npm run build`.
- [ ] 3.4 Env-gated devnet smoke, off by default: remote signer id and policy
  readback must match persisted binding before any transfer.
- [ ] 3.5 Manual devnet signature in explorer (human).

## 4. Delivery

- [x] 4.1 Incremental conventional commits (WU1→WU4) and push.
- [x] 4.2 Draft PR #2 targeting `main`; no merge.
- [x] 4.3 Update Herdr receipt and state.

## Deferred human validation

- 3.4 Live Privy readback was unavailable (environment-gated).
- 3.5 A human-approved devnet signature is pending; none was signed/submitted.

## Retry review remediation

- [x] 5.1 Add RED coverage for missing, empty, and whitespace-only preview IDs; prove no blockhash RPC or signing occurs.
- [x] 5.2 Remove the timestamp-generated reference fallback and return `not_dispatched` before any signing path.
- [x] 5.3 Run exact-branch focused/static/build and relevant integration/E2E checks; record results.
- [x] 5.4 Push the fix to PR #2; backend and frontend CI passed at `cbb699c`.
- [ ] 5.5 Hermes configured retest of exact PR head `cbb699c` remains pending.
