# Archive report — nani-grant-creation

## Summary

Nani crea transferencias delegadas de Solana por conversación (voz y texto); la UI dejó de ofrecerlas.

## Delivered

- `GrantCreator` port + `composeGrantCreator`: ready Solana wallet → ledger row + audit → Privy policy sync.
- Shared `createGrantCreator` factory wired into both the text agent and the LiveKit worker.
- Strict `create_grant` tool: `{recipientId, recipientVersion, maxPerTransferSol, maxCumulativeSol}`; chain, window, expiry and addresses are server-side.
- Honest narration: a provider sync failure keeps the grant created but reports `policyReady: false`.

## Evidence

- Merged as PR #12 (`6de4b96`).
- Tests: `tests/unit/agent-grant-tool.test.ts`, `tests/integration/nani-grant-creation.test.ts`.

## Open items and deferrals

Deferred: voice grant creation is not gated by the spoken-decision gate, because creating a permission is not a fund movement. Recorded as a deliberate scope boundary.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
