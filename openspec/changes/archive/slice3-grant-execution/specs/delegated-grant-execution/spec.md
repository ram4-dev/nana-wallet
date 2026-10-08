# Spec Delta: delegated-grant-execution

## ADDED Requirements

### Requirement: Server-side coverage decision on the original transfer request

The system SHALL classify grant coverage only when evaluating the **original
transfer request**, against grants that are already `active` at that moment. The
decision SHALL be made server-side in the shared conversation service execution
boundary (`src/conversations/service.ts`); the model and the client MUST NOT be
able to influence it in any way. A grant that becomes `active` after a transfer
preview was created MUST NOT auto-execute that pending preview. Any outcome that
is not `covered` — any degrade reason, grant-engine unavailability, ledger or
database error, or an unknown error — SHALL fall back to the existing preview plus
explicit confirmation flow and MUST NOT surface a hard conversation error.

#### Scenario: A later-created grant does not auto-execute a pending preview

- **Given** a transfer request that was evaluated as not covered and for which a
  preview with a pending confirmation was persisted
- **When** a grant covering that transfer becomes `active` before the user answers
- **Then** the pending preview is not auto-executed and the sequence still requires
  the explicit confirmation

#### Scenario: The model cannot trigger the skip

- **Given** an active grant that covers the requested transfer
- **When** the model emits a tool call asserting authorization or asking to skip
  confirmation
- **Then** no coverage decision is derived from the tool call, and the broadcast is
  authorized only by the server-side decision

#### Scenario: The client cannot force the skip

- **Given** a conversation turn or decision request whose payload asserts coverage,
  names a grant, or requests skipping confirmation
- **When** the server processes the request
- **Then** the strict request contract rejects the extra fields and coverage is
  derived only from persisted ledger state

#### Scenario: Ambiguous intent degrades instead of auto-executing

- **Given** a user turn or transcript whose transfer intent does not bind an exact
  requested amount and a resolved recipient to the authenticated text (ambiguous,
  absent, or unmatchable via the existing financial-intent parsing and recipient
  resolution), even when an active grant would otherwise cover the request
- **When** coverage is classified
- **Then** the classification degrades to preview plus explicit confirmation, and
  model-produced tool arguments alone never fill or override the amount or
  recipient for coverage purposes

#### Scenario: Every degrade reason keeps the confirmation flow

- **Given** a coverage evaluation that returns `degrade` for any reason
- **When** the response is produced
- **Then** the standard preview plus explicit confirmation flow runs

#### Scenario: Infrastructure failure degrades closed instead of erroring

- **Given** the grant engine is unavailable, a ledger/database error occurs, or an
  unknown error is raised during the coverage decision
- **When** a transfer request is evaluated
- **Then** the flow degrades to preview plus explicit confirmation and no hard
  conversation error is surfaced to the user

### Requirement: Covered execution without second confirmation

For a request classified `covered` — an active, non-expired, policy-ready grant
that fully covers it (amount within the per-transfer cap and remaining cumulative
budget, recipient allowed, chain and action matching) — the conversation service
SHALL execute the transfer without requiring the second explicit user
confirmation. Such an execution MUST NOT return a `confirmation_required` turn
result and MUST NOT offer a cancel window for the covered path. It SHALL narrate a
short, honest processing/result message consistent with the outcome actually
observed, and a broadcast outcome of `uncertain` MUST NOT be narrated as confirmed
success (the existing uncertain wording SHALL be preserved). Skipping the second
confirmation MUST NOT bypass the wallet-policy and recipient re-validation that
already runs at the transfer execution boundary.

#### Scenario: Fully covered request executes without a confirmation turn

- **Given** an active, unexpired, policy-ready grant that fully covers the request
  (amount at or below the per-transfer cap, remaining cumulative budget sufficient,
  recipient allowed, chain and action matching)
- **When** the transfer is requested
- **Then** the transfer executes and the conversation does not return a
  `confirmation_required` result

#### Scenario: Covered execution narrates honestly and offers no cancel window

- **Given** a request classified `covered`
- **When** the execution is narrated
- **Then** the user receives a short processing/result message and no cancel window
  is offered for that covered path

#### Scenario: Covered but uncertain broadcast is not narrated as success

- **Given** a covered execution whose broadcast outcome is `uncertain`
- **When** the result is narrated
- **Then** the existing uncertain-outcome wording is preserved and the message does
  not claim confirmed success

#### Scenario: Skip does not bypass wallet policy and recipient re-validation

- **Given** a request classified `covered`
- **When** the execution proceeds without the second confirmation
- **Then** the wallet-policy and recipient re-validation at the execution boundary
  still runs, and a failure there is handled by the existing outcome handling
  rather than by a broadcast

#### Scenario: Exact per-transfer cap is covered and one unit above degrades

- **Given** an active, unexpired, policy-ready grant
- **When** the requested amount equals the grant's per-transfer cap
- **Then** the request is covered and executes without the second confirmation
- **And** when the requested amount is one smallest unit above that cap, the
  request degrades to preview plus explicit confirmation

### Requirement: Deterministic least-privilege grant selection

When more than one grant could cover the request, selection SHALL be deterministic
and least-privilege first: lowest per-transfer cap, then lowest cumulative cap,
then earliest expiry, then stable grant identifier as the final tiebreaker.
Selection MUST NOT depend on the model or the client. A grant whose `wallet_id`
does not match the executing wallet MUST never be a candidate (D-2). Selection
SHALL operate among candidates that pass the atomic claim: when a candidate's
claim fails because concurrent executions exhausted its remaining budget, the next
candidate in the deterministic order SHALL be tried, and the request SHALL degrade
closed only when no candidate passes the claim.

#### Scenario: Lowest per-transfer cap is charged

- **Given** two active, policy-ready grants that both cover the request, one with a
  lower per-transfer cap than the other
- **When** the request is executed as covered
- **Then** the grant with the lowest per-transfer cap is the one charged

#### Scenario: Cumulative-cap tiebreaker

- **Given** two covering candidates with equal per-transfer caps and different
  cumulative caps
- **When** a candidate is selected
- **Then** the candidate with the lowest cumulative cap is selected

#### Scenario: Expiry tiebreaker

- **Given** covering candidates with equal per-transfer and cumulative caps and
  different expirations
- **When** a candidate is selected
- **Then** the candidate with the earliest expiry is selected

#### Scenario: Stable identifier as the final tiebreaker

- **Given** covering candidates identical in per-transfer cap, cumulative cap, and
  expiry
- **When** a candidate is selected
- **Then** the selection is decided by a stable grant identifier ordering and is
  reproducible across runs

#### Scenario: Concurrent budget exhaustion falls back to the next candidate

- **Given** two covering candidates where the deterministically preferred one fails
  its atomic claim because concurrent executions consumed its remaining budget
- **When** the claim is attempted
- **Then** the next candidate in the deterministic order is claimed and charged for
  that execution

#### Scenario: Selection is not influenced by the model or the client

- **Given** a client payload or a model output naming a specific grant to charge
- **When** selection runs
- **Then** the deterministic server-side order decides and the hint is ignored

#### Scenario: A grant bound to another wallet is never a candidate

- **Given** a grant whose `wallet_id` does not match the executing wallet but which
  would otherwise cover the request
- **When** candidates are evaluated
- **Then** that grant is never selected, and if no other candidate passes the
  request degrades to preview plus explicit confirmation

#### Scenario: No candidate passes the claim degrades closed

- **Given** every covering candidate fails its atomic claim
- **When** the request is evaluated
- **Then** the flow degrades to preview plus explicit confirmation and no hard error
  is surfaced

### Requirement: Fail-closed amount conversion to smallest units

Coverage math SHALL operate on the grants ledger's integer smallest-unit decimal
strings. A human-readable transfer amount (as carried by the pending transfer
contract) SHALL be converted explicitly to an integer smallest-unit value through
the token decimals factor for the request's token before any coverage comparison,
and the conversion MUST fail closed to preview plus explicit confirmation when the
token is unknown, when no decimals factor is available, or when the converted value
is not an integral value (no rounding, no silent truncation). Solana native SOL
SHALL be converted to lamports, and the per-transfer ceiling of 10,000,000
lamports (0.01 SOL) inherited from the grant ledger SHALL apply.

#### Scenario: Known token converts to integral smallest units and stays covered

- **Given** a request for a token with a known decimals factor and a grant that
  covers the converted amount
- **When** the human amount is converted
- **Then** the integral smallest-unit value is used for coverage and the execution
  proceeds as covered

#### Scenario: Unknown token degrades closed

- **Given** a request whose token has no known decimals factor entry
- **When** the amount is converted
- **Then** the conversion fails closed and preview plus explicit confirmation runs

#### Scenario: Missing decimals factor degrades closed

- **Given** a request whose token is known but for which no decimals factor is
  available in the configured map
- **When** the amount is converted
- **Then** the conversion fails closed and the standard confirmation flow runs

#### Scenario: Non-integral result degrades closed

- **Given** a human amount with more fractional digits than the token's decimals
  factor
- **When** the amount is converted
- **Then** no rounding or truncation is applied, the conversion fails closed, and
  preview plus explicit confirmation runs

#### Scenario: Solana native SOL converts to lamports at the ceiling

- **Given** a Solana native SOL request of exactly 0.01 SOL and a grant with a
  10,000,000-lamport per-transfer cap and remaining cumulative budget
- **When** the amount is converted
- **Then** it becomes 10,000,000 lamports and the request is covered

#### Scenario: Amount above the SOL ceiling can never be covered

- **Given** a Solana native SOL request above 0.01 SOL
- **When** the request is evaluated
- **Then** it degrades to preview plus explicit confirmation, because no grant may
  exceed the 10,000,000-lamport per-transfer ceiling

### Requirement: Atomic ledger claim is the execution authority

The atomic ledger claim (`claimConsumption`) SHALL be the sole authoritative
pre-broadcast re-check of lifecycle state, database-clock expiry, provider policy
readiness, per-transfer cap, and cumulative rolling window, performed under its
advisory lock inside a user-scoped transaction. Grant-engine evaluation
(`evaluateGrant`) MAY serve only as a pre-filter for user-facing copy and MUST NOT
serve as execution authority. The cumulative window MUST NOT be evaluated through
`consumedInWindow` with an anonymous or raw client — that call returns zero
consumption outside a user-scoped transaction — so the claim path's user-scoped
transaction SHALL be the window authority. The database claim row and the `used`
audit row MUST be persisted before any broadcast side effect of that execution.
In-memory counters and session state MUST NOT decide coverage. The claim's
idempotency key SHALL be deterministic and user-namespaced, derived from the
persisted preview attempt identity, with no additional ledger or idempotency store.

#### Scenario: The claim rejects a grant that changed after the pre-filter

- **Given** a request the pre-filter classified as covered, and a grant that is
  revoked or expired before the claim runs
- **When** the claim executes
- **Then** the claim rejects the execution, no broadcast occurs, and the flow
  degrades to preview plus explicit confirmation

#### Scenario: The cumulative window is read through the user-scoped claim

- **Given** a grant with prior consumption inside the rolling window such that the
  remaining budget cannot cover the request
- **When** the covered path evaluates the request
- **Then** the window total is read inside the user-scoped claim transaction and the
  request degrades closed instead of being treated as having zero consumption

#### Scenario: Audit and claim rows precede the broadcast

- **Given** a covered execution proceeding to broadcast
- **When** the broadcast step is reached
- **Then** the claim-ledger row and the `used` audit row already exist for that
  execution

#### Scenario: Deterministic key derived from the persisted preview

- **Given** the same persisted preview attempt being executed again
- **When** the execution derives its idempotency key
- **Then** the key is deterministic and user-namespaced from that preview identity, and a reused key
  returns the same budget claim with no second consumption or second audit row
- **And** the budget-claim replay alone never implies a completed transfer: any broadcast still requires
  winning the existing single-winner attempt state transition, so an attempt already broadcasting or
  terminal cannot broadcast twice, and a crash after the budget claim but before the attempt claim may
  safely retry with the same key and proceed only if that transition succeeds

#### Scenario: Racing executions cannot both consume the same budget

- **Given** a grant with remaining budget for exactly one bounded execution
- **When** two executions with distinct idempotency keys race
- **Then** at most one consumes budget (enforced at the database level), the other
  degrades closed, and the rejection is audited

#### Scenario: Claim is the cap authority at the exact boundary

- **Given** a grant whose remaining cumulative budget exactly equals the requested
  amount
- **When** the claim runs
- **Then** the claim consumes it and the execution proceeds, while an amount one
  smallest unit above the remaining budget is rejected and degrades closed

#### Scenario: In-memory or session state cannot grant coverage

- **Given** a session or in-memory record carrying a previously covered decision
- **When** a later request exceeds the grant's remaining per-transfer or cumulative
  budget
- **Then** the claim rejects it regardless of that in-memory state

#### Scenario: Multiple executions under one grant are individually accounted

- **Given** an active grant with sufficient per-transfer and cumulative budget
- **When** two covered executions occur within the rolling window
- **Then** each execution is individually claimed and audited

### Requirement: Reserved budget release on definitive no-dispatch

A granted budget claim SHALL be a **reservation** from the moment its claim row
is persisted until dispatch certainty. When the outcome is a **definitive
non-dispatch** (the provider returns `not_dispatched`) or a preflight rejection
(policy/recipient revalidation) inside `runFinancialTransfer`, the service
SHALL release the reservation ONLY through the atomic settlement below: the
exact claim-ledger row (grant + idempotency key) gets `released_at` and
`released_reason` and a compensating `released` audit row commits IN THE SAME
user-scoped transaction under the same per-grant advisory lock, gated by the
successful exact-owner attempt CAS. The settle SHALL mark the old attempt
terminal `cancelled` and release the budget in the SAME atomic transaction, so
no later worker can win a broadcast transition on a cancelled attempt. There
are no partial commits: settlement SHALL be ONE atomic user-scoped transaction
(`withUserTransaction`, per-grant advisory lock acquired inside it) covering
attempt cancellation + ledger release + compensating `released` audit ALL on
the SAME transaction client, via the tx-only ledger method (no nested
transaction open/commit by the method itself); ANY part failing rolls back ALL THREE
effects together — the attempt stays `broadcasting`, the claim stays active,
and the reservation is therefore retained (nothing persisted). The
`claimPendingTransfer` winner result SHALL return the persisted `claim_id`
ownership token (already persisted by migration 002) and settle SHALL thread it
through the service: `runFinancialTransfer` enters with the attempt ALREADY
`broadcasting` under the winner's token (claim won first, then policy/recipient
validation, then `broadcastTransfer`), so BOTH preflight rejections
(policy/recipient) and provider definitive `not_dispatched` settle from the
OWNED `broadcasting` state: ONE compare-and-set on the exact attempt row
(`broadcasting → cancelled` WHERE id, status, AND `claim_id` all match), and
only on CAS success the SAME transaction marks the exact grant/idempotency claim
released and inserts the audit row; a lost or absent CAS (wrong/stale
`claim_id`, moved status, missing row) releases NOTHING and retains the budget —
no owned-token CAS, no release. No `previewed → cancelled` path exists for
these `runFinancialTransfer` settles. The broadcasting-to-previewed reset
(`releasePendingTransferClaim`) is REPLACED: a released attempt is NEVER
re-opened. If the attempt row or claim ownership is absent or ambiguous, the
settlement SHALL retain rather than release. There is NO re-activation: a released key is
permanently retired — a replay of `claimConsumption` for a released key MUST
fail closed (never `consumed`, never authorizing a broadcast), and a retry of
the same request requires a FRESH persisted `previewId` (fresh idempotency key
and reservation). The provider reference identity stays verbatim-stable only
for retained outcomes (`submitted`/`uncertain` retries reconcile by reference).
Release keyed on attempt state SHALL require reading the CURRENT persisted
attempt row and ownership BEFORE releasing: losing the single-winner attempt
transition alone is NOT proof of no dispatch — the attempt may be
`broadcasting` because another worker won it while sharing this same reservation
(same attempt id ⇒ same idempotency key), so the reservation MUST be retained
whenever the attempt is in any dispatched state or winner ownership cannot be
distinguished from an
in-flight dispatch. The ONLY release authority for settlements originating in
`runFinancialTransfer` is a SUCCESSFUL exact-owner compare-and-set: the settle
transaction itself wins `broadcasting → cancelled` on the exact attempt row
(id + status + `claim_id` all match) and only then releases the claim and
inserts the audit row in that SAME transaction. An absent attempt row, an
already-`cancelled` status, an ambiguous ownership, or a lost CAS never release
standalone — they RETAIN the reservation. No `previewed → cancelled` path
exists for these settles. Release SHALL be idempotent:
re-releasing an already-released key is a no-op with no second audit row. The
reservation MUST be retained for `submitted`, `uncertain`, or any outcome where
the transaction may have left the process — retained budget is reconciled by
existing reference-id reconciliation, never self-released. Rolling-window accounting is an
EXPLICIT QUERY CHANGE, not an additive side effect: BOTH existing window sums —
the claim's authoritative cap total and the engine prefilter
`consumedInWindow` — currently read `grant_audit_log` `used` rows and MUST be
rewritten to sum UNRELEASED `grant_claim_ledger` rows (`released_at IS NULL`,
claimed inside the window), so released budget actually returns; until both
queries are rewritten, release cannot free budget. The schema
migration SHALL be additive (release columns,
`released` audit event in the existing CHECK, `UPDATE` grant to `recipient_app`
under the existing forced-RLS user-isolation policy) in both the local runner and
the Supabase chain; the query rewrites ship in the same change.

#### Scenario: Submitted or uncertain outcomes retain the reservation

- **Given** a covered execution whose broadcast returned `submitted` or
  `uncertain`, including a provider error mapped to `uncertain` after the request
  may have left the process
- **When** the execution settles
- **Then** the reservation is NOT released: the claim row stays unreleased, no
  `released` audit row is written, and recovery is by reconciliation only

#### Scenario: Release is idempotent and locked

- **Given** a reservation already released for a grant and idempotency key
- **When** release is requested again for the same key (replay, crash retry, or
  duplicate settle path)
- **Then** the release executes under the same per-grant advisory lock with no
  second mutation and no second `released` audit row, and the original release
  timestamp and reason are preserved

#### Scenario: Definitive no-dispatch cancels the attempt and releases atomically

- **Given** a covered execution that claimed grant budget and then received a
  definitive non-dispatch for THIS execution, whose winner holds the persisted
  `claim_id` ownership token
- **When** the settlement transaction runs
- **Then** it commits ALL THREE effects together — the exact attempt row CASed
  `broadcasting → cancelled` (id + status + `claim_id` matching), the claim row
  marked released with its reason, and the compensating `released` audit row —
  or rolls back ALL THREE: a failed settlement persists nothing (the attempt
  stays `broadcasting`, the claim stays active, the budget is retained), and a
  concurrent `claimPendingTransfer` racing the settle either loses (nothing to
  broadcast) or had already produced a retained dispatched outcome outside this
  settle's authority

#### Scenario: A released key fails closed and never authorizes a broadcast

- **Given** a reservation released after a definitive non-dispatch
- **When** the same old preview/key is replayed or retried
- **Then** the replay of the claim fails closed (never `consumed`, no broadcast),
  the old attempt cannot win any broadcast transition (it is terminal
  `cancelled`), and a retry requires a FRESH persisted `previewId` deriving a
  fresh idempotency key and a fresh reservation that CAN claim normally

#### Scenario: A fresh preview claims normally after an unrelated release

- **Given** a released reservation from a prior definitive non-dispatch and a
  retry that creates a fresh persisted `previewId`
- **When** the fresh preview claims a new reservation
- **Then** it claims normally under the full grant/window/cap checks with its own
  key, independently of the retired released key

#### Scenario: Released budget returns to the rolling window in BOTH sums

- **Given** a grant whose remaining budget could not cover a second request while
  one reservation was held, and that reservation is later released on definitive
  no-dispatch
- **When** a new covered request within the rolling window is evaluated — both by
  the claim's authoritative cap total and by the `consumedInWindow` prefilter
- **Then** BOTH rewritten sums exclude the released reservation (summing
  unreleased ledger rows, not audit rows), and the second execution proceeds
  with the returned budget

#### Scenario: Proven pre-dispatch blocks release; every dispatched/uncertain state retains

- **Given** a covered execution whose persisted attempt row is absent, whose
  status is already `cancelled`, whose ownership is ambiguous, or whose settle
  carries a wrong/stale `claim_id` — and, separately, attempts in each
  dispatched/uncertain state (`broadcasting` owned by another worker,
  `submitted`, `uncertain`, `confirmed`, `reverted`, `receipt_invalid`),
  including a provider error mapped to `uncertain` after the request may have
  left the process
- **When** each settles
- **Then** NOTHING is released in any of these cases: no claim row released, no
  `released` audit row, the reservation is retained, and recovery is by
  reference-id reconciliation only with the verbatim-stable provider reference —
  release happens ONLY through the successful exact-owner `broadcasting →
  cancelled` CAS inside the settlement transaction

#### Scenario: The settlement is one atomic transaction gated by the claim ownership token

- **Given** a covered execution whose broadcast returned a definitive
  `not_dispatched`, whose winner holds the persisted `claim_id` ownership token
- **When** the settle runs
- **Then** the exact attempt row transitions `broadcasting → cancelled` only
  where id, status, and `claim_id` all match, and the SAME transaction marks the
  exact grant/idempotency claim released and inserts the `released` audit row;
  an injected failure rolls back BOTH the cancellation and the ledger/audit

#### Scenario: A wrong or stale claim_id cannot cancel or release

- **Given** a settle carrying a `claim_id` that does not match the persisted
  attempt row's token
- **When** the settle CAS executes
- **Then** the attempt is NOT cancelled, nothing is released, no audit row is
  written, and the reservation is retained

#### Scenario: Ambiguous ownership retains rather than releases

- **Given** a settle whose attempt row or claim ownership cannot be resolved
  unambiguously (row missing, multiple candidates, missing token)
- **When** the settle runs
- **Then** nothing is cancelled or released and the reservation is retained

#### Scenario: A preflight rejection cancels and releases from the owned broadcasting state

- **Given** a covered execution whose attempt is already `broadcasting` under
  the winner's `claim_id`, rejected after the claim by policy or recipient
  revalidation and before any dispatch
- **When** the settle runs
- **Then** the same owner-token `broadcasting → cancelled` CAS plus the ledger
  release and audit commit together in one transaction, and any part failing
  rolls back all of it; no `previewed → cancelled` path exists for these
  `runFinancialTransfer` settles, and the broadcasting-to-previewed reset no
  longer exists — a released attempt is never re-opened

#### Scenario: A concurrent attempt winner never has its reservation released

- **Given** two executions racing the same persisted preview, one of which wins
  the single-winner attempt transition and may be broadcasting under the shared
  reservation (same attempt id ⇒ same idempotency key)
- **When** the loser settles without dispatching
- **Then** the loser does NOT release the reservation: it retains the budget
  (its claim was a replay of a live claim) and degrades without a `released`
  audit row, because winner ownership cannot be distinguished from an in-flight
  dispatch at settle time

### Requirement: Persisted preview identity guards provider dispatch

The Solana devnet provider SHALL fail closed on `broadcastTransfer` when the
request carries no persisted preview identity: a missing, empty, or
whitespace-only `previewId` returns `not_dispatched` BEFORE any RPC read
(recent blockhash) and BEFORE any signer call (`signAndSend`). No timestamp,
random, or synthesized fallback reference SHALL be generated. A valid
`previewId` SHALL be used verbatim as the dispatch reference so a retry of the
same persisted preview reuses the identical idempotency identity.

#### Scenario: Missing or blank preview ID is rejected before any dispatch seam

- **Given** a broadcast request whose `previewId` is absent, empty, or
  whitespace-only
- **When** `broadcastTransfer` executes
- **Then** it resolves `not_dispatched` without calling `getRecentBlockhash`
  or `signAndSend`, and no fallback reference is generated

#### Scenario: A valid preview ID dispatches once with stable retry identity

- **Given** a broadcast request with a valid persisted `previewId`
- **When** the transfer is broadcast and later retried after an uncertain
  outcome with the same preview
- **Then** both dispatch attempts use exactly that `previewId` as the reference
  id, so reconciliation correlates one identity across retries

### Requirement: Closed degradation with simple explicit copy

When the coverage outcome is not `covered`, the user-facing copy SHALL state
simply and explicitly that the active authorization did not cover the request, and
the standard preview plus explicit confirmation flow SHALL then run. Raw internal
reason codes MUST NOT be exposed in the HTTP contract: the conversation turn and
decision responses MUST NOT gain a reason-code field for degradation, and reason
codes SHALL remain internal (audit and observability only).

#### Scenario: Degradation copy is explicit and the standard flow follows

- **Given** any non-covered outcome
- **When** the response is produced
- **Then** the copy states that the active authorization did not cover the request,
  and a preview plus explicit confirmation follows

#### Scenario: No reason-code field in the HTTP contract

- **Given** a degraded conversation turn or decision response
- **When** the response is validated against the contract
- **Then** it carries no degrade/reason-code field and uses only the existing result
  shapes

#### Scenario: Degradation is never a hard conversation error

- **Given** any degrade reason, including a ledger/database error
- **When** the user is answered
- **Then** no error result is returned and no hard error is surfaced to the typed
  client or the voice session

### Requirement: Policy readiness gates covered execution

A covered execution SHALL satisfy both planes of D-4: the ledger claim must find a
verified provider policy binding (otherwise `policy_not_ready`), and the provider
enclave policy must permit the transaction at broadcast. A grant without a verified
provider policy binding MUST degrade with `policy_not_ready` before any execution.
The covered path MUST NOT introduce a new execution-time provider-policy readback
beyond the guarantees the existing sync-service architecture already provides;
execution-time detection of policy drift between the ledger and the provider is out
of scope and remains an accepted risk.

#### Scenario: Missing policy binding degrades with policy_not_ready

- **Given** an active, unexpired grant with no verified provider policy binding
- **When** the transfer request is evaluated
- **Then** the outcome is degrade with internal reason `policy_not_ready`, no budget
  is consumed, no broadcast occurs, and the standard preview plus explicit
  confirmation flow runs

#### Scenario: Policy readiness is re-checked at the claim

- **Given** a policy binding observed by the pre-filter that is no longer present
  when the claim runs
- **When** the claim executes
- **Then** it degrades with `policy_not_ready` and no broadcast occurs

#### Scenario: No new execution-time policy readback is introduced

- **Given** a covered execution with all dependencies configured
- **When** it executes
- **Then** the provider interaction is limited to the broadcast, with no additional
  provider policy-readback call required by the flow

### Requirement: Voice and tool surfaces unchanged

Grant authorization SHALL remain HTTP-only. The voice tool surfaces MUST NOT gain a
grant capability and MUST NOT gain a broadcast path, and the confirmation-skip MUST
NOT be delegable to a model tool call: the skip SHALL be decided only inside the
shared conversation service, so every entry point reaches the same decision through
the same service. The existing transcript confirm and cancel paths MUST keep working
for degraded (non-covered) flows.

#### Scenario: The voice tool surface gains no grant or broadcast capability

- **Given** the voice tool surfaces (real-time tools and the agent-tool adapter)
- **When** the model attempts a transfer or asks to skip confirmation
- **Then** no grant-mutating or broadcast tool exists, and the request still routes
  through the conversation service's own decision

#### Scenario: Confirmed and cancelled degraded flows keep working

- **Given** a degraded (non-covered) transfer with a persisted pending preview
- **When** the user confirms or cancels through the existing transcript path
- **Then** the decision is still resolved through the existing flow and the transfer
  proceeds or cancels as today

#### Scenario: Voice and typed entry points reach the same decision

- **Given** identical request data and identical ledger state
- **When** the same transfer is requested from a typed turn and from a voice entry
  point
- **Then** the coverage classification and the resulting behavior are identical

### Requirement: Contract mirroring

Any change to the conversation turn or decision response contract required by
covered execution SHALL be defined in `src/contracts/http.ts` (zod) and
hand-mirrored in `apps/nana-wallet/src/lib/api-types.ts` in the same PR, per the
repository's hard front/backend separation rule. The extension SHALL be minimal: a
covered execution returns an existing terminal/executing result shape instead of
`confirmation_required`, and degradation adds no new field.

#### Scenario: Covered result is mirrored in the same PR

- **Given** a covered execution that returns a terminal/executing result instead of
  `confirmation_required`
- **When** the change is submitted
- **Then** both `src/contracts/http.ts` and
  `apps/nana-wallet/src/lib/api-types.ts` express it in the same PR

#### Scenario: Both sides accept the same covered and degraded payloads

- **Given** the mirrored request/response types
- **When** a covered result and a degraded result are validated against both
  definitions
- **Then** both definitions accept the same payloads and their shapes agree

### Requirement: Demo boundary and testnet-only scope

`WDK_TOOLS_SOURCE` SHALL keep its `fixture` default, and this capability SHALL
remain devnet/testnet-only: no mainnet and no live funds. No live credential SHALL
be required by this change's tests, and database-backed suites MUST actually run
(local pgvector service) rather than self-skip, so covered-path claims, races, and
idempotency are genuinely exercised.

#### Scenario: Fixture default is preserved

- **Given** the repository configuration defaults
- **When** they are inspected
- **Then** `WDK_TOOLS_SOURCE` still defaults to `fixture` and the covered path
  requires no live provider credential

#### Scenario: Covered execution stays on devnet/testnet

- **Given** the covered execution path
- **When** a network is selected for a transfer
- **Then** only devnet/testnet networks are supported and mainnet remains out of
  scope

#### Scenario: Change tests need no live credentials

- **Given** this change's test suites
- **When** they run against the local pgvector database without live credentials
- **Then** they pass, and the database-backed suites are not self-skipped
