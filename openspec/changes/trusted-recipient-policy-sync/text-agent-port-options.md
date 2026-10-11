# Design options — completing the trusted-recipient flow on the text agent

> **Status: decision support, not an approved design.** No code was written. This document exists
> because the live attempt on `sns-alias-recipients` task 8.2 exposed the gap (§1), and because the
> owning commit for the port lives in this change, not in the sibling. It records options and one
> recommendation so the decision can be made in one sitting.

## 1. The gap, precisely

Three things are missing. They are of very different sizes, and conflating them is what let the gap
survive a code review and two verification passes:

| # | Missing piece | Size |
| --- | --- | --- |
| **a** | The **port** that lets the text agent stage a proposal at all | small — the design is already written (see §2) |
| **b** | The **delivery** that tells the user a proposal is waiting | medium — the only existing transport is LiveKit-room-bound |
| **c** | A definition of **who "the text user" is** in this product | product call, not an implementation detail |

Today every text call to `stage_trusted_recipient` returns the constant `address_review_required`
(`src/agent/definition.ts:571,576`), and the confirm tool returns the identical refusal
(`:609`), because `context.contactActions` is supplied **only** by the voice worker
(`src/livekit/worker.ts:307`) and the realtime-tools adapter
(`src/livekit/realtime-tools/create-realtime-tools.ts:98`).

## 2. What already exists — the options are cheaper than they look

| Piece | State | Evidence |
| --- | --- | --- |
| Port type, already origin-parameterized `'text' \| 'voice'` | exists | `src/agent/definition.ts:55,85` |
| Text-path window primitives (`stageContactAction` / `currentContactAction` / `clearContactAction` / `confirmContactAction`) | **built, integration-tested, zero production callers** | `src/conversations/session-state.ts:155,164,189`; `tests/integration/contact-action-proposals.test.ts:218,233` |
| The design **already assigns the text path its own in-process window** | written | `src/conversations/session-state.ts:14-22` — *"The text path's half of a trusted-recipient proposal (design §7.2/§7.5) … exactly as the voice arbiter owns the voice window in the worker process"* |
| The one and only port implementation | voice-only, room-bound | `src/livekit/contact-proposal-publication.ts:323` |
| One-use across processes | exists, owned by the persisted row | design §7.2 SQL; `src/wallet/policy/contact-actions.ts:338` |
| Review routes (origin-agnostic, keyed by `proposalId`) | exist | `src/api/contact-actions.ts:163,189` |
| Card is deliberately **transport-value-blind** | exists, load-bearing | `apps/nana-wallet/src/lib/contact-action-topic.ts:14-23` |
| A text-agent surface in the app | **does not exist** | the front never calls `/v1/conversations`; the agent UI is `apps/nana-wallet/src/features/agent/voice/` |

**The consequence that matters:** §7.2 already decided *where the text window lives*. The port is not
a new design — it is the wiring the design already specifies, plus one extraction. Piece **(c)** is
the only genuine open question.

## 3. Part A — the port

### A1 — a backend port built on the existing session primitives
New `createTextContactActions(...)` calling `RecipientPolicyService` (still the only contact/policy
writer) plus `stageContactAction`/`confirmContactAction` on the session, wired through a new
`contactActions?` on `HandleMessageOptions` — the exact precedent is `grantService`
(`src/agent/wallet-agent.ts:143`).

- **+** Completes the design as written; the window and its tests already exist; no new persistence.
- **−** The publication step is embedded inside the voice implementation, so the orchestration is
  either duplicated or extracted.

### A2 — reuse `createVoiceContactActions` as-is
**Not possible without a refactor, and this is worth stating flatly**: the function hard-refuses
whenever `dependencies.boundParticipantIdentity` is absent
(`src/livekit/contact-proposal-publication.ts:326`), which is *always* true for a plain HTTP text
turn. It also publishes through a room-bound `destinationIdentities` (`:388`). Anyone who reads only
the type at `definition.ts:55` — as the previous verification did — will conclude the port is
origin-neutral and half-wired. It is not.

- **+** Single implementation, so no lifecycle drift.
- **−** Cannot serve the text path as written; pretending otherwise is precisely how the original gap
  was recorded as *"there is no second ('text path') port construction"* and a task closed on it.

### A3 — extract one shared lifecycle with two injected seams
One `stage`/`confirm` orchestration used by both surfaces, differing in exactly two dependencies:

| Seam | Voice | Text |
| --- | --- | --- |
| **window** (which kind may be authorized now) | `ConfirmationArbiter` (per LiveKit job) | `session.contactAction` (per `ConversationSession`) |
| **publisher** (how the user is told) | LiveKit message to the bound participant | see Part B |

## 4. Part B — delivering the proposal to the text user

The transport contract is already weak **on purpose**: the card's guard requires only the *wakeup
identity*, and the card answers by re-reading the canonical row through
`GET /v1/contact-actions/:id` (`apps/nana-wallet/src/lib/contact-action-topic.ts:14-23`). The LiveKit
topic is therefore **one possible wakeup, not a requirement** — which is what makes a cheap delivery
possible at all.

### D1 — carry the wakeup on the existing notification feed
The backend writes a notification for the text-origin proposal; the app hands that packet to the same
bus and the **same, already-working card** renders. (`GET /v1/notifications`,
`apps/nana-wallet/src/lib/api.ts:398`.)

- **+** No new surface; no LiveKit room in an HTTP-only path; preserves the wakeup-carries-no-values
  invariant; the same mechanism generalizes to any future channel.
- **−** Needs a notification entry for the text origin plus a front poll→bus hop; delivery latency is
  poll-bounded.

### D2 — a listing route the app polls
`GET /v1/contact-actions?status=open`.

- **+** Simplest; the persisted row is already the source of truth.
- **−** Another route; the app polls; same latency bound as D1 with less reuse.

### D3 — put the text turn inside a LiveKit room
- **+** Zero new delivery code.
- **−** The text agent is deliberately HTTP-only, and *"the bound authenticated participant"* has no
  meaning for a plain HTTP turn. Drags LiveKit into a path designed without it.

### D4 — reply in chat only, no card
- **+** Near-zero.
- **−** Nothing surfaces the `proposalId`, and the routes the screen uses do not manage proposals —
  `POST /v1/contacts` writes the contact **directly** with `origin: "screen"`
  (`src/api/contacts.ts:262`). The flow stays dead: this is today's state, not a fix.

## 5. Recommendation

**A3, delivered incrementally as the A1 shape: extract the publisher seam out of
`createVoiceContactActions` (a behaviour-preserving refactor) and build the text port against that
one shared lifecycle, then deliver with D1.**

Two rejections carry the reasoning:

- **Reject a second hand-written lifecycle**, even though it is the smallest diff today. Lifecycle
  divergence is the *mechanism* that produced this defect: a voice-only assumption was never
  revisited, and the sibling change's task 6.4 was closed on the false premise that no second call
  site existed. Writing the second lifecycle now would repeat the cause, not just the symptom.
- **Reject D3 and D4.** D3 forces a room onto a path designed without one. D4 leaves the user with no
  way to reach the proposal, which is the current broken state.

D1 wins because it reuses machinery that already exists **and is already tested**, and because the
card was built to accept any wakeup that carries an id.

## 6. Sequencing and risk

**(a) and (b) must land as one work unit.** The port alone converts an honest hard refusal into a
staged proposal that *nothing can surface* — and it opens a window that only expires. If they must be
split, gate the port so a text turn never stages an unreachable proposal.

- **Risk 1.** The shared-lifecycle refactor touches the transfer path. Design §7.3 requires the
  transfer gate to be *behaviourally equivalent*, so the whole `voice-decision-gate` unit suite must
  pass unchanged — not merely "mostly".
- **Risk 2.** One-use must remain owned by the persisted row (`contact-actions.ts:338`), never by the
  in-process window. Two processes presenting the same evidence must still not both consume.
- **Scope note.** Completing the port also completes the **alias** flow on text for free: `snsName`
  already travels through the port's `stage` and is resolved before the proposal row exists
  (`src/agent/definition.ts:102`; `contact-proposal-publication.ts:328-340`). This document therefore
  also covers the un-met clause of `sns-alias-recipients` task 6.4 — *"and the text path's own port
  construction"*.

## 7. What this does not decide

- Whether a text-agent surface should exist in the product at all.
- Which channel "the text user" is. D1 assumes the app; a genuinely external channel (a messaging
  integration) changes D1's shape and may change the priority.
- Anything about the three decisions currently held: the `sdd-archive` gate, this gap's fix, and the
  `LIVE_VOICE_BINDING_PRIVATE_KEY` rotation.
- Whether `sns-alias-recipients` task 6.4 gets re-opened or closed by the resulting work.

## 8. Evidence index

| Claim | Evidence |
| --- | --- |
| Text staging always refuses today | `src/agent/definition.ts:571,576`; `:609` |
| The port is never supplied to the text agent | `grep -rn contactActions src/` → only `definition.ts`, `livekit/worker.ts`, `create-realtime-tools.ts` |
| The text window exists and is tested, with no production caller | `src/conversations/session-state.ts:12,24,155,164,189`; `tests/integration/contact-action-proposals.test.ts:218,233` |
| The design already assigned the text path its own window | `src/conversations/session-state.ts:14-22`; design §7.2 |
| The voice port cannot serve text as written | `src/livekit/contact-proposal-publication.ts:326,388` |
| The card accepts any id-bearing wakeup | `apps/nana-wallet/src/lib/contact-action-topic.ts:14-23` |
| No app text-agent surface exists | the front never calls `/v1/conversations`; agent UI under `apps/nana-wallet/src/features/agent/voice/` |
| The screen writes contacts without proposals | `src/api/contacts.ts:262` |
