# Spec Delta: delegated-grant-core

## ADDED Requirements

### Requirement: Authenticated grant lifecycle

Grants SHALL be created, listed, and revoked only through authenticated HTTP
endpoints protected by the configured `RequestIdentityProvider`. Voice tools
MUST NOT create, extend, modify, or revoke grants.

#### Scenario: Grant created via authenticated endpoint

- **Given** a user authenticated by the configured `RequestIdentityProvider`
- **When** they POST `/v1/grants` with a valid bounded grant
  (action, per-transfer cap, cumulative cap, rolling window, expiration,
  recipient allowlist)
- **Then** the server resolves the user's sole ready embedded wallet and
  verifies its chain matches the request, persists an `active` grant scoped to
  that user and wallet,
  appends an audit row `created`, attempts provider policy sync, and returns the
  grant representation with `policyReady` reflecting the sync outcome

#### Scenario: Client cannot select another wallet

- **Given** an authenticated user with a ready embedded wallet
- **When** they POST `/v1/grants` with a client-supplied `walletId`
- **Then** the strict request contract rejects the field and the server never
  accepts wallet identity from the client

#### Scenario: Grant creation requires exactly one ready wallet for its chain

- **Given** an authenticated user with no ready wallet, multiple ready wallets,
  or a ready wallet on another chain
- **When** they POST `/v1/grants`
- **Then** the server rejects creation without persisting a grant

#### Scenario: Grant creation rejected without identity

- **Given** an unauthenticated or unresolvable request
- **When** any grant lifecycle endpoint is called
- **Then** the endpoint responds 401 and no grant state changes

#### Scenario: Revocation takes effect immediately

- **Given** an `active` grant
- **When** the user revokes it via `POST /v1/grants/:id/revoke`
- **Then** the grant state becomes `revoked`, an audit row `revoked` is appended,
  and the next execution attempt against it is rejected

#### Scenario: Voice cannot mutate grants

- **Given** any voice session with the current tool set
- **When** the model attempts any grant mutation through a tool call
- **Then** no grant mutation exists in the tool surface and the request fails
  closed

### Requirement: Server-side coverage validation at execution time

Grant coverage SHALL be evaluated server-side at the moment of execution, using
the grant's action, per-transfer cap, cumulative rolling-window cap, expiration,
revocation state, and recipient allowlist. A covered execution proceeds without
re-confirmation; anything not covered SHALL degrade closed to the existing
preview + explicit confirmation flow.

#### Scenario: Covered execution within all bounds

- **Given** an `active`, unexpired grant with cumulative budget remaining and a
  recipient inside the allowlist
- **When** an execution is requested for an amount ≤ per-transfer cap
- **Then** the execution is classified `covered` and proceeds without user
  re-confirmation

#### Scenario: Exceeded cumulative rolling cap degrades to confirmation

- **Given** an `active` grant whose consumed amount within the rolling window
  plus the requested amount exceeds the cumulative cap
- **When** an execution is evaluated
- **Then** the decision is `degrade` with reason `cumulative_cap_exceeded`, an
  audit row `rejected` is appended, and the flow falls back to preview +
  explicit confirmation

#### Scenario: Expired or revoked grant degrades closed

- **Given** a grant that is `expired` (past `expires_at`) or `revoked`
- **When** an execution is evaluated
- **Then** the decision is `degrade`, an audit row records the reason, and no
  state is mutated on the grant

#### Scenario: Recipient outside allowlist degrades closed

- **Given** an `active` grant with a non-empty recipient allowlist
- **When** an execution targets a recipient not in the allowlist
- **Then** the decision is `degrade` with reason `recipient_not_allowed` and the
  audit trail records it

#### Scenario: Conversation never fails hard on degradation

- **Given** any grant rejection (expired, revoked, cap, allowlist)
- **When** the degradation path runs inside the conversation service
- **Then** the user still receives the standard preview + confirmation
  experience; no hard error surfaces to the voice session

### Requirement: Cumulative rolling-window accounting in PostgreSQL

Grant consumption SHALL be accounted in PostgreSQL by aggregating audited
`used` events inside the rolling window, and consumption SHALL be appended
atomically within the execution transaction. In-memory counters MUST NOT be the
source of truth.

#### Scenario: Rolling window excludes stale usage

- **Given** a grant with a 7-day window and usage recorded 8 days ago
- **When** the cumulative cap is evaluated
- **Then** only usage within the last 7 days counts toward the cap

#### Scenario: Concurrent executions cannot exceed the cap at the DB level

- **Given** a grant with remaining budget for exactly one bounded execution
- **When** two executions with distinct idempotency keys race
- **Then** at most one succeeds within the cap; the other is rejected by the
  database-enforced accounting (unique-constraint/atomic claim path), and the
  rejection is audited

#### Scenario: Reused idempotency key does not double-consume

- **Given** an execution already claimed with idempotency key K
- **When** the same key K is submitted again
- **Then** no additional consumption or on-chain effect occurs (DB-level
  idempotency), and the original execution result is returned

#### Scenario: Invalid claim amount is rejected without throwing

- **Given** a claim amount that is zero or not a positive decimal integer in
  smallest units
- **When** the claim is evaluated
- **Then** the service returns `invalid_amount`, appends a rejected audit row
  without storing the malformed amount, creates no claim-ledger row, and never
  throws from integer parsing

#### Scenario: Claim ledger enforces positive amounts across upgrade paths

- **Given** a fresh install (fully validated named constraint
  `grant_claim_ledger_amount_positive_ck` on `grant_claim_ledger`) or an upgraded
  database (the same named constraint added `NOT VALID` by the upgrade
  migration)
- **When** any write attempts to persist a claim amount that is not a positive
  decimal integer
- **Then** the database rejects the write, and previously persisted historical
  rows in the upgraded database remain intact (the constraint validates future
  INSERT/UPDATE statements only until a validation sweep is chosen)

### Requirement: Privy Solana policy sync driven by the grants ledger

The grants ledger SHALL be the single decision authority for creating, rotating,
and revoking the delegated signer's Privy Solana policy. Grant-covered
executions SHALL require both the ledger validation to pass and the Privy policy
to permit the transaction. A policy sync failure SHALL leave the grant
non-executable (fail-closed).

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

### Requirement: Immutable audit trail

Every grant creation, use, rejection, revocation, expiry, and policy sync
outcome SHALL append an immutable audit row before any on-chain side effect of
the corresponding execution. Audit rows MUST NOT be updated or deleted.

#### Scenario: Audit precedes on-chain effect

- **Given** a grant-covered execution in progress
- **When** the execution reaches the broadcast step
- **Then** the `used` audit row already exists for that intention

#### Scenario: Rejections are audited with reason codes

- **Given** an execution rejected by the engine (any reason)
- **When** the rejection is processed
- **Then** an audit row with the reason code and context (amount, recipient,
  grant id) exists and cannot be modified

### Requirement: Chain-agnostic validation with plug-in validators

The grant engine SHALL validate recipient addresses through a per-chain
validator plug-in interface. For chain `solana` the validator SHALL enforce
base58 recipient format. Chains without a registered validator SHALL fail
closed.

#### Scenario: Solana base58 recipient validated

- **Given** chain `solana` and a well-formed base58 recipient
- **When** coverage is evaluated
- **Then** the recipient passes format validation (semantic checks remain with
  allowlist and policy layers)

#### Scenario: Unregistered chain fails closed

- **Given** a grant whose `chain` has no registered validator
- **When** coverage is evaluated
- **Then** the decision is `degrade` with a validator-unavailable reason and the
  audit trail records it

### Requirement: Contract mirroring across the front/backend boundary

Grant lifecycle endpoints SHALL be defined in `src/contracts/http.ts` (zod) and
SHALL be hand-mirrored in `apps/nana-wallet/src/lib/api-types.ts` in the same
PR, per the repository's hard front/backend separation rule.

#### Scenario: Contract change is mirrored in the same PR

- **Given** any modification to grant endpoint schemas
- **When** the change is submitted
- **Then** both `src/contracts/http.ts` and
  `apps/nana-wallet/src/lib/api-types.ts` are updated in the same PR
