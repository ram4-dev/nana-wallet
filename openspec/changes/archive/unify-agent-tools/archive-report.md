# Archive report — unify-agent-tools

## Summary

Una sola definición de herramientas para el agente de texto y el de voz, con paridad estructural, lecturas multi-red y evals de cobertura.

## Delivered

- `createWalletAgentDefinition()` as the single source of truth; `toAiSdkTools` (text) and `toLivekitRealtimeTools` (voice) as thin adapters. `definition.ts` never imports `@livekit/*`.
- Shared preview-only `send_token` contract: the model can never invent an address or force a broadcast.
- `network` optional on read tools; the voice wallet binding resolves the chain family per call instead of per session.
- `search_contacts` renamed to `search_recipients` across voice, evals and docs.
- `confirm_transfer` / `cancel_transfer` declared as the only voice-only divergence (`VOICE_ONLY_TOOLS`).
- Parity guarded by a unit test and a mirror eval; 10 new coverage scenarios (7 previously uncovered tools + multi-network reads).
- Dead code removed: the unused `src/agent/livekit-adapter.ts`.

## Evidence

- Merged as PR #5 on `ram4-dev/nana-wallet` (`2958412`); the PR check runs (backend + frontend) were green and gated the merge.
- Ledger reconciled 2026-10-08: item 5.3 is now checked. Nuance recorded honestly — the post-merge push run on `2958412` failed its backend job on an unrelated expiry-boundary flake in `tests/integration/privy-policy-sync.test.ts` (recomputed `Date.now()` at assertion time; `expiresAt` 1791469667 vs 1791469666). Fixed in `5c84465` by giving `setup()` a single expiry source; 20 consecutive runs green.
- Suite at the reconciled HEAD, in a clean environment: 1069 passed / 0 failed (158 files), evals 27/27 at 100%.
- Evals grew from 16 to 27, all at 100%.

## Open items and deferrals

Deferred (documented, not hidden):

1. **`EVAL_REAL=1` release gate** — the real-time voice matrix and the real judge stay opt-in, documented in `docs/evals.md` as a release gate rather than a CI gate.
2. **Fixture demo-legacy network** — the offline agent evals still use the sepolia/USDT `FixtureWalletProvider` because it is the demo provider; the coverage scenarios assert tool-selection arguments, which are provider-independent. Recorded as an explicit, bounded exception.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
