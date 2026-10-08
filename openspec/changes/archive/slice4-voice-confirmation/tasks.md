# Tasks: Explicit voice confirmation (Slice 4)

## Review Workload Forecast

Estimated changed lines: ~380; risk: High (voice authorization + chain-aware contact migration).
Delivery: single reviewable PR per slice, as explicitly requested; no stacked child PR.
Rollback: disable Solana voice routing and keep the existing strict preview gate closed; retain EVM behavior.

## 1. Strict TDD — tests first

- [x] 1.1 Unit-test per-preview, one-use voice confirmation/cancellation evidence: final-only, exact phrases including standalone localized yes/sí, narration completion/interruption, transcript ordering (including delayed pre-readback event), replay, replacement preview, missing evidence, unknown speaker identity, and no parallel generic resolution route.
- [x] 1.2 Extend strict realtime tool tests: tool call alone cannot authorize; response remains address-free; preview includes amount/name/fee.
- [x] 1.3 Add chain-aware contacts repository/API tests for legacy EVM default, explicit Solana devnet, canonical base58, version updates and wrong-network rejection. Repository/unit tests pass; DB-backed API test is ready for Hermes' configured DB run.
- [x] 1.4 Add Solana voice service tests for decimal-to-lamport precision, configured live maximum, stale contact version, preview, cancellation, single broadcast and finality, using existing claim/finality regressions and new service/policy tests.
- [x] 1.5 Add worker/session fake E2E proving only a post-read-back final spoken confirmation enables broadcast; include cancel, stale, interim, interrupted narration, early confirmation, forged tool-call, duplicate race, and no double-routing cases.
- [x] 1.6 Add frontend contact editor/render tests for selecting network and showing Solana network; keep existing EVM contacts compatible.
- [x] 1.7 Add provider regression proving a missing preview ID cannot synthesize a timestamp-based idempotency key or dispatch.
- [x] 1.8 Add projection regression proving confirmed Solana state uses the devnet explorer URL.

## 2. Implementation — GREEN

- [x] 2.1 Implement the voice decision gate and wire final LiveKit transcripts from the authenticated single room participant into each session; fail closed on unknown/mismatched speaker or ordering uncertainty. Do not fan the same transcript into generic service handling.
- [x] 2.2 Make `send_token` use worker-controlled exact preview narration and arm the gate only after uninterrupted audio playout finishes.
- [x] 2.3 Add backward-compatible chain/network fields and migrations to versioned contact/memory records, routes, contracts, and UI.
- [x] 2.4 Implement chain-aware recipient validation and transfer policy; enforce `solana-devnet`, native SOL, exact lamports, configured live maximum, no oracle; preserve EVM behavior and keep Slice 2 grant cap separate.
- [x] 2.5 Return display-safe contact name and fee in the voice tool result; update concise English/Spanish instructions for exact preview and explicit confirmation.
- [x] 2.6 Keep provider claim/idempotency/finality path canonical and prove stale/race/uncertain outcomes.
- [x] 2.7 Use the network-aware explorer projection for terminal transfer state.

## 3. Verification

- [x] 3.1 Focused backend, frontend, and fake-worker E2E tests.
- [x] 3.2 Backend lint, typecheck, build, and full non-DB tests; frontend lint, typecheck, build and tests. DB-backed tests were attempted on the local Slice 3 test DB; see `04-verification.md` for the environment blockers.
- [x] 3.3 `npm run eval` because agent instructions change.
- [x] 3.4 Browser E2E created and rendered a Solana devnet contact; fake-worker E2E exercised preview/read-back/confirm/cancel. Real LiveKit provider credentials are not present for an external voice round-trip.
- [x] 3.5 SDD verification against scenarios and source/test evidence is recorded in `04-verification.md`.

## 4. Delivery

- [x] 4.1 Commit by phase on branch `slice4-voice-confirmation`; push the verified branch.
- [x] 4.2 Open reviewable PR #4 against `slice3-grant-execution`; do not merge.
- [x] 4.3 Record CI and Hermes test handoff, worktree/session receipt, and final verification. Exact-head Hermes summary is recorded in `04-verification.md`; GitHub Actions run `37368402063` attempt 3 is still queued because hosted runners are unavailable.
