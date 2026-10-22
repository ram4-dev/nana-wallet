# Handoff: broadcast uncertainty defects

Updated: 2026-10-22

## Current status

Continue in `/Users/ramiro/Desktop/projects/colloseum.fix-broadcast-uncertain-defects`, branch `fix/broadcast-uncertain-defects`, based on `main` at `76473ea`. The branch is clean apart from an untracked `.cache` directory. Do not remove it without checking who owns it.

The Pi session is idle after Nan/GLM monthly quota exhaustion. Ramiro then directed Codex to continue this task in the current session; the unavailable independent Pi review is explicitly waived for this bounded D-B/D-C scope and is not claimed as completed.

Resume attempt on 2026-10-22: Herdr resumed the same Pi session under `nan/glm5.3-flash` at high reasoning; the first prompt returned `402 monthly_cap_reached` (reset 2026-11-01 00:00 UTC). After Ramiro explicitly directed Codex to continue, implementation proceeded on this branch. See `90-verification.md` for exact checks and full-suite limits.

## State of the three work branches

| Branch | Current result |
| --- | --- |
| `test/self-provisioning-suites` | Complete through `4854c4d`, pushed to its origin branch. Fresh database full suite: 5 expected failures from class B, parked `realtime-agent-session`, and PEW-013; 1848 passed. |
| `fix/class-b-realtime-baselines` | Complete through `0c06cd2`, pushed. Fresh database full suite at `--maxWorkers=2`: 8 expected failures from the class-A sibling work and parked `realtime-agent-session`; 1828 passed. Its three owned tests passed in the full suite. |
| `fix/broadcast-uncertain-defects` | D-A, D-D, and D-E are committed and pushed through `ce84043`; D-B is implemented and locally verified in commit `1e81163` (not pushed). D-C remains safely open. Latest full suite on this checkout failed as recorded in `odd/tasks/broadcast-uncertain-defects.md`; DB could not be started because port 5432 was occupied. |

The two sibling worktrees and this branch are separate. Keep their current work intact. The main checkout has unrelated untracked work (`.agent-workflow/tasks/privy-sdk-migration/` and `compose.privy-local.ports.yaml`); do not alter it.

## Completed on this branch

- **D-A, `df7e88c`:** `PayloadSignerError` is definitive because signer authorization happens before the single RPC POST and the path has no retry. The provider now maps signer and policy failures to truthful `not_dispatched` causes; generic transport errors remain `uncertain`. Targeted tests, typecheck, and lint passed.
- **D-D, `236c9aa`:** added a non-throwing signer capability probe returning only `{ capable, code }`; health exposes it fail-closed. Probe and health tests, typecheck, and lint passed.
- **D-E, `e98b548`:** WDK provider validates the hash shape and explorer link for the network it serves. Solana devnet uses a base58 signature and Solana explorer URL; Sepolia keeps the EVM hash and Etherscan URL. Contract and wiring tests, typecheck, and lint passed. Other EVM explorer networks remain unsupported by evidence and were left unchanged.
- **Receipts, `255fceb` and `ce84043`:** captured the local CI reproduction and D-D/D-E evidence in `odd/tasks/broadcast-uncertain-defects.md`.

## Next work

1. **D-B:** implemented and committed as `1e81163`. Provider request/preparation failures and typed `PrivyWalletRuntimeError` resolve to `not_dispatched`; generic resolver/provider/dispatch failures remain `uncertain`. Focused tests, typecheck, lint, build, and fake E2E pass.
2. **D-C:** behavior intentionally unchanged; missing reference lookup and bounded history are not proof of absence. Keep uncertain/no retry and leave D-C open pending authoritative production correlation.
3. Full suite was attempted and failed; details and environmental blockers are in `odd/tasks/broadcast-uncertain-defects.md` and `.agent-workflow/tasks/broadcast-uncertain-defects/90-verification.md`.

## Constraints from Ramiro

- Keep money movement fail-closed. Never turn a post-submission ambiguity into a definitive failure.
- No live payment or live RPC in tests; use fixtures or fake transport.
- Commit each verified defect promptly. Work only on its named feature branch, never on `main`.
- `.env.example:91` reframing and restoring the paused remote Supabase project are Rama's decisions; neither blocks this work.
- The user allowed pushes to work branches, never `main`; do not open PRs or perform destructive actions without a new request.

## Useful files

- `odd/tasks/broadcast-uncertain-defects.md` — authoritative scope, safety constraints, completed evidence, and task checklist.
- `.agent-workflow/tasks/broadcast-uncertain-defects/` — resumed RPI packet, current-state evidence, proposed outline, and blocked independent-review gate.
- `openspec/changes/broadcast-uncertainty-d-b-d-c/` — SDD proposal, spec, design, and tasks for the remaining D-B/D-C scope.
- `src/wallet/solana-devnet-provider.ts` — provider dispatch and reconciliation boundaries.
- `src/conversations/service.ts` — conversation-level broadcast error handling.
- `src/wallet/wdk-provider.ts` — D-E chain-specific hash and explorer behavior.
- `src/wallet/signer/probe.ts` and `src/api/health.ts` — D-D capability probe and health response.
