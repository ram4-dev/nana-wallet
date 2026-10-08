# Proposal: Solana Devnet Provider (Slice 2)

## Intent and Outcome

Add a devnet-only `SolanaDevnetProvider` implementing the existing
`WalletProvider` seam (`src/wallet/provider.ts`) so Nana Wallet can read a
balance and execute a test transfer on **Solana devnet** through the same
normalized preview → confirmation → broadcast → finality pipeline used by the
other providers. `uncertain` broadcast outcomes are surfaced honestly and
reconciled by the stable Privy reference id and on-chain signature lookup —
never re-broadcast, never fabricated as success.

This implements Slice 2 of the approved plan
(`.agent-workflow/tasks/financial-assistant-development/01-propuesta-plan.md:148`).
Gate G4 (provider Solana devnet support, dated primary sources) is satisfied
by `.agent-workflow/tasks/financial-assistant-development/06-research-d4-privy-solana.md`
(verified 2026-10-03) and the client-library evidence dated 2026-10-04 in the
exploration artifact.

## User Decisions Bound Into This Change

| Decision | Resolution |
| --- | --- |
| Provider custody | Privy embedded wallets sign server-side (Slice 1 ADR-1 hybrid). No local keypairs, no secrets in repo. |
| Network scope | **Solana devnet only.** No mainnet code path; devnet is the registry network (plan F2 note: all fee/finality conclusions are devnet-only evidence). |
| Client library | `@solana/web3.js@1.98.4` (ADR-1 revised 2026-10-04: Kit 8/6/5 registry-incompatible with Circle/Privy peers and repo TS 6; web3.js resolves cleanly and is maintained). Initial Kit recommendation in 01-exploration.md Q5 is **superseded** by ADR-1. |
| Other providers | Strictly additive wiring; fixture remains default; `circle-arc`/`live` behavior unchanged. |

## Scope

### In Scope

- New `src/wallet/solana-devnet-provider.ts` implementing `WalletProvider`.
- Injectable dependencies for determinism: Solana RPC read client + Privy
  `signAndSend` client doubles; unit tests never touch devnet or Privy.
- **Per-user Solana wallet discovery** (`createSolanaWalletForUser`):
  resolve each user's single embedded Privy Solana wallet via the existing
  `walletForUser(userId, chain)` seam — additive `listWalletsForChain` typed chain
  filter over the authenticated `user_id` list, DB `user_wallets` ready-only
  gate (`state='ready'`, exactly one; stale non-ready rows tolerated),
  fail-closed on missing/multiple/wrong-chain/id-or-address mismatch; no
  global sender address.
- **Authenticated chain-aware Solana wallet sync** (row producer): extend
  wallet sync so the ready `chain_family='solana'` row required by the
  resolver can be created by the product at runtime — list only the
  authenticated Privy user's wallets, accept exactly one `chain_type:
  'solana'` wallet with a valid base58 address, and upsert a ready
  `chain_family='solana'` row without touching its `provider_signer_id`;
  zero/multiple/unavailable fail closed; existing Ethereum sync and `arc`
  rows unchanged. Without this, no runtime path could ever produce the
  ready Solana row the resolver gates on.
- **Canonical Privy signer binding**: migration 010 adds
  `user_wallets.provider_signer_id` and the durable pending-grant signer
  snapshot. Backfill historical signer ids only where one distinct id was
  previously readback-verified. Persist the canonical id after exact Privy
  readback; resolve the provider wallet/signer pair before policy mutation.
  Ambiguity fails closed.
- **Explicit chain intent**: wallet HTTP, conversation, and LiveKit financial
  paths pass network-derived EVM/Solana intent through `WalletForUser`; unknown
  or absent chain hints never fall through to another family.
- **Minimal consent and routing UX**: update the existing Privy signer
  enrollment component to request chain-aware Solana delegation, and make only
  the agent instruction changes required to select the explicit devnet network.
  Broader UI redesign and agent behavior remain out of scope.
- **Solana grant policy provisioner** (completing Slice 1's deliberate
  fail-closed stub): a `GrantPolicyProvisioner` adapter for Privy Solana
  policies (create on grant activation, revoke on revocation, denomination
  SOL lamports for `solana-devnet` grants with a fixed 0.01 SOL
  (10,000,000 lamports) per-transfer ceiling and no oracle conversion), wired in `src/server.ts` in place
  of `createUnavailableGrantPolicyProvisioner` for the Solana path so grants
  can reach `policyReady: true` and Slice 3 can execute them. Sync/revoke
  lifecycle, audit rows, and fail-closed semantics remain those of
  `PrivyPolicySyncService` — this slice only supplies the real provisioner.
- Devnet registration: network entry (`solana-devnet`, `kind: 'testnet'`),
  token list pinned to native SOL (decimals 9) — no conditional SPL mints,
  no fabricated mints — and explorer URL in `EXPLORER_URLS`
  (`src/wallet/provider.ts`).
- Wiring: `WDK_TOOLS_SOURCE=solana-devnet` selector in
  `src/runtime/dependencies.ts` with a fail-closed boot guard
  (mismatched `WDK_NETWORK`/`WDK_TOKEN` throws at boot).
- Strict outcome mapping: broadcast → `submitted`/`uncertain`/
  `not_dispatched`; finality → `confirmed`/`reverted`/`receipt_invalid`
  from `getSignatureStatuses` confirmation statuses.
- Uncertain-broadcast reconciliation: signature lookup without re-broadcast.
- Unit + contract tests (Strict TDD: RED first) and an env-gated devnet
  smoke integration test, skipped by default.

### Out of Scope

- Mainnet or testnet-beta support (any network other than devnet is refused).
- Out-of-chain grant enforcement beyond the provisioner: the ledger engine
  (`grants/engine.ts`), consumption, and HTTP lifecycle are Slice 1 code and
  stay untouched.
- Broader frontend redesign or agent behavior changes. LiveKit wallet
  resolution changes are in scope only to pass the explicit chain hint.
- Wallet history analytics (provider returns an empty ledger, documented).
- Slices 3-7.

## Rollback Plan

Wallet behavior risk is low: the provider is inert unless
`WDK_TOOLS_SOURCE=solana-devnet` is set. Rollback disables the selector and
reverts the wiring; the additive nullable signer column and verified values may
remain. No existing contract is removed or rewritten.
