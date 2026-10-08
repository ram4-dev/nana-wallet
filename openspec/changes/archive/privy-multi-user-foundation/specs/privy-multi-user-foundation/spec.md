# Privy Multi-User Foundation Specification

## Purpose

Turn the Nana system into a real multi-user application: every authenticated request carries a verified Privy access token, the backend resolves each Privy identity to an internal `users` UUID, RLS scopes all data to that UUID, and the front bootstraps identity (`/v1/me`) and manages user contacts (`/v1/contacts`) through the same server-mediated isolation. The demo single-user mode remains the default for dev, tests, and CI.

## ADDED Requirements

### Requirement: PMU-001 Identity Provider Selection

The backend MUST select the request identity provider from `IDENTITY_PROVIDER` with exactly two modes: `demo` (default for dev/tests/CI, no Privy or network dependency) and `privy` (verifies Privy access tokens). The selected provider MUST be the sole source of the request `userId`. `DEMO_USER_ID` MUST be required only in `demo` mode.

#### Scenario: demo mode is the default

- GIVEN `IDENTITY_PROVIDER` is unset or `demo`
- WHEN the server builds the identity provider
- THEN it uses the demo provider keyed to the demo sentinel UUID
- AND no Privy credential is required

#### Scenario: privy mode requires credentials

- GIVEN `IDENTITY_PROVIDER=privy`
- WHEN the server builds the identity provider
- THEN it uses the Privy provider with the configured app id and verification key
- AND it rejects startup when the verification key or app id is missing

### Requirement: PMU-002 Verified Privy Token per Request

The backend MUST verify each incoming access token before granting identity. Verification MUST succeed only for a JWT signed with the app verification key using ES256, with `iss=privy.io` and `aud=PRIVY_APP_ID`, and MUST reject expired tokens. Invalid, expired, wrong-key, wrong-issuer, or wrong-audience tokens MUST be rejected as unauthenticated.

#### Scenario: valid token

- GIVEN a token signed by the app verification key with matching `iss` and `aud` and unexpired
- WHEN the identity provider resolves it
- THEN it extracts the `sub` (Privy DID)

#### Scenario: expired token

- GIVEN a token whose `exp` is in the past
- WHEN the identity provider resolves it
- THEN it rejects the request as unauthenticated

#### Scenario: token signed by another key

- GIVEN a token signed by a non-app key
- WHEN the identity provider resolves it
- THEN it rejects the request as unauthenticated

### Requirement: PMU-003 DID-to-UUID Idempotent Upsert

The backend MUST resolve a verified Privy DID to an internal `users` UUID, creating the `users` row on first login and returning the existing UUID on subsequent logins. Provisioning MUST be idempotent and safe under concurrent first logins, and MUST be performed by a `SECURITY DEFINER` function owned by the migration owner so no `BYPASSRLS` role is introduced.

#### Scenario: first login provisions

- GIVEN a verified DID with no existing `users` row
- WHEN identity is resolved
- THEN a `users` row is created with that `privy_did` and the internal UUID is returned

#### Scenario: repeat login is idempotent

- GIVEN a verified DID with an existing `users` row
- WHEN identity is resolved again
- THEN the same internal UUID is returned and no duplicate row is created

#### Scenario: concurrent first logins

- GIVEN two concurrent requests for the same new DID
- WHEN both resolve identity
- THEN exactly one `users` row exists and both requests receive the same UUID

### Requirement: PMU-004 Demo Sentinel User

A `users` row with sentinel `privy_did='demo'` and `id = DEMO_USER_ID` MUST be provisioned by demo-mode startup before serving requests, or by the demo seed before writing recipients. The schema migration MUST NOT insert a demo row with a generated UUID. Repeated provisioning MUST preserve the configured UUID; an existing sentinel with a different UUID MUST reject provisioning without changing data. In `demo` mode the demo identity provider MUST resolve to this sentinel row's UUID. The recipient-memory seed MUST run only in demo mode.

#### Scenario: demo resolution

- GIVEN `IDENTITY_PROVIDER=demo`
- WHEN a request resolves identity
- THEN it returns the demo sentinel UUID

#### Scenario: fresh migration followed by demo startup

- GIVEN a freshly migrated database and a configured `DEMO_USER_ID`
- WHEN demo-mode startup provisions the sentinel twice
- THEN exactly one demo row exists with `id = DEMO_USER_ID`
- AND both startups succeed without Privy access

#### Scenario: conflicting sentinel

- GIVEN an existing demo sentinel whose UUID differs from `DEMO_USER_ID`
- WHEN demo-mode startup provisions the sentinel
- THEN startup fails without rewriting either the sentinel or existing user data

#### Scenario: seed before server startup

- GIVEN a freshly migrated database and `IDENTITY_PROVIDER=demo`
- WHEN the recipient-memory seed runs before the server has started
- THEN it provisions the sentinel with `id = DEMO_USER_ID` before inserting recipients

#### Scenario: seed gated to demo

- GIVEN the recipient-memory seed runs
- WHEN `IDENTITY_PROVIDER=privy`
- THEN the seed does not run

### Requirement: PMU-005 RLS Scoping via app.user_id

All user-scoped queries MUST continue to flow through `withUserTransaction`, which sets `SET LOCAL ROLE recipient_app` and `app.user_id` to the resolved internal UUID. `app.user_id` MUST be the sole scoping source for every user-scoped table. The system MUST NOT scope by any other column or client-supplied value. Existing policies MUST remain unchanged.

#### Scenario: scoping from resolved identity

- GIVEN a request resolved to user A's UUID
- WHEN a user-scoped repository query runs
- THEN `app.user_id` is set to A's UUID and the query is scoped to A

#### Scenario: existing policies untouched

- GIVEN existing `recipients`, `user_memories`, and `conversations` policies
- WHEN the change is applied
- THEN those policies are not modified

### Requirement: PMU-006 users Self-Isolation Policy

The `users` table MUST have RLS ENABLED and FORCED, with a policy scoping rows to `id = app.user_id` so `/v1/me` returns only the authenticated user's row. No user MAY read another user's `users` row.

#### Scenario: self-only read

- GIVEN a request resolved to user A
- WHEN the `users` row is read
- THEN only A's row is visible

#### Scenario: cross-user users read blocked

- GIVEN a request resolved to user A
- WHEN a query would touch user B's `users` row
- THEN RLS prevents it

### Requirement: PMU-007 /v1/me Identity-Only Bootstrap

`GET /v1/me` MUST return only identity data for the authenticated user. It MUST require a verified token; unauthenticated, invalid, or expired tokens MUST return `401`. It MUST NOT include wallet or balance data.

#### Scenario: authenticated identity

- GIVEN a verified token
- WHEN `GET /v1/me` is called
- THEN it returns the authenticated user's identity only

#### Scenario: unauthenticated rejected

- GIVEN no token or an invalid/expired token
- WHEN `GET /v1/me` is called
- THEN it returns `401`

### Requirement: PMU-008 /v1/contacts List

`GET /v1/contacts` MUST return the authenticated user's active recipients. It MUST be scoped to the resolved `userId` and MUST NOT return another user's recipients.

#### Scenario: list own contacts

- GIVEN a verified token for user A with stored contacts
- WHEN `GET /v1/contacts` is called
- THEN it returns only A's active recipients

### Requirement: PMU-009 /v1/contacts Create

`POST /v1/contacts` MUST create a recipient with `provenance='user'` and `status='confirmed'`, meaning a user-created contact is user-confirmed at creation time. Creation MUST scope to the resolved `userId` and MUST NOT allow creating a record for another user.

#### Scenario: create confirmed user contact

- GIVEN a verified token for user A
- WHEN `POST /v1/contacts` is called with a valid name and address
- THEN a recipient is created for A with `provenance='user'` and `status='confirmed'`

#### Scenario: create blocked for another user

- GIVEN a verified token for user A
- WHEN a create attempts to set a `user_id` for user B
- THEN it is rejected and no row is created for B

### Requirement: PMU-010 /v1/contacts Update as New Version

`PATCH /v1/contacts/:id` MUST update name, description, or address by creating a new version of the existing recipient rather than overwriting it. Updates MUST be scoped to the authenticated user and MUST NOT modify another user's record. PATCH MUST require expectedVersion, reject a stale value with 409 and atomically retain the prior snapshot in owner-scoped recipient_versions while advancing the current recipients projection. The stable recipient ID MUST be preserved.

#### Scenario: update creates new version

- GIVEN a verified token for user A and an existing A recipient
- WHEN `PATCH /v1/contacts/:id` changes the address
- THEN a new version is recorded and the prior version remains

#### Scenario: update blocked for another user

- GIVEN a verified token for user A
- WHEN `PATCH /v1/contacts/:id` targets user B's recipient
- THEN it is rejected and no version is created


#### Scenario: concurrent updates preserve history

- GIVEN two PATCH requests carrying the same expectedVersion for an owned recipient
- WHEN both attempt to change the contact
- THEN one advances the current version and retains its prior snapshot, while the other returns 409
- AND search/reveal uses only the current active projection

### Requirement: PMU-011 /v1/contacts Soft Delete

`DELETE /v1/contacts/:id` MUST soft-delete a recipient by setting `status='archived'` rather than physically removing it. It MUST scope to the authenticated user and MUST NOT archive another user's record.

#### Scenario: archive own contact

- GIVEN a verified token for user A and an existing A recipient
- WHEN `DELETE /v1/contacts/:id` is called
- THEN the recipient's status becomes `archived` and it is excluded from active lists

#### Scenario: archive blocked for another user

- GIVEN a verified token for user A
- WHEN `DELETE /v1/contacts/:id` targets user B's recipient
- THEN it is rejected and B's record stays unchanged

### Requirement: PMU-012 /v1/contacts Reveal CBU

`POST /v1/contacts/:id/reveal-cbu` MUST return the plain address for the authenticated user's recipient so the front can tap-to-copy. It MUST require a verified token and MUST NOT reveal another user's address.

#### Scenario: reveal own address

- GIVEN a verified token for user A and an existing A recipient
- WHEN `POST /v1/contacts/:id/reveal-cbu` is called
- THEN it returns the plain address

#### Scenario: reveal blocked for another user

- GIVEN a verified token for user A
- WHEN `POST /v1/contacts/:id/reveal-cbu` targets user B's recipient
- THEN it returns `404`/`403` and reveals no address

### Requirement: PMU-013 Cross-User Isolation on Contacts

Every `/v1/contacts` endpoint MUST guarantee cross-user isolation through RLS plus parameterized (bind) queries. User A MUST never read or mutate user B's recipients, and the endpoints MUST NOT reveal the existence of another user's records.

#### Scenario: A cannot read or mutate B

- GIVEN users A and B both have recipients
- WHEN A lists, reads, updates, deletes, or reveals any B recipient id
- THEN the operation returns no B data and does not mutate B's rows

#### Scenario: existence not revealed

- GIVEN user A queries a B recipient id
- WHEN the operation fails to find it
- THEN the response does not reveal whether the id belongs to another user

### Requirement: PMU-014 Text Path Per-Request Identity

The text path MUST construct the memory runtime per request using the resolved `userId`, replacing the fixed `demoUserId`. The voice worker MUST continue scoping via `binding.sub`; token issuance MUST first authenticate the caller and verify conversation ownership (PMU-020). In `privy` mode no path MAY use a fixed `demoUserId`; `demo` mode resolves the configured sentinel UUID.

#### Scenario: text path scopes to resolved user

- GIVEN a request resolved to user A
- WHEN the text memory runtime is built
- THEN it uses A's resolved UUID

#### Scenario: voice identity comes from an authorized conversation

- GIVEN a live voice session
- WHEN memory tools scope
- THEN they scope to `binding.sub` as today

### Requirement: PMU-015 Front Privy Login and Session

The configured phone channel MUST be either SMS or WhatsApp according to the Privy app configuration, never an unsupported promise of both. The front MUST wrap the app with `PrivyProvider` using `VITE_PRIVY_APP_ID`, provide a login screen with email and configured phone OTP (SMS or WhatsApp), persist the Privy session, and provide logout. The `sessionStorage` token and the `"token-de-desarrollo"` fallback MUST be retired except for the demo path.

#### Scenario: login flow

- GIVEN the front with `VITE_PRIVY_APP_ID` configured
- WHEN the user logs in via email or the configured phone channel
- THEN a Privy session is established and the app continues authenticated

#### Scenario: logout

- GIVEN an authenticated session
- WHEN the user logs out
- THEN local auth state is cleared and the app returns to login

### Requirement: PMU-016 Front Bearer Token Plumbing with 401 Retry

The front MUST obtain a Privy access token and send it as `Authorization: Bearer <token>` on every API request. On `401`, it MUST refresh the token and retry the request once. Unauthenticated calls MUST NOT proceed without a token.

#### Scenario: bearer on each request

- GIVEN an authenticated front session
- WHEN an API request is made
- THEN it carries `Authorization: Bearer <access token>`

#### Scenario: 401 refresh and retry once

- GIVEN a request returns `401`
- WHEN the front observes it
- THEN it refreshes the token and retries once

#### Scenario: retry once only

- GIVEN the refreshed request again returns `401`
- WHEN the front observes it
- THEN it does not retry again and surfaces the failure

### Requirement: PMU-017 Front Demo Fallback Gating

The front MUST fall back to the demo token only when `VITE_IDENTITY_PROVIDER=demo`; in `privy` mode it MUST NOT use the demo fallback.

#### Scenario: demo fallback allowed

- GIVEN `VITE_IDENTITY_PROVIDER=demo`
- WHEN an API request is made
- THEN it uses the demo token

#### Scenario: demo fallback disabled in privy mode

- GIVEN `VITE_IDENTITY_PROVIDER=privy`
- WHEN an API request is made
- THEN it does not use the demo fallback

### Requirement: PMU-018 api-types.ts Mirror

`apps/nana-wallet/src/lib/api-types.ts` MUST be updated to mirror `src/contracts/http.ts` in the same PR, keeping the front and back contract types in sync.

#### Scenario: mirror stays in sync

- GIVEN a contract change in `src/contracts/http.ts`
- WHEN the PR ships
- THEN `api-types.ts` reflects the same types

### Requirement: PMU-019 Identity and Isolation Tests

The change MUST ship tests covering provider token verification (valid, expired, wrong key), idempotent upsert, and cross-user isolation per endpoint.

#### Scenario: provider token tests

- GIVEN a test signing key
- WHEN tokens valid, expired, and wrong-key are verified
- THEN valid passes and the others are rejected

#### Scenario: idempotent upsert test

- GIVEN repeated resolution of the same DID
- WHEN tested
- THEN exactly one row exists and the same UUID returns

#### Scenario: cross-user isolation tests

- GIVEN users A and B in the same database
- WHEN each contacts endpoint is exercised across users
- THEN no A/B cross-read or cross-mutation is observed

### Requirement: PMU-020 Authorized Voice Tokens

In Privy mode, `POST /v1/voice/room-token` MUST verify the access token and fetch the conversation under the resolved UUID with RLS before calling the issuer. Missing/invalid/expired authentication MUST return 401. A missing or foreign conversation MUST return the same 404. The issuer MUST derive participant identity from the resolved UUID and room name from the owned conversation. It MUST NOT accept caller-supplied identity or arbitrary agent dispatch. Existing TTL, grants and signed live-binding checks MUST remain enforced.

#### Scenario: no token and foreign conversation

- GIVEN users A and B with separate conversations
- WHEN a caller has no token, or A requests B's room
- THEN the response is respectively 401 or the same 404 as an absent conversation
- AND the issuer is never called

#### Scenario: owned room on either LiveKit deployment

- GIVEN A owns the requested conversation and LiveKit is local or hosted
- WHEN A requests a token
- THEN the participant UUID and live binding subject are A and the grant permits only that conversation's room
- AND the browser takes its expected identity from `/v1/me`, not `VITE_LIVEKIT_PARTICIPANT_IDENTITY`
- AND the unauthenticated demo token-server path cannot be selected in Privy mode

### Requirement: PMU-021 Account Transition Isolation

Logout, session expiration and account switch MUST cancel user-scoped requests, clear React Query data and conversation/preview state, disconnect voice and discard late responses from the old session before rendering another user. Cache keys MUST include the internal UUID. A retry MUST retain the originating user and idempotency key; it MUST NOT replay A's request with B's token.

#### Scenario: late response after switching accounts

- GIVEN A has cached contacts, an open voice room and an in-flight mutation
- WHEN A logs out and B logs in before the response arrives
- THEN no A data, transcript, room or confirmation remains accessible to B
- AND the late result cannot populate B's cache or trigger a retry as B

### Requirement: PMU-022 Provisioning Under FORCE RLS

Provisioning MUST work with a non-superuser, NOBYPASSRLS migration owner. The new `users` table MUST have a provisioning policy restricted to that actual owner, alongside the self-read policy restricted to `recipient_app`. The owner-only SECURITY DEFINER function MUST use schema-qualified objects and a safe search path. PUBLIC and recipient_app MUST lack EXECUTE; recipient_app MUST lack membership allowing SET ROLE to the owner. Existing user-data policies MUST remain unchanged. Runtime role and function ownership MUST be checked explicitly, never inferred from a successful superuser test.

#### Scenario: ordinary owner provisions first login

- GIVEN FORCE RLS and a non-superuser owner without BYPASSRLS
- WHEN the trusted backend calls the provisioning function twice and concurrently for a verified DID
- THEN one UUID is returned and one user exists

#### Scenario: application role cannot provision identities

- GIVEN the recipient_app role scoped to A
- WHEN it attempts to invoke provisioning, assume the owner or read B
- THEN all three operations are denied or reveal zero foreign rows

### Requirement: PMU-023 Runnable Migration and Contract Gates

A fresh local database MUST acquire the conversation tables before the users migration adds their foreign keys. Tests MUST cover both the local migration sequence and Supabase sequence, plus upgrade from an existing demo database. Contract parity MUST be validated through shared JSON examples tested separately in each project, without importing backend code into frontend or vice versa.

#### Scenario: clean database and independent contracts

- GIVEN a clean local database and separately compiled frontend/backend
- WHEN their migration and contract tests run
- THEN all prerequisites exist and the same HTTP examples pass both independent schemas
- AND no cross-project import is introduced

### Requirement: PMU-024 Identity Foundation Cannot Spend a Shared Wallet

Until the dependent per-user wallet change is implemented and verified, `IDENTITY_PROVIDER=privy` MUST reject startup with a funded/live singleton wallet provider. Fixture preview and confirmation remain available for verification. Wallet, conversation and paid voice routes MUST authenticate in Privy mode; health remains public with redacted operational data.

#### Scenario: shared wallet in Privy mode

- GIVEN Privy authentication and a live WDK or Circle singleton provider
- WHEN the foundation starts
- THEN startup rejects before serving financial operations

### Requirement: PMU-025 Observable End-to-End Verification

Delivery MUST include backend lint, typecheck, unit/integration tests with a running database, evals and build; frontend lint, typecheck, tests and build; browser E2E through the real fixture backend; and a Privy web login smoke for each promised login method. A test identity adapter MAY replace the external SDK only in the deterministic browser harness and MUST NOT be reachable in production. Missing external credentials or OTP access MUST be reported as a blocked live check, never as a pass.

#### Scenario: browser identity and memory journey

- GIVEN two browser sessions and the fixture backend with a migrated database
- WHEN A logs in, creates a contact, asks the agent to use it, previews and cancels, then logs out and B logs in
- THEN the owned contact is used for A, no transfer occurs on cancel, and B sees none of A's data
- AND unauthorized voice-token requests are rejected

### Requirement: PMU-026 Supported Phone Login Channel

The app MUST offer email plus the phone OTP channel actually configured in Privy. It MUST NOT advertise SMS and WhatsApp simultaneously when the provider permits only one. Implementation MUST first record the existing channel or obtain a product decision if the app is not configured; no dashboard channel changes are authorized by this specification.

#### Scenario: one phone channel configured

- GIVEN the Privy app is configured for SMS or WhatsApp
- WHEN the login UI and live smoke run
- THEN email and that configured channel are offered and tested
- AND the other phone channel is not presented as available
