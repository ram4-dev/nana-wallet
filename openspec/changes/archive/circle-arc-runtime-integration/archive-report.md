# Archive report — circle-arc-runtime-integration

## Summary

Provider runtime de Circle Arc como fuente de wallets live, con guardas fail-closed, idempotencia de transferencias y health explícito.

## Delivered

- Provider, idempotency seam, both policy gates, receipt-waiter selection, explorer URL, additive health field and the D8 boot guard.
- Fake-Circle integration test slices covering the contract boundary.
- `.env.example` and documentation updated.

## Evidence

- Tasks ledger: 31/33 complete.
- Contract mirrors in `src/contracts/http.ts` + `apps/nana-wallet/src/lib/api-types.ts`.

## Open items and deferrals

Two intentionally deferred items (recorded, never silently checked):

1. **7.4 Manual E2E runbook execution** — requires real `CIRCLE_*` credentials, real testnet USDC and explicit human consent. The numbered steps are documented in the runbook; the checkbox stays open for the human operator.
2. **Bounded review of the candidate** — parent-owned review gate, outside this implementation session's authority.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
