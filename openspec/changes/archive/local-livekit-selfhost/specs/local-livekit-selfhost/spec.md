# Local LiveKit Self-Host Specification

## Purpose

Enable the live voice stack to run end-to-end against a locally self-hosted `livekit-server` for local development. After this change, `docker compose up -d livekit`, `npm run livekit:dev`, and the web app work against `ws://localhost:7880` with no LiveKit Cloud credentials, while LiveKit Cloud remains fully supported as an explicit configuration alternative. Token issuance is server-authoritative from Fastify, and the browser obtains a short-lived room-scoped token without knowing grants or room naming. Privacy guarantees (`record: false`, no egress/recording/webhooks, audio on loopback) and the preview→confirm financial flow are unchanged.

## Requirements

### Requirement: LLS-001 Self-hosted LiveKit server availability

The system MUST provide a `livekit` service in `compose.yaml` running the official `livekit/livekit-server` image, configured by a `docker/livekit.yaml` config. The service MUST publish only loopback-bound ports (`127.0.0.1`, port `7880` for WebSocket/RTC and the RTC UDP media range), MUST source its API key/secret from the same `.env` credentials used by the API and worker, and MUST NOT enable egress, recording, or webhooks.

#### Scenario: Compose service starts and is reachable

- GIVEN `docker compose up -d livekit` is run
- WHEN the service becomes healthy
- THEN the local server is reachable at `ws://localhost:7880`
- AND no Cloud credentials are required

#### Scenario: Loopback-only published ports

- GIVEN the `livekit` service is running
- WHEN the published ports are inspected
- THEN only `127.0.0.1`-bound ports (`7880` and the RTC media range) are exposed

#### Scenario: No egress/recording/webhooks

- GIVEN the `docker/livekit.yaml` config
- WHEN it is inspected
- THEN no egress, recording, or webhook settings are enabled

### Requirement: LLS-002 Room-token issuance endpoint contract

The system MUST expose `POST /v1/voice/room-token`, registered within `registerVoiceRoutes`, DB-independent, and validated by zod schemas in `src/contracts/http.ts`. The request body MUST be `{ conversationId: uuid, agentName?: string }`. The response MUST be `{ serverUrl, participantToken, roomName }`, replicating the token-source contract the web client already consumes.

#### Scenario: Valid request returns the token-source contract

- GIVEN a valid `{ conversationId, agentName? }` request
- WHEN `POST /v1/voice/room-token` is called
- THEN the response contains `serverUrl`, `participantToken`, and `roomName`

#### Scenario: Invalid request body

- GIVEN a request with a malformed or missing `conversationId`
- WHEN the endpoint is called
- THEN it returns a `400` response using the existing `invalid_body` zod error pattern

### Requirement: LLS-003 Server-authoritative room name and identity

The server MUST derive `roomName = nani-${conversationId}` and the participant identity from its own configuration (demo user identity). The frontend MUST NOT decide the room name or the participant identity, and `VITE_LIVEKIT_PARTICIPANT_IDENTITY` MUST remain only a frontend sanity check.

#### Scenario: Server derives the room name

- GIVEN a request with `conversationId` set
- WHEN the endpoint issues a token
- THEN `roomName` equals `nani-${conversationId}`

#### Scenario: Server owns identity

- GIVEN a token is issued
- WHEN the JWT is decoded
- THEN the participant identity is the server-derived demo user identity, not a client-supplied value

### Requirement: LLS-004 Token grants and single-room scoping

The issued token MUST carry video grants `{ roomJoin, room, canPublish, canSubscribe }`, MUST be scoped to exactly one room (`nani-${conversationId}`), and MUST NOT carry admin grants.

#### Scenario: Decoded grants are non-admin and single-room

- GIVEN a token issued for one conversation
- WHEN the JWT is decoded
- THEN the grants include `roomJoin`, `room`, `canPublish`, and `canSubscribe`
- AND the `room` is the single `nani-${conversationId}` room
- AND no admin grant is present

### Requirement: LLS-005 Automatic agent dispatch via RoomConfiguration

The issued token MUST embed a `RoomConfiguration` with an `agents` array containing the requested `agentName`, so the worker is dispatched automatically without an explicit dispatch client in the real flow. When `agentName` is absent, the system MUST use a default configured agent name.

#### Scenario: Embedded agents trigger automatic dispatch

- GIVEN a request with `agentName` set
- WHEN the JWT is decoded
- THEN the `RoomConfiguration` contains an `agents` entry for that `agentName`

#### Scenario: Default agent when not provided

- GIVEN a request without `agentName`
- WHEN the token is issued
- THEN the embedded `agents` entry uses the configured default agent name

### Requirement: LLS-006 Token TTL bounds

The issued token MUST be short-lived with a default TTL of `10m`, and MUST honor an optional `LIVEKIT_ROOM_TOKEN_TTL` configuration bounded to a minimum. The configured TTL MUST NOT fall below the enforced minimum.

#### Scenario: Default TTL applies when unset

- GIVEN `LIVEKIT_ROOM_TOKEN_TTL` is not configured
- WHEN a token is issued
- THEN the token TTL is the default `10m`

#### Scenario: Configured TTL within bounds

- GIVEN `LIVEKIT_ROOM_TOKEN_TTL` is set to a value at or above the minimum
- WHEN a token is issued
- THEN the token TTL equals that configured value

#### Scenario: TTL below the minimum is rejected or clamped

- GIVEN `LIVEKIT_ROOM_TOKEN_TTL` is set below the enforced minimum
- WHEN a token is issued
- THEN the token TTL is either rejected or clamped to the minimum
- AND a too-short token is never issued

### Requirement: LLS-007 Failure behavior on issuer misconfiguration

The endpoint MUST fail fast and clearly when the LiveKit issuer credentials (`LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) are not configured, returning a `503`-class response documented in `docs/api.md`. Invalid request bodies MUST return `400 invalid_body` per the existing zod error pattern.

#### Scenario: Missing issuer credentials

- GIVEN LiveKit issuer credentials are not configured
- WHEN `POST /v1/voice/room-token` is called
- THEN the endpoint returns a clear `503`-class failure
- AND no token is issued

#### Scenario: Invalid body when credentials are present

- GIVEN LiveKit issuer credentials are configured
- WHEN a request with an invalid body is submitted
- THEN the endpoint returns `400 invalid_body`

### Requirement: LLS-008 Frontend token source selection

The frontend MUST select its token source via `VITE_LIVEKIT_TOKEN_SOURCE`, with `local` as the default. The `local` source MUST call `fetchVoiceRoomToken(conversationId)` and MUST NOT hold frontend knowledge of `roomName` or grants. The `cloud` source MUST retain the existing `TokenSource.developmentTokenServer` path and MUST require `VITE_LIVEKIT_TOKEN_SERVER_ID`. Both sources MUST satisfy the same `{ serverUrl, participantToken }` connect contract used by `room.connect`.

#### Scenario: Local is the default source

- GIVEN `VITE_LIVEKIT_TOKEN_SOURCE` is not set
- WHEN the web client initializes
- THEN it uses the `local` token source
- AND `VITE_LIVEKIT_TOKEN_SERVER_ID` is not required

#### Scenario: Cloud source is preserved

- GIVEN `VITE_LIVEKIT_TOKEN_SOURCE=cloud` and `VITE_LIVEKIT_TOKEN_SERVER_ID` is set
- WHEN the web client initializes
- THEN it uses the `developmentTokenServer` path unchanged

#### Scenario: Cloud source without its server ID

- GIVEN `VITE_LIVEKIT_TOKEN_SOURCE=cloud`
- WHEN `VITE_LIVEKIT_TOKEN_SERVER_ID` is not set
- THEN the client reports a clear configuration error and does not connect

#### Scenario: Both sources satisfy the connect contract

- GIVEN the `local` or `cloud` source returns credentials
- WHEN `room.connect(serverUrl, participantToken)` is called
- THEN the connect flow succeeds without contract changes

### Requirement: LLS-009 Privacy invariants unchanged

The worker MUST continue sending `record: false` to sessions, and `readLiveKitPrivacyConfig` MUST continue forcing `recordingEnabled: false` and `observabilityRecording: false` and throwing if a caller attempts to enable them. The self-hosted server config MUST enable no egress, recording, or webhooks, so audio MUST NOT leave loopback.

#### Scenario: Recording stays off in the worker

- GIVEN a session is started
- WHEN the worker publishes session config
- THEN `record: false` is sent
- AND recording/observability stay disabled

#### Scenario: Attempting to enable recording is rejected

- GIVEN a caller tries to enable recording
- WHEN `readLiveKitPrivacyConfig` is used
- THEN the config throws

#### Scenario: Audio stays on loopback

- GIVEN the self-hosted server runs with the `docker/livekit.yaml` config
- WHEN the server is inspected
- THEN egress, recording, and webhooks are disabled
- AND audio never leaves loopback

### Requirement: LLS-010 HTTP /v1 contract and typed client updated together

The new `POST /v1/voice/room-token` contract MUST be documented in `docs/api.md` and typed in `apps/nana-wallet/src/lib/api-types.ts` in the same change. The documented response, the typed response, and the endpoint's actual response MUST agree on `{ serverUrl, participantToken, roomName }`.

#### Scenario: Contract sides updated together

- GIVEN the new endpoint is implemented
- WHEN the change is complete
- THEN `docs/api.md` documents the endpoint
- AND `apps/nana-wallet/src/lib/api-types.ts` carries the matching response type
- AND both match the actual endpoint response

### Requirement: LLS-011 Front/back separation

The backend MUST own token issuance and MUST be server-authoritative for room name, identity, grants, and dispatch. The frontend MUST only call the token endpoint and MUST NOT construct grants, room names, or admin tokens. The frontend MUST NOT use server-side admin credentials.

#### Scenario: Frontend does not decide sensitive values

- GIVEN a browser requests a token
- WHEN the token is issued
- THEN the frontend does not supply room name, identity, grants, or admin privileges

### Requirement: LLS-012 Explicit livekit-server-sdk dependency

`livekit-server-sdk` MUST be declared as an explicit root dependency in `package.json` before it is imported by `src/api/voice.ts`.

#### Scenario: Explicit dependency declared

- GIVEN `src/api/voice.ts` imports `livekit-server-sdk`
- WHEN `package.json` is inspected
- THEN `livekit-server-sdk` is declared as an explicit root dependency

## Amendment (docker full-stack wiring, 2026-09-06)

- **LLS-002 (amended):** the token response `serverUrl` is the **browser-facing**
  LiveKit URL, sourced from `LIVEKIT_BROWSER_URL` when set, defaulting to
  `LIVEKIT_URL`. Rationale: when the backend runs in compose, `LIVEKIT_URL`
  points at the internal service (`ws://livekit:7880`), which is unreachable
  from the browser; the browser must connect through the loopback-published
  port (`ws://localhost:7880`).
- **LLS-001 (amended):** the self-hosted server also serves the docker
  full-stack flow: backend and voice-worker services (existing docker stack)
  register/sign against the internal `livekit` compose service while the
  browser connects via `LIVEKIT_BROWSER_URL`.
