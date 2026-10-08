# Archive report — agent-multi-network-balance

## Summary

`get_balance` sin argumentos devuelve un JSON con los balances de todas las redes soportadas, y Nani responde solo lo que se le preguntó.

## Delivered

- Multi-network read driven by the per-user `listNetworks` union (arc-testnet + solana-devnet).
- Per-network failure degrades to an `{error}` entry instead of rejecting the whole read.
- Explicit `network` keeps the single-balance shape (backward compatible).
- Text and realtime instructions never ask which wallet or network to use.

## Evidence

- Merged PRs #7 (`bce7f3d`) and #8 (`34fbb3a`).
- New tests: `tests/unit/agent-balance-multi-network.test.ts` plus updated realtime tool tests.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
