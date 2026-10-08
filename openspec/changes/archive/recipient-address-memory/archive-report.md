# Archive report — recipient-address-memory

## Summary

Memoria de destinatarios con embeddings: búsqueda semántica, versionado y confirmación explícita antes de persistir.

## Delivered

- Recipient memory service with pgvector search, score threshold/floor/margin ranking.
- Versioned recipients (`recipient_versions`) with explicit user confirmation for writes.
- Retrieval never exposes addresses to the model; addresses resolve server-side at transfer time.

## Evidence

Tasks ledger: 16/16 complete.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
