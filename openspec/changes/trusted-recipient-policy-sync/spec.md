# Spec Delta: trusted-recipient-policy-sync

Consolidated delta for change `trusted-recipient-policy-sync`. Five capabilities are
changed: one added (`trusted-recipient-policy-sync`) and four modified
(`recipient-address-memory`, `delegated-grant-core`, `unified-agent-tools`,
`voice-transfer-confirmation`). Every requirement uses RFC 2119 keywords and carries at
least one Given/When/Then scenario. Requirement names and IDs of modified capabilities
are reused verbatim from their published baselines; no parallel IDs are introduced.

## Baseline references

`openspec/specs/` holds no merged domain specification in this repository yet, so
MODIFIED deltas resolve against the requirement blocks published by the archived change
specs below (unmodified requirements are not repeated; only the blocks this change edits
are reproduced in full).

| Capability | Baseline requirement source |
|---|---|
| `recipient-address-memory` | `openspec/changes/archive/recipient-address-memory/specs/recipient-address-memory/spec.md` (RAM-001…RAM-007), modified once by `openspec/changes/archive/privy-multi-user-foundation/specs/recipient-address-memory/spec.md` (RAM-008 ADDED, RAM-001 MODIFIED) |
| `delegated-grant-core` | `openspec/changes/archive/delegated-grant-core/specs/delegated-grant-core/spec.md` |
| `unified-agent-tools` | `openspec/changes/archive/unify-agent-tools/specs/unified-agent-tools/spec.md` |
| `voice-transfer-confirmation` | `openspec/changes/archive/slice4-voice-confirmation/specs/voice-transfer-confirmation/spec.md` |

## Capability: `trusted-recipient-policy-sync` (added)

## ADDED Requirements

### Requirement: Single recipient management service and single policy composer

One user-scoped recipient management service SHALL be the only writer of
trusted-recipient intent for the screen, the text agent, and the voice agent. That
service MUST bind user, wallet, and network server-side; a model or client MUST NOT
supply policy ID, signer ID, cap, or network. The complete attached policy SHALL be
built by exactly one serialized composer per wallet from the enrollment permission plus
the active delegated grants. No second full-rule writer MAY remain reachable: every
policy-writing path (contacts, enrollment, delegated grant create, revoke, expiry,
retry) MUST route through that composer, and a path that cannot MUST fail visibly
instead of issuing an independent full-rule replacement.

#### Scenario: Screen, text, and voice converge on one service

- **Given** a user with one ready `solana-devnet` wallet and a ready signer permission
- **When** the same trusted recipient is created once through the screen, once through the text agent, and once through the voice agent
- **Then** all three mutations are persisted and composed by the same recipient management service
- **And** the resulting composed policy differs only by the added address

#### Scenario: No competing full-rule writer remains reachable

- **Given** the enrollment path, the delegated grant create/revoke/expiry paths, and the retry path
- **When** each path mutates the attached policy
- **Then** each one composes through the single composer and appends a revision
- **And** no independent code path replaces the complete rule set

#### Scenario: Unsupported writer path fails visibly

- **Given** a policy-writing path that cannot route through the composer
- **When** it executes
- **Then** it returns a typed configuration error
- **And** no partial or competing remote write is issued

#### Scenario: Server owns identity, wallet, and network

- **Given** a model tool call or HTTP body containing `policyId`, `signerId`, a cap, or a `network`
- **When** the mutation is validated
- **Then** the strict contract rejects the field and the server derives user, wallet, network, and permission identity itself

### Requirement: Invariants preserved through every composition

Every composition, retry, and rollback step MUST preserve the ordinary trusted-contact
transfer ceiling of 10,000,000 lamports (0.01 SOL), the policy ID, the canonical signer
attachment, unrelated signers, policy ownership, and already approved delegated limits
and expirations. Adding a trusted contact MUST NOT create an automatic-payment
(delegated) grant and MUST NOT alter delegated contributions.

#### Scenario: Ordinary cap unchanged after add, edit, and remove

- **Given** an attached policy whose ordinary transfer rule caps at 10,000,000 lamports
- **When** a recipient is added, renamed, and removed
- **Then** the composed ordinary transfer rule still caps at exactly 10,000,000 lamports

#### Scenario: Signer identity, unrelated signers, and ownership preserved

- **Given** an attached policy with a canonical signer attachment, an unrelated additional signer, and a recorded owner
- **When** any contact mutation is composed
- **Then** the policy ID, canonical signer, unrelated signer, and owner are byte-for-byte preserved

#### Scenario: Approved delegated limits and expiries are not silently changed

- **Given** active delegated grants with approved per-transfer limits, cumulative limits, and expiries
- **When** a trusted recipient is added, edited, or removed
- **Then** each surviving grant keeps its exact approved limit and expiry
- **And** no grant is extended, narrowed, or re-granted as a side effect

#### Scenario: Adding a contact creates no automatic-payment grant

- **Given** a wallet with no eligible delegated grant for the added address
- **When** the contact is created
- **Then** zero grants are created and no delegated contribution is composed
- **And** the first transfer to that address still requires the ordinary preview and explicit confirmation flow

### Requirement: Consent provenance for the retained baseline

The retained baseline allowlist MUST be derived from durable consent provenance: the
active `signer_grants` enrollment consent snapshot for retained enrollment addresses,
and the active confirmed contact ID plus version for each trusted recipient. A remote
GET is observed/applied state and MUST NEVER be treated as a consent source or copied
into desired state. Unknown remote rules, owner drift, and signer-attachment drift MUST
block mutation of the affected policy rather than be deleted, narrowed, or adopted. The
existing local/remote drift MUST be repaired by the same reconciler from those recorded
consent sources; a one-off database patch MUST NOT be the repair path.

#### Scenario: Baseline comes from the consent snapshot, not from the remote allowlist

- **Given** the enrollment consent snapshot contains only the wallet's own retained address
- **And** the remote policy additionally allows an address with no consent record
- **When** the next composed revision is built
- **Then** the desired baseline contains the consented retained address
- **And** the unconsumed remote entry is neither adopted into desired state nor silently deleted

#### Scenario: Unknown remote rule blocks mutation

- **Given** the remote policy contains a rule with no matching consent source
- **When** any contact mutation for that wallet is attempted
- **Then** the mutation stops with the blocked-conflict status
- **And** the remote policy is left untouched and no rule is deleted to force convergence

#### Scenario: Owner or attachment drift blocks mutation

- **Given** the remote policy's owner or canonical signer attachment differs from the recorded consent binding
- **When** any policy mutation for that wallet is attempted
- **Then** the mutation is blocked as `blocked configuration`
- **And** no PATCH is issued and no recorded owner or signer binding is overwritten

#### Scenario: Known drift is repaired by the reconciler, not by a database patch

- **Given** the persisted allowlist and `policy_hash` disagree with the remote policy for an address whose provenance is the active confirmed contact ID and version (for example the existing `Test1` drift)
- **When** the reconciler runs after the applied revision matches
- **Then** the drift is repaired through the composer using the recorded consent provenance and recorded as evidence
- **And** no one-off database patch is used as the repair

### Requirement: Atomic recipient mutation with desired revision and granted-scope revocation

A confirmed recipient mutation SHALL persist, in one database transaction: the contact
change, the incremented desired policy revision for the wallet, the revocation of every
affected granted scope, and its revocation audits. Remote provider I/O MUST occur
outside that transaction. The lock order spanning wallet serialization and the existing
claim/revoke locks MUST be documented once and acquired in that same order by every
writer.

#### Scenario: Failed transaction leaves no partial state

- **Given** a confirmed removal whose transaction fails after the contact row is written
- **When** the transaction rolls back
- **Then** the contact is unchanged, the desired revision is not incremented, no grant is revoked, and no revoke audit exists

#### Scenario: Remote I/O stays outside the contact transaction

- **Given** a provider PATCH that takes longer than the transaction budget
- **When** the mutation commits
- **Then** the contact, desired revision, grant revocations, and audits are committed before the provider call starts
- **And** no database lock is held open across the remote call

#### Scenario: Concurrent delegated claim and removal

- **Given** a delegated claim in flight for a grant that a last-alias removal affects
- **When** both operations proceed concurrently
- **Then** one serialized order applies and the grant is either fully claimed or fully revoked
- **And** no state exists where the claim succeeded against a revoked scope

#### Scenario: Documented lock order prevents deadlock

- **Given** two writers that must take wallet serialization and a grant claim/revoke lock
- **When** both acquire their locks
- **Then** both acquire them in the documented global order and neither blocks the other indefinitely

### Requirement: Cross-process wallet serialization with revision verification

Policy application SHALL be serialized across the backend and voice worker processes by
a database-backed wallet ownership or lease with bounded acquisition and explicit
release, and every write MUST verify the revision it is applying. A stale writer MUST
NOT overwrite a newer applied policy; it MUST abandon or recompose. Persisted intent
MUST survive process restart, and recovery MUST resume from persisted intent instead of
fabricating a result.

#### Scenario: Two processes contend for the same wallet

- **Given** the backend and the voice worker both want to sync the same wallet
- **When** both attempt acquisition
- **Then** exactly one holds the lease and the other waits or defers
- **And** no interleaved PATCH is issued for that wallet

#### Scenario: A stale writer cannot overwrite a newer applied policy

- **Given** writer A composes desired revision 7 while revision 8 becomes applied
- **When** A submits its write
- **Then** A's write is rejected and revision 8's applied policy stands
- **And** A's intent is recorded as superseded, not applied

#### Scenario: Crash and restart recover from persisted intent

- **Given** a process that dies after committing desired intent and before verified readback
- **When** the process restarts
- **Then** the retry resumes from the persisted intent
- **And** the wallet's status only advances after a signed readback verifies the rules

### Requirement: Applied-revision binding for automatic executions

Delegated coverage and claim SHALL require the wallet's verified applied revision or
policy hash matching the intended effective policy. `provider_policy_id` alone MUST NOT
be sufficient. An ambiguous PATCH outcome, a readback mismatch, or an unknown remote
rule, owner, or attachment MUST block every affected automatic execution for that
wallet, including sibling grants of other recipients, until verified reconciliation
completes. A timeout means the outcome is unverified, so a signed remote GET MUST
establish the actual state before any retry.

#### Scenario: Ambiguous PATCH blocks sibling grants as well

- **Given** two automatic grants on the same wallet and a PATCH for one of them with an unknown outcome
- **When** an automatic transfer against the sibling grant is evaluated
- **Then** the sibling also degrades to the confirmation flow
- **And** neither grant auto-executes until reconciliation verifies the applied policy

#### Scenario: Mismatched readback blocks automatic execution

- **Given** a readback whose rules differ from the intended effective policy
- **When** coverage for an automatic transfer is evaluated
- **Then** the decision degrades closed and the transfer requires ordinary confirmation
- **And** the mismatch is recorded as evidence

#### Scenario: A bound policy ID alone is insufficient

- **Given** a grant bound to the wallet's `provider_policy_id` but with no verified applied revision or hash match
- **When** coverage is evaluated
- **Then** automatic execution is refused
- **And** the grant is not treated as executable on the strength of the identifier alone

#### Scenario: Timeout means unverified, so GET precedes retry

- **Given** a PATCH that timed out
- **When** a retry is considered
- **Then** a signed remote GET is performed first
- **And** the retry only proceeds from the observed state, never blind

#### Scenario: Verified match restores automatic execution

- **Given** a wallet whose verified applied revision and hash match the intended effective policy
- **When** an eligible delegated transfer is evaluated
- **Then** the covered execution path may proceed under its approved limits

### Requirement: Effective status vocabulary and no premature success

The permission lifecycle SHALL expose exactly these observable states: saved or not
configured, pending, syncing, applied, retryable failure, and blocked
conflict/configuration. No screen, text reply, voice narration, or API field MAY report
enabled, applied, or revoked before a signed remote readback verifies the exact rules
and the canonical signer attachment. A pending removal MUST NOT be announced as a
verified remote revocation. A contact on a wallet without a ready permission MUST
remain saved and not enabled.

#### Scenario: Enabled is reported only after verified readback

- **Given** a saved recipient whose policy application has not yet been read back
- **When** the screen, the text reply, and the voice narration report the outcome
- **Then** none of them reports enabled or applied
- **And** the reported state is one of the non-success vocabulary values

#### Scenario: Timeout is reported as unverified

- **Given** a policy PATCH that timed out
- **When** the save reply is produced
- **Then** the state is pending, syncing, or retryable failure
- **And** no success wording, toast, or spoken "habilitado" is produced

#### Scenario: A pending removal is not announced as a verified revocation

- **Given** a removal whose remote readback has not confirmed the revoked scope
- **When** the removal result is reported
- **Then** the reply states that remote revocation is not yet verified
- **And** no verified-revocation claim is produced

#### Scenario: Wallet without a ready permission stays saved and not enabled

- **Given** a user whose wallet has no ready signer permission
- **When** a trusted recipient is saved
- **Then** the contact is persisted as saved and not enabled
- **And** no policy write is attempted and no automatic-payment capability is implied

#### Scenario: Retryable failure is retriable from persisted intent

- **Given** a retryable failure already recorded
- **When** the user or the reconciler retries
- **Then** the retry runs from the persisted intent and updates the state only from verified readback

### Requirement: Last-active-alias removal semantics and disclosure

When a removal or address replacement eliminates the last active alias for an address,
that address's affected delegated grants SHALL be revoked whole. A grant covering
several addresses MUST be revoked whole rather than narrowed by invention; unrelated
grants MUST be preserved; grants MUST NEVER be migrated to a replacement address.
Removing one alias MUST NOT revoke another active alias for the same address. The
revocation consequence MUST be disclosed to the user in the screen and agent proposals
before the mutation executes, and a revocation MUST NOT be advertised as verified before
remote readback confirms it. Ledger state, whole-grant revocation, and revoke audits are
specified in `delegated-grant-core`.

#### Scenario: Removing the last alias revokes the affected whole grant

- **Given** an address with exactly one active contact alias and one active delegated grant whose allowlist includes it
- **When** the user confirms the removal
- **Then** the affected grant is revoked in the same transaction as the contact change
- **And** a revoke audit row is appended for it

#### Scenario: Remaining alias protects the grant

- **Given** two active contact aliases for the same address and an active delegated grant for that address
- **When** one alias is removed
- **Then** the grant is not revoked and the address stays authorized through the remaining alias

#### Scenario: Unrelated grants and later-approved grants are preserved

- **Given** active delegated grants for other addresses, and a later explicitly approved grant for this address
- **When** the last alias for this address is removed
- **Then** the grants for other addresses are preserved unchanged
- **And** the later grant's own approval governs it rather than the removal

#### Scenario: No grant is migrated to a replacement address

- **Given** an address replacement from A to B
- **When** the replacement is composed
- **Then** grants for A are retired under the approved semantics
- **And** no grant is rewritten, transferred, or extended to cover B

#### Scenario: Revocation is disclosed before mutation

- **Given** a removal that will revoke an affected automatic-payment grant
- **When** the screen or agent proposal is presented
- **Then** the proposal states which automatic-payment grants will be revoked
- **And** no mutation is executed before that disclosure is confirmed

### Requirement: Metadata edits never broaden permission and address edits invalidate stale state

Editing only a contact's name or description MUST NOT broaden remote permission, and the
system MUST validate that the composed rule set is unchanged. An address edit MUST
invalidate stale selections and previews and MUST recompose both the old and the new
address.

#### Scenario: Renaming an existing contact changes no rule

- **Given** an applied policy for a contact
- **When** only the name or description is edited
- **Then** the validated composed rule set is identical to the previously applied rules
- **And** no additional address, cap, or scope is granted

#### Scenario: Denying permission broadening is a validation failure, not a merge

- **Given** a metadata edit whose recomposed rules would differ from the applied rules
- **When** the edit is evaluated
- **Then** the mutation is blocked as blocked conflict instead of being applied silently

#### Scenario: Address edit invalidates stale selections and previews

- **Given** a pending transfer preview or a selected contact version for the old address
- **When** the contact's address is edited
- **Then** that selection and preview are invalidated and MUST be re-resolved by the user
- **And** the composition covers the old and the new address under the approved semantics

### Requirement: Empty composition never broadens authority

Composition MUST NEVER be detached in a way that leaves the signer unrestricted. If the
composed recipient set would become empty, an explicitly supported deny behaviour MUST
be proven first. If that behaviour cannot be proven, the existing restrictive policy
MUST be retained and the operation MUST stop visibly with an explicit message; the last
recipient MUST be kept.

#### Scenario: Unproven empty-policy support blocks the last removal

- **Given** a wallet whose composed recipient set would become empty and no proven supported deny representation
- **When** the user asks to remove or replace the last trusted recipient
- **Then** the operation stops visibly with an explicit message and the recipient is kept
- **And** the existing restrictive policy is left attached and unchanged

#### Scenario: Proven deny behaviour never detaches the policy

- **Given** an established supported deny representation for empty composition
- **When** the composed set becomes empty
- **Then** the composed policy uses that supported deny representation
- **And** the policy is never detached, deleted, or left with an absent recipient rule

### Requirement: Unproven provider semantics are explicit stop conditions

Provider semantics that the approved design does not prove — support for an empty
composed policy, the canonical signer binding asserted by readback, and policy-ownership
conflicts — MUST be treated as blocking verification conditions. The system MUST stop
with blocked configuration instead of assuming a resolution whenever the supported
empty/deny composition cannot be established, the canonical signer attachment cannot be
proven from readback, or the remote owner differs from the recorded owner.

#### Scenario: Signer binding cannot be proven

- **Given** a readback that does not prove the canonical signer attachment
- **When** a composed revision is about to be applied
- **Then** the mutation stops as blocked configuration
- **And** no policy write is attempted and the previous policy stays attached

#### Scenario: Ownership conflict stops the flow

- **Given** a remote policy owned by an identity other than the recorded owner
- **When** any mutation is attempted
- **Then** the flow stops as blocked configuration with the conflict recorded as evidence
- **And** the remote owner is neither adopted nor overwritten

#### Scenario: Stops are recorded, not silently assumed

- **Given** any of the unproven conditions above
- **When** the operation stops
- **Then** the stop, its reason, and the observed evidence are persisted
- **And** the product surface reports the blocked state instead of a fabricated outcome

### Requirement: Immutable action-bound proposal and one-use authorization

A recipient mutation SHALL be represented by a server-owned, immutable, versioned
proposal containing the action kind, the contact ID and exact old/new address, the
disclosure of any granted-scope revocation, an expiry, and the user binding.
Authorization MUST be authenticated to the bound user and session, MUST occur after the
proposal exists, MUST consume exactly one proposal version exactly once, and MUST
expire. Replay, foreign session, foreign speaker, a missing or delayed final
affirmative, a model-provided confirmation ID, and voice user-turn counters MUST fail
closed. A contact affirmative MUST NEVER authorize a transfer, and a transfer
affirmative MUST NEVER authorize a contact action.

#### Scenario: One authenticated later affirmative authorizes exactly one action once

- **Given** a persisted contact proposal and a later authenticated final affirmative in the bound session
- **When** the matching recipient tool consumes it
- **Then** exactly one mutation executes for that proposal version
- **And** the evidence is consumed and cannot be reused

#### Scenario: Replay of consumed evidence fails closed

- **Given** evidence already consumed for a proposal version
- **When** the same utterance or the same tool call is presented again
- **Then** the second attempt is refused and no mutation executes

#### Scenario: Foreign session or foreign speaker fails closed

- **Given** evidence that originates in another session, another room participant, or an unauthenticated source
- **When** it is presented as authorization
- **Then** it cannot authorize the proposal and the mutation is refused

#### Scenario: Pre-proposal and expired affirmatives fail closed

- **Given** an affirmative spoken before the proposal existed or after its expiry
- **When** it is presented as authorization
- **Then** the proposal is refused and a fresh proposal is required

#### Scenario: Model-provided identifiers are not evidence

- **Given** a model tool call carrying its own confirmation ID, timestamp, or voice turn counter
- **When** authorization is evaluated
- **Then** those values are not accepted as consent and the call fails closed

#### Scenario: Contact and transfer affirmatives never cross-authorize

- **Given** a pending contact action and a pending transfer preview in the same session
- **When** a single affirmative arrives
- **Then** it can authorize only the action kind it belongs to
- **And** no shared affirmative authorizes both, in either direction

### Requirement: Voice permission creation requires a published proposal and a verified address

For the voice path the server MUST persist the contact-action proposal and publish it,
with the exact address, action, version, and revocation effects, to the bound
authenticated conversation UI. The voice authorization window MUST open only after that
publication succeeds. Creating a permission or replacing an address MUST require a
verified pasted or scanned address; a spoken-only, inferred, or name-derived address
MUST NEVER be a permission source. Without a bound visual client or a verified address
source, permission creation MUST be refused, and the contact MAY be saved as not
enabled.

#### Scenario: The window opens only after successful publication

- **Given** a persisted contact proposal for voice permission creation
- **When** the proposal card is published to the bound authenticated conversation UI
- **Then** the voice authorization window opens for that immutable proposal version
- **And** an affirmative received before successful publication cannot authorize it

#### Scenario: Absent bound visual client refuses permission creation

- **Given** a voice session with no bound visual client to receive the proposal card
- **When** the user asks to create a trusted recipient by voice
- **Then** permission creation is refused and the missing review channel is requested
- **And** the contact may be saved as not enabled

#### Scenario: Spoken-only or inferred address is rejected

- **Given** an address that exists only in spoken input or model inference
- **When** permission creation is attempted
- **Then** the request is refused and a verified pasted or scanned address is requested

#### Scenario: Name-derived address is never accepted

- **Given** a model attempt to derive an address from a contact name or description
- **When** the mutation is validated
- **Then** the address is rejected as unverified evidence
- **And** no contact or permission change occurs

### Requirement: Versioned `/v1` contract with mirrored frontend types

The `/v1` recipient contract SHALL expose permission readiness and the desired and
applied policy revision, and mutations SHALL be version-aware and idempotent. Unknown or
stale remote state MUST be reported through explicit conflict errors rather than
overwriting it. The frontend MUST mirror the contract in
`apps/nana-wallet/src/lib/api-types.ts` within the same change. Read APIs MUST NOT expose
secrets, signatures, or key material. The recipient surface MUST NOT offer a chain
picker and MUST validate only Solana addresses.

#### Scenario: Readiness and revisions are exposed

- **Given** a saved recipient with a composed revision
- **When** the client reads the recipient list
- **Then** the response carries the readiness state and the desired and applied revisions

#### Scenario: Stale or unknown remote state produces a conflict error

- **Given** a mutation whose expected version is stale, or a wallet whose remote state cannot be reconciled
- **When** the mutation is submitted
- **Then** the API returns an explicit conflict error instead of applying or overwriting the state

#### Scenario: Idempotent mutation replay

- **Given** a mutation submitted twice with the same idempotency key
- **When** the second request is processed
- **Then** exactly one recipient mutation is persisted and the same result is returned

#### Scenario: Both contract sides are updated together

- **Given** any change to the recipient endpoint schemas
- **When** the change is delivered
- **Then** `src/contracts/http.ts` and `apps/nana-wallet/src/lib/api-types.ts` are both updated

#### Scenario: Reads expose no secrets and no chain selector

- **Given** an authenticated read of the recipient surface
- **When** the response payload is inspected
- **Then** it contains no secret, private key, signature value, or signer credential
- **And** no chain selector is offered, since only Solana addresses are accepted

#### Scenario: Non-Solana or malformed address is rejected

- **Given** a draft or write containing an EVM address or a malformed Solana key
- **When** it is validated
- **Then** the request is rejected with a typed validation error and nothing is persisted

### Requirement: Two-process capability with contained secrets

The backend (`src/server.ts`) and the voice worker (`src/livekit/worker.ts`) MUST both
receive the injected recipient management service and a signed-authorization
capability. The existing worker loopback endpoint MUST NOT be assumed reachable from the
backend. A private key MUST NOT exist in the frontend or in general application
containers. Authorization MUST be verified without exposing secret or signature values.

#### Scenario: Both processes receive the service and the capability

- **Given** a running backend and a running voice worker
- **When** each process composes a policy revision
- **Then** both use the injected recipient management service and their own signed-authorization capability
- **And** neither falls back to an alternate local writer

#### Scenario: Worker loopback is not a backend loopback

- **Given** the worker's loopback endpoint
- **When** the backend needs to apply a policy
- **Then** it uses its own injected capability and does not depend on the worker's loopback address

#### Scenario: No private key outside the dedicated signer

- **Given** the frontend container and the general application containers
- **When** their environment and mounted configuration are inspected
- **Then** no private key material or signing secret is present

#### Scenario: Authorization verified without exposing secret values

- **Given** a signed-authorization probe
- **When** connectivity and authority are verified
- **Then** the probe reports only a boolean or status outcome
- **And** no secret, key, or signature value is logged, returned, or echoed

## Capability: `recipient-address-memory` (modified)

## ADDED Requirements

### Requirement: RAM-009 Solana recipient validation on draft, write, and selected-address lookup

Recipient draft, recipient write, and selected-address lookup MUST validate the address
with the configured chain's validator instead of the EVM validator. For `solana-devnet`
a recipient MUST be a canonical base58 Solana public key, and EVM address validation
MUST NOT gate a Solana recipient. A malformed, wrong-length, or unknown-chain identifier
MUST fail closed and MUST NOT be persisted or resolved. Confirmed fact memory MUST keep
its separate path and MUST NOT expand payment permissions.

#### Scenario: Valid Solana recipient passes draft and write

- **GIVEN** a canonical base58 Solana public key for `solana-devnet`
- **WHEN** a recipient draft is created and then written after exact confirmation
- **THEN** both validations pass and the address is persisted unchanged

#### Scenario: EVM validation no longer rejects a Solana recipient

- **GIVEN** a recipient write on the Solana configuration
- **WHEN** validation runs
- **THEN** the EVM validator is not the acceptance gate and the Solana key is accepted

#### Scenario: Wrong-chain or malformed identifier fails closed

- **GIVEN** an EVM-shaped address or a malformed Solana key
- **WHEN** draft, write, or selected-address lookup runs
- **THEN** a typed validation error is returned and no record is created or resolved

#### Scenario: Fact memory never expands permissions

- **GIVEN** a confirmed fact-memory write mentioning a person
- **WHEN** it is persisted
- **THEN** no trusted-recipient record, address, or permission contribution is created by it

## MODIFIED Requirements

### Requirement: RAM-005 Confirmed Durable Writes

`write_user_memory` MUST persist only user-provided facts or recipients after explicit
confirmation. Address creation or change MUST confirm the exact address. Rejection,
missing confirmation, or invalid data MUST preserve memory unchanged. Trusted-recipient
records MUST additionally be written through the scoped recipient management service
rather than through a memory-local write path, and a Solana recipient MUST validate as a
canonical base58 public key scoped to `solana-devnet` before it is persisted. Confirmed
fact memory MUST keep its separate path and MUST NOT create or broaden a payment
permission.
(Previously: any recipient record accepted by the memory write path was persisted locally; now trusted-recipient records route through the recipient management service and require Solana-validated addresses.)

#### Scenario: Confirmed relationship write

- GIVEN the user states Lucas is their grandson
- WHEN the displayed fact is confirmed
- THEN `write_user_memory` MAY persist it

#### Scenario: Unconfirmed address update

- GIVEN an address lacks exact confirmation
- WHEN writing is attempted
- THEN no record changes

#### Scenario: Trusted-recipient write goes through the recipient management service

- GIVEN a confirmed trusted-recipient creation or address change
- WHEN it is persisted
- THEN the scoped recipient management service performs the write and records the desired policy revision
- AND no memory-local path writes the recipient record directly

#### Scenario: Invalid Solana address preserves memory unchanged

- GIVEN a recipient address that is not a canonical base58 Solana public key
- WHEN a write is attempted
- THEN a typed validation error is returned and no record changes

### Requirement: RAM-007 Exact Address Handoff and Compatibility

`get_recipient_address` MUST return the exact current address only for the authenticated
user's resolved ID. Revalidation before preview and confirmation MUST invalidate changed,
missing, invalid, or mismatched selections and approvals. For Solana recipients the
returned address MUST be a canonical base58 Solana public key scoped to `solana-devnet`,
and the handoff MUST carry the recipient version through the recipient management
service so a stale version fails closed. Existing WDK MCP, explicit-address, Sepolia
USD₮, dry-run, and approval behavior MUST remain unchanged.
(Previously: the handoff validated and returned the stored exact address with version revalidation; now the Solana handoff additionally requires canonical Solana key validation and service-owned version binding.)

#### Scenario: Revalidated transfer

- GIVEN a resolved record remains valid
- WHEN preparing preview
- THEN WDK `to` equals its exact address
- AND existing controls apply

#### Scenario: Record changes after selection

- GIVEN a selection changes before preview or confirmation
- WHEN revalidated
- THEN selection and approval are invalidated
- AND resolution repeats

#### Scenario: Solana handoff returns only a canonical Solana key

- GIVEN a resolved Solana recipient scoped to `solana-devnet`
- WHEN `get_recipient_address` returns the address
- THEN the value is the canonical base58 public key and no EVM validation was applied to it
- AND an unversioned or stale handoff is refused

## Capability: `delegated-grant-core` (modified)

## ADDED Requirements

### Requirement: Delegated execution requires the wallet's verified applied policy revision

Grant-covered auto-execution SHALL require that the wallet's verified applied policy
revision and hash match the intended effective policy for that grant's scope. The
wallet's `provider_policy_id` alone MUST NOT authorize an execution. While the wallet's
applied state is unverified — ambiguous PATCH, mismatched readback, or unknown remote
rule, owner, or attachment — every affected grant, including siblings for other
recipients, MUST degrade to the ordinary confirmation flow.

#### Scenario: Applied-revision mismatch degrades the whole wallet

- **Given** a grant whose scope is covered by the intended policy but whose wallet applied revision is unverified
- **When** an automatic execution is evaluated
- **Then** the decision degrades to the confirmation flow
- **And** sibling grants for other recipients degrade with it

#### Scenario: Verified revision allows covered execution within approved bounds

- **Given** a wallet whose verified applied revision and hash match the intended effective policy
- **When** an automatic execution within the grant's per-transfer and cumulative limits is evaluated
- **Then** the covered execution proceeds without a second confirmation under the existing grant rules

#### Scenario: Policy identifier alone is not authority

- **Given** a grant bound only by `provider_policy_id`
- **When** coverage is evaluated without a verified applied revision or hash
- **Then** the auto-execution path is refused and the ordinary confirmation flow applies

### Requirement: Atomic revocation of affected grants on last-alias removal

When the last active contact alias for an address is removed or replaced, every affected
delegated grant whose allowlist includes that address SHALL be revoked whole in the same
database transaction as the contact mutation, and each revocation SHALL append its
immutable `revoked` audit row in that transaction. A grant covering several addresses
MUST be revoked whole rather than narrowed by invention; grants for unrelated addresses
MUST be preserved unchanged; a grant MUST NEVER be migrated, rewritten, or extended to
cover a replacement address. A grant whose scope remains covered by another active alias
MUST NOT be revoked.

#### Scenario: Whole-grant revocation with audit in one transaction

- **Given** an active grant whose allowlist includes the address and no other active alias for it
- **When** the last alias is removed
- **Then** the grant transitions to `revoked` and its `revoked` audit row is appended in the same transaction as the contact mutation

#### Scenario: Multi-address grant is revoked whole, not narrowed

- **Given** an active grant whose allowlist contains the address and a second address
- **When** the last alias for the first address is removed
- **Then** the entire grant is revoked rather than being rewritten with only the second address
- **And** the revocation is audited with its reason

#### Scenario: Another active alias prevents revocation

- **Given** a second active alias for the same address
- **When** one alias is removed
- **Then** the grant stays active and no revoke audit is appended

#### Scenario: Unrelated grants are preserved and none is migrated

- **Given** active grants for other addresses
- **When** an address is removed or replaced
- **Then** those grants are byte-for-byte unchanged and no grant is rewritten to cover the replacement address

## MODIFIED Requirements

### Requirement: Privy Solana policy sync driven by the grants ledger

The grants ledger SHALL be the single decision authority for creating, rotating,
and revoking the delegated signer's Privy Solana policy. Grant-covered
executions SHALL require both the ledger validation to pass and the Privy policy
to permit the transaction. A policy sync failure SHALL leave the grant
non-executable (fail-closed). Policy sync SHALL be composed by the single serialized
wallet composer rather than by an independent full-rule replacement, every sync SHALL
verify the revision it applies, and a sync outcome that cannot be verified SHALL block
the affected automatic executions until verified reconciliation completes.
(Previously: the grants path issued its own full-rule policy update and treated a successful sync call as sufficient.)

#### Scenario: Grant creation provisions the signer policy when an adapter is available

- **Given** the D-4 hybrid decision, a created `active` grant, and an available
  denomination-safe provider policy adapter
- **When** the ledger processes policy sync
- **Then** the delegated signer's Privy Solana policy reflects per-transfer max,
  recipient allowlist, and temporal window, and an audit row `policy_synced` is
  appended

#### Scenario: Missing provider adapter leaves a grant non-executable

- **Given** a created grant and no denomination-safe provider adapter
- **When** the production server attempts policy sync
- **Then** it appends `policy_sync_failed`, returns `policyReady: false`, and
  refuses grant-covered execution until a provider policy is bound

#### Scenario: Policy sync failure keeps execution blocked

- **Given** a policy sync that fails (provider error)
- **When** the sync outcome is recorded
- **Then** an audit row `policy_sync_failed` is appended, `policyReady` remains
  false, and no grant-covered execution can proceed for it (the lifecycle state
  remains `active` because the grant is neither revoked nor expired)

#### Scenario: Revocation removes policy enforcement surface

- **Given** a revoked grant
- **When** the ledger processes revocation sync
- **Then** the signer policy no longer permits the revoked scope and the audit
  trail records the sync

#### Scenario: Sync composes through the single wallet composer

- **Given** a granted-scope change on a wallet that also has trusted contacts
- **When** policy sync runs
- **Then** the composed revision contains the enrollment baseline, the active contacts, and this grant
- **And** no independent full-rule replacement is issued

#### Scenario: Unverified sync blocks automatic execution

- **Given** a sync whose readback could not be verified
- **When** an automatic execution is evaluated for any grant of that wallet
- **Then** the execution degrades closed to the ordinary confirmation flow until reconciliation verifies the applied revision

## Capability: `unified-agent-tools` (modified)

## ADDED Requirements

### Requirement: Version-bound recipient lifecycle tools in both agents

The shared tool surface SHALL expose trusted-recipient create, edit, and remove tools to
both the text agent and the voice agent. Those tools MUST accept only stable contact
identifiers and exact versions; they MUST NOT accept an arbitrary address, a network, a
policy identifier, a signer, or a cap from the model. Ambiguous name references MUST be
resolved by asking before any mutation. A stale or mismatched version MUST fail closed.
Every mutation MUST route through the recipient management service and MUST be bound to
an immutable versioned proposal.

#### Scenario: Both agents expose the recipient lifecycle tools

- **Given** the shared tool definition with a text context and a voice context
- **When** the tool name lists of both agents are compared
- **Then** the recipient create, edit, and remove tools appear in both surfaces from the same definition

#### Scenario: The model cannot supply an address, network, or permission scope

- **Given** a model call for a recipient mutation containing an address, a network, a policy id, a signer, or a cap
- **When** the strict schema validates the call
- **Then** the call is rejected with a typed error and no mutation occurs

#### Scenario: Ambiguous name is resolved before mutation

- **Given** two contacts matching the spoken or typed reference
- **When** a recipient edit or removal is requested
- **Then** the agent asks which exact contact and version is intended
- **And** no mutation is executed before that resolution

#### Scenario: Stale version fails closed

- **Given** a mutation referencing a contact version that changed after the proposal
- **When** the tool executes
- **Then** the mutation is refused, a fresh proposal is required, and no policy change occurs

#### Scenario: Mutations route through the recipient management service

- **Given** any recipient create, edit, or remove request from either agent
- **When** it is executed
- **Then** the scoped recipient management service performs the mutation
- **And** the agent reports only the actual resulting status

## MODIFIED Requirements

### Requirement: Single shared tool definition for text and voice agents

The system SHALL define agent tools once in `src/agent/definition.ts`
(`createWalletAgentDefinition()`) and both the text agent (AI SDK) and the voice
agent (LiveKit realtime) SHALL consume that definition through their respective
adapters. `src/agent/definition.ts` MUST NOT import from `@livekit/*`; only the
LiveKit side imports the definition. The shared definition SHALL include the
trusted-recipient create, edit, and remove tools, and the parity assertion MUST cover
them.
(Previously: parity covered the then-existing shared tools; the recipient lifecycle tools were not part of the shared definition.)

#### Scenario: Both agents expose the same shared tools

- **Given** the canonical tool definition with a text context and a voice context
- **When** the tool name lists of both agents are compared
- **Then** they are identical except for `confirm_transfer` and `cancel_transfer`,
  which are declared in `VOICE_ONLY_TOOLS` as the only permitted divergence

#### Scenario: No duplicated hand-written tool bodies for shared tools

- **Given** the voice realtime tools module
- **When** the module is inspected for tool definitions
- **Then** shared tools (`get_balance`, `get_networks`, `list_tokens`, `get_address`,
  `get_history`, `send_token`, `search_recipients`, memory tools, and the recipient
  lifecycle tools) are produced from the shared definition, not re-declared with
  independent schemas

#### Scenario: Recipient lifecycle parity is asserted

- **Given** the shared definition and both adapters
- **When** the parity check runs
- **Then** a missing or divergent recipient lifecycle tool in either surface fails the check

## Capability: `voice-transfer-confirmation` (modified)

## ADDED Requirements

### Requirement: Typed per-session confirmation arbiter

Each authenticated session SHALL own exactly one confirmation arbiter holding at most
one active authorization window, keyed by
`{kind: transfer|contact, actionId, userId, createdAt}` together with the immutable
proposal or preview version. Opening a window of one kind while another is open MUST
fail closed until the user explicitly cancels or replaces the conflicting action. Only
the tool matching the window's kind and action ID MAY consume the evidence, exactly
once. Parallel transcript listeners MUST NOT be able to authorize an action
independently. The arbiter MUST NOT redefine the transfer gate's bounded wait for a
delayed final transcript; it inherits that behavior and applies it per action kind.

#### Scenario: The arbiter holds one window at a time

- **Given** an active authorization window for a transfer preview
- **When** a contact action requests its own window
- **Then** the contact window does not open until the transfer action is cancelled or replaced
- **And** neither action can be authorized by the other's evidence

#### Scenario: Collision in either opening order fails closed

- **Given** a pending contact action and a pending transfer preview
- **When** the opening order is reversed in a second run
- **Then** the same fail-closed outcome is produced in both orders

#### Scenario: Only the matching tool consumes evidence once

- **Given** a window keyed to a specific kind and action ID
- **When** a different tool, or the same tool a second time, presents the evidence
- **Then** authorization is refused and the consumed evidence is never re-armed

#### Scenario: Late or delayed affirmative follows the inherited bounded wait

- **Given** a tool call that outruns the final affirmative transcript
- **When** the final authenticated evidence arrives within the inherited bound for that action kind
- **Then** that same call completes the single authorization for its action ID
- **And** an interim transcript, an expired bound, or a replaced proposal never authorizes

## MODIFIED Requirements

### Requirement: Explicit confirmation is authorized by final user speech

The LiveKit session MUST record final user transcript evidence independently of model
tool selection. For an uncovered transfer, the service MUST NOT broadcast unless an
exact supported confirmation phrase was received after the active persisted preview was
created, the server-controlled read-back audio finished without interruption, and the
evidence is consumed for that preview exactly once. The voice session MUST arm evidence
only after reloading the ID of the persisted preview and completing that read-back.
Interim transcripts, previous-turn confirmations, model calls without evidence, and
evidence for another or stale preview MUST fail closed. Decision evidence MUST come only
from the authenticated room participant; a room/runtime that cannot prove the source
participant MUST fail closed. The worker MUST NOT also route the same decision
transcript through a second generic conversation path.

Supported standalone confirmations MUST include the unambiguous localized `yes` and
`sí`/`si`, consistent with the tool prompt; exact cancellation remains a separate phrase
set.

Evidence SHALL be owned by one typed per-session arbiter keyed by action kind, action
ID, user, and creation time plus the immutable proposal or preview version, so a contact
affirmative can never authorize a transfer and a transfer affirmative can never
authorize a contact action. Model-provided confirmation identifiers, timestamps, and
voice user-turn counters MUST NOT count as evidence.
(Previously: the gate authorized the transfer preview from final speech alone, with no typed per-action-kind arbiter and no explicit prohibition on model-provided identifiers or turn counters.)

#### Scenario: Current spoken confirmation broadcasts once

- **GIVEN** a Solana preview is pending and its amount, recipient name, and fee were read back
- **WHEN** the user speaks a supported exact confirmation and the realtime model calls `confirm_transfer`
- **THEN** the server consumes that final transcript for the active preview and broadcasts at most once
- **AND** the provider finality result is recorded and surfaced

#### Scenario: Model tool call without fresh speech is rejected

- **GIVEN** a pending preview and no final confirmation transcript after it was created
- **WHEN** the model calls `confirm_transfer`
- **THEN** the tool returns a confirmation-required error
- **AND** no claim or provider broadcast occurs

#### Scenario: Confirmation before complete preview narration is ignored

- **GIVEN** a preview has persisted but its exact server-controlled read-back is still playing or was interrupted
- **WHEN** the user speaks an exact confirmation
- **THEN** that transcript cannot authorize the preview
- **AND** a new exact confirmation is required after uninterrupted read-back completes

#### Scenario: Old, partial, replayed, or mismatched speech cannot authorize

- **GIVEN** a preview has just been created
- **WHEN** confirmation speech is only interim, predates the preview, was already consumed, or belongs to a replaced preview
- **THEN** confirmation fails closed and the provider is not called

#### Scenario: Model-supplied identifiers and turn counters are not evidence

- **GIVEN** a model tool call that supplies its own confirmation id, timestamp, or voice turn counter
- **WHEN** the gate evaluates authorization
- **THEN** those values are ignored and the call fails closed without evidence from final authenticated speech

#### Scenario: Contact and transfer windows never cross-authorize

- **GIVEN** an active transfer window and a pending contact action in the same session
- **WHEN** one affirmative is received
- **THEN** it can authorize only the action kind whose window is open
- **AND** the other action remains unauthorized

## REMOVED Requirements

None. This change removes no existing requirement; the ordinary transfer cap of
10,000,000 lamports, the preview and explicit-confirmation flow, and the delegated grant
lifecycle all remain in force.
