# Exploration: slice3-grant-execution

Status: exploration complete. No proposal, spec, design, or tasks were produced by
this phase. No source file was modified.

Evidence base: every claim below cites a real path (with line numbers where
meaningful) read directly from the working tree at
`/Users/ramiro/Desktop/projects/colloseum.slice3-grant-execution`.

Tooling note (degraded self-healing, disclosed): this executor had no CodeGraph
MCP tool and no shell access, so `.codegraph/` could neither be checked nor
initialized. Exploration therefore used direct read/grep against the repository
instead of CodeGraph. Findings are source-cited and re-verifiable; nothing is
speculative.

---

## 1. Objective

Authorized objective: a transfer that is **fully covered by an already-active,
non-expired, policy-ready grant** shall execute **without the current second
confirmation**; anything outside or ambiguous keeps the existing explicit
preview + confirmation flow.

Non-negotiable preservation:

- **D-2** — one wallet per user (server-selected; never client-supplied).
- **D-3** — HTTP-only grant authorization; voice never creates/changes grants.
- **D-4** — hybrid enforcement: Privy signer policy (per-transfer/recipient
  plane) + Postgres ledger (cumulative/lifecycle/audit plane; sole authority).
- **D-7** — multiple executions covered within cap/window until expiry or
  revocation.

Must fail closed on: revocation, expiry, policy drift/readiness,
recipient/chain/action mismatch, amount/per-transfer cap, cumulative budget,
duplicate/idempotency/race, execution uncertainty.

Explicit non-goal for this slice: **no transaction signing or submission code
changes**. This slice concerns the confirmation gate on the
conversation/execution path, not the wallet provider.

Build-time mandate: `openspec/config.yaml:12` sets `strict_tdd: false` and
`openspec/config.yaml:49` sets `apply.tdd: false`, but the user mandates
**Strict TDD (RED → GREEN → TRIANGULATE → REFACTOR)** at apply time for this
change. The tasks artifact must carry that override explicitly, with
`npm test` (Vitest) as the RED/GREEN runner and `npm run typecheck` as the
static gate.

---

## 2. Current-state map

### 2.1 How a transfer flows today — text (typed HTTP)

1. `POST /v1/conversations/:conversationId/turns` — `src/api/conversations.ts:104`.
   Service present → `service.handleTurn` (`src/api/conversations.ts:108-115`).
2. Turn loop: `handleTurnStream` — `src/conversations/service.ts:192`.
3. **Confirmation short-circuit (the second confirmation)** —
   `src/conversations/service.ts:287-295`: if `snapshot.pendingTransfer` and
   `isConfirmation(input.text)`, it delegates straight to `resolveDecision(confirm)`.
   Cancellation mirror at `src/conversations/service.ts:297-305`.
   Phrase matcher: `src/livekit/resolution-phrases.ts:23-29`.
4. Intent → model → `send_token` preview. Two tool implementations exist:
   - `src/agent/definition.ts:249-253` (`sendToken` at `src/agent/definition.ts:272`),
     reached via `handleMessage`, guarded by `buildGuardedTools`
     (`src/agent/wallet-agent.ts:258-358`).
   - `src/wallet/agent-tools.ts:82-85` → `sendToken` (`src/wallet/agent-tools.ts:95`).
5. **Broadcast refusal without a confirmed preview** (gate #2) —
   `src/wallet/agent-tools.ts:107-111` returns `confirmation_required` unless the
   session's pending transfer matches exactly (`matchesPending`,
   `src/wallet/agent-tools.ts:158-160`);
   `src/agent/wallet-agent.ts:336-344` does the same.
6. Preview persistence — `service.persistNativePreview`
   (`src/conversations/service.ts:1049-1113`) or `service.previewTransfer`
   (`src/conversations/service.ts:615-673`) →
   `PostgresConversationRepository.setPendingTransfer`
   (`src/conversations/postgres-repository.ts:289-320`), which cancels prior
   `previewed` attempts and inserts `conversation_transfer_attempts` with
   `status='previewed'`; that row's `id` becomes `previewId`
   (`src/conversations/postgres-repository.ts:300-313, 385-389`).
7. Explicit decision endpoint — `POST /v1/conversations/:conversationId/decisions`
   (`src/api/conversations.ts:77-103`), zod `previewId` + `decision`
   (`src/contracts/http.ts:213`); stale check `src/api/conversations.ts:82-84`.
8. `resolveDecision` — `src/conversations/service.ts:430-605`:
   previewId equality check (`:441-449`), cancel path (`:452-486`), **atomic
   claim** `claimPendingTransfer` (`:508`; repo SQL
   `src/conversations/postgres-repository.ts:364-395`, single-winner
   `UPDATE ... status='broadcasting' WHERE status='previewed'`), then
   `runFinancialTransfer` directly or via `financialTasks.start`
   (`src/conversations/service.ts:527-560`).
9. `runFinancialTransfer` — `src/conversations/service.ts:730-1000`:
   re-validates wallet policy + recipient (`:739-771`), marks `broadcasting`
   (`:772-782`), **broadcast** via `walletForUser(userId, transfer.network).broadcastTransfer(transfer)`
   (`:794-799`), handles `not_dispatched` (`:801-822`) and `uncertain`
   (`:823-841`), `markTransferSubmitted` (`:843-849`), `waitForFinality`
   (`:866-880`), finalizes (`:883-951`).
10. Voice-facing preview entry point (reused by LiveKit, no broadcast) —
    `service.previewTransfer` (`src/conversations/service.ts:615-673`) returns
    `status: "confirmation_required"` at `src/conversations/service.ts:673`.

### 2.2 How a transfer flows today — voice (LiveKit)

Two voice shapes exist; **both are structurally blocked from broadcasting
directly**, and neither can mutate grants.

- **Realtime tools worker** (`src/livekit/worker.ts:126`,
  `createRealtimeTools`):
  - `send_token` — `src/livekit/realtime-tools/create-realtime-tools.ts:265-285`.
    Schema takes only `amount` + `recipientId`/`recipientVersion`; no address,
    network, token, or `dryRun`. Delegates to `service.previewTransfer`
    (`:274-284`).
  - `confirm_transfer` — `src/livekit/realtime-tools/create-realtime-tools.ts:334-338`
    → `decideTransfer("confirm")` (`:287-327`) which re-reads the **current
    persisted previewId** each call (`:295-305`) and calls
    `service.resolveDecision` (`:307-317`).
  - `cancel_transfer` — `src/livekit/realtime-tools/create-realtime-tools.ts:341-345`.
  - Returned tool set is only `get_balance`, `search_contacts`, `send_token`,
    `confirm_transfer`, `cancel_transfer` (`src/livekit/realtime-tools/create-realtime-tools.ts:350`).
    **No grant tool exists in the voice surface (D-3 holds).**
- **Agent-tool voice adapter** (LiveKit `llm.tool` bridge) —
  `src/agent/livekit-adapter.ts:103-120`: `send_token` with `dryRun !== true` is
  refused with `confirmation_required` **before** `execute` runs. Voice
  broadcasts are impossible through this adapter by construction.
- **Voice transcript turns** — `RoomConversation.resolvePendingDecision`
  (`src/livekit/room-conversation.ts:195-217`) intercepts confirm/cancel phrases
  and routes to `service.resolveDecision`; everything else goes to
  `service.handleTurnStream` (`src/livekit/room-conversation.ts:236-244`).
- Voice instructions also mandate `confirm_transfer` as the only confirmation
  route (`src/livekit/create-agent-session.ts:10-13`).

### 2.3 Grant lifecycle HTTP (Slice 1 surface, live)

`src/api/grants.ts` (registered at `src/server.ts:197-201`):

- `POST /v1/grants` — `src/api/grants.ts:82`; identity via `resolveUserId`
  (`src/server.ts:152-153`, `RequestIdentityProvider`); server-resolved wallet
  `DelegatedGrantService.resolveWalletId(userId, chain)` (`src/api/grants.ts:105-108`);
  create (`:109-118`); **post-commit policy sync** (`:113-117`) and post-sync
  re-read so the response carries `policyReady` (`src/api/grants.ts:119-121`,
  projection at `src/api/grants.ts:43-49`).
- `GET /v1/grants` — `src/api/grants.ts:150`.
- `POST /v1/grants/:grantId/revoke` — `src/api/grants.ts:170`; ledger revocation
  is authoritative, provider cleanup is best-effort (`:186-194`).

### 2.4 Grant engine API surface and its (un)wiring status

Public surface:

- `evaluateGrant(grant, request, window)` → `{decision:'covered'} | {decision:'degrade', reason}`
  — pure, I/O-free, injected clock — `src/wallet/grants/engine.ts:108-150`.
  Degrade reasons (`src/wallet/grants/engine.ts:52-62`) include `policy_not_ready`.
  Check order (`:113-150`): action/chain → lifecycle state → expiry →
  provider policy binding → per-transfer cap → cumulative window →
  chain validator → allowlist.
  Chain validator plug-in is **inline in engine.ts** (`CHAIN_VALIDATORS`,
  `src/wallet/grants/engine.ts:82-84`); the `src/wallet/grants/validators.ts`
  module promised at `openspec/changes/delegated-grant-core/design.md:122` does
  **not exist** — `tests/unit/grants-validators.test.ts` imports `evaluateGrant`
  from `engine.js`.
- `DelegatedGrantService` — `src/wallet/grants/consumption.ts:238`:
  `resolveWalletId` (`:252`), `createGrant` (`:291`, Solana ceiling check `:293-299`),
  `listGrants` (`:325`), `getGrant` (`:338`), `revokeGrant` (`:349`),
  `claimConsumption` (`:382-512`, advisory lock `:388-391`, idempotent replay
  `:395-409`, `invalid_amount` before integer math `:427-431`, state/expiry
  re-check on the locked row against `clock_timestamp()` `:436-459`,
  `policy_not_ready` `:462-466`, rolling-window SQL sum `:468-476`, cap checks
  `:477-486`, claim-ledger insert + `used` audit in the same tx `:488-510`).
- `consumedInWindow` (`src/wallet/grants/consumption.ts:160-193`) and
  `appendGrantAudit` (`src/wallet/grants/consumption.ts:201-233`).

**Unwired — verified:** `DelegatedGrantService` is constructed once at
`src/server.ts:191` and passed **only** to `registerGrantsRoutes`
(`src/server.ts:192-201`). The conversation service is built at
`src/server.ts:205-217` with no grants dependency
(`WalletConversationDependencies`, `src/conversations/service.ts:160-184`).
A repository-wide grep for `evaluateGrant|claimConsumption|consumedInWindow`
finds definitions plus tests only — **zero production callers**. This matches the
Slice 1 deferral recorded at `openspec/changes/delegated-grant-core/design.md:140-143`
("wired into the transfer flow in Slice 3") and
`openspec/changes/delegated-grant-core/verify-report.md:33`.

### 2.5 Legacy EVM pipeline — explicitly NOT the integration seam

`src/wallet/transfer-pipeline.ts` reads `signer_grants` +
`wallet_operations` (`:99-107`), is pinned to Arc/USDC
(`validateIntent`, `:517-551`), and **refuses to construct against a non-fixture
Privy client** (`:264-270`). Its only production reference is the
`TransferRejectedError` import at `src/api/wallets.ts:32`; no route or server
path constructs `WalletTransferPipeline` (grep: construction appears only in
`tests/integration/wallets-transfer.test.ts` and
`tests/integration/wallets-cross-user.test.ts`).

Consequence: Slice 1's note about "replace the read path in Slice 3"
(`openspec/changes/delegated-grant-core/proposal.md:89-92`) governs this legacy
path, which is **not** on the live conversation transfer path. The real seam for
this slice is `src/conversations/service.ts` + `src/wallet/grants/*`.

### 2.6 Frontend touchpoint (read-only, contract mirroring awareness)

- `apps/nana-wallet/src/lib/api-types.ts:413-441` — `DelegatedGrant`,
  `CreateDelegatedGrantRequest`, `Create/List/RevokeDelegatedGrantResponse`
  (includes `policyReady`).
- `apps/nana-wallet/src/lib/api-types.ts:225-232` (`TransferPreview`),
  `:252-261` (`confirmation_required` turn result), `:262` (`pendingTransfer`).
- Client calls: `apps/nana-wallet/src/lib/api.ts:583-587` (`decideConversation`
  → POST `/v1/conversations/:id/decisions`).
- Hazard: `apps/nana-wallet/src/lib/api.ts:527-531`
  (`confirmTransfer` → POST `/v1/transfers/:intentId/confirm`) has **no matching
  backend route** (grep for `/v1/transfers` in `src/` returns nothing). Do not
  build the confirmation contract on this stale client method.

---

## 3. Gap analysis

What must change: a server-side coverage decision evaluated **at execution
time**, on the conversation path, that suppresses the explicit confirmation
**only** for a fully-covered request and otherwise degrades to today's
preview + explicit confirmation — with the grant ledger (not the model, not
session state) as the authority.

| # | Fail-closed invariant | Enforced today at | Reachable from the conversation path? | Must be enforced at (this slice) |
| --- | --- | --- | --- | --- |
| G-1 | Coverage decision itself (skip the second confirmation) | **Nowhere** — unconditional gate at `src/conversations/service.ts:287`, `src/wallet/agent-tools.ts:107-111`, `src/agent/wallet-agent.ts:336-344`, `src/agent/livekit-adapter.ts:109-116` | n/a | **New** seam in the conversation service execution boundary |
| G-2 | Revocation | `src/wallet/grants/engine.ts:118-120` (`grant_revoked`); `src/wallet/grants/consumption.ts:436-441` (state on locked row) | No | Conversation → ledger claim before any broadcast |
| G-3 | Expiry | `src/wallet/grants/engine.ts:121-123`; DB-clock re-check `src/wallet/grants/consumption.ts:448-459` | No | Same (never trust session-preview time) |
| G-4 | Policy readiness / drift | `src/wallet/grants/engine.ts:124-130` + `src/wallet/grants/consumption.ts:462-466` check only `provider_policy_id IS NOT NULL` | No | Same, plus explicit acknowledgement of the readback-drift gap in §6.5 |
| G-5 | Recipient allowlist + format | `src/wallet/grants/engine.ts:139-147` (`validator_unavailable`, `recipient_invalid`, `recipient_not_allowed`) | No | Same |
| G-6 | Per-transfer cap | `src/wallet/grants/engine.ts:131-133`; `src/wallet/grants/consumption.ts:477-486` | No | Same |
| G-7 | Cumulative rolling-window budget | `src/wallet/grants/engine.ts:134-137`; SQL over `grant_audit_log` in `src/wallet/grants/consumption.ts:468-476` | No | Same; the conversation path currently has **no** window authority at all |
| G-8 | Chain / action mismatch | `src/wallet/grants/engine.ts:113-115` (`action_not_covered`) | No | Same, plus **new** mapping from `PendingTransfer.network`/`token` to grant `chain`/`action` |
| G-9 | Amount units integrity (lamports vs token decimal string) | Not enforced anywhere on this path — `PendingTransfer.amount` (`src/contracts/http.ts:144`) is a human token amount; grants are integer decimal lamports (Slice 2 spec; Solana ceiling `src/wallet/grants/consumption.ts:293-298`) | No | **New** explicit, fail-closed conversion before any coverage math |
| G-10 | Duplicate / idempotency / race | Conversation level: single-winner claim `src/conversations/postgres-repository.ts:364-395` + `financialTasks.start` (`src/conversations/service.ts:527-536`). Grant level: `grant_claim_ledger` unique key + advisory lock (`src/wallet/grants/consumption.ts:388-391, 395-409, 488-501`) | Partially (conversation level only) | Both levels, with a **new deterministic grant idempotency key derived from the preview** |
| G-11 | Execution uncertainty messaging | `src/conversations/service.ts:823-841` marks `uncertain`, never claims success; `BroadcastOutcome` (`src/wallet/provider.ts:27-30`) | Yes | Must stay honest when confirmation is skipped: "executed without asking" MUST NOT be narrated as confirmed |
| G-12 | Audit before on-chain effect | `src/wallet/grants/consumption.ts:488-510` (claim + `used` audit in one tx); `appendGrantAudit` doc contract `:197-200` | No | Same, invoked in the same flow as the broadcast |
| G-13 | Voice must not gain an authorization or broadcast path | Real-time `send_token` is preview-only (`src/livekit/realtime-tools/create-realtime-tools.ts:265-285`); adapter refuses `dryRun:false` (`src/agent/livekit-adapter.ts:109-116`); no grant tool in the voice surface (`:350`) | Yes | Preserved — the skip is decided **server-side in the service**, never by the model |
| G-14 | D-2 one wallet per user | `DelegatedGrantService.resolveWalletId` (`src/wallet/grants/consumption.ts:252-272`); wallet binding `walletForUser` (`src/conversations/service.ts:185-190`) | Yes | Preserved; the grant's `wallet_id` MUST be matched to the executing wallet |

---

## 4. Existing test coverage map

Confirmation gate and transfer flow:

- `tests/unit/conversation-service.test.ts` — preview streaming (`:117-123`),
  atomic resolve + terminal result (`:146-152`), superseded previewId →
  `stale_preview` (`:216`), missing claim → `stale_preview` (`:236`),
  only one spoken/touch confirmation wins (`:260`), state revisions across
  preview/claim/finality (`:409-424`).
- `tests/unit/wallet-agent-guard.test.ts` (`:102`, `:115`, `:150`, `:164`,
  `:178`, `:195`, `:225`) — the `confirmation_required` guard on `send_token`.
- `tests/unit/wallet-agent-confirm-seam.test.ts` (`:115`, `:139`, `:150`,
  `:185`, `:218`) — duplicate-confirm and missing-preview fail-closed.
- `tests/unit/conversation-preview-id.test.ts:166` — previewId carried into the
  broadcast request.
- `tests/unit/realtime-tools.test.ts` (`:262-323`) — voice `send_token` preview
  only; `confirm_transfer` re-reads the current preview; fails closed to
  `stale_preview`.
- `tests/unit/realtime-tool-binding.test.ts` (`:130-153`) — preview vs
  `confirm_transfer` broadcast through the fixture spy.
- `tests/integration/api-conversation-resolution.test.ts:16`,
  `tests/integration/conversation-preview-claim-race.test.ts:29-80`,
  `tests/integration/voice-touch-decision-race.test.ts:18-48`,
  `tests/integration/livekit-native-transfer.e2e.test.ts:88`,
  `tests/integration/api-conversation-service.test.ts:54`,
  `tests/integration/fake-circle-transfers.test.ts:253-260`,
  `tests/simulation/livekit-voice.simulation.test.ts:29-57`,
  `tests/e2e/wallet-agent-live-preview.e2e.test.ts:9-21`.

Grant engine / ledger / policy:

- `tests/unit/grants-engine.test.ts:49` (covered, per-transfer cap, cumulative
  cap + exact-exhaustion, expired, revoked, non-active, allowlist, empty
  allowlist, validator plug-in) and `tests/unit/grants-validators.test.ts`.
- `tests/unit/grants-solana-ceiling.test.ts:8`,
  `tests/unit/grants-policy-provisioner.test.ts` (`:87`, `:240`, `:343`, `:401`),
  `tests/unit/grants-policy-runtime.test.ts` (`:239`, `:379`, `:512`),
  `tests/unit/privy-policy-sync.test.ts:88`.
- `tests/integration/delegated-grants-consumption.test.ts:59` (window
  boundaries, DB-level cap race, idempotency-key reuse),
  `tests/integration/delegated-grants-schema.test.ts`,
  `tests/integration/delegated-grants-http.test.ts:21`,
  `tests/integration/privy-policy-sync.test.ts`.

DB harness:

- Self-skipping pattern: `const databaseUrl = process.env.DATABASE_URL; const suite = databaseUrl ? describe : describe.skip;`
  (`tests/integration/delegated-grants-consumption.test.ts:19-20`).
- User provisioning fixture: `tests/fixtures/provision-user.ts:9-26`.
- Local service: `compose.yaml:4` (`pgvector/pgvector:0.8.1-pg16`),
  `docker compose up -d db`, `DATABASE_URL=postgresql://recipient_app@127.0.0.1:5432/wdk_agent`
  (`README.md:297`), confirmed for CI at `AGENTS.md:59`. `openspec/config.yaml:26`
  notes integration suites require this service.

**No existing test asserts that a covered grant transfer skips the second
confirmation.** That is the RED baseline this slice must add.

Strict TDD RED-first notes:

- RED 1 (unit, no DB): coverage classification for the conversation path —
  covered vs every degrade reason, including units conversion and
  grant-not-found. Pure Vitest, mirrors `tests/unit/grants-engine.test.ts`.
- RED 2 (unit): the gate — a covered transfer returns a terminal `sent`/executing
  decision with no `confirmation_required`, and a degraded one still returns
  `confirmation_required` + preview. Extend
  `tests/unit/conversation-service.test.ts` / a new sibling file.
- RED 3 (integration, DB): atomic claim under concurrent executions, idempotency
  replay returning the original result, revocation/expiry between preview and
  execution, and the cumulative window refusing the second of two racing
  claims — patterned on `tests/integration/delegated-grants-consumption.test.ts`.
- RED 4 (integration): both transcript paths (typed `handleTurn`, voice
  `resolvePendingDecision` / `confirm_transfer`) plus the real-time tool surface
  must show that voice still cannot broadcast or mutate grants.
- TRIANGULATE: degrade reasons that differ only by boundary
  (exact-cap covered vs cap+1 degraded; window-exact covered vs window+1
  degraded; expiry at `now === expiresAt`).
- Note the config override: `openspec/config.yaml:12` and `:49` disable TDD by
  default; this change's tasks MUST state Strict TDD is active and use
  `npm test` with `npm run typecheck`.

---

## 5. Constraints and invariants checklist

RFC 2119 wording; each item is a MUST/MUST NOT that apply/verify must check.

- **D-2**: The system MUST resolve the executing wallet server-side and MUST NOT
  accept wallet identity from the client. A grant-covered skip MUST verify the
  grant's `wallet_id` equals the executing wallet.
- **D-3**: Grant creation, extension, and revocation MUST remain HTTP-only. Voice
  tools MUST NOT gain a grant-mutating capability, and the confirmation-skip MUST
  NOT be delegable to a model tool call.
- **D-4**: A covered execution MUST satisfy BOTH planes: ledger validation
  (`provider_policy_id` present + caps + lifecycle) AND the Privy policy at
  broadcast. A missing binding MUST degrade with `policy_not_ready`.
- **D-7**: A single grant MUST be able to cover multiple executions until expiry
  or revocation, each accounted individually in the rolling window.
- **Coverage precision**: The skip MUST apply ONLY when the decision is
  `covered`. Every other outcome (`degrade` for any reason, engine unavailability,
  ledger/DB error, unknown error) MUST fall back to preview + explicit
  confirmation, and MUST NOT surface a hard error to the user.
- **Authority**: The Postgres ledger (`delegated_grants`, `grant_audit_log`,
  `grant_claim_ledger`) MUST be the sole cumulative and lifecycle authority.
  In-memory counters and session state MUST NOT decide coverage.
- **Audit before effect**: A `used` audit row (or a `rejected` row with its
  reason code) MUST exist before any on-chain side effect of that execution.
- **DB-level idempotency**: Duplicate or racing executions MUST be resolved by
  database constraints (unique key + atomic claim + advisory lock), not by
  application-level counters. A reused idempotency key MUST NOT double-consume.
- **Uncertainty honesty**: When the broadcast outcome is `uncertain`, the system
  MUST NOT claim confirmation, and MUST NOT present a covered-but-uncertain
  execution as a confirmed success.
- **No signing/submission changes**: This slice MUST NOT modify the wallet
  provider's signing, submission, or finality code paths, nor the Privy
  `signAndSendTransaction` routing.
- **Demo boundary**: `WDK_TOOLS_SOURCE` MUST keep its `fixture` default
  (`src/wallet/privy-client.ts:314`) and no live credential may be required by
  this change's tests.
- **Amount units**: Coverage math MUST use the grant's smallest-unit integer
  decimal strings. Converting a human-token amount into smallest units MUST be
  explicit and MUST fail closed on an unknown token, an absent decimals factor,
  or a non-integral result.
- **Contract mirroring**: Any change to conversation/transfer HTTP contracts MUST
  update `src/contracts/http.ts` and
  `apps/nana-wallet/src/lib/api-types.ts` in the same PR.
- **Testing**: Strict TDD MUST be followed (RED first), with `npm test` and
  `npm run typecheck` green.

---

## 6. Risks

1. **The gate is not one place — it is four.** Confirmation is currently enforced
   at `src/conversations/service.ts:287` (text), `src/livekit/room-conversation.ts:195`
   (voice transcript), `src/livekit/realtime-tools/create-realtime-tools.ts:334`
   (voice tool), and `src/agent/livekit-adapter.ts:109` (agent-tool adapter), with
   broadcast refusals at `src/wallet/agent-tools.ts:107` and
   `src/agent/wallet-agent.ts:336`. A skip wired into only one path produces
   divergent behavior between text and voice. The skip MUST be decided in the
   shared service layer that all of them call.
2. **Two attempt/idempotency layers already exist.** `conversation_transfer_attempts`
   status machine (`src/conversations/postgres-repository.ts:289-395`) and the
   legacy `wallet_operations` (`src/wallet/transfer-pipeline.ts:375-450`) must not
   become three. The grant claim key should be derived, not a new parallel ledger.
3. **Units mismatch is the highest-probability silent bug.** `PendingTransfer.amount`
   is a human token string (`src/contracts/http.ts:144`); grants are integer
   decimal lamports with a 0.01 SOL ceiling
   (`src/wallet/grants/consumption.ts:293-298`; Slice 2 spec). Comparing them
   without conversion silently over- or under-authorizes.
4. **Idempotency-key provenance.** `previewId` exists only when the attempt row
   was created (`src/conversations/postgres-repository.ts:385-389`). Deriving a
   grant key from it must be deterministic, per-user unique, and must not collide
   across users — compare the existing namespacing rule at
   `src/wallet/transfer-pipeline.ts:279-285`.
5. **Policy drift between ledger and Privy is not detected at execution.**
   `evaluateGrant` only checks `provider_policy_id IS NOT NULL`
   (`src/wallet/grants/engine.ts:124-130`); the composed-policy readback guarantee
   from Slice 2 lives in the sync service, not in the execution path. Skipping a
   human confirmation increases the consequence of a stale or drifted policy.
   This must be an explicit accepted or mitigated risk.
6. **Uncertain broadcasts vs "executed without confirmation" messaging.**
   `src/conversations/service.ts:823-841` correctly refuses to claim success on
   `uncertain`. The new skip path must preserve that; a covered execution is not
   a confirmed execution.
7. **`consumedInWindow` returns `0` outside a user-scoped transaction by design**
   (`src/wallet/grants/consumption.ts:178-196`). A naive wiring that calls it with
   a raw `DatabaseClient` reads zero consumption and bypasses the cumulative cap
   while appearing green.
8. **DB suites self-skip without `DATABASE_URL`**
   (`tests/integration/delegated-grants-consumption.test.ts:19-20`). Skipped
   integration coverage looks like a passing suite; verification must confirm the
   pgvector service was up for this change's DB tests.
9. **Frontend mirror drift.** `apps/nana-wallet/src/lib/api.ts:527-531` targets a
   backend route that does not exist. New confirmation-skip UI wiring must use
   `/v1/conversations/:id/decisions` (`apps/nana-wallet/src/lib/api.ts:583-587`).

---

## 7. Recommendation

**Narrowest integration seam.** Decide coverage inside the conversation service
at the execution boundary — `runFinancialTransfer` (`src/conversations/service.ts:730`)
with the pre-decision placed in `resolveDecision` (`src/conversations/service.ts:430`)
before the existing claim at `src/conversations/service.ts:508`. Rationale: all
three entry points (typed turn, voice transcript, voice confirm tool) already
funnel through `resolveDecision`, so one seam covers text and voice without
touching LiveKit tools, the adapter, or the provider.

Authority split inside that seam:

- `evaluateGrant` (`src/wallet/grants/engine.ts:108`) as a **pre-filter** for the
  user-facing degradation copy and reason code, with `consumedInWindow`
  (`src/wallet/grants/consumption.ts:160`) supplying the window total through a
  user-scoped `Queryable`.
- `DelegatedGrantService.claimConsumption` (`src/wallet/grants/consumption.ts:382`)
  as the **atomic authority** — it already re-checks lifecycle, DB-clock expiry,
  policy readiness, caps, and the window under an advisory lock, and audits
  inside the same transaction.

Wiring shape: add optional grant dependencies to
`WalletConversationDependencies` (`src/conversations/service.ts:160-184`) and
pass the existing `DelegatedGrantService` (`src/server.ts:191`) into the service
constructor (`src/server.ts:205-217`). Absent dependencies ⇒ today's behavior
exactly (fail-closed, additive).

**Suggested slice boundary (in scope):**

1. Coverage classification for the conversation path, including the fail-closed
   units conversion and the grant-selection rule when more than one grant could
   apply.
2. A server-side decision that suppresses the explicit confirmation only on
   `covered`, with honest narration (a preview may still be narrated without
   asking).
3. Atomic claim + audit at the execution boundary via the existing ledger
   service, with a deterministic idempotency key derived from the preview.
4. Degradation to the existing preview + confirmation flow for everything else,
   with the reason code surfaced to the user.
5. Contract updates (if any) mirrored in `src/contracts/http.ts` and
   `apps/nana-wallet/src/lib/api-types.ts` in the same PR.

**Explicitly out of scope:** wallet provider signing/submission/finality code,
LiveKit tool surface changes, grant lifecycle endpoints, `transfer-pipeline.ts`,
and any change that would let a model tool authorize a broadcast.

---

## 8. Open product questions

1. **Intervening grant creation.** If a user requests a transfer (preview shown,
   confirmation pending) and then a covering grant becomes active before they
   answer, should the pending sequence auto-skip, or is the skip decided only at
   request time? (Material: it changes whether the decision is stored on the
   pending attempt or recomputed at execution.)
2. **Narration and reversibility on a covered transfer.** Should a covered
   transfer still narrate a short preview without asking, and should the user get
   a cancel window? (Material: it determines whether a "covered" path can still
   produce a `confirmation_required` turn result.)
3. **Multiple covering grants.** When two or more active grants could cover the
   same transfer, which one is charged? The engine today returns only
   `covered`/`degrade` and performs no grant selection
   (`src/wallet/grants/engine.ts:108-150`).
4. **Degradation transparency.** On degrade after a user might expect a skip
   ("you have a grant for this"), is the specific reason disclosed (e.g.
   `cumulative_cap_exceeded`, `policy_not_ready`) or is it silently the standard
   preview + confirmation? (Material: it affects the user-visible copy and
   whether reason codes become part of the conversation contract.)
