# Spec Delta: sns-alias-recipients

Consolidated delta for change `sns-alias-recipients`. Three capabilities are modified:
`trusted-recipient-policy-sync`, `recipient-address-memory`, and `unified-agent-tools`. No
capability is added, no requirement is removed, and every requirement uses RFC 2119 keywords
and carries at least one Given/When/Then scenario. Requirement names and IDs of modified
capabilities are reused verbatim from their published baselines; no parallel IDs are
introduced.

This delta contains exactly **one deliberate revision of an existing MUST**: the requirement
`Voice permission creation requires a published proposal and a verified address` forbids a
name-derived address unconditionally today, and is revised to distinguish **model inference**
of an address (still forbidden, without exception) from **server-side resolution of an explicit
`.sns` name the user supplied** (newly admitted as a second verified source). The admitted
source is bounded by the eight mandatory compensations M1–M8 recorded in
`.agent-workflow/tasks/sns-alias-recipients/02-design-discussion.md` §1.5, and the requirement
text plus its scenarios below are the revision drafted in §1.3 of that document. Every other
delta in this file adds behaviour that does not exist today; none of them weakens an existing
requirement.

## Baseline references

`openspec/specs/` holds no merged domain specification in this repository, so MODIFIED deltas
resolve against the requirement blocks published by the change specs below. Unmodified
requirements are not repeated; only the blocks this change edits are reproduced in full.

| Capability | Baseline requirement source |
|---|---|
| `trusted-recipient-policy-sync` | `openspec/changes/trusted-recipient-policy-sync/spec.md`, capability block `trusted-recipient-policy-sync` (its ADDED requirements). **This baseline is not yet archived**: `openspec/changes/trusted-recipient-policy-sync/` has no `archive-report.md` and no `state.yaml`, and `openspec/specs/` does not exist in this worktree |
| `recipient-address-memory` | `openspec/changes/archive/recipient-address-memory/specs/recipient-address-memory/spec.md` (RAM-001…RAM-007), modified once by `openspec/changes/archive/privy-multi-user-foundation/specs/recipient-address-memory/spec.md` (RAM-008 ADDED, RAM-001 MODIFIED) and once by `openspec/changes/trusted-recipient-policy-sync/spec.md` (RAM-009 ADDED, RAM-005 and RAM-007 MODIFIED). RAM-010 is the next free id in this series |
| `unified-agent-tools` | `openspec/changes/archive/unify-agent-tools/specs/unified-agent-tools/spec.md`, modified by `openspec/changes/trusted-recipient-policy-sync/spec.md` (MODIFIED *Single shared tool definition for text and voice agents*; ADDED *Version-bound recipient lifecycle tools in both agents*) |

Two reader notes that follow from the table above, both of which affect how this delta is
applied:

1. **Host-capability correction.** The design discussion's §1.1 locates the revised clause in
   capability `voice-transfer-confirmation`. That is a misattribution: in
   `openspec/changes/trusted-recipient-policy-sync/spec.md` the requirement *Voice permission
   creation requires a published proposal and a verified address* sits inside the capability
   block `trusted-recipient-policy-sync`, and the block `voice-transfer-confirmation` contains
   the arbiter requirements only. This delta therefore modifies the requirement under its real
   host capability, and modifies nothing in `voice-transfer-confirmation`.
2. **Sequencing dependency.** The revised requirement and the `unified-agent-tools` requirement
   modified here were both published by an unarchived change. This delta must not be applied
   ahead of that block: applying it against the pre-`trusted-recipient-policy-sync` text would
   silently reinstate the unconditional prohibition in a different wording.

## Capability: `trusted-recipient-policy-sync` (modified)

## ADDED Requirements

### Requirement: An alias-resolved destination is re-verified before the address is authorized

An alias-resolved address MUST be resolved at the moment the address is authorized, not only at
the moment it was displayed. On the review-card path the server MUST re-resolve the name before
the one-use consumption transaction and MUST compare the result against the address bound to the
immutable proposal version the user is confirming. On the contact-add path the server MUST
resolve the name itself and compare its result against the address the client displayed; a
request-supplied address MUST only ever be able to **veto** the stored destination and MUST
NEVER be able to choose it. Remote I/O for the re-verification MUST stay outside the contact
mutation transaction, and no memoization MAY serve an address other than the one obtained for
the request being authorized.

When the re-resolution returns a **different** address, the operation MUST fail closed: nothing
is written for the displayed address, the stale version MUST be superseded by a new immutable
version carrying the newly observed address, and that version MUST be re-published before its
window re-opens. When the re-resolution **cannot be reached**, the operation MAY proceed with
the displayed, already-resolved address and MUST record the re-verification as unavailable. An
unreachable resolver MUST NEVER be reported as a changed name, and MUST NEVER be reported as a
non-existent one. Proposal expiry is an affordance and MUST NOT be relied on as this guard.

#### Scenario: Unchanged resolution proceeds

- **Given** an immutable proposal version bound to the address an alias resolved to
- **When** the user's affirmative arrives and the re-resolution returns that same address
- **Then** the consume transaction executes once for that version and stores that address

#### Scenario: A resolution that moved before confirmation supersedes the proposal

- **Given** a displayed proposal version *n* presenting address A
- **When** the name resolves to address B by the time the user confirms
- **Then** version *n* is superseded and never consumed, and a version *n+1* carrying B is created
- **And** the window re-opens only for version *n+1* after it is re-published, so the user confirms the newly displayed address

#### Scenario: An unreachable resolver proceeds with the displayed address

- **Given** a displayed proposal version presenting address A
- **When** the re-resolution cannot be reached
- **Then** address A is stored and the re-verification is recorded as unavailable
- **And** the outcome is never reported as a change of destination

#### Scenario: A client-supplied address can veto but never choose

- **Given** a contact-add request carrying an alias name together with the address the client displayed
- **When** the server resolves the name to a different address
- **Then** the request is refused with a typed conflict and nothing is persisted
- **And** the client-supplied address is never stored as the destination

## MODIFIED Requirements

### Requirement: Last-active-alias removal semantics and disclosure

When a removal or address replacement eliminates the last active alias for an address,
that address's affected delegated grants SHALL be revoked whole. A grant covering
several addresses MUST be revoked whole rather than narrowed by invention; unrelated
grants MUST be preserved; grants MUST NEVER be migrated to a replacement address.
Removing one alias MUST NOT revoke another active alias for the same address. An add whose
address already belongs to another active contact MUST be disclosed and MUST proceed: a second
active alias for one address creates no grant and adds no authority, because the composed
allowlist is a set, and the alias path MUST NOT be stricter than the paste path for the same
address. That disclosure MUST name the address as already trusted and MUST state that the
ability to pay does not change. Independent of any duplicate, an address that is the user's own
wallet address MUST be refused with a typed error, on every surface that creates or replaces a
trusted recipient. The revocation consequence MUST be disclosed to the user in the screen and
agent proposals before the mutation executes, and a revocation MUST NOT be advertised as
verified before remote readback confirms it. Ledger state, whole-grant revocation, and revoke
audits are specified in `delegated-grant-core`.
(Previously: the requirement governed removal and replacement semantics only. The add path had no specified behaviour for an address another active contact already held — it was neither required nor forbidden — and the wallet's own address was excluded by non-goal rather than by a typed refusal.)

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

#### Scenario: A duplicate-address add is disclosed and proceeds

- **Given** an active contact named `Mamá` holding address A, and an alias that resolves to address A
- **When** the user confirms adding the alias on either surface
- **Then** the contact is created with address A and the disclosure names A as already trusted
- **And** no grant is created or revoked by the add, and the paste path's behaviour for the same address is unchanged

#### Scenario: The wallet's own address is refused

- **Given** an alias whose resolved address is the user's own wallet address
- **When** the add is attempted on any surface
- **Then** a typed refusal is returned and no contact is created
- **And** the refusal is not reported as a duplicate-contact conflict

### Requirement: Voice permission creation requires a published proposal and a verified address

For the voice path the server MUST persist the contact-action proposal and publish it, with the
exact address, action, version, and revocation effects, to the bound authenticated conversation
UI. The voice authorization window MUST open only after that publication succeeds.

An address MUST reach a permission-creating proposal through exactly one of two verified sources:

1. an address the user **pasted or scanned** into the review channel; or
2. an address the **server** resolved from an explicit `.sns` name the user supplied, which the
   card then presented to the user **as that exact address**, bound to an immutable proposal
   version the user then confirmed.

A spoken-only address, a model-inferred address, or any address supplied as a model tool argument
MUST NEVER be a permission source. **In the alias path the alias is a label and the resolved address
is the authorization: what the user confirms and what the system stores and authorizes MUST be the
resolved address, never the alias.**

Without a bound visual client, or without one of those two verified sources, permission creation
MUST be refused, and the contact MAY be saved as not enabled.
(Previously: creation and address replacement required a verified pasted or scanned address, and no address was ever derived from a name.)

#### Scenario: Model-inferred address is never accepted

- **Given** a model attempt to supply, guess, or infer an address from a contact name, a description, or any other spoken value
- **When** the mutation is validated
- **Then** the address is rejected as unverified evidence
- **And** no contact or permission change occurs

#### Scenario: Spoken-only address is still rejected

- **Given** an address that exists only in spoken input
- **When** permission creation is attempted
- **Then** the request is refused and a verified pasted, scanned, or server-resolved source is requested

#### Scenario: Server-resolved alias address is accepted only as displayed

- **Given** an explicit `.sns` name the user supplied and no address anywhere in the request
- **When** the server resolves it to a canonical base58 address and the card presents that exact address bound to an immutable proposal version
- **Then** the user's affirmative for that version authorizes exactly that address
- **And** the stored contact carries the resolved address, and the composed policy contains that address and not the alias

#### Scenario: The confirmed version is the only authorization

- **Given** a card for proposal version *n* presenting a resolved address
- **When** an affirmative arrives after version *n+1* was created
- **Then** it cannot authorize version *n+1*, and no address other than the one that version *n+1* displays can be consumed

#### Scenario: Unresolvable, unsupported or unreachable alias creates no permission

- **Given** an `.sns` name that does not exist, a suffix this deployment does not support, or a resolver that cannot be reached
- **When** permission creation is attempted
- **Then** the request is refused with a typed outcome that distinguishes "does not exist" from "could not be reached"
- **And** no contact is authorized and no address is invented to compensate
- **And** an unreachable resolver is never reported to the user as a non-existent name

#### Scenario: Absent bound visual client refuses permission creation

- **Given** a voice session with no bound visual client to receive the proposal card
- **When** the user asks to create a trusted recipient by alias
- **Then** permission creation is refused and the missing review channel is requested
- **And** the contact may be saved as not enabled

#### Scenario: The window opens only after successful publication

- **Given** a persisted contact proposal for voice permission creation
- **When** the proposal card is published to the bound authenticated conversation UI
- **Then** the voice authorization window opens for that immutable proposal version
- **And** an affirmative received before successful publication cannot authorize it

#### Scenario: The paste or scan source is not replaced by the alias source

- **Given** a user who supplies a pasted or scanned address
- **When** the contact is created
- **Then** the verified pasted or scanned source is used exactly as before this change
- **And** no resolution is performed and no alias provenance is written

## Capability: `recipient-address-memory` (modified)

## ADDED Requirements

### Requirement: RAM-010 Alias-resolved addresses are frozen at add time with recorded provenance

An address resolved from an `.sns` name SHALL be validated exactly like any other recipient address
— a canonical base58 Solana public key scoped to `solana-devnet` — and SHALL be persisted with
provenance recording at least `{source:'sns', name, resolvedAt, resolver}`.

The stored address MUST NEVER be re-resolved for a payment, a preview, a composition, or an
automatic execution. A later change to what the name resolves to MUST be surfaced as drift and MUST
NEVER automatically update, replace, re-authorize, or revoke the stored address. An address edit on
an alias-origin contact SHALL rewrite or clear the alias provenance atomically with the address
change, so no stale alias claim survives an address the user replaced.

#### Scenario: The stored address is the frozen destination

- **Given** a contact created from an alias that resolved to address A
- **When** a later payment, preview, or composition for that contact runs
- **Then** address A is used and no resolution is performed

#### Scenario: A name that later resolves elsewhere is drift, never an update

- **Given** a stored alias whose name now resolves to address B while the stored address is A
- **When** the drift is observed
- **Then** the stored address remains A, the composition is unchanged, and no grant is revoked or created
- **And** the drift is recorded as evidence and reported to the user, with the user deciding whether to keep or replace

#### Scenario: Provenance is persisted and reported

- **Given** a contact created from an alias
- **When** the contact is read back
- **Then** its provenance records the alias name, the resolution time, and the resolver identity
- **And** the alias is never the stored payment target

#### Scenario: An address edit leaves no stale alias claim

- **Given** a contact created from an alias, whose address the user then replaces
- **When** the address change is composed
- **Then** the alias provenance is rewritten or cleared in the same transaction as the address change
- **And** no later drift comparison is made against an alias for the replaced address

#### Scenario: A drift notice never blocks a payment

- **Given** an alias-origin contact with an observed drift, and a payment to that stored address
- **When** the transfer is previewed and confirmed
- **Then** the transfer proceeds against the stored address under the ordinary cap and confirmation flow
- **And** the drift state alone refuses nothing

#### Scenario: A metadata-only edit preserves the freeze

- **Given** an alias-origin contact whose display name the user renames
- **When** the metadata edit is composed
- **Then** the composed rule set is identical and the alias provenance is unchanged

## Capability: `unified-agent-tools` (modified)

## MODIFIED Requirements

### Requirement: Version-bound recipient lifecycle tools in both agents

The shared tool surface SHALL expose trusted-recipient create, edit, and remove tools to
both the text agent and the voice agent. Those tools MUST accept only stable contact
identifiers and exact versions; they MUST NOT accept an arbitrary address, a network, a
policy identifier, a signer, or a cap from the model. The create tool MAY additionally accept one
explicit `.sns` name supplied by the user; a name is a label and not a permission scope, its
address MUST be produced server-side, and accepting it MUST NOT relax the prohibition above —
the model MUST NEVER supply an address in any form, including an address it inferred from the
name. Ambiguous name references MUST be resolved by asking before any mutation. A stale or
mismatched version MUST fail closed. Every mutation MUST route through the recipient management
service and MUST be bound to an immutable versioned proposal.
(Previously: the create tool accepted a display name and an optional description only, and no name-resolution source existed on the model surface.)

#### Scenario: Both agents expose the recipient lifecycle tools

- **Given** the shared tool definition with a text context and a voice context
- **When** the tool name lists of both agents are compared
- **Then** the recipient create, edit, and remove tools appear in both surfaces from the same definition

#### Scenario: The model cannot supply an address, network, or permission scope

- **Given** a model call for a recipient mutation containing an address, a network, a policy id, a signer, or a cap
- **When** the strict schema validates the call
- **Then** the call is rejected with a typed error and no mutation occurs

#### Scenario: The model may supply an alias name but never an address

- **Given** a create call carrying an explicit `.sns` name and no address field
- **When** the strict schema validates the call
- **Then** the call is accepted and the name is resolved server-side before any proposal is persisted
- **And** a call carrying an address, a resolved address, or a model-inferred address is rejected with a typed error

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

## REMOVED Requirements

None. This change removes no existing requirement: the ordinary transfer cap of 10,000,000
lamports, the composer's address-only contract, the one-use typed confirmation arbiter, the
delegated-grant lifecycle, and the verified pasted/scanned source all remain in force. Exactly one
MUST is revised — *Voice permission creation requires a published proposal and a verified address*,
reproduced above in full with its `(Previously: …)` note — and three requirements are added.
