# Slice 4 verification

Date: 2026-10-05. Worktree: `colloseum.slice4-voice-confirmation`.

## SDD scenario trace

| Requirement | Evidence |
|---|---|
| Exact, final, authenticated, post-readback decision; one use; no generic route | `src/livekit/voice-decision-gate.ts`, `src/livekit/voice-decision-transcripts.ts`, `src/livekit/worker.ts`; `tests/unit/livekit/voice-decision-gate.test.ts`, `tests/unit/livekit/voice-decision-transcripts.test.ts`, `tests/integration/livekit-voice-confirmation-fake.e2e.test.ts` |
| Model call alone, interim, early, interrupted, delayed, stale, or replayed evidence fails closed | Same gate tests and fake E2E; delay test was added RED and turned GREEN after comparing LiveKit event `createdAt` to narration completion time |
| Cancellation requires post-readback voice and never broadcasts | `tests/integration/livekit-voice-confirmation-fake.e2e.test.ts`, `tests/unit/realtime-tools.test.ts` |
| Saved contacts are chain-scoped and versioned, with EVM compatibility | `src/memory/address.ts`, both contact repositories, API contracts and migrations; `tests/unit/contacts-repository.test.ts`, `tests/unit/memory/address.test.ts`, `tests/integration/api-contacts.test.ts`, browser check below |
| Read-back includes exact amount, saved name, network, fee and no address | `src/livekit/realtime-tools/create-realtime-tools.ts`; realtime tool tests and fake E2E |
| Solana cap uses exact configured SOL maximum, no oracle, separate from grant cap | `src/agent/definition.ts`, `src/agent/wallet-agent.ts`, `src/conversations/service.ts`; policy and service tests |
| Provider claim/idempotency/finality and missing-preview fail-closed behavior | Existing conversation claim/finality tests plus `tests/unit/solana-devnet-provider.test.ts` |
| Devnet explorer is used for confirmed state | `src/conversations/state-projection.ts`, `tests/unit/state-projection.test.ts` |

## Checks

- Backend: lint, typecheck, and build passed.
- Backend unit/simulation/e2e plus Slice 4 fake voice integration: **707 passed, 8 skipped; 93 files passed, 4 skipped**.
- Frontend: lint, typecheck, build, and full Vitest suite passed (**94 tests**).
- `npm run eval`: **16 evals, 100%**. Real-mode Realtime/STT/TTS evaluations are skipped when `EVAL_REAL` is off.
- `npm run test:e2e:livekit-fake`: **3 passed**.
- Browser E2E using the running Vite app and MSW: created a Solana devnet contact through the form and verified the contact and network label render.
- Strict TDD evidence: the gate unit test for a delayed pre-readback transcript failed before the `createdAt` ordering guard and passed after it. The focused voice/realtime suite then passed (**48 tests**).
- Migration `012_chain_scoped_recipients.sql` applied to the isolated `colloseum-slice3-test-db`.

## Environment limits

- DB-backed API/full-suite validation did not complete cleanly. The preconfigured DB URL failed because its configured `ramiro` role does not exist. Retrying against the isolated Slice 3 test DB applied migration 012, but the broad DB suite then reported `api-conversations` and `users-db` sentinel failures and a 60-second timeout in `contacts-cross-user`; the focused `api-contacts` integration also stalled and was stopped. No claims are made that these failures are caused by this slice. Hermes should run the PR's DB-backed tests in its configured environment.
- No provider-backed LiveKit credentials were provisioned into this local test process; real voice transport was not exercised. The deterministic fake-worker flow and browser contact flow passed.

## Delivery gate update (2026-10-05)

- Hermes monitor report at 2026-10-05 21:15 UTC identifies current Slice 4 head `d874f3b`: 695 tests passed, 1 skipped across 88 files; lint and typecheck passed. The first run had one timeout; the monitor reports the rerun passed. This is a relayed summary; individual raw logs were not attached.
- GitHub Actions run `37368402063` attempt 3 targets exact head `d874f3bb900e3b50e22d5dfaf3319867942631c6`. At 21:40 UTC, backend and frontend jobs remained queued without runner assignment. The GitHub Status incident is tracked at https://www.githubstatus.com/incidents/3q1yb5m7ltvb.
- The test handoff, current worktree/session receipt, and final available verification evidence are recorded. No live provider credentials or real transaction were used.

## Review result

The implemented behavior maps to each Slice 4 acceptance scenario above. The decision gate is bound to the current persisted preview, refuses transcripts whose server event time is not strictly after completed narration, and is consumed once. Address resolution remains ID/version based; chain mismatch, amount policy failure, missing preview ID, and unsupported state fail closed. No unresolved implementation blocker was found in source-to-SDD verification. PR CI and Hermes DB-backed testing remain delivery checks.
