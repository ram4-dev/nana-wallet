# Archive report — wallet-profile

## Summary

Perfil de wallet: identidad más saldo personal USDC con lectura explícita y sin métricas simuladas.

## Delivered

- `GET /v1/wallets/current/balances` with owner-resolved, read-only personal balance and `private, no-store` caching.
- Identity-first screen: balance card, explicit refresh, error state that wins over cached data.
- Legacy peso/quotes/simulated-movement sections preserved but intentionally unmounted (WP-015).

## Evidence

Tasks ledger: 26/26 complete.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
