# Verify Report: Local LiveKit Self-Host

## Status: FAIL (blocking CRITICAL)

The committed implementation (commits `8f6a21b` → `453d8a8` → `1b9c03e` in the
`local-livekit-selfhost` worktree) satisfies the spec requirements LLS-001–LLS-007
and LLS-009–LLS-012, and every mandated automated validation gate is GREEN.
**LLS-008 has a real logic defect**: the `VITE_LIVEKIT_TOKEN_SOURCE` selector
rejects its own documented `local` value and throws
`Unknown VITE_LIVEKIT_TOKEN_SOURCE value: local`, which breaks the primary
documented configuration (the runbook's `.env.local` block and the `.env.example`
uncomment path). This must be fixed before archive.

---

## Structured status / actionContext

- change: `local-livekit-selfhost`
- artifact store: `openspec`
- worktree: `/Users/ramiro/Desktop/projects/personales/aleph-hackathon.local-livekit-selfhost`
- branch: `local-livekit-selfhost`; commits reviewed: `271f5f7..1b9c03e`
- status: `verify` (read-only verification performed)
- mode: `workspace-verify` — no source mutation; only `openspec/.../verify-report.md` written
- Action context findings:
  - Implementation ownership: all changed paths are inside the authoritative worktree (repo root subtree). No edit-root conflict.
  - `sdd-init` context: present (SDD changes under `openspec/changes/local-livekit-selfhost`).
  - Artifact store is file-based (`openspec`), so objects were read directly from `openspec/changes/local-livekit-selfhost/`.

---

## Requirement coverage (LLS-001 … LLS-012)

| Req | Result | Evidence (file:line) |
| --- | --- | --- |
| **LLS-001** Self-hosted LiveKit availability | ✅ PASS | `compose.yaml:19-29` — `livekit` service, image `livekit/livekit-server:v1.13.6`, `command: --config /etc/livekit.yaml`, `environment: LIVEKIT_KEYS` from `.env`, ro config volume, all three published ports `127.0.0.1`-bound (7880, 7881/udp, 60000-60100/udp), `wget` healthcheck. `docker/livekit.yaml:4-8` — `port: 7880`, `rtc.udp_port: 7881`, `port_range_start: 60000`, `port_range_end: 60100`. `docker compose config` → exit 0, loopback `host_ip: 127.0.0.1`. |
| **LLS-001/LLS-009** No egress/recording/webhooks | ✅ PASS | `docker/livekit.yaml` contains no active `egress`/`recording`/`webhook` section (grep matched only `#` comment lines 2, 9, 14). Absence is the auditable privacy guarantee. |
| **LLS-002** Endpoint contract | ✅ PASS | `src/api/voice.ts:136` — `POST /v1/voice/room-token`; request validated by `voiceRoomTokenRequestSchema` (`src/contracts/http.ts`); response `{ serverUrl, participantToken, roomName }` (matching `voiceRoomTokenResponseSchema`). `src/api/voice.ts:103,141` — `400 { status:'error', message, code:'invalid_body' }`. DB-independent (`registerVoiceRoutes`), registered unconditionally in `src/server.ts:92`. |
| **LLS-003** Server-authoritative room name + identity | ✅ PASS | `src/livekit/token-issuer.ts:33` — `roomName = \`nani-${input.conversationId}\``; identity from `config.identity` (server-owned, `DEMO_USER_ID`). Frontend derives neither: `apps/nana-wallet/.../livekit-web-client.ts:112-113` uses endpoint fields; identity is only a sanity check (`decodeJwtIdentity` at `:113`, mismatch throws). |
| **LLS-004** Grants / single-room / no admin | ✅ PASS | `src/livekit/token-issuer.ts:40-44` — `addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true })`, no `roomAdmin`/`roomCreate`. Verified by `tests/unit/voice-room-token.test.ts` asserts `claims.video.roomAdmin`/`roomCreate` undefined and exact grant equality. |
| **LLS-005** Automatic dispatch via RoomConfiguration | ✅ PASS | `src/livekit/token-issuer.ts:46` — `token.roomConfig = new RoomConfiguration({ agents: [{ agentName }] })`; request `agentName` else `config.defaultAgentName` (`token-issuer.ts:34`, `src/config/livekit.ts:50`). Decoded-claim test asserts `roomConfig.agents[0].agentName`. |
| **LLS-006** TTL bounds (default 10m, min, REJECT below) | ✅ PASS | `src/config/livekit.ts:33` default `600`; `:40-41` `parsed < 60` throws `LIVEKIT_ROOM_TOKEN_TTL must be at least 60 seconds.` (REJECT, not clamp); `:38` non-integer/non-positive throws. Unit tests cover 600 default, 60/900 honored, 59 + `abc`/`0` rejected, and `exp - nbf === ttl`. |
| **LLS-007** Failure on issuer misconfiguration | ✅ PASS | `src/config/livekit.ts:18-27` throws the named-missing-credentials message; `src/api/voice.ts:144-164` maps issuer absence/errors to `503 { status:'error', code:'voice_token_unavailable' }` naming the offending env var. `docs/api.md` documents the 503 semantics. Missing `DEMO_USER_ID` → `token-issuer.ts:19` throws → `503`. |
| **LLS-008** Frontend token source selection | ❌ **CRITICAL** | `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts:49-50` throws `Unknown VITE_LIVEKIT_TOKEN_SOURCE value: ${source}. Use "local" or "cloud".` for **any** non-`cloud` value, **including the legitimate `"local"` value** — the local branch (`:109`, and the `{ tokenSource: "local" }` return at `:52`) is reachable only when `source === undefined` (env unset). Explicitly setting `VITE_LIVEKIT_TOKEN_SOURCE=local` throws. The default-unset path works, and the `cloud` path is preserved byte-for-byte (`:119`). |
| **LLS-009** Privacy invariants unchanged | ✅ PASS | `src/livekit/worker.ts:138` — `record: false`. `src/config/livekit.ts:56-67` — `readLiveKitPrivacyConfig` unchanged, still forces `recordingEnabled:false`/`observabilityRecording:false` and throws on enable attempts (regression test in `voice-room-token.test.ts`). No-egress server config (LLS-001 row). |
| **LLS-010** /v1 contract + typed client updated together | ✅ PASS | `docs/api.md` fresh `POST /v1/voice/room-token` section (request/response/400/503/privacy notes); `apps/nana-wallet/src/lib/api-types.ts` `VoiceRoomTokenResponse = { serverUrl, participantToken, roomName }`; endpoint + `voiceRoomTokenResponseSchema` agree on the same three fields. |
| **LLS-011** Front/back separation | ✅ PASS | Frontend sends only `conversationId` (`apps/nana-wallet/src/lib/api.ts` `fetchVoiceRoomToken`, `jsonRequest("POST", { conversationId })`); never constructs grants, room names, or admin tokens on the `local` path (`livekit-web-client.ts:112-117`). Backend owns all sensitive values. |
| **LLS-012** Explicit `livekit-server-sdk` dependency | ✅ PASS | `package.json` — `"livekit-server-sdk": "^2.18.0"` in root `dependencies`; `npm ls livekit-server-sdk` → single hoisted `livekit-server-sdk@2.18.0` (deduped against `@livekit/agents@1.7.1`), no dual copy; imported by `src/livekit/token-issuer.ts:1` and `src/api/voice.ts` via `token-issuer`. |

---

## Task completion status

Implementation tasks **Phase 1–Phase 12 are all checked** `- [x]` in `tasks.md`.
No unchecked *implementation* task markers remain. The only unchecked markers are
human/manual and parent-owned, and are expected (not failures):

```text
- [ ] 13.1 Manual runbook check (documented, not automated): docker compose up -d livekit → reachable at ws://localhost:7880 ... (LLS-001, LLS-009)
- [ ] 13.2 Optional smoke e2e: LIVEKIT_URL=ws://localhost:7880 npm run test:e2e:livekit-smoke ... (LLS-001, LLS-009)
- [ ] Start or reuse a bounded review of the candidate after the apply phase completes ... (sdd-owner: parent)
```

- 13.1 / 13.2 are **pending human verification**, deliberately left unchecked (per apply-progress), and not treated as verification failures.
- The **Post-Apply Review** row is parent-owned and preserved byte-for-byte.

---

## Validation commands (run in the worktree)

| Command | Result |
| --- | --- |
| root `npm run lint` (`eslint src tests --max-warnings=0`) | ✅ exit 0 |
| root `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | ✅ exit 0 |
| root `npm test` (`vitest run`) | ✅ 65 files passed / 9 skipped (74); 348 tests passed / 19 skipped (367) |
| `apps/nana-wallet` `npm run lint` | ✅ exit 0 |
| `apps/nana-wallet` `npm run typecheck` (`tsc --noEmit`) | ✅ exit 0 |
| `apps/nana-wallet` `npm test` | ✅ 13 files passed (13); 50 tests passed (50) |
| `docker compose config` | ✅ resolves, exit 0; livekit ports `host_ip: 127.0.0.1` (loopback). Expected interpolation warnings for unset `LIVEKIT_API_KEY`/`LIVEKIT_API_SECRET` without a root `.env`. |
| `npm ls livekit-server-sdk` | ✅ single hoisted `livekit-server-sdk@2.18.0` |

No container was started here; the value of `docker compose up -d livekit` reachability
is covered by the pending human task 13.1.

---

## Strict TDD compliance

- **Mode conflict (WARNING):** the injected runtime marker says
  `Strict TDD Mode: enabled`, but the authoritative `openspec/config.yaml` declares
  `strict_tdd: false` and its `apply.guidelines` say "Keep strict TDD disabled". The
  implementation's own apply-progress reflects this conflict.
- `apply-progress.md` contains a **TDD Cycle Evidence** table in Batch 2 (frontend):
  RED (tests written first, initially failing) → GREEN (selector + local path
  implemented, 6/6) → Refactor (prettier, no behavior change), plus an API-client
  cycle. Batch 3 (docs + env + verification) rightly notes no RED/GREEN applies
  (no production code path).
- **Cross-reference:** reported test files exist in the codebase —
  `tests/unit/voice-room-token.test.ts`, `apps/nana-wallet/.../livekit-web-client.test.ts`,
  `apps/nana-wallet/src/lib/api.test.ts`. All are real and validated.
- **GREEN is true:** backend and frontend suites both pass (see validation table).
- **Gap (WARNING):** if strict TDD is treated as active per the runtime marker,
  Batch 1 (backend: config reader, issuer, route, server injection) has no
  TDD Cycle Evidence table in `apply-progress.md`. The backend tests are
  comprehensive and GREEN, but the RED/GREEN traceability for the backend slice is
  not recorded. This does not block, but should be reconciled by the parent.

## Assertion quality

No tautologies, ghost loops, type-only assertions, smoke-only tests, or
implementation-detail CSS assertions were found. Highlights:

- `tests/unit/voice-room-token.test.ts` decodes/verifies the real JWT (`TokenVerifier`)
  and asserts exact grant set, absence of `roomAdmin`/`roomCreate`, `sub`/`iss`,
  `roomConfig.agents[0].agentName`, `exp - nbf === ttl`, config-reader thrown messages,
  and endpoint `200/400/503` via Fastify `inject`.
- `livekit-web-client.test.ts` asserts behavior (call args, rejection, no-connect on
  config error, no cloud fallback, no re-derivation of room name) rather than types.
- `api.test.ts` asserts the posted body is exactly `{ conversationId }`, the raw
  contract is returned, and the 503 message surfaces. Meaningful, non-tautological.

---

## Review workload / PR boundary

The `tasks.md` Review Workload Forecast (chained PRs recommended, 400-line budget
risk high, delivery strategy `ask-on-risk`, chain strategy pending) was respected:

- PR1 `8f6a21b` = deps + infra + backend + backend tests. PR2 `453d8a8` = frontend.
  PR3 `1b9c03e` = docs + env examples + verification gates. Each slice stayed within
  its bounded outcome and rollback boundary (compose + endpoint revertible without
  frontend; Cloud path config-gated).
- No scope creep beyond the three recommended slices was observed. `docker/livekit.yaml`,
  `src/livekit/token-issuer.ts`, and the compose service/dependency additions are all
  within the forecasted scope.
- The parent-owned Post-Apply Review remains pending (not started by this verifier).

Deviation notes (all recorded by the implementation in `apply-progress.md` and
consistent with the design): D1 keys via `LIVEKIT_KEYS` in compose (v1.13.6 does not
expand `${VAR}` in its config file); D2 `nbf` vs `iat` in the SDK-signed claim; D3
protobuf zero-value defaults in the decoded `roomConfig`; D4 `RoomConfiguration`
import through `livekit-server-sdk`'s re-export (existing nested `@livekit/protocol`
version); D6 server-owned `roomName` stored but currently unconsumed; D7 unknown token
source values fail loudly; D8/D10 `.env.example` edits via checked script (file-edit
tool blocked on `.env*` paths).

---

## Findings summary

### CRITICAL (1)

1. **LLS-008 — `VITE_LIVEKIT_TOKEN_SOURCE=local` is rejected by the selector.**
   `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts:49-50`:
   ```ts
   if (source !== undefined)
     throw new Error(`Unknown VITE_LIVEKIT_TOKEN_SOURCE value: ${source}. Use "local" or "cloud".`);
   ```
   This throws for the legitimate `"local"` value because the guard only special-cases
   `"cloud"`. The `local` branch (`:109`) and the `{ tokenSource: "local" }` return
   (`:52`) are reachable only when `source === undefined` (env unset). The default-unset
   path works and the LLS-008 scenario "local is the default when unset" passes, but any
   explicit `local` configuration — exactly what `docs/livekit-development-runbook.md`
   shows as an active `VITE_LIVEKIT_TOKEN_SOURCE=local` line and what the
   `apps/nana-wallet/.env.example` `# VITE_LIVEKIT_TOKEN_SOURCE=local` uncomment path
   produces — throws and blocks connect. **The frontend test suite has a blind spot:
   it never sets `VITE_LIVEKIT_TOKEN_SOURCE=local` explicitly**, so all 50 frontend
   tests pass while this defect ships. Fix direction (not applied by this verifier):
   treat `"local"` (or `undefined`) as the local branch, e.g. only throw on values that
   are neither `"local"` nor `"cloud"` (nor `undefined`), and add a colocated test that
   sets `VITE_LIVEKIT_TOKEN_SOURCE=local`.

### WARNING (2)

2. **Runbook overstates identity verification on the cloud path.**
   `docs/livekit-development-runbook.md` ("With the default ... On both paths the
   browser verifies that the token identity matches `VITE_LIVEKIT_PARTICIPANT_IDENTITY`
   before connecting."). The implementation only verifies the JWT identity on the
   `local` path (`livekit-web-client.ts:113`); the `cloud` path (`:119`) does not
   `decodeJwtIdentity`/verify. Not a spec violation — LLS-003 only requires the
   server-authoritative/sanity-check behavior on the local path — but the doc statement
   is inaccurate.

3. **Strict TDD mode conflict / Batch 1 missing RED-GREEN evidence.**
   Injected marker says enabled while `openspec/config.yaml` says
   `strict_tdd: false` and "Keep strict TDD disabled". If treated as active per the
   runtime marker, Batch 1 (backend) lacks a TDD Cycle Evidence table. Reconcile with
   the parent before archive.

### SUGGESTION (minor, non-blocking)

4. `readLiveKitTokenIssuerConfig`'s two-missing-missing message reads
   `LIVEKIT_URL, and LIVEKIT_API_KEY are required...` (awkward "and" placement for
   `n=2`). Cosmetic only; all cases are tested and correct.
5. `issueRoomToken` is `async` and returns a `Promise`, whereas the design interface
   sketched a synchronous return. Correctness is unaffected (route awaits it); note only.

---

## Blocker status

- **Hard blocker (must fix before archive):** Finding 1 (LLS-008 `local` value rejected).
- **Pending human verification (not failures):** tasks 13.1 / 13.2 (manual runbook
  check + optional smoke e2e).
- **Pending parent-owned:** Post-Apply Review row.

---

## Next recommended

`verify` → **remediation** (apply a one-line fix to `livekit-web-client.ts:49-50` to
accept `"local"`, add a colocated test for explicit `local`, then re-run the frontend
`lint`/`typecheck`/`test`) → re-verify → archive. Until the CRITICAL is resolved, do not
return a clean `PASS` and do not archive.

## Remediation (post-verify)

- CRITICAL LLS-008 resolved: `readConfig` in `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts` now treats an explicit `VITE_LIVEKIT_TOKEN_SOURCE=local` identically to the unset default; unknown values still throw. New colocated test asserts the explicit `local` path reaches `fetchVoiceRoomToken` and never the cloud token server.
- Re-validation (apps/nana-wallet): `npm run lint` exit 0 · `npm run typecheck` exit 0 · `npm test` 13 files / 51 tests passed.
- Remaining warnings/suggestions from the first verify pass are non-blocking; CRITICAL count is now 0.
