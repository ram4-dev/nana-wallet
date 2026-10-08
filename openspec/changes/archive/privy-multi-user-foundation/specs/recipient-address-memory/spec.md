# Delta for Recipient Address Memory

## ADDED Requirements

### Requirement: RAM-008 Per-Request Text Path Identity

The text path MUST build the recipient-memory runtime per request using the resolved internal `userId` from the active identity provider, replacing the fixed `demoUserId`. The voice path MUST continue to scope via `binding.sub`. In `privy` mode no path MAY use a fixed `demoUserId`; `demo` mode resolves the configured sentinel UUID.

#### Scenario: text path scopes to resolved user

- GIVEN a request resolved to user A
- WHEN the text memory runtime is built
- THEN it uses A's resolved UUID

#### Scenario: voice identity comes from an authorized conversation

- GIVEN a live voice session
- WHEN memory tools scope
- THEN they scope to `binding.sub`

## MODIFIED Requirements

### Requirement: RAM-001 Durable, Isolated Memory

Recipients MUST durably retain stable ID, name, description, and exact address; facts MUST retain user-provided relationships. Every operation MUST enforce authenticated-user scope without revealing other users' data or existence. The authenticated-user scope MUST be the internal UUID resolved by the active identity provider — the verified Privy identity in `privy` mode and the demo sentinel UUID in `demo` mode — and MUST NOT be a fixed configured demo user in `privy` mode.
(Previously: scoped to the configured demo user identity; now resolves from the verified identity provider per request.)

#### Scenario: Cross-user isolation

- GIVEN two users each store Lucas
- WHEN one searches or resolves Lucas
- THEN only their records are observable

#### Scenario: Missing authentication

- GIVEN authentication is absent
- WHEN a memory tool runs
- THEN it returns or changes no data

#### Scenario: identity source is per-request

- GIVEN a request resolved to a verified identity
- WHEN a memory tool runs
- THEN it scopes to that resolved UUID, not a fixed demo user
