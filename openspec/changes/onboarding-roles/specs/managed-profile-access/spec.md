# Managed Profile Access Specification

## Purpose

Define actor/subject authorization for managed reads while preserving owner-only wallet and transfer boundaries.

## Requirements

### Requirement: MPA-001 Actor and subject remain distinct

The system MUST derive `actorUserId` only from a verified Privy session. A requested `subjectUserId` MUST NOT grant authority. Every managed operation MUST authorize the relationship status, version, and exact capability in the same transaction as the subject-scoped operation.

#### Scenario: Authorized managed read

- GIVEN an authenticated actor has an accepted relationship with the subject and the requested read capability
- WHEN the actor requests managed contacts, transactions, or limits
- THEN the system MUST return only that subject's authorized data

#### Scenario: Forged subject

- GIVEN an actor supplies an unrelated or inaccessible subject ID
- WHEN a managed operation is requested
- THEN the system MUST deny it without revealing whether that subject exists

### Requirement: MPA-002 Accepted relationships grant narrow reads

Relationships in `accepted_pending_policy_authorization` or `active` MAY grant only `contacts.read`, `history.read`, and `limits.read` under this specification. Pending, revoking, revoked, declined, and expired states MUST NOT grant those reads. Policy writes require the separate managed-policy-authority specification.

#### Scenario: Policy authorization remains pending

- GIVEN an accepted relationship awaits policy authorization
- WHEN the responsible person opens the beneficiary profile
- THEN the system MUST allow its approved reads
- AND MUST show policy management as unavailable rather than applied

#### Scenario: Relationship is not readable

- GIVEN the relationship is pending, revoking, revoked, declined, or expired
- WHEN the actor requests managed data
- THEN the system MUST reject the request and return no subject data

### Requirement: MPA-003 Managed APIs are narrow and owner RLS remains authoritative

Managed reads MUST use dedicated subject-explicit endpoints and bounded repository operations after authorization. The system MUST NOT add a generic guardian RLS policy, expose arbitrary subject transactions, or change existing self-only routes. Backend and frontend HTTP contracts MUST remain mirrored without cross-imports.

#### Scenario: Existing owner route receives a subject override

- GIVEN an authenticated actor calls an existing contacts, wallet, conversation, voice, grant, or transfer route
- WHEN the request attempts to name another subject
- THEN the route MUST ignore or reject the override and remain scoped to the authenticated owner

### Requirement: MPA-004 Responsible access cannot move money

A responsible-person context MUST NOT prepare, preview, confirm, sign, send, retry, or schedule a beneficiary transfer, and MUST NOT administer beneficiary signers, grants, room tokens, or delegated payment authority. This prohibition MUST hold through UI, HTTP, text, and voice.

#### Scenario: Direct transfer bypass attempt

- GIVEN an actor is authorized to read a beneficiary profile
- WHEN they invoke a beneficiary transfer or signing path directly
- THEN the backend MUST reject the request
- AND MUST NOT create an executable preview, confirmation, signature, or transfer attempt

### Requirement: MPA-005 Revocation serializes with access

Revocation MUST cut off new managed operations before publishing `revoked`. An operation ordered after revocation begins MUST be denied; data already returned MUST be invalidated by the client. Other accepted relationships MUST remain unaffected.

#### Scenario: Read races with revocation

- GIVEN a managed read and revocation target the same relationship
- WHEN their ordering is resolved
- THEN only a read ordered before revocation begins MAY complete
- AND every later read MUST be denied

### Requirement: MPA-006 Compatibility remains Solana-devnet only

Managed access MUST remain additive, MUST NOT reassign existing wallets, and MUST NOT introduce EVM, mainnet, chain switching, secrets, or changes to the owner's preview and explicit confirmation invariant.

#### Scenario: Owner transfers after onboarding

- GIVEN a beneficiary has one or more managed relationships
- WHEN the beneficiary performs their normal Solana-devnet transfer flow
- THEN the existing preview, authenticated post-preview confirmation, and idempotency requirements MUST still apply
