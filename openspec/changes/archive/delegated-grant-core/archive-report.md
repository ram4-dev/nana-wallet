# Archive report — delegated-grant-core

## Summary

Núcleo de delegación de transferencias: grants con ledger append-only, RLS por usuario y sincronización de política Privy fail-closed.

## Delivered

- Delegated grant schema with RLS and append-only audit log.
- Pure grant-evaluation engine with a chain validator plug-in.
- Ledger consumption accounting with DB-level idempotency.
- Privy policy sync driven by the grants ledger, fail-closed.
- Authenticated HTTP lifecycle endpoints plus frontend contract.

## Evidence

- Merged as PR #1 (`c4d56c3`).
- Tasks ledger: 28/28 complete.
- Superseded in scope by `slice3-grant-execution` (execution path).

## Open items and deferrals

None in this change; execution moved to `slice3-grant-execution`.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
