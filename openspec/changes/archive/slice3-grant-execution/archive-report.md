# Archive report — slice3-grant-execution

## Summary

Ejecución de transferencias cubiertas por un grant activo sin segunda confirmación, degradando fail-closed a preview + confirmación explícita.

## Delivered

- Server-side coverage decision at the conversation execution boundary (model and client cannot influence it).
- Deterministic least-privilege candidate selection with atomic ledger claims and next-candidate fallback.
- Reserved-budget release on definitive no-dispatch via exact-owner CAS settlement (AD-10), with the `released` audit row.
- Fail-closed units conversion (provider decimals; Solana lamports with a 0.01 SOL ceiling).
- Zero contract delta; mirrored in both contract files.

## Evidence

- Merged as PR #3 (`17ea917`).
- Tasks ledger: 35/35 complete.
- Strict TDD with observed RED/GREEN evidence recorded in the change's apply/verify artifacts.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
