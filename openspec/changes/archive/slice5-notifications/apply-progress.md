# Apply Progress — slice5-notifications

Strict TDD Mode: active (state.yaml `strict_tdd: true`, runner Vitest).
This artifact records the per-task RED → GREEN → TRIANGULATE → REFACTOR
evidence recovered from the phase history (`0dd76f0` RED contracts →
`5af13a5`/`54f5a5b` backend → `e0d64f9`/`0dd8192` outbox/dispatcher →
`e79c34a` frontend) plus the review-fix rounds preserved in the branch log.

## TDD Cycle Evidence

| Task | Test File | Layer | Safety Net | RED | GREEN | TRIANGULATE | REFACTOR |
| ------ | ----------- | ------- | ------------ | ----- | ------- | ------------- | ---------- |
| 1.1 | `tests/unit/notifications/webhook-signature.test.ts`, `tests/unit/notifications/identity-resolution.test.ts` | Unit | N/A (new) | ✅ Written (6+4 cases failing on missing modules) | ✅ 6/6 + 4/4 | ✅ boundaries ±300s exact, wrong secret, forged key, mismatched account binding | ✅ verifier split into pure `webhook-verification.ts`; fixture uses base64-decoded `whsec_` key bytes |
| 1.2 | `tests/unit/notifications/assistant-state-mapping.test.ts`, `tests/unit/notifications/ingestion.test.ts`, `tests/integration/notifications-schema.test.ts` | Unit + Integration | ✅ 12-migration baseline applied | ✅ 5 unit + 7 DB cases (missing relations) | ✅ 5/5, 4/4, 8/8 | ✅ uncertain unresolved, `not_dispatched` excluded, concurrent race `23505` with exactly-one winner, safe projection, outbox replay | ✅ mapping guard fail-closed for non-notification-worthy states; repository `ON CONFLICT DO NOTHING` primitive shared by all paths |
| 1.3 | `tests/unit/notifications/reconciliation.test.ts`, `tests/integration/notifications-schema.test.ts` | Unit + Integration | ✅ 12-migration baseline applied | ✅ 4 unit + lease/RLS DB cases | ✅ 4/4 + RLS cases green | ✅ first/last-signature retry, stable order, capped backoff, system-context no-read/no-write on user rows | ✅ index-based in-place retry (no re-fetch, no reprocess) |
| 1.4 | `apps/nana-wallet/src/features/notifications/useNotificationsFeed.test.tsx` | Unit (jsdom) | N/A (new) | ✅ Written (missing hook) | ✅ 5/5 after typed api spy | ✅ empty/unread/mark-read, 30s visible poll boundary (29_999/1), focus, hidden no-poll | ✅ typed api mock cast at one boundary |
| 2.1 | `tests/integration/notifications-schema.test.ts` (9 cases) | Integration (PostgreSQL) | ✅ migrations 001–012 baseline | ✅ relations/function absent | ✅ 9/9 on fresh DB (v5+) | ✅ concurrent race, cross-user RLS, system-context boundaries, lease exclusion, system wallet lookup policy `TO recipient_app` | ✅ lease function rewritten with `INSERT … AS existing` alias (ambiguous `lease_token` fix); applied and re-verified on fresh DB |
| 2.2 | `tests/integration/notifications-ingestion.test.ts` + unit suites | Integration + Unit | ✅ schema suite green | ✅ replay/dedupe cases RED | ✅ 3/3 + 19/19 unit | ✅ winner-only fan-out, per-user dedupe scoping, publish-failure isolation | ✅ `insertNotificationRow` shared primitive (webhook + reconciler + dispatcher) |
| 2.3 | `tests/integration/notifications-webhook.test.ts`, `-deep.test.ts`, `-receipt.test.ts` | Integration (HTTP + PostgreSQL) | ✅ server builds in prior suites | ✅ 404 route, tampered-bytes cases | ✅ 3/3, 5/5, 3/3 | ✅ raw-byte tampering 401 zero-side-effects, duplicate single receipt, receipt-only (no notification from generic payload), owner feed + mark-read | ✅ receipt-only contract after research gap (privy embedded events unverified); raw-buffer content-type parser |
| 2.4 | `tests/unit/notifications/reconciliation.test.ts`, `tests/unit/notifications/solana-reconciliation-source.test.ts`, `tests/integration/notifications-reconciliation.test.ts` | Unit + Integration | ✅ schema suite green | ✅ source contract absent | ✅ 4/4, 9/9, 10/10 | ✅ >pageSize lossless multi-page catch-up, exact-multiple empty-page completion, fresh-signature discovery, lease release/concurrent exclusion, per-mint SPL deltas, null-details no-skip, backoff scheduling | ✅ forward catch-up model (`scan_high_watermark`/`scan_cursor`), oldest-first processing, clamped `MAX_PAGE_SIZE` |
| 2.5 | `tests/integration/notifications-outbox.test.ts` | Integration (PostgreSQL, real repository) | ✅ claim/preview suites green | ✅ direct-row insert only (table shape) | ✅ 5/5 | ✅ all five states, uncertain path, zero-row staleness, cancelled no-event, trigger-forced rollback | ✅ guard on `RETURNING id` before outbox write; finally-cleanup for triggers |
| 2.6 | `tests/unit/notifications/outbox-dispatcher.test.ts`, `tests/integration/notifications-outbox-dispatcher.test.ts`, `tests/unit/notifications/outbox-worker.test.ts`, `tests/unit/notifications/livekit-invalidation-publisher.test.ts` | Unit + Integration | ✅ outbox rows from 2.5 | ✅ missing dispatcher module; crash/replay cases | ✅ 2/2 unit, 2/2 DB, worker/publisher suites green | ✅ same-state crash→recovery→replay, atomic insert+`processed_at` (winner AND dedupe loser), post-commit winner-only fan-out with swallowed failure, orphan attempt fail-pending, userId-scoped dispatch | ✅ shared core `dispatchPendingAssistantEvents` + DB adapter closures; `revision` coerced from BIGINT string |
| 3.1–3.3 | `apps/nana-wallet/src/features/notifications/*`, `scripts/run-notifications-browser-e2e.mjs` | Unit (jsdom) + Browser E2E | ✅ existing app suites green | ✅ hook RED at 1.4 | ✅ frontend lint/typecheck/build pass, 20 files / 103 tests | ✅ focus/poll/revision refresh, E2E shows outbox + reconciled events, `read_at` verified in PostgreSQL | ✅ revision callback wired in `routes/index.tsx` (delivery by owner) |

### Test Summary

- **Total tests written (notification scopes)**: 77 backend (unit + integration) + 103 frontend
- **Total tests passing**: 77/77 backend on isolated DB, 103/103 frontend
- **Layers used**: Unit (7 files), Integration PostgreSQL (6 files), HTTP integration (3 files), Browser E2E (1)
- **Approval tests (refactoring)**: schema/RLS suite re-runs after each migration function fix (lease alias, identity-lookup policy)
- **Pure functions created**: `verifyProviderWebhook`, `assistantStateToNotification`, `buildAssistantNotification`, `canonicalDedupeKey`, `nextCursorPage`, `computeReconciliationBackoff`, `dispatchPendingAssistantEvents`

## Phase Commit Map

| Phase | Commit | Content |
| --- | --- | --- |
| RED contracts | `0dd76f0` | 11 test files, tasks 1.1–1.4 |
| Backend 2.1–2.4 | `5af13a5` + `54f5a5b` | migration 013 (+ Supabase mirror), ingestion, webhook, feed, reconciliation |
| Backend 2.5 | `e0d64f9` | atomic assistant outbox writes |
| Backend 2.6 | `0dd8192` | dispatcher + worker + LiveKit publisher |
| Frontend 3.x | `e79c34a` | typed API, inbox, refresh wiring |

## Deviations from design

1. **Webhook receipt-only** (documented in spec + 02-research.md): no verified
   Privy embedded-wallet event contract, so the ingress persists only a scoped
   dedupe receipt; reconciliation is the complete `wallet_event` path.
2. **Forward catch-up cursors**: Solana `getSignaturesForAddress` walks
   backward, so `cursor_value` is a forward high watermark with
   `scan_high_watermark`/`scan_cursor` drain state (additive columns in 013 +
   Supabase mirror) instead of a naive `before` cursor that would miss new
   events.
3. **Fan-out is optional best-effort**: LiveKit `conversation_state_changed`
   publishes only post-commit for insert winners when configured; durable-feed
   polling/focus is the correctness path (polling fallback accepted and tested).

## Remaining tasks

- `- [ ] 4.3 Commit phases 2/3/4, push branch, open one Slice 5 PR, and hand
  exact SHA to Hermes for testing.` (delivery in progress by owner)
