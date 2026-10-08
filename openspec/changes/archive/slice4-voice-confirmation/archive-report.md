# Archive report — slice4-voice-confirmation

## Summary

Confirmación por voz con evidencia hablada: el broadcast exige una decisión hablada tras el read-back, nunca una llamada de tool.

## Delivered

- Spoken-decision gate (`voiceDecisionGate`) with one-use authorization evidence.
- Server read-back of the exact preview (amount, saved name, network, fee) before asking for the decision.
- `confirm_transfer` / `cancel_transfer` as voice-only tools; a model tool call is never authorization.
- Text and voice share the same preview/decision service path.

## Evidence

- Merged as PR #4 (`8dfb360`).
- Tasks ledger: 23/23 complete.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
