# Archive report — slice5-notifications

## Summary

Bandeja durable de actividad de wallet y notificaciones del asistente.

## Delivered

- `wallet_notifications` table (migration 013) with user-scoped dedupe keys and table-specific RLS.
- Notification feed API + read marks, assistant outbox with a bounded dispatcher, Solana reconciliation source.
- Frontend notifications route and feed hook.

## Evidence

- Merged as PR #5 (`8ce10b9`).
- Tasks ledger: 16/16 complete.
- CI green (backend + frontend).

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
