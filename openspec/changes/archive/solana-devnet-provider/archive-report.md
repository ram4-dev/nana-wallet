# Archive report — solana-devnet-provider

## Summary

Provider Solana devnet como fuente de wallet live, con límites en lamports y dispatch firmado.

## Delivered

- `SolanaDevnetProvider` with devnet-only boot guard (fail-closed on mismatched network/token).
- Solana user wallet resolution with exactly-one-ready-binding enforcement and provider read-back of id + address.
- Grant ceilings in lamports and the grant-gate execution path for `solana-devnet` transfers.

## Evidence

- Merged as PR #2 (`3be5d7a`).
- Tasks ledger: 30/33 complete.

## Open items and deferrals

Three intentionally deferred items (manual / environment-dependent, never silently checked):

1. **3.4 Env-gated devnet smoke** — off by default; requires an operator to enable it.
2. **3.5 Manual devnet signature in explorer** — human verification step.
3. **5.5 Hermes configured retest of PR head `cbb699c`** — external harness, pending.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
