# Proposal: Local Self-Hosted LiveKit for Voice Development

## Intent and Outcome

Run the live voice stack end-to-end against a locally self-hosted `livekit-server`, removing the LiveKit Cloud dependency (registered Cloud agent + Cloud development token server) from local development. After this change, `docker compose up -d livekit` plus `npm run livekit:dev` plus the web app work against `ws://localhost:7880` with no Cloud credentials, while LiveKit Cloud remains fully supported as an explicit configuration alternative. Privacy guarantees (`record: false`, no egress, short-lived room-scoped tokens) and the preview→confirm financial flow are unchanged.

## Why

Today `docs/livekit-development-runbook.md` requires a Cloud project with a registered agent and Cloud's *development token server* to hand the browser its room token (`TokenSource.developmentTokenServer` with `VITE_LIVEKIT_TOKEN_SERVER_ID` in `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts:75`). That token-server service does not exist in a self-hosted deployment and its ID cannot be redirected to localhost, so local voice development is blocked on an external SaaS. The backend already holds all credentials needed to sign room tokens itself (`LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` read by `readWorkerProcessConfig` in `src/config/process.ts:89`), and the runbook's own "production gap" item — *issue LiveKit tokens from Fastify* — is exactly what self-hosting forces us to close.

## Scope

### In Scope

- A `livekit` service in `compose.yaml` running the official `livekit/livekit-server` image with a new `docker/livekit.yaml` config: port 7880, RTC UDP (7881 + media range) bound to `127.0.0.1`, keys sourced from the same `.env` credentials used by API and worker, and egress/recording/webhooks explicitly not enabled so privacy is auditable.
- A new server-authoritative endpoint `POST /v1/voice/room-token` in `src/api/voice.ts` (`registerVoiceRoutes`, DB-independent, registered in `src/server.ts:90`), validated by zod schemas in `src/contracts/http.ts`:
  - Request: `{ conversationId: uuid, agentName?: string }`.
  - Response: `{ serverUrl, participantToken, roomName }` — replicating the dev token server's `{ serverUrl, participantToken }` contract, plus the server-derived `roomName`.
  - The server derives `roomName = nani-${conversationId}`, signs an `AccessToken` (explicit `livekit-server-sdk` dependency in root `package.json`, currently transitively hoisted) with video grants `{ roomJoin, room, canPublish, canSubscribe }`, embeds a `RoomConfiguration` with `agents: [{ agentName }]` for automatic dispatch (how the Cloud dev token server triggers the agent today), uses the demo user identity, short TTL (default `10m`, optional `LIVEKIT_ROOM_TOKEN_TTL` with a bounded minimum).
  - New config reader `readLiveKitTokenIssuerConfig` (in `src/config/`) validating `LIVEKIT_URL`/`LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` with a clear failure when missing; injected into `registerVoiceRoutes` from `src/server.ts` via the existing options pattern (`bindingPrivateKey` precedent).
- Frontend local token source in `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts` calling a new `fetchVoiceRoomToken(conversationId)` in `apps/nana-wallet/src/lib/api.ts`, removing frontend knowledge of `roomName` and grants. Route selector `VITE_LIVEKIT_TOKEN_SOURCE` = `local` (default) | `cloud`; the Cloud path (`TokenSource.developmentTokenServer` + `VITE_LIVEKIT_TOKEN_SERVER_ID`) stays intact for `cloud`.
- Documentation: `docs/livekit-development-runbook.md` gains a "Self-hosted LiveKit (default local)" section with Cloud demoted to an explicit alternative; `.env.example` (root) and `apps/nana-wallet/.env.example` updated with commented defaults in English.
- HTTP contract documentation: `docs/api.md` updated for the new endpoint, and `apps/nana-wallet/src/lib/api-types.ts` updated with the response type. This is a NEW HTTP `/v1` contract addition, so both sides of the contract (docs and typed frontend client) must be updated in the same change per the repo hard rule.

### Out of Scope / Non-goals

- Replacing LiveKit Cloud in production: this change targets the local development route only; the Cloud code path and documentation remain supported via config.
- Any change to the financial flow, the existing `/v1` contract endpoints, or the Ed25519 live-voice binding (`POST /v1/live-bindings` and the binding token system).
- No TURN/TLS/certificates: the local server is a loopback development server speaking plain HTTP/WS.
- No changes to the runtime selector (`LIVEKIT_AGENT_RUNTIME`) or the recorded transport.
- Explicit dispatch via `AgentDispatchClient` remains smoke-e2e-only; the real flow uses automatic dispatch via the token's RoomConfiguration.

## Business Rules and Constraints

- Privacy invariants (explicit, unchanged):
  - The worker continues sending `record: false` to sessions (`src/livekit/worker.ts:130`) and `readLiveKitPrivacyConfig` (`src/config/livekit.ts`) continues forcing `recordingEnabled: false` / `observabilityRecording: false` and throwing if someone tries to enable them.
  - The self-hosted server config enables no egress, recording, or webhooks; audio never leaves loopback.
- The browser room token MUST be short-lived, scoped to exactly one room (`nani-<conversationId>`), signed for the demo user identity, and MUST NOT carry admin grants (unlike the smoke e2e, which uses server-side admin credentials).
- Token issuance is server-authoritative: the server derives `roomName` and identity from its own config; the frontend does not decide anything sensitive. `VITE_LIVEKIT_PARTICIPANT_IDENTITY` remains only as a frontend sanity check.
- The endpoint MUST fail fast and clearly when the LiveKit issuer credentials are not configured (503-class response documented in `docs/api.md`), and return `invalid_body` (400) per the existing zod error pattern in `src/contracts/http.ts`.
- `livekit-server-sdk` must be declared as an explicit root dependency before it is imported by `src/api/voice.ts`.
- The response contract `{ serverUrl, participantToken, ... }` is the token-source contract the web client already consumes (`room.connect(credentials.serverUrl, credentials.participantToken, ...)`), so the local source must satisfy it without changes to the connect flow.

## Capabilities

### New Capabilities

- `local-livekit-selfhost`: self-hosted LiveKit server for local voice development, server-authoritative room-token issuance from Fastify, and a local frontend token source with Cloud kept as a config alternative.

### Modified Capabilities

- None. Existing capabilities (voice conversation flow, live-voice binding, smoke e2e, Cloud route) keep their behavior; the Cloud token source is preserved behind the `VITE_LIVEKIT_TOKEN_SOURCE` selector.

## Affected Areas

| Area | Impact | Description |
| --- | --- | --- |
| `compose.yaml` + `docker/livekit.yaml` (new) | New | Local `livekit-server` service, loopback-only ports, explicit no-egress config |
| Root `package.json` | Modified | Explicit `livekit-server-sdk` dependency |
| `src/contracts/http.ts` | Modified | New zod request/response schemas for the room-token endpoint |
| `src/config/` (`process.ts` or new `livekit.ts` reader) | Modified | `readLiveKitTokenIssuerConfig` validating issuer credentials + optional TTL |
| `src/api/voice.ts` + `src/server.ts` | Modified | New `POST /v1/voice/room-token` handler; config injection into `registerVoiceRoutes` |
| `apps/nana-wallet/src/lib/api.ts` + `src/lib/api-types.ts` | Modified | New typed client call; contract types updated in the same change |
| `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts` | Modified | Local token source (default), `VITE_LIVEKIT_TOKEN_SOURCE` selector, Cloud path preserved |
| `.env.example` (root), `apps/nana-wallet/.env.example` | Modified | New documented env values (selector, optional TTL) |
| `docs/api.md` | Modified | New endpoint documented per repo hard rule (contract sides updated together) |
| `docs/livekit-development-runbook.md` | Modified | Self-hosted route as local default; Cloud as explicit alternative |
| Tests (backend unit + frontend colocated) | New | JWT decode assertions (grants, agents, identity, TTL), 400/503 handling, token-source selection, response contract |

## Risks

| Risk | Mitigation |
| --- | --- |
| `RoomConfiguration` field shape differs in the pinned `livekit-server-sdk` version (`roomConfiguration` vs `roomConfig`) | Verify against the declared version at implementation time; unit test decodes the JWT and asserts grants + embedded agents |
| UDP media forwarding problems under Docker/Colima | Minimal loopback port config, manual smoke steps in the runbook, documented fallback to a locally installed binary |
| Token issued before the local server is reachable (ordering confusion) | Runbook healthcheck step for the compose service; endpoint errors clearly if issuer credentials are missing |
| Frontend drift between `local` and `cloud` sources breaking the connect flow | Both sources satisfy the same `{ serverUrl, participantToken }` contract; colocated tests cover source selection and error handling |
| Scope creep into dispatch mechanics | Automatic dispatch via RoomConfiguration only; explicit `AgentDispatchClient` stays confined to the gated smoke e2e |

## Rollback Plan

Set `VITE_LIVEKIT_TOKEN_SOURCE=cloud` (and `VITE_LIVEKIT_TOKEN_SERVER_ID`) to restore the exact pre-change browser flow; the Cloud code path is not removed. The compose `livekit` service and the new endpoint can be left unused or reverted independently; no persisted data or existing `/v1` contract changes hands, so rollback is configuration-only.

## Success Criteria

- [ ] `docker compose up -d livekit` starts a local `livekit-server` reachable at `ws://localhost:7880` with only `127.0.0.1` published ports and no egress/recording/webhook config.
- [ ] The browser obtains its room token without `TokenSource.developmentTokenServer` or `VITE_LIVEKIT_TOKEN_SERVER_ID` when `VITE_LIVEKIT_TOKEN_SOURCE=local` (the default).
- [ ] `POST /v1/voice/room-token` returns `{ serverUrl, participantToken, roomName }`; unit tests decode the JWT and assert `roomJoin`/room/`canPublish`/`canSubscribe` grants, embedded `agents`, demo-user identity, short TTL, 400 `invalid_body`, and clear failure without credentials; `docs/api.md` and `apps/nana-wallet/src/lib/api-types.ts` are updated in the same change.
- [ ] The worker (`npm run livekit:dev`) registers against the local server and is dispatched automatically via the token's RoomConfiguration — no Cloud project needed.
- [ ] A full voice turn (non-financial, and financial with preview→confirm) works against the local server: bidirectional audio, Confirm/Cancel card, `conversation_state_changed`.
- [ ] The smoke e2e (`test:e2e:livekit-smoke`) runs against the local server with unchanged Ed25519 binding guarantees.
- [ ] `docs/livekit-development-runbook.md` documents the self-hosted route as the local default with the Cloud route as an explicit alternative, and privacy guarantees (`record: false`, no egress, short-lived room-scoped tokens) are verifiably unchanged.
