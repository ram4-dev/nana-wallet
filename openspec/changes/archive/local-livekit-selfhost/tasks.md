# Tasks: Local LiveKit Self-Host

## Review Workload Forecast

| Field | Value |
| ------- | ------- |
| Estimated changed lines | ~780–900 |
| 400-line budget risk | High |
| Chained PRs recommended | Yes |
| Suggested split | PR 1 (deps + infra + backend) → PR 2 (frontend) → PR 3 (docs + verification) |
| Delivery strategy | ask-on-risk |
| Chain strategy | pending |

```text
Decision needed before apply: Yes
Chained PRs recommended: Yes
Chain strategy: pending
400-line budget risk: High
```

Rationale: the change touches infra (new compose service + config), backend (config reader, issuer, contracts, route, injection), a new backend unit test file, frontend (types, api client, token-source selector), a new colocated frontend test file, docs, and env examples — plus both backend and frontend verification gates. `livekit-server-sdk ^2.18.0` is the only dependency, but the RoomConfiguration field-shape risk (R1) needs a build-time check. The three slices are independently revertible (compose service + endpoint can be reverted without touching frontend; Cloud path is config-gated), so chained PRs keep review diffs focused.

### Suggested Work Units

| Unit | Bounded outcome | Focused test | Runtime harness | Rollback boundary |
| --- | --- | --- | --- | --- |
| 1 | Deps + infra + backend issuance | `npm test -- --run tests/unit/voice-room-token.test.ts` | `docker compose up -d livekit`; `npm run livekit:dev` | package.json, compose service, config reader, issuer, contracts, route, server injection |
| 2 | Frontend local token source | `npm test -- --run apps/nana-wallet/src/features/agent/voice/livekit-web-client.test.ts` | `VITE_LIVEKIT_TOKEN_SOURCE=local` web app vs `ws://localhost:7880` | frontend `.env.example`, api types/client, web client; `cloud` path kept |
| 3 | Docs + verification gates | `npm run typecheck && npm test` | manual runbook smoke; optional `test:e2e:livekit-smoke` | docs + `.env.example` |

## Phase 1: Dependencies and Infrastructure

- [x] 1.1 Declare `livekit-server-sdk` as an explicit root dependency in `package.json` at `^2.18.0` (before any import of it). Verify no lockfile drift and no dual hoisted copy (`npm ls livekit-server-sdk`). Depends: none. **LLS-012**. <!-- sdd-owner: implementation -->
- [x] 1.2 Create `docker/livekit.yaml`: `port: 7880`, `rtc.udp_port: 7881`, `rtc.port_range_start: 60000`, `rtc.port_range_end: 60100`, and `keys` using `${LIVEKIT_API_KEY}` / `${LIVEKIT_API_SECRET}` (the compose service injects the same .env credentials the API and worker use). Must contain NO egress, recording, or webhook sections — their absence is the auditable privacy guarantee. Depends: 1.1. **LLS-001, LLS-009**. <!-- sdd-owner: implementation -->
- [x] 1.3 Add a `livekit` service to `compose.yaml`: image `livekit/livekit-server` (pin the tag at implementation time), `command: --config /etc/livekit.yaml`, `environment` for `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET`, `volumes` mounting `./docker/livekit.yaml:/etc/livekit.yaml:ro`, and published ports bound only to `127.0.0.1` (`7880`, `7881/udp`, `60000-60100/udp`). Verify `docker compose config` resolves and the ports are loopback-only; add a healthcheck if the image supports one. Depends: 1.2. **LLS-001**. <!-- sdd-owner: implementation -->

## Phase 2: Backend — Config Reader

- [x] 2.1 In `src/config/livekit.ts`, add the `LiveKitTokenIssuerConfig` type and `readLiveKitTokenIssuerConfig(environment = process.env)` reader. Reuse `positiveInteger` from `src/config/process.ts`. Validate: `url` (non-empty `LIVEKIT_URL`), `apiKey` (`LIVEKIT_API_KEY`), `apiSecret` (`LIVEKIT_API_SECRET`) — throw `LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET are required to issue LiveKit room tokens.` naming exactly which are missing; `defaultAgentName` = `LIVEKIT_AGENT_NAME ?? 'nani-agent'`; `roomTokenTtlSeconds` = `LIVEKIT_ROOM_TOKEN_TTL` default `600`, minimum `60`, and REJECT below `60` with `LIVEKIT_ROOM_TOKEN_TTL must be at least 60 seconds.`. Do NOT modify `readLiveKitPrivacyConfig` (it must keep forcing `recordingEnabled: false` / `observabilityRecording: false` and throwing on enable attempts). Depends: 1.1. **LLS-006, LLS-007, LLS-009**. <!-- sdd-owner: implementation -->

## Phase 3: Backend — Token Issuer Module

- [x] 3.1 Create `src/livekit/token-issuer.ts` with `issueRoomToken(config, input: { conversationId, agentName? })` returning `{ serverUrl, participantToken, roomName }`. Derive `roomName = nani-${conversationId}` (server-authoritative, LLS-003). Build `AccessToken(config.apiKey, config.apiSecret, { identity, ttl: config.roomTokenTtlSeconds })`. Video grants EXACTLY `{ roomJoin: true, room: roomName, canPublish: true, canSubscribe: true }` — no `roomAdmin`, no `roomCreate`. Embed `RoomConfiguration` with `agents: [{ agentName }]` (request `agentName` else `config.defaultAgentName`). Return `serverUrl = config.url` verbatim. Before wiring, confirm the `AccessToken` room-config option name and the JWT claim (`roomConfig` with `agents`/`RoomAgentDispatch`) against the `^2.18.0` typings (risk R1) — the unit test asserts the decoded JWT, not the constructor shape. Depends: 2.1. **LLS-003, LLS-004, LLS-005**. <!-- sdd-owner: implementation -->

## Phase 4: Backend — Contracts

- [x] 4.1 In `src/contracts/http.ts`, add `voiceRoomTokenRequestSchema = z.object({ conversationId: z.string().uuid(), agentName: z.string().trim().min(1).optional() })` and `voiceRoomTokenResponseSchema = z.object({ serverUrl: z.string().min(1), participantToken: z.string().min(1), roomName: z.string().min(1) })`. Depends: none (standalone schema addition). **LLS-002, LLS-010**. <!-- sdd-owner: implementation -->

## Phase 5: Backend — Route and Injection

- [x] 5.1 Extend `registerVoiceRoutes(app, options?)` in `src/api/voice.ts` with an optional `liveKitTokenIssuer` dependency, and add `POST /v1/voice/room-token`. Handler flow: `safeParse(request.body)` → malformed/missing `conversationId` → `400 { status:'error', message, code:'invalid_body' }` (same shape as `/v1/voice/speak`); issuer-level misconfiguration (missing credentials, missing `demoUserId`, TTL out of bounds) → `503 { status:'error', message, code:'voice_token_unavailable' }` with a message naming the offending env var, and no token issued; success → `200 { serverUrl, participantToken, roomName }`. Existing `/v1/voice/speak` route and any existing behavior must remain unchanged when the dependency is absent. Depends: 3.1, 4.1. **LLS-002, LLS-007**. <!-- sdd-owner: implementation -->
- [x] 5.2 In `src/server.ts`, build the issuer dependency and pass it into `registerVoiceRoutes` using the existing options pattern (`bindingPrivateKey` precedent): `issue: (input) => issueRoomToken({ ...readLiveKitTokenIssuerConfig(), identity: memoryConfig.demoUserId ?? "" }, input)`. A missing `demoUserId` surfaces as `503 voice_token_unavailable` (identity is server-owned). Keep the DB-independent registration order; when DB/demo config is absent the voice routes must still register as they do today. Depends: 5.1. **LLS-003, LLS-007**. <!-- sdd-owner: implementation -->

## Phase 6: Backend — Unit Tests

- [x] 6.1 Create `tests/unit/voice-room-token.test.ts` (no network, no LiveKit server): issue via `issueRoomToken` with a generated key/secret, then verify the JWT (`TokenVerifier` or decode the payload) and assert the video grants are exactly `{ roomJoin, room, canPublish, canSubscribe }`, `room === nani-<conversationId>`, no `roomAdmin`/`roomCreate`, `identity === demoUserId`, an embedded `agents` entry for the requested `agentName`, and `exp - iat === ttl`. Depends: 3.1. **LLS-003, LLS-004, LLS-005**. <!-- sdd-owner: implementation -->
- [x] 6.2 Add TTL bounds tests: default `600` when `LIVEKIT_ROOM_TOKEN_TTL` is unset; a configured value at/above `60` is honored; a value below `60` makes `readLiveKitTokenIssuerConfig` throw the named `must be at least 60 seconds.` message. Depends: 2.1. **LLS-006**. <!-- sdd-owner: implementation -->
- [x] 6.3 Add credential tests: `readLiveKitTokenIssuerConfig` throws the named message for each missing of `LIVEKIT_URL` / `LIVEKIT_API_KEY` / `LIVEKIT_API_SECRET`, and that `readLiveKitPrivacyConfig` still forces `recordingEnabled: false`/`observabilityRecording: false` and throws on enable attempts (no regression). Depends: 2.1. **LLS-007, LLS-009**. <!-- sdd-owner: implementation -->
- [x] 6.4 Add endpoint tests through Fastify `inject`: valid body → `200` with the three fields; malformed/missing `conversationId` → `400 invalid_body`; issuer misconfiguration → `503 voice_token_unavailable`. Depends: 5.1. **LLS-002, LLS-007**. <!-- sdd-owner: implementation -->

## Phase 7: Frontend — Types and API Client

- [x] 7.1 Add `VoiceRoomTokenResponse = { serverUrl: string; participantToken: string; roomName: string }` to `apps/nana-wallet/src/lib/api-types.ts`. Depends: 4.1 (matches the backend response schema). **LLS-010**. <!-- sdd-owner: implementation -->
- [x] 7.2 Add `fetchVoiceRoomToken(conversationId)` to `apps/nana-wallet/src/lib/api.ts` using the `rawConversationRequest<VoiceRoomTokenResponse>("/v1/voice/room-token", jsonRequest("POST", { conversationId }))` pattern (voice/conversation envelope, not `ApiEnvelope`). The frontend sends only `conversationId`; it must not construct grants, room names, or admin tokens. Depends: 7.1. **LLS-002, LLS-011**. <!-- sdd-owner: implementation -->

## Phase 8: Frontend — Token Source Selector

- [x] 8.1 In `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts`, add the `VITE_LIVEKIT_TOKEN_SOURCE` selector (`"local"` default when unset | `"cloud"`). `local`: requires only `participantIdentity` (`VITE_LIVEKIT_PARTICIPANT_IDENTITY` sanity check), calls `fetchVoiceRoomToken(binding.conversationId)` after `createLiveVoiceBinding`, stores the returned `roomName` (server-owned; the frontend no longer builds `nani-${conversationId}`), decodes the JWT payload (`atob`) and verifies `identity === participantIdentity` (mismatch → clear error before `room.connect`), then calls `room.connect(credentials.serverUrl, credentials.participantToken, ...)` unchanged. `cloud`: keep `TokenSource.developmentTokenServer(config.tokenServerId)` byte-for-byte and require `VITE_LIVEKIT_TOKEN_SERVER_ID`; when missing under `cloud`, surface the existing "Live voice is not configured for this browser." failure before any connect. Both paths must satisfy the same `{ serverUrl, participantToken }` connect contract. Depends: 7.2. **LLS-008, LLS-011**. <!-- sdd-owner: implementation -->
- [x] 8.2 Update `apps/nana-wallet/.env.example`: add `VITE_LIVEKIT_TOKEN_SOURCE=local` and commented English defaults; document env semantics — `VITE_LIVEKIT_TOKEN_SERVER_ID` is Cloud-only and ignored under `local`; `VITE_LIVEKIT_AGENT_NAME` is sent to the dev token server under `cloud` only; `VITE_LIVEKIT_PARTICIPANT_IDENTITY` is a sanity check on both paths. Depends: 8.1. **LLS-008**. <!-- sdd-owner: implementation -->

## Phase 9: Frontend — Colocated Tests

- [x] 9.1 Create `apps/nana-wallet/src/features/agent/voice/livekit-web-client.test.ts`: source selection — unset `VITE_LIVEKIT_TOKEN_SOURCE` → `local` path calls `fetchVoiceRoomToken` and does NOT require `VITE_LIVEKIT_TOKEN_SERVER_ID`; `cloud` + id → `developmentTokenServer` path unchanged; `cloud` without id → clear configuration error, no connect. Depends: 8.1. **LLS-008**. <!-- sdd-owner: implementation -->
- [x] 9.2 Add the response-contract test: the `local` source feeds `room.connect(serverUrl, participantToken)` with the endpoint's fields and stores the returned `roomName`. Depends: 8.1. **LLS-008, LLS-010**. <!-- sdd-owner: implementation -->

## Phase 10: Docs

- [x] 10.1 Document `POST /v1/voice/room-token` in `docs/api.md`: request `{ conversationId, agentName? }`, response `{ serverUrl, participantToken, roomName }`, `400 invalid_body`, `503 voice_token_unavailable`, and the privacy/security notes (short-lived, single-room, demo identity, no admin grants, no JWTs logged). Depends: 5.1. **LLS-002, LLS-007, LLS-010**. <!-- sdd-owner: implementation -->
- [x] 10.2 Update `docs/livekit-development-runbook.md`: add a "Self-hosted LiveKit (default local)" section (self-hosted route as the local default: `docker compose up -d livekit` → healthcheck reachability at `ws://localhost:7880` → `npm run livekit:dev` registers against the local server → start API and web app → one non-financial turn and one financial preview→confirm turn), and demote Cloud to an explicit alternative. Document the Colima/Docker UDP fallback (locally installed binary), TTL expiry recovery ("stop and start live voice again"), and the different-host `LIVEKIT_URL` note. Depends: 1.3, 8.1. **LLS-001, LLS-006, LLS-008**. <!-- sdd-owner: implementation -->
- [x] 10.3 Update root `.env.example` with commented English defaults for the livekit compose keys (`LIVEKIT_URL=ws://localhost:7880` local default), `LIVEKIT_AGENT_NAME`, and `LIVEKIT_ROOM_TOKEN_TTL` (default 600, min 60). Depends: 1.2, 2.1. **LLS-001, LLS-006**. <!-- sdd-owner: implementation -->

## Phase 11: Verification — Backend

- [x] 11.1 Run backend verification: `npm run typecheck` and `npm test -- --run tests/unit/voice-room-token.test.ts tests/unit/livekit-config.test.ts tests/unit/livekit-privacy.test.ts tests/integration/api-voice.test.ts`. Confirm exit 0, the new issuer/TTL/credential/endpoint tests pass, and the privacy reader still throws on recording-enable attempts (no regression). Depends: 6.1–6.4. **LLS-006, LLS-007, LLS-009**. <!-- sdd-owner: implementation -->

## Phase 12: Verification — Frontend

- [x] 12.1 Run frontend verification for the changed modules: typecheck + test of `apps/nana-wallet/src/features/agent/voice/livekit-web-client.test.ts` and the `api.ts`/`api-types.ts` modules. Confirm the `cloud` path is still present, the `room.connect` contract is unchanged, and the `local` path is the default. Depends: 9.1–9.2. **LLS-008**. <!-- sdd-owner: implementation -->

## Phase 13: Manual Runbook Check and Optional Smoke E2E

- [ ] 13.1 Manual runbook check (documented, not automated): `docker compose up -d livekit` → reachable at `ws://localhost:7880` with only `127.0.0.1` published ports and no egress/recording/webhooks; `npm run livekit:dev` registers against the local server; run one non-financial turn and one financial preview→confirm turn; confirm the worker sends `record: false` and audio stays on loopback. Depends: 1.3, 10.2. **LLS-001, LLS-009**. <!-- sdd-owner: implementation -->
- [ ] 13.2 Optional smoke e2e: run `LIVEKIT_URL=ws://localhost:7880 npm run test:e2e:livekit-smoke` against the local server and confirm the Ed25519 binding guarantees are unchanged (the smoke e2e's server-side admin grants stay there and are not moved into the real endpoint). Depends: 5.1. **LLS-001, LLS-009**. <!-- sdd-owner: implementation -->

## Post-Apply Review

- [ ] Start or reuse a bounded review of the candidate after the apply phase completes (frozen candidate, at-most-one correction, terminal receipt), covering the infra + backend + frontend + docs slices and the R1 `RoomConfiguration` field-shape check. <!-- sdd-owner: parent -->

## Addendum: docker full-stack wiring (LLS-001/LLS-002 amendment)

- [x] 14.1 Port the deploy-test-env docker stack (Dockerfile, entrypoint, backend/voice-worker services) into this branch and wire them to the self-hosted livekit compose service (LIVEKIT_URL=ws://livekit:7880)
- [x] 14.2 Add LIVEKIT_BROWSER_URL to readLiveKitTokenIssuerConfig (default LIVEKIT_URL) and return it as serverUrl from issueRoomToken (LLS-002 amendment), with unit tests
- [x] 14.3 Document the docker voice flow (docs/local-docker-runbook.md) and the new env in .env.example
