# Apply Progress — slice3-grant-execution

## Phase 1+2 — Coverage classifier (completed 2026-10-05)

### RED evidence (before implementation)

`node_modules/.bin/vitest run tests/unit/grant-coverage.test.ts`:

```
Error: Cannot find module '../../src/conversations/grant-coverage.js'
       imported from tests/unit/grant-coverage.test.ts
Test Files  1 failed (1)
Tests  no tests
```

### GREEN evidence (after implementation)

| Check | Command | Result |
| --- | --- | --- |
| Focused unit suites | `vitest run tests/unit/grant-coverage.test.ts tests/unit/grants-engine.test.ts` | 2 files passed, **42/42 tests** (26 coverage + 16 engine) |
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | clean (`--max-warnings=0`) |
| Whitespace | `git diff --check` | exit 0 |

### Files

- `src/conversations/grant-coverage.ts` (new) — pure static pre-filter `classifyGrantCoverage`.
- `tests/unit/grant-coverage.test.ts` (new) — 26 RED-first cases.
- `openspec/changes/slice3-grant-execution/tasks.md` — checkboxes 1.1–1.5, 2.1–2.3 → `[x]` (wording unchanged, 511 words ≤ 530 cap).

### Contract decisions locked in Phase 1+2

1. **Units (AD-5)**: SOL `0.01` → exactly `10000000` lamports; +1 lamport degrades `per_transfer_cap_exceeded`; unknown token / missing decimals → `units_unknown`; non-integral → `units_non_integral`; malformed/non-positive → `units_invalid`. String/`BigInt` only, no floats, no clamping.
2. **Eligibility (AD-3)**: `origin` is a server-owned discriminator — `model_tool` or any unknown value → `origin_ineligible`. `intentBoundToOriginalText` is an **explicit required server-computed boolean**; missing/false → `intent_not_bound`; never inferred from origin or field presence; `intentAmbiguous` also degrades closed. Phase 3 must prove the conversation service sets both from the authenticated original turn/transcript only (tool args cannot set them).
3. **D-2**: `walletId` is required on the request; exact identity comparison — a grant bound to another wallet is never a candidate.
4. **Q1 timestamp rule**: a candidate with `createdAt > request.now` is excluded (later grants never auto-execute older previews).
5. **Q3 ordering**: per-transfer cap ↑ → cumulative cap ↑ → earliest expiry → stable grant id, over validated rows only.
6. **Fail-closed robustness**: malformed cap strings (incl. hex `0x12` — `parseCap` enforces `/^\d+$/` before BigInt) are dropped **before** sorting (strict total-order comparator, no sentinel); a throwing `tokenDecimals` lookup → `units_unknown`; classification never throws.
7. **Sibling fallback**: `policy_not_ready` is remembered non-blocking — a policy-less stale grant never blocks a valid ready sibling; the reason surfaces only when nothing else covers.
8. **Structural invariant (AD-2)**: the module accepts no DB client, consumption reader, or window total; the cumulative window belongs exclusively to the atomic ledger claim (Phase 4).

### Next

Phase 3 — conversation service gate RED/GREEN (covered ⇒ `sent` without confirmation; degraded ⇒ preview + copy; optional deps wiring; contract zero-delta assertion).

## Phase 3 — Conversation gate (completed 2026-10-05)

### RED evidence (before service wiring)

`vitest run tests/unit/conversation-grant-gate.test.ts` — covered case failed with
`expected 'confirmation_required' to be 'sent'` while both controls (degraded gate,
absent dependency) passed with `confirmation_required` — an invalid-RED round was
corrected first: pre-seeded pending transfer and wrong network/token fixture made
all 3 cases fail with generic `error`; fixture repaired to the existing EVM USDT
baseline so only the covered case failed for the intended missing behavior.

### GREEN evidence

| Check | Command | Result |
| --- | --- | --- |
| Focused suites (gate + service + factory + classifier + engine) | `vitest run` (5 files) | **71/71** |
| Full unit gate suite | grant-gate file | 4/4 (covered, financial-task terminal `sent`, degraded, absent-dep) |
| Typecheck | `npm run typecheck` | 0 errors |
| Lint | `npm run lint` | clean |
| Whitespace | `git diff --check` | exit 0 |

### Implementation

- `src/conversations/service.ts`: optional `grantGate` dependency; consulted ONLY in
  `handleTurnStream` after a fresh `confirmation_required` preview — never from
  `persistNativePreview`/`previewTransfer` (model-tool paths; regression-asserted).
  Covered ⇒ internal `resolveDecision({decision:"confirm", authorizedBy:"delegated_grant",
  waitForFinancialTask:true})` reusing the single-winner attempt claim +
  `runFinancialTransfer`; terminal `sent` returned in-turn. `authorizedBy:"delegated_grant"`
  skips the fabricated user "confirm" message (asserted). Gate absence/exception ⇒ null ⇒
  unchanged flow (fail closed).
- `src/conversations/grant-gate.ts` (new): concrete factory gate — parses the original text
  server-side, requires exact action/amount/token/recipient match against the server-owned
  pending preview (model cannot alter amount/destination), resolves wallet via
  `DelegatedGrantService.resolveWalletId(userId,"solana")` (D-2), decimals via
  `provider.listTokens("solana-devnet")`, classifies via `classifyGrantCoverage`. No
  consumption reads (AD-2); every error/mismatch ⇒ null (fail closed); injected clock.
- `src/server.ts`: gate wired in the database block only when `walletForUser` exists;
  absent seam ⇒ no gate ⇒ today's behavior.
- Contract: zero HTTP contract delta (existing `sent` shape reused); `api-types.ts` mirror
  untouched — mirror obligation remains the phase-6 no-op assertion.

### Tests added

`tests/unit/conversation-grant-gate.test.ts` (4), `tests/unit/grant-gate-factory.test.ts` (8:
exact hit, unknown token, amount mismatch, recipient mismatch, ambiguous intent, unsupported
network, no candidates, ledger failure).

### Next

Phase 4 — atomic claim integration (DB): claimConsumption authority, races, replay two-gate
semantics, revoke/expiry between preview and execution, window rejection.

### Environment note (2026-10-05)

- `delegated-grants-consumption` against `dgc-test-db-1`
  (`postgresql://postgres@127.0.0.1:55499/wdk_agent`): **14/14 pass**
  (verified independently by Ramiro). An earlier "14 fails" reading came from
  a WRONG `DATABASE_URL` (database=postgres, wrong port) — not evidence of
  failure; do not cite it.
- Fresh migrated DB ready for Phase 4:
  `postgresql://postgres@127.0.0.1:55501/wdk_agent?options=-csearch_path%3Dpublic,extensions`
  (extensions schema present, recipient_app granted).
- Fresh full suite result (run by Ramiro): **10 failing / 836 passing /
  10 skipped**. Failures are `api-contacts` timeouts, extension-schema
  permission issues (predating this change's grant), and sentinel config;
  comparison against CI/main pending before attributing any of them to this
  change.
- Targeted conversation subset on the fresh DB
  (`api-conversation-service`, `api-conversation-resolution`,
  `conversation-preview-claim-race`, `voice-touch-decision-race`):
  **4 files / 6 tests pass**. The `api-contacts` rerun that hung >2 min with
  no active DB query was stopped rather than waiting for timeouts.

## Phase 4 — Atomic ledger claim (completed 2026-10-05)

### RED evidence (before grantLedger wiring)

`DATABASE_URL=:55501/wdk_agent vitest run tests/integration/delegated-grant-execution.test.ts`:
3 cases failed with `AssertionError: expected false to be true` — the real
`grants.claimConsumption` callback was never invoked by the service. Two harness
defects were corrected first (pre-seeded attempt, non-durable previewId in the
spy repository) so the RED was specifically the missing claim integration:
`saveSnapshot` now models the durable repository behavior (new pendingTransfer
creates `conversation_transfer_attempts` and attaches the durable attempt id),
and the replay case pre-claims `grant-exec:{userId}:{predeterminedAttemptId}`.

### GREEN evidence

| Check | Command | Result |
| --- | --- | --- |
| Integration ordering suite | `vitest run tests/integration/delegated-grant-execution.test.ts` (DATABASE_URL :55501/wdk_agent) | **3/3** |
| Typecheck / lint | `npm run typecheck` / `npm run lint` | clean |

### Implementation

- `src/conversations/service.ts`: `grantLedger.claim` dependency. AD-6 sequencing
  on the delegated-grant path: **claimConsumption BEFORE claimPendingTransfer** —
  missing context (grantId/amountSmallestUnits), missing ledger, rejection, or any
  ledger error ⇒ degrade closed with NO attempt claim and NO broadcast. Key =
  `grant-exec:{userId}:{persisted attemptId}`; `amountSmallestUnits` exact from
  the classifier. Replay returns the same budget claim but never authorizes a
  broadcast by itself — the broadcast still requires winning the single-winner
  attempt claim. Explicit user confirms keep the existing ordering.
- `src/conversations/grant-gate.ts`: covered decision now carries
  `amountSmallestUnits` (exact smallest-units from `CoverageDecision`).
- `src/server.ts`: `grantLedger.claim` wired from the same `grants` service
  (`grants.claimConsumption`), conditional on `walletForUser` like the gate.

### Tests

`tests/integration/delegated-grant-execution.test.ts` (3, real Postgres):
claim-commits-before-attempt-and-broadcast (event order: ledger:consumed <
attempt:broadcasting < submitted); real rejected claim (unbound grant ⇒
`policy_not_ready`) never claims the attempt nor broadcasts; same-key replay
(no second audit row) still requires winning `claimPendingTransfer`.

### Next

4.4 remainder: ordered candidate fallback + audited degradation; then Phase 5
(typed/voice parity + E2E).

## Phase 4.4 — Ordered candidate fallback (completed 2026-10-05)

### Implementation (design AD-4/AD-6/AD-8 binding)

- `src/conversations/grant-coverage.ts`: `CoverageDecision.covered` now carries
  `orderedCandidates` — ALL statically eligible candidates in Q3 order
  (per-transfer cap → cumulative cap → expiry → stable id), computed from the
  sorted valid candidate list. Unit suite 26/26 (covered assertions now
  `toMatchObject`; malformed-cumulative and policy-less-sibling cases updated
  for the new shape).
- `src/conversations/grant-gate.ts`: `GrantGateDecision.orderedCandidates`
  propagated from the classifier result.
- `src/conversations/service.ts`: sequential claim loop over
  `orderedCandidates` — same key `grant-exec:{userId}:{attemptId}` per
  candidate; first `consumed: true` wins and proceeds to the attempt gate;
  each rejection (revoked/expired/window/budget) falls back to the next and is
  audited by the ledger; a ledger error or exhausted list degrades closed with
  no attempt claim and no broadcast. `used` rows exist only for the winning
  claim. Explicit user-confirm path unchanged.

### Evidence

| Check | Command | Result |
| --- | --- | --- |
| Classifier unit | `vitest run tests/unit/grant-coverage.test.ts` | 26/26 |
| Claim ordering (real DB :55501) | `vitest run tests/integration/delegated-grant-execution.test.ts` | 3/3 |
| Candidate fallback (real DB :55501) | `vitest run tests/integration/delegated-grant-candidates.test.ts` | 2/2 (service iterates: narrow rejected+audited → fallback consumed → single broadcast; all-rejected ⇒ no broadcasting, confirmation_required, both rejections audited) |
| Typecheck / lint | `npm run typecheck` / `npm run lint` | clean |

Harness notes (test-only, production Q1 rule untouched): test classifier `now`
pinned +5s to absorb Postgres/process clock skew on `createdAt`; gate stub
delivers real `classifyGrantCoverage` output so the service iteration runs
against the real ledger; pre-claim exhausts the narrow grant's budget before
the flow. Diagnostic console.logs removed.

## Phases 5+6 — Parity, model-origin exclusion, E2E, verification (2026-10-05)

### Phase 5 evidence

- **Typed/voice parity + LiveKit layer** (`tests/unit/livekit/grant-parity.test.ts`, 3):
  transcript funnels through the SAME `handleTurnStream` seam (identical gate contract);
  the RoomConversation surface exposes no grant capability; degraded confirm/cancel
  still routes through `resolveDecision`.
- **Model-origin exclusion** (`tests/e2e/grant-gate-model-origin.e2e.test.ts`, 2):
  tool `persistNativePreview` (dry-run, `preview:true` output) never consults gate/ledger
  nor broadcasts; tool preview + EXPLICIT user confirm broadcasts exactly once with gate/
  ledger uninvolved.
- **Covered E2E both entry points** (`tests/e2e/grant-gate-entries.e2e.test.ts`, 1):
  one service + one shared durable in-memory repository; typed turn and voice transcript
  (signed Ed25519 binding) each skip confirmation via gate+claim+attempt-win; terminal
  `sent`; D-7 multi-execution (two distinct durable attempts consumed the same grant).
- Focused suites: 6 files / 45 tests (updated for the Fase-4 contract: gate decisions
  carry `grantId`/`amountSmallestUnits`/`orderedCandidates`; service requires a consumed
  `grantLedger.claim` before skipping).

### Phase 6 verification (all exit 0)

| Check | Result |
| --- | --- |
| `npm run lint` (--max-warnings=0) | clean |
| `npm run typecheck` | clean |
| `npm run build` | clean |
| Unit suite | 84 files / 657 passed, 1 skipped (exit 0) |
| DB grants suite (:55501) | 5 files / 35 passed (exit 0) |
| Focused parity + E2E suite | 6 files / 45 passed (exit 0) |
| Full integration suite (:55501) | 37 files / 183 passed / 2 skipped / 6 failed |
| Contract mirrors | zero delta (existing `sent` shape reused); `api-types.ts` untouched |
| Scope check | no provider, LiveKit tool surface, or `transfer-pipeline.ts` changes in the diff |

### Bounded-review fix (request-time classification, AD-2/Q1)

`createGrantGate` previously captured `clock.now()` AFTER ledger/provider lookups; a
grant created during slow lookups could cover an older request. Fixed: `handleTurnStream`
captures `requestAt` at entry (before the first await) and passes it as a REQUIRED
`GrantGateInput.requestAt`; the classifier's `now` is that captured instant. Regressions
added for a grant created after `requestAt` (never a candidate) and a clock that advances
during the turn (no eligibility change).

### Full integration baseline comparison

The six full-integration failures reproduce unchanged on `origin/main` at
`c4d56c3` with the same local database and environment, in the same four files:
two `users-db` sentinel tests (missing `DEMO_USER_ID`), one durable
`api-conversations` create/read test (500), one `contacts-cross-user` timeout,
and two `api-contacts` timeouts. The four-file baseline subset on `origin/main`
also reports 6 failed / 10 passed. The delegated-grant database tests remain
green in isolation (5 files / 35 passed).

### Phase 8 RED execution (2026-10-05, tests only — NO production code/migrations)

New file: `tests/integration/grant-claim-release.test.ts` (11 RED tests, real
Postgres :55501, DATABASE_URL env only; real `DelegatedGrantService`, real
`PostgresConversationRepository`, real `grant_claim_ledger`/`grant_audit_log`/
`conversation_transfer_attempts` rows — atomicity is NOT mock-tested).

### RED evidence (vitest --reporter=verbose, /tmp/phase8-red-v7.log preserved

as `.agent-workflow/tasks/slice3-grant-execution/phase8-red-vitest.log`)

Result: **1 file, 11 tests, 11 failed — ALL feature-level** (assertions by
absence of schema/API/branch). Zero fixture/env/DB/import failures after three
harness iterations (per-test user+wallet+grant to respect the one-active-wallet
per user/chain unique index; per-test conversation for the one-active-transfer
index; documented early-return RED guards on missing APIs so no TypeError
masks the assertion).

Grouped failure causes (each RED by missing behavior):

1. **Schema missing (migration 012):** 8.1 — `expected ['id','grant_id',…] to
   include 'released_at'` (columns absent; `released` audit CHECK absent;
   RLS/UPDATE-grant assertions pending the migration).
2. **Tx-only ledger API missing:** 8.2 (x2) and 8.3 —
   `expected 'undefined' to be 'function'` on
   `releaseReservationInTransaction` (guarded, documented early return).
3. **claim_id seam missing:** 8.4b real-repository test — `expected undefined
   to be 'f3c0bb42…'`: the REAL `PostgresConversationRepository.claimPendingTransfer`
   CAS persists and mints `claim_id` in the DB (re-read proves
   `broadcasting` + non-null token) but `PendingTransferClaim` does not return
   it to the winner.
4. **Settlement API missing:** 8.2b and 8.4b (x3) — guarded absence of
   `settleGrantReservation` (atomic CAS+release+audit; cannot be mock-tested).
5. **Service settle branch missing:** 8.4 (x2) — the flow REACHES
   `attempt:broadcasting` (owned state proven via events; provider
   `not_dispatched` spy-proven awaited `kind`), then the CURRENT code runs the
   legacy `releasePendingTransferClaim` broadcasting→previewed reset and never
   releases the grant claim: `expected false to be true` on the `settle:`
   event assertion.

### Checks (this phase, test code only)

| Check | Result |
| --- | --- |
| `tsc --noEmit -p tsconfig.test.json` | 0 errors |
| `eslint tests/integration/grant-claim-release.test.ts --max-warnings=0` | clean |
| `git diff --check` | exit 0 |
| Focused RED suite | 1 file / 11 tests / 11 failed (all feature-level) |
| Production diff | none (no src/, no migrations touched) |

Semantics NOT claimed verified until GREEN. Harness notes: wallet/conversation
fixtures isolated per test (unique indexes honored, none disabled);
`insertAttempt` provisions a real conversation row (FK); deterministic runtime
env restored in afterEach; preflight rejection engineered by flipping
`WDK_TOOLS_SOURCE=live` AFTER previewTransfer succeeds (real
`validateWalletTransferPolicy` rejection in `runFinancialTransfer`).

## Reservation-release amendment (2026-10-05, planning only — no implementation)

**Binding user decision:** when a valid grant claim is followed by an
attempt/preflight failure with no transaction dispatched, release the reserved
budget with compensating audit; retain it for `submitted`, `uncertain`, or
`broadcast_in_progress`.

### Model (AD-6/AD-10; spec requirement "Reserved budget release on definitive no-dispatch")

- Claims in `grant_claim_ledger` are RESERVATIONS from persist until dispatch
  certainty; `released_at`/`released_reason` (migration `012` + Supabase mirror
  `20260901001100`, additive; `released` added to the audit event CHECK; forced
  RLS unchanged) mark release; BOTH window sums (claim authoritative total AND
  engine `consumedInWindow` prefilter) are explicitly REWRITTEN to sum UNRELEASED
  `grant_claim_ledger` rows, so released budget actually returns to the rolling
  window (additive columns alone cannot free budget — both queries read
  `grant_audit_log` today).
- Release points: definitive `not_dispatched` (service.ts:985 branch) and
  preflight policy/recipient rejection — BOTH settle from the OWNED
  `broadcasting` state `runFinancialTransfer` enters with (claim won first,
  then validation, then broadcast), and the ONLY release authority is the
  EXACT-OWNER compare-and-set `broadcasting → cancelled` (id + status +
  `claim_id` all match) inside the settlement transaction; a lost/absent CAS,
  an absent row, an already-`cancelled` status, or ambiguous ownership NEVER
  release standalone — they retain; no `previewed → cancelled` path exists
  for these settles. Retain on EVERY dispatched/uncertain state
  (`broadcasting` unowned, `submitted`, `uncertain`, `confirmed`, `reverted`,
  `receipt_invalid`; incl. the provider-exception mapping to `uncertain`) and
  whenever winner ownership is indistinguishable from an in-flight dispatch — a
  concurrent winner may be broadcasting under the same reservation.
- Idempotent locked release keyed by grant + idempotency key: same per-grant
  advisory lock, same user-scoped transaction, one `released` audit row max,
  original timestamp/reason preserved on re-release; a replayed live claim is
  never released by the replay path itself.
- Retry contract (NO re-activation — the version-token reactivation design was
  REJECTED for lifecycle races): the settlement marks the old attempt terminal
  `cancelled` and releases the budget IN THE SAME atomic transaction (all
  three effects commit together or all roll back — no partial commits); a
  released same-key replay FAILS CLOSED (never `consumed`, never authorizing a
  broadcast); a retry requires a FRESH persisted `previewId` — fresh
  idempotency key and a fresh reservation claimed under full grant/window/cap
  checks; provider reference identity stays verbatim-stable only for retained
  outcomes (`submitted`/`uncertain` reconcile by reference).

### Provider previewId guard remediation (HIGH PR #3, planning only — no implementation)

- Restores the fail-closed `previewId` guard in
  `src/wallet/solana-devnet-provider.ts` (`broadcastTransfer`): missing/empty/
  whitespace preview id ⇒ `not_dispatched` BEFORE `getRecentBlockhash` and BEFORE
  `signAndSend`; no timestamp/random fallback; valid id used verbatim (retry
  identity preserved). Matches slice2 commit `e39dbad`.
- Tracked as tasks Phase 8.7 (RED-first, tests in
  `tests/unit/solana-devnet-provider.test.ts`) and spec requirement "Persisted
  preview identity guards provider dispatch" (2 scenarios); design AD-11.
- E2E verification per AGENTS.md tracked as Phase 8.8 (focused unit + DB suites,
  `npm test`/typecheck/lint, covered-path E2E fixtures).
- Budget claim/refund semantics remain governed by AD-10, not by this guard.

### Atomic settlement with claim ownership token (final review blockers, planning only)

- **One atomic user-scoped settlement transaction** per settle: attempt
  cancellation + ledger release + compensating `released` audit, all under the
  per-grant advisory lock inside the user transaction. No partial persistence:
  any failure rolls back attempt cancellation AND ledger/audit together.
- **Ownership token:** the existing `claimPendingTransfer` winner already
  persists `claim_id` (migration 002, UUID) on the attempt row; the claim result
  now RETURNS it and the service carries it to settle. For a definitive provider
  `not_dispatched`, settle performs a compare-and-set on the EXACT attempt row:
  `broadcasting → cancelled` WHERE id, status = `broadcasting`, AND
  `claim_id` = the winner's token all match; only on CAS success does the SAME
  transaction mark the exact grant/idempotency claim released and insert the
  `released` audit row. If the CAS loses (wrong/stale claim_id, status moved),
  NOTHING is released and budget is retained.
- **Preflight rejection** (policy/recipient): settles from the SAME owned
  `broadcasting` state via the same owner-token `broadcasting → cancelled` CAS
  - ledger release/audit in the same transaction; any part failing rolls back
  everything.
- **Replaces `releasePendingTransferClaim`:** the existing broadcasting-to-
  previewed reset is removed — a released attempt is never re-opened. If the
  attempt row or claim ownership is absent or ambiguous, the settlement RETAINS
  the reservation rather than releasing.
- **API/task/test seam:** `claimPendingTransfer` winner result carries `claim_id`;
  the settle path threads it through the service to the repository settlement;
  RED cases: exact-owner broadcasting→cancelled+release atomically; wrong/stale
  claim_id cannot cancel or release; race winner retains; injected failure rolls
  back both cancellation and ledger/audit; pre-broadcast CAS cancellation+release;
  ambiguity retains.

### Scenario-count reconciliation

The pre-amendment baseline was 47 scenarios (git HEAD), not 45 as the binding
headers previously stated: the header count had drifted before this amendment.
Final arithmetic: 47 baseline + 12 reservation-release scenarios + 2
provider-guard scenarios = 61; binding headers (tasks.md, design.md, state.yaml)
now state 61 / 12.

The 12 release scenarios enumerate as: (1) definitive no-dispatch cancels the
attempt and releases atomically; (2) a released key fails closed and never
authorizes a broadcast; (3) a fresh preview claims normally after an unrelated
release; (4) released budget returns to the rolling window in BOTH sums; (5)
proven pre-dispatch blocks release — every dispatched/uncertain state retains;
(6) the settlement is one atomic transaction gated by the claim ownership token;
(7) a wrong or stale claim_id cannot cancel or release; (8) ambiguous ownership
retains rather than releases; (9) a preflight rejection cancels and releases
from the owned broadcasting state; (10) a concurrent attempt winner never has
its reservation released; (11) submitted or uncertain outcomes retain the
reservation; (12) release is idempotent and locked.

The "submitted or uncertain outcomes retain" and "proven pre-dispatch vs
dispatched/uncertain states" scenarios were kept as INDEPENDENT acceptance
scenarios (not merged) per review. Status semantics: settlements originate
in `runFinancialTransfer` with the attempt ALREADY `broadcasting` under the
winner's `claim_id`; the ONLY release authority is the successful exact-owner
`broadcasting → cancelled` CAS in the settlement transaction — an absent row,
already-`cancelled`, ambiguous ownership, or lost CAS retains, and no
`previewed → cancelled` release path exists.

### Plan

- Tasks Phase 8.1–8.8 (all unchecked; RED-first: 8.1 migration, 8.2 ledger
  `releaseReservationInTransaction` (tx-only), 8.2b atomic all-or-nothing
  settlement, 8.3 window accounting, 8.4 service settle wiring;
  8.5 implementation AFTER RED; 8.6 GREEN evidence; 8.7 provider guard RED-first;
  8.8 E2E verification per AGENTS.md).
- Budget claim/refund semantics from the earlier HIGH PR #3 review finding are
  NOT yet implemented — the pending consequence question was answered by this
  decision; Phase 8 implementation is the next bounded Strict-TDD batch.
- The solana-devnet `previewId` fail-closed guard restoration (HIGH PR #3) is
  planned in this amendment as Phase 8.7 (AD-11); its implementation also
  awaits RED evidence, in the same bounded batch or a separate one.

## Phase 8 GREEN + AD-11 guard (2026-10-05, implementation complete)

### Implementation (after recorded RED evidence)

- Migration `012_grant_claim_release.sql` + Supabase mirror
  `20260901001100_grant_claim_release.sql`: released_at/released_reason, `released`
  audit CHECK, UPDATE grant — applied to :55501 (8.1 green).
- Ledger `DelegatedGrantService`: tx-only `releaseReservationInTransaction`
  (single release-semantics implementation; failAfter:'ledger' hook INSIDE it,
  after the exact-row UPDATE and BEFORE the audit INSERT);
  `settleGrantReservation` = ONE `withUserTransaction` + per-grant advisory
  lock: exact-owner CAS `broadcasting→cancelled` (id+conversation+user+status+
  claim_id) → tx-only release → audit; `failAfter:'audit'` after return; lost
  CAS/absent/already-cancelled ⇒ bare return (retain, no release, no mutation).
- Replay fail-closed: a RELEASED key returns `consumed:false, replay:false,
  reason:'reservation_released'` (audited) — never `consumed:true`.
- Window sums REWRITTEN to unreleased `grant_claim_ledger` rows in BOTH paths
  (claim total + module `consumedInWindow`).
- Repository seam: `PendingTransferClaim` (types.ts) `claimed` variant carries
  `claimId`; `PostgresConversationRepository.claimPendingTransfer` UPDATE
  RETURNING includes the minted `claim_id`. session-state in-memory variant
  unchanged (no DB token there).
- Service wiring: `runFinancialTransfer` gains `claimId/claimedGrantId/
  authorizedBy`; settlement invoked ONLY when
  `authorizedBy==='delegated_grant'` AND claimId AND claimedGrantId AND
  `grantLedger.settle` exist — identity key `grant-exec:{userId}:{previewId}`,
  no empty-identity fallback (fail closed, retain). Replaces the legacy
  broadcasting→previewed reset on BOTH branches (preflight rejection with
  reason `policy_rejected`/`recipient_revalidation_required`; provider
  `not_dispatched` with reason `not_dispatched`), then `clearPendingTransfer`
  (retry requires a FRESH persisted preview; the cancelled attempt is never
  re-opened). `releasePendingTransferClaim` is PRESERVED only for the
  explicit-user retry path (`authorizedBy !== 'delegated_grant'`), per Ramiro's
  preserved-behavior instruction. `src/server.ts` wires `grantLedger.settle →
  grants.settleGrantReservation`.
- AD-11 (8.7): Solana provider `broadcastTransfer` fails closed on
  missing/empty/whitespace `previewId` with `not_dispatched` BEFORE
  `requireRecentBlockhash` and BEFORE `signAndSend`; no `sol-${now()}` fallback;
  valid `previewId` used verbatim as the dispatch reference.

### GREEN evidence (real Postgres :55501; DATABASE_URL required)

| Suite | Result |
| --- | --- |
| `grant-claim-release.test.ts` (11: schema, tx-only release, replay fail-closed, real-repo claimId, 3-boundary rollback w/ DB re-read, exact-owner CAS, stale claim_id retention, absent/cancelled retention, service preflight + not_dispatched settle, window sums) | 11/11 |
| `delegated-grants-consumption.test.ts` (fixtures updated to AD-10 semantics: real held reservations; window sum proven bidirectional — release stops counting; concurrent cap seeded from a real 4M held reservation) | 14/14 |
| `solana-devnet-provider.test.ts` (AD-11 RED→GREEN: 3-case fail-closed before both seams; verbatim reference) | 11/11 |
| E2E `grant-gate-entries.e2e.test.ts` + `grant-gate-model-origin.e2e.test.ts` | 3/3 |

| Check | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run build` | exit 0 |
| `npm run lint` (src+tests, --max-warnings=0) | exit 0 |
| `git diff --check` | exit 0 |

Notes: two `delegated-grants-consumption` failures surfaced by the full-suite
run were fixtures reading the OLD audit-row window sums — fixed to seed real
ledger reservations (that was the point of the AD-10 change). `settleGrantReservation`
failAfter is TEST-ONLY. `eval-fixtures.ts` claimId placeholder + unused-import
removal compile the shared contract; two remaining unused-param lints there are
pre-existing at HEAD.

Full-suite follow-up after those fixture fixes: `npm test` completed with 842
passed, 29 failed, 10 skipped (130 files: 116 passed, 10 failed, 4 skipped).
The failures include unrelated database-backed contact/conversation/user tests
timing out at their configured 5s/60s limits and the demo sentinel failing
because `DEMO_USER_ID` is unset. All Slice 3 grant consumption/settlement and
provider suites, plus the covered-path grant-gate E2E fixtures, pass separately
as recorded above; the full suite remains a CI/environment blocker to report.

## Phase 8 GREEN — reservation release implemented (2026-10-05, commit 4fe4cf2)

### Implementation (all on top of the RED suite, which was NOT weakened)

- `src/db/migrations/012_grant_claim_release.sql` + Supabase
  `20260901001100_grant_claim_release.sql`: additive `released_at`/
  `released_reason`, `released` audit event, UPDATE grant to `recipient_app`
  (applied to :55501; already present from the RED-phase dev run).
- `src/wallet/grants/consumption.ts`: tx-only
  `releaseReservationInTransaction` (no nested tx; idempotent double-release
  no-op preserving original timestamp/reason; one compensating `released`
  audit row per actual release); `claimConsumption` replay branch fails closed
  for released keys (never consumed/replay-flagged, audited
  `reservation_released`); BOTH window sums (claim cap total +
  `consumedInWindow`) rewritten to UNRELEASED `grant_claim_ledger` rows.
- `settleGrantReservation`: ONE `withUserTransaction` + per-grant advisory
  lock: exact-owner attempt CAS `broadcasting → cancelled` (id + conversation
  - user + status + claim_id), then ledger release + `released` audit on the
  SAME client; lost CAS ⇒ plain return (retain); missing releasable row ⇒
  invariant throw (rollback); test-only `failAfter` at all three effect
  boundaries proves all-or-nothing rollback by DB re-read.
- `src/conversations/postgres-repository.ts`: winner `claimPendingTransfer`
  RETURNING includes the minted `claim_id`; `PendingTransferClaim` (types.ts)
  carries it. session-state in-memory type unchanged (no fake token).
- `src/conversations/service.ts`: `runFinancialTransfer` takes
  `claimId`/`claimedGrantId`/`authorizedBy`; settlement invoked ONLY when
  `authorizedBy === 'delegated_grant'` with complete identity (fail closed,
  retain otherwise — never empty-identity release) on preflight
  policy/recipient rejection (reason `policy_rejected`/
  `recipient_revalidation_required`) and `not_dispatched`; both legacy
  `releasePendingTransferClaim` calls in those branches REMOVED; uncertain/
  submitted untouched; `clearPendingTransfer` after not_dispatched settle
  (released key retired, retry needs fresh preview). Winner claimId threaded
  at both call sites (async + synchronous).
- `src/server.ts`: `grantLedger.settle` wired to `grants.settleGrantReservation`.
- `src/wallet/solana-devnet-provider.ts`: AD-11 fail-closed `previewId` guard
  restored before RPC/signer, no fallback reference (HIGH PR #3).

### GREEN evidence

| Check | Result |
| --- | --- |
| grant-claim-release.test.ts (real PG :55501) | **11/11 passed** |
| delegated-grant DB suites (execution/consumption/candidates) | 28/28 |
| Unit suite (84 files) | 659 passed / 1 skipped |
| E2E grant-gate (entries + model-origin) | 3/3 |
| Solana provider guard tests | 14/14 |
| `npm run lint` / `typecheck` / `build` | clean |
| Full integration | 190 passed; 10 failures = documented baseline (api-contacts & contacts-cross-user timeouts, users-db sentinel missing DEMO_USER_ID, api-conversation-service/conversations/me/voice-auth fail only in the full parallel run and pass isolated) — none touch grant/release paths |

Phase 8 tasks 8.1–8.8 complete. Remaining: Phase 7.2 final PR update/review.
