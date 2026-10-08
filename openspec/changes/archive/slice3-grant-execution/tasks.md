# Tasks: Slice 3 — Grant Execution

Binding: `spec.md` (61 scenarios); AD-1..AD-11. Strict TDD: RED/GREEN/TRIANGULATE/REFACTOR.

Estimated changed lines: approximately 4,000 including SDD, implementation, and tests. 400-line budget risk: High.
Chained PRs recommended: Yes; Slice 3 depends on the provider contract in Slice 2.
Decision needed before apply: No
Chain strategy: size-exception
400-line budget risk: High

PR #3 stacks on `origin/slice2-provider-solana-devnet` until PR #2 merges. Hermes gates post-PR; run DB suites on Postgres.

## Phase 1 — Unit RED: amount and eligibility

- [x] 1.1 Test exact SOL-to-lamport conversion (`0.01` = `10000000`), unknown decimals, malformed/non-integral input, and +1 rejection.
- [x] 1.2 Test classification for active, expired, revoked, over-cap, recipient/chain/action/wallet mismatch, and `policy_not_ready`.
- [x] 1.3 Test deterministic least-privilege selection and each Q3 tiebreaker.
- [x] 1.4 Test original intent binding: ambiguous amount/recipient, later grant, or model/tool-origin request never qualifies; tool args cannot fill missing intent.
- [x] 1.5 Assert classifier takes static inputs only and cannot read DB or consumption state.

## Phase 2 — Classifier GREEN

- [x] 2.1 Implement `src/conversations/grant-coverage.ts` with integer-only conversion using provider token decimals.
- [x] 2.2 Implement static grant evaluation, stable candidate ordering, and preview origin/intent metadata.
- [x] 2.3 Refactor; rerun unit tests, typecheck, lint.

## Phase 3 — Conversation RED/GREEN

- [x] 3.1 RED service tests: covered request returns `sent` without confirmation; ineligible request uses existing preview-confirm flow and honest copy.
- [x] 3.2 Add optional grant/converter dependencies to `src/conversations/service.ts`; absence preserves current behavior; wire in `src/server.ts`.
- [x] 3.3 Reuse `runFinancialTransfer`; expose no reason code; assert HTTP contract parity (`src/contracts/http.ts` and frontend `api-types.ts`).

## Phase 4 — Atomic claim RED/GREEN

- [x] 4.1 RED DB tests: `claimConsumption` rechecks state/window and records claim/audit before broadcast; no pre-filter `consumedInWindow` call.
- [x] 4.2 RED races: distinct claims yield one consumption; revoke/expiry before claim rejects; boundary and +1 amounts are deterministic.
- [x] 4.3 RED replay: same key reuses claim without duplicate audit/consumption; broadcast and crash retry require winning `claimPendingTransfer`.
- [x] 4.4 Implement ordered candidate fallback and audited degradation; run DB integration tests against real Postgres.

## Phase 5 — Typed/voice parity and E2E

- [x] 5.1 RED parity tests: same intent/ledger yields same typed/transcript decision; degraded preview supports confirm/cancel.
- [x] 5.2 RED tool tests: model-origin `send_token` remains preview-only; no grant or direct-broadcast tool exists.
- [x] 5.3 Mark LiveKit tool previews ineligible; keep realtime tool surface unchanged.
- [x] 5.4 Add fixture E2E for covered typed and voice requests plus degraded confirmation; no live credentials.

## Phase 6 — Verification and scope

- [x] 6.1 Verify expiry-at-boundary, window/cap +1, and stable tie ordering.
- [x] 6.2 Run lint, typecheck, full DB-backed tests, and E2E; record outcomes.
- [x] 6.3 Confirm HTTP contract mirrors and diff contains no provider, LiveKit tool, or transfer-pipeline changes.

## Phase 7 — Delivery gates

- [x] 7.1 Apply is authorized under Ramiro’s standing instruction; no approval pause.
- [x] 7.2 Push the slice branch and open one stacked PR; obtain Hermes test and bounded review.
  Phase 8 branch state pushed through origin/slice3-grant-execution (07527de
  RED suite, 4fe4cf2 GREEN implementation, 936076c slice2 merge synced);
  stacked PR #3 open with Hermes tests green; bounded review pending on the
  Phase 8 increment.
- [x] 7.3 Record post-apply verification and delivery status in `state.yaml`.

## Phase 8 — Reservation release (amendment, Ramiro-approved 2026-10-05)

Binding: spec "Reserved budget release on definitive no-dispatch" (12 scenarios;
AD-6 reservations, AD-10) and "Persisted preview identity guards provider
dispatch" (2 scenarios; AD-11). Strict TDD: RED first, DB suites on real
Postgres (:55501). No implementation before RED evidence is recorded.

- [x] 8.1 RED migration test (`tests/integration/grant-claim-release.test.ts`):
  columns `released_at`/`released_reason` exist on `grant_claim_ledger`; `released`
  accepted by the `grant_audit_log` event CHECK; forced RLS + `UPDATE` grant hold
  for `recipient_app` (foreign release rejected).
- [x] 8.2 RED ledger tests (`releaseReservationInTransaction`, tx-only):
  release marks the exact row (grant + idempotency key) with reason, appends one
  `released` audit row on the SAME transaction client under the per-grant advisory
  lock; the method NEVER opens/commits/nests its own transaction (asserted);
  double release ⇒ no-op, original timestamp/reason preserved, exactly one
  audit row; replayed live claim (`replay: true`) is never released by the replay
  path itself; a RELEASED key replay fails closed — never `consumed: true`, never
  authorizing a broadcast; re-activation under the same key is impossible by
  construction (no re-activation path exists).
- [x] 8.2b RED atomic all-or-nothing settlement test (REAL DB, not mock-only):
  the settlement opens ONE `withUserTransaction` and performs attempt CAS +
  ledger release + `released` audit on the SAME client — on success all three
  effects commit TOGETHER under the grant lock; on ANY injected failure at
  EACH of the three effect boundaries (post-CAS, post-ledger, post-audit)
  NOTHING persists: verified against the real database by re-reading all rows
  after rollback (attempt still `broadcasting` with original `claim_id`, claim
  row still active/unreleased, zero `released` audit rows, window total
  unchanged — no partial cancel commit, no orphan release/audit); a losing
  concurrent `claimPendingTransfer` leaves the reservation retained; a FRESH
  previewId claims a new reservation normally.
- [x] 8.3 RED window tests covering BOTH code paths (explicit query rewrite, not
  additive): the claim's authoritative cap total AND the engine prefilter
  `consumedInWindow` sum UNRELEASED `grant_claim_ledger` rows (`released_at IS
  NULL`, claimed inside the window) — each test proves released rows stop counting
  and released budget is re-claimable in-window; retained reservations keep
  counting in both sums.
- [x] 8.4 RED service tests (settle wiring): definitive `not_dispatched` ⇒
  release with reason `not_dispatched`; the ONLY release authority is the
  successful EXACT-OWNER
  compare-and-set `broadcasting → cancelled` (id + status + `claim_id` all
  match) inside the settlement transaction — from the owned `broadcasting`
  state `runFinancialTransfer` enters with after the claim, before
  policy/recipient validation and `broadcastTransfer` (the existing
  `service.ts:985` `not_dispatched` branch is where settlement hooks in; it
  authorizes NO release outside the CAS); a lost/absent CAS, an
  absent row, an already-`cancelled` status, or ambiguous ownership NEVER
  releases standalone (retention);
  EVERY dispatched/uncertain state
  (`broadcasting` unowned, `submitted`, `uncertain`, `confirmed`, `reverted`,
  `receipt_invalid`) ⇒ NO release; concurrent-winner race ⇒ loser retains, never
  releases; pre-broadcast policy/recipient rejection ⇒ release with specific
      reason; a same-old-key retry after release NEVER broadcasts (released key fails
      closed, attempt terminal `cancelled`); a fresh-preview retry claims a fresh
      reservation and proceeds only through the full covered path.
- [x] 8.4b RED atomic settlement + ownership-token tests (final review
      blockers): `claimPendingTransfer` winner result RETURNS the persisted
      `claim_id`; settle threads it through the service; ONE atomic user-scoped
      transaction does exact-owner `broadcasting → cancelled` CAS (id + status +
      claim_id) + ledger release + `released` audit; wrong/stale claim_id ⇒ no
      cancel, no release, retained; race winner ⇒ retain; injected failure ⇒
      rollback of cancellation AND ledger/audit; preflight policy/recipient
      rejection settles from the SAME owned `broadcasting` state via the same CAS
      (no `previewed → cancelled` path); ambiguous/absent
      ownership ⇒ retain; `releasePendingTransferClaim` broadcasting→previewed
      reset REPLACED — a released attempt is never re-opened.
- [x] 8.5 Implementation AFTER RED: migration `012_grant_claim_release.sql` +
  Supabase mirror `20260901001100_grant_claim_release.sql` (additive columns,
  CHECK extension, UPDATE grant — after 8.1 RED); ledger
  `releaseReservationInTransaction` (tx-only)
  with released-key fail-closed replay (after 8.2 RED); settle cancel-and-release
  ordering (after 8.2b RED); window-sum rewrites in BOTH
  `consumption.ts` query sites — the claim total AND `consumedInWindow` (after
  8.3 RED); service settle wiring + attempt-state reads (after 8.4 RED);
  atomic settlement with claim_id CAS + `claimPendingTransfer` result change +
  `releasePendingTransferClaim` replacement (after 8.4b RED).
- [x] 8.6 GREEN/TRIANGULATE: focused DB suites on :55501, `npm test`,
  `npm run typecheck`, `npm run lint`; record RED/GREEN evidence in
  apply-progress before any commit beyond the SDD amendment.
- [x] 8.7 RED-first provider guard restoration (HIGH PR #3; AD-11): RED tests in
  `tests/unit/solana-devnet-provider.test.ts` prove missing/empty/whitespace
  `previewId` resolves `not_dispatched` BEFORE `getRecentBlockhash` and BEFORE
  `signAndSend` (spy seams assert zero calls), with no timestamp/random fallback;
  a valid `previewId` is used verbatim as the dispatch reference preserving retry
  identity. GREEN restores the fail-closed guard in
  `src/wallet/solana-devnet-provider.ts` only after RED evidence is recorded;
  budget claim/refund semantics stay out of scope (AD-10 governs release).
- [x] 8.8 E2E verification per AGENTS.md after 8.7 GREEN: focused unit + DB
  suites on :55501, `npm test`, `npm run typecheck`, `npm run lint`, and the
  covered-path E2E fixtures (`tests/e2e/grant-gate-entries.e2e.test.ts`,
  `tests/e2e/grant-gate-model-origin.e2e.test.ts`); record evidence in
  apply-progress.
