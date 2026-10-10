# Managed Profile Onboarding Specification

## Purpose

Define role entry, invitation lifecycle, relationship consent, profile selection, and revocation without changing wallet ownership or transfer behavior.

## Requirements

### Requirement: MPO-001 Role entry preserves identity and ownership

The system MUST offer wallet-user and responsible-person entry before Privy login, MUST treat that choice only as navigation preference, and MUST preserve each authenticated DID's existing user, wallet, and self-service flow.

#### Scenario: Responsible person signs in

- GIVEN a visitor selects the responsible-person path
- WHEN they authenticate with Privy
- THEN the system MUST create or load only their own profile
- AND MUST NOT attach a beneficiary wallet to their DID

#### Scenario: Existing wallet user signs in

- GIVEN an existing wallet user selects the wallet-user path
- WHEN they authenticate with their existing DID
- THEN the system MUST retain their wallet, data, and transfer confirmation flow

### Requirement: MPO-002 Invitations are opaque and email-verified

An authenticated responsible person MUST be able to invite a normalized email with an idempotency key. Creation MUST NOT reveal whether the email has an account. The system MUST expose an invitation only after a trusted Privy lookup proves that the actor owns the matching verified email; browser-supplied email text MUST NOT suffice.

#### Scenario: Invite future user

- GIVEN a responsible person submits a valid email
- WHEN the invitation is created
- THEN the response MUST be opaque and the invitation MUST remain pending
- AND repeated use of the same key MUST NOT create another invitation

#### Scenario: Email cannot be verified

- GIVEN an actor lacks the invited verified email or Privy verification is unavailable
- WHEN invitations are listed or decided
- THEN the system MUST withhold that invitation and MUST NOT create a relationship

### Requirement: MPO-003 Decisions are versioned and single-use

Invitations MUST expire after seven days and MUST support idempotent accept or decline using the expected invitation version. Acceptance MUST atomically bind guardian and beneficiary user IDs and enter `accepted_pending_policy_authorization`; it MUST NOT itself grant policy writes or authorize a transfer. The system MUST allow multiple relationships on either side while preventing duplicate non-revoked relationships for the same pair.

#### Scenario: Beneficiary accepts

- GIVEN a pending, unexpired invitation matching the actor's verified email
- WHEN the actor accepts its current version from screen or voice
- THEN exactly one relationship MUST be created in `accepted_pending_policy_authorization`
- AND replay MUST return the same result without a second relationship

#### Scenario: Stale or terminal invitation

- GIVEN an invitation is stale, declined, expired, or already decided differently
- WHEN a decision is submitted
- THEN the system MUST reject the state transition without reactivating it

### Requirement: MPO-004 Startup and profile switching isolate subjects

Pending invitations MUST appear before the normal greeting and balance, one at a time in creation order. Marking a notification read MUST NOT decide the invitation. Accessible profiles MUST identify their subject and relationship state; cache keys MUST include actor, subject, and relationship version.

#### Scenario: Switch managed profile

- GIVEN a responsible person has two readable relationships
- WHEN they switch subjects
- THEN every managed view MUST identify the selected subject
- AND requests and cached data for the prior subject MUST be cancelled or cleared

### Requirement: MPO-005 Revocation cuts future access

The beneficiary MUST be able to revoke an accepted relationship. Revocation MUST prevent subsequent managed access, MUST preserve unrelated relationships, and MUST NOT silently change an already-applied wallet policy.

#### Scenario: Revoke while profile is open

- GIVEN a responsible person is viewing an accepted beneficiary profile
- WHEN the beneficiary revokes that relationship
- THEN the next managed request MUST be denied
- AND the client MUST remove the inaccessible subject data
