# Tasks: Privy Multi-User Foundation

## Review Workload Forecast

Delivery strategy: `chained`; chain strategy: `stacked-to-main`, matching state.yaml. The previous single-PR exception is superseded. Boundaries: database prerequisites/provisioning; authenticated backend including voice; frontend/session isolation with complete browser evidence. Every slice runs applicable verification before delivery. The original 1,900–2,600 line estimate predates these corrections and must be re-estimated at apply.

### Suggested Work Units

| Unit | Bounded outcome | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|
| WU1 — DB | `users` + RLS + upsert + sentinel + FK | `npm test -- tests/integration/users-db.test.ts` | `docker compose up -d db; npm run db:migrate` | migration/env |
| WU2 — Identity + `/v1/me` | `PrivyIdentityProvider`, config matrix, `/v1/me` | `npm test -- tests/unit/privy-identity.test.ts` | `IDENTITY_PROVIDER=privy` + test key | env/config |
| WU3 — `/v1/contacts` | Contacts CRUD over `recipients`, cross-user RLS | `npm test -- tests/integration/contacts-cross-user.test.ts` | `docker compose up -d db; npm run db:migrate` | contacts module |
| WU4 — Front | Privy login, Bearer + 401 retry, `/v1/me` + `/perfil` | `npm test -- src/lib/api.test.ts` (in `apps/nana-wallet`) | `VITE_PRIVY_APP_ID` + `VITE_IDENTITY_PROVIDER` | token/route |
| WU5 — Text path | Per-request memory runtime | `npm test -- tests/unit/memory-runtime-per-user.test.ts` | `binding.sub` fixture | runtime factory |
| WU6 — Verification | Backend + front gates, RLS e2e, smoke | `npm test` + front `npm test` | `docker compose up -d db` | none (read-only) |

---

## Work Unit 1: Database (users + RLS + upsert path)

- [ ] **RED** Create `tests/integration/users-db.test.ts` (mirrors `tests/integration/recipient-memory-db.test.ts`, reads `src/db/migrations/004_users.sql`) asserting: `users` table exists; RLS ENABLED + FORCED; `user_self_isolation` policy scoping `id = app.user_id`; `users_ensure_for_privy_did(did, display_name)` returns the same UUID on repeat and exactly one row under two concurrent calls; migration creates no demo sentinel; demo startup with a known `DEMO_USER_ID` creates exactly one sentinel with that UUID; repeated startup preserves it; conflicting existing UUID rejects without modifying data; `recipients`/`conversations` FK `user_id → users.id` exist NOT VALID. Run `docker compose up -d db && npm run db:migrate && npm test -- tests/integration/users-db.test.ts` — expect failure (migration absent). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `supabase/migrations/20260901000300_users.sql` per the design sketch: `users` table (UUID PK, `privy_did TEXT UNIQUE NOT NULL`, `display_name`, `created_at`, `last_seen_at`); RLS ENABLED + FORCED; `user_self_isolation` policy on `id = NULLIF(current_setting('app.user_id', true), '')::uuid`; `users_ensure_for_privy_did` `SECURITY DEFINER` with `ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()` returning `id`; `REVOKE ALL ... FROM PUBLIC`; no demo sentinel insert (startup owns its configured UUID); `NOT VALID` FKs on `recipients` and `conversations`. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `src/db/migrations/004_users.sql` — mirror of the Supabase migration for the local compose dev database, same pattern as `001_recipient_memory.sql`. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `src/auth/demo-sentinel.ts` with `ensureDemoSentinelUser(database, demoUserId)`: idempotent upsert of `users (id = DEMO_USER_ID, privy_did='demo')`; fail loudly when a `privy_did='demo'` row exists with a different id. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/memory/seed.ts` to reject seeding unless `IDENTITY_PROVIDER=demo` (read `readRecipientMemoryConfig`; throw a clear error when `IDENTITY_PROVIDER !== 'demo'`); in demo mode call `ensureDemoSentinelUser(database, demoUserId)` before writing any recipients, including when the server has never started. <!-- sdd-owner: implementation -->
- [ ] **TRIANGULATE** Run `docker compose up -d db && npm run db:migrate && npm test -- tests/integration/users-db.test.ts`; confirm the schema, upsert idempotency/concurrency, sentinel, and FK `NOT VALID` behavior are green. <!-- sdd-owner: implementation -->

## Work Unit 2: Backend Identity + /v1/me

- [ ] **RED** Create `tests/unit/privy-identity.test.ts` — token verification with a test ES256 signing key: valid token passes and extracts `sub` (`did:privy:` prefix); expired, wrong-key, wrong-issuer (`iss !== 'privy.io'`), and wrong-audience (`aud !== PRIVY_APP_ID`) all reject as `PrivyIdentityError('unauthenticated')`; malformed DID shape rejects. Run `npm test -- tests/unit/privy-identity.test.ts` — expect failure (module absent). <!-- sdd-owner: implementation -->
- [ ] **RED** Extend `tests/unit/process-config.test.ts` and `tests/unit/recipient-memory-config.test.ts` — config matrix: `IDENTITY_PROVIDER` unset/`demo` → demo provider, no Privy credential required, `DEMO_USER_ID` required only when `DATABASE_URL` set; `privy` → `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` required, `DEMO_USER_ID` rejected; any other `IDENTITY_PROVIDER` value rejects startup. Run `npm test -- tests/unit/process-config.test.ts tests/unit/recipient-memory-config.test.ts` — expect failure (enum not present). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `src/auth/privy-identity.ts` — `PrivyIdentityProvider` verifying via `jose` `jwtVerify` (ES256, `iss='privy.io'`, `aud=PRIVY_APP_ID`, expiry enforced); validate `sub` DID `did:privy:`; call `users_ensure_for_privy_did(did, display_name)` on the owner connection (`database.query`, not `withUserTransaction`); throw `PrivyIdentityError('unauthenticated')` mapped to 401. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/auth/identity.ts` — keep `RequestIdentity`/`RequestIdentityProvider`/`DemoIdentityProvider`; remove the "replace before multi-user" comment. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/config/process.ts` — add `IDENTITY_PROVIDER` enum (`demo|privy`, default `demo`, any other value rejects); in `readApiProcessConfig` and `readWorkerProcessConfig`: demo mode requires `DEMO_USER_ID` (UUID when `DATABASE_URL` set); privy mode requires `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY` and rejects `DEMO_USER_ID`. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/config/env.ts` — plumb `IDENTITY_PROVIDER` into `readRecipientMemoryConfig`; gate the `DEMO_USER_ID` requirement to `IDENTITY_PROVIDER=demo` only (drop the unconditional requirement when `RECIPIENT_MEMORY_ENABLED=true`). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/contracts/http.ts` — add `meResponseSchema`, `contactSchema`, `createContactInputSchema`, `updateContactInputSchema`, `revealedCbuSchema` (zod, per the design Interfaces section; `privy_did` never serialized). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `src/api/me.ts` — `GET /v1/me` handler: `resolveUserId` → `withUserTransaction` → `SELECT id, display_name FROM users` (RLS self-policy) → `ApiEnvelope { userId, displayName }`. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/server.ts` — build `DemoIdentityProvider` or `PrivyIdentityProvider` from config; in demo mode call `ensureDemoSentinelUser(database, demoUserId)` at startup; register `/v1/me` (and `/v1/contacts` in WU3) with per-request `resolveUserId`. <!-- sdd-owner: implementation -->
- [ ] **TRIANGULATE** Run `npm run typecheck && npm test -- tests/unit/privy-identity.test.ts tests/unit/process-config.test.ts tests/unit/recipient-memory-config.test.ts`; confirm green. <!-- sdd-owner: implementation -->
- [ ] **GREEN (integration)** Create `tests/integration/api-me.test.ts` — authenticated `/v1/me` returns identity-only; no token, invalid token, and expired token return `401`; response excludes `privy_did`. <!-- sdd-owner: implementation -->

## Work Unit 3: Backend /v1/contacts

- [ ] **RED** Create `tests/integration/api-contacts.test.ts` — CRUD over `recipients`: create maps `physical status='active'` (logical confirmed) + `provenance {"origin":"user"}` + `address_confirmed_at`; list returns only active; PATCH creates a new version (prior version remains); DELETE soft-deletes (excluded from list); reveal-cbu returns the plain address; a foreign/missing id returns the not-found shape. Run `docker compose up -d db && npm run db:migrate && npm test -- tests/integration/api-contacts.test.ts` — expect failure (module absent). <!-- sdd-owner: implementation -->
- [ ] **RED** Create `tests/integration/contacts-cross-user.test.ts` — two users A/B in the same DB; per endpoint (list, create, patch, delete, reveal) prove A never reads or mutates B; a B id used by A returns the not-found shape (existence never revealed); create cannot set `user_id` for B (bind params, no client-supplied `userId`). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `src/memory/contacts-repository.ts` — recipient queries for the user surface (separate from the agent memory repository): list active, insert with `provenance {"origin":"user"}` + `status='active'` + `address_confirmed_at`, versioned update (new version, prior remains), soft delete (`status='inactive'`), fetch-by-id; all bind-parameterized. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `src/api/contacts.ts` — `GET/POST/PATCH/DELETE /v1/contacts` and `POST /v1/contacts/:id/reveal-cbu`; all scoped through `withUserTransaction`; status mapping per Finding 3 (`confirmed`→`status='active'`, `archived`→`status='inactive'`); 404 for foreign/missing id. <!-- sdd-owner: implementation -->
- [ ] **TRIANGULATE** Run `docker compose up -d db && npm run db:migrate && npm test -- tests/integration/api-contacts.test.ts tests/integration/contacts-cross-user.test.ts`; confirm CRUD, status mapping, versioning, soft delete, reveal, and cross-user isolation are green. <!-- sdd-owner: implementation -->
- [ ] **REFACTOR / guard test** Extend the existing guard suite (e.g. `tests/unit/wallet-agent-guard.test.ts`) to keep the RAM-007 behavior: a contact without a confirmed address is not transferable (unchanged from `recipient-address-memory`). <!-- sdd-owner: implementation -->

## Work Unit 4: Front Privy + Token Plumbing (parallel to WU3)

- [ ] **RED** Extend `apps/nana-wallet/src/lib/api.test.ts` — Bearer on every request; `401` → refresh then retry exactly once; a second `401` surfaces failure (no second retry); demo fallback strictly gated by `VITE_IDENTITY_PROVIDER=demo`; `sessionStorage nana-wallet-token` and the unconditional `"token-de-desarrollo"` fallback are retired. Run `npm test` in `apps/nana-wallet/` — expect failure (current token logic). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `apps/nana-wallet/src/lib/api.ts` — async `getApiToken()` → Privy `getAccessToken()`; `Authorization: Bearer` on every request; `401` → refresh + retry once (no second retry); demo fallback only when `VITE_IDENTITY_PROVIDER=demo`; retire `sessionStorage nana-wallet-token` and the unconditional fallback. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `apps/nana-wallet/src/routes/__root.tsx` — wrap the app with `PrivyProvider` using `VITE_PRIVY_APP_ID`; unauthenticated guard redirects to `/login`; logout clears local auth state. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Create `apps/nana-wallet/src/routes/login.tsx` — login screen with email + configured phone OTP (SMS or WhatsApp); regenerate `routeTree.gen.ts`. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `apps/nana-wallet/src/routes/perfil.tsx` — wire contacts CRUD + reveal against the real backend (`api.getContacts/createContact/updateContact/deleteContact/revealContactCbu`); `/v1/me` bootstrap at app start. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `apps/nana-wallet/src/lib/api-types.ts` — mirror the new `src/contracts/http.ts` types (`MeResponse`, `Contact`, `CreateContactInput`, `UpdateContactInput`, `RevealedCbu`) in the same PR. <!-- sdd-owner: implementation -->
- [ ] **TRIANGULATE (HTTP examples)** Validate the same JSON HTTP examples separately against backend schemas and frontend contract expectations. Compile each project separately; no imports across the front/back boundary. <!-- sdd-owner: implementation -->
- [ ] **REFACTOR / verify** Run `npm run lint && npm run typecheck && npm test` in `apps/nana-wallet/`; confirm the 401-retry, demo gating, login/logout, and mirror tests are green. <!-- sdd-owner: implementation -->

## Work Unit 5: Text Path Per-Request Identity

- [ ] **RED** Create `tests/unit/memory-runtime-per-user.test.ts` — `getMemoryRuntimeForUser(userId)` builds a runtime with the given `userId` (not a fixed demo); the conversation service uses the per-request provider, never the fixed `demoUserId`. Run `npm test -- tests/unit/memory-runtime-per-user.test.ts` — expect failure (factory absent). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/memory/runtime.ts` — deprecate `getConfiguredRecipientMemoryRuntime` (fixed `demoUserId`); export a factory `getMemoryRuntimeForUser(userId): RecipientMemoryRuntime` wrapping the shared tenant-agnostic service. <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/conversations/service.ts` — accept a per-request memory runtime provider `(userId) => runtime` instead of a fixed demo-tenant runtime; text path parity with voice (`binding.sub`, PMU-014). <!-- sdd-owner: implementation -->
- [ ] **GREEN** Modify `src/runtime/dependencies.ts` — worker dependencies stop keying the claimed-recipient revalidation to the demo tenant; use the shared service with the conversation's resolved internal UUID (`binding.sub`). Voice token issuance and browser identity must satisfy PMU-020; worker binding checks remain enforced. <!-- sdd-owner: implementation -->
- [ ] **TRIANGULATE** Run `npm run typecheck && npm test -- tests/unit/memory-runtime-per-user.test.ts tests/unit/worker-dependencies.test.ts`; confirm per-request scoping and worker revalidation are green. <!-- sdd-owner: implementation -->

## Work Unit 6: Verification

- [ ] **Backend gates** `docker compose up -d db && npm run db:migrate && npm run lint && npm run typecheck && npm test && npm run eval && npm run build` — full suite green. <!-- sdd-owner: implementation -->
- [ ] **Front gates** `cd apps/nana-wallet && npm run lint && npm run typecheck && npm test && npm run eval && npm run build` — full suite green. <!-- sdd-owner: implementation -->
- [ ] **RLS e2e** Re-run the cross-user A/B suite across every endpoint (me, list, create, patch, delete, reveal) with two users in the same database; assert zero cross-read and zero cross-mutation. <!-- sdd-owner: implementation -->
- [ ] **Smoke** Fixture mode end-to-end: login → create a contact in `/perfil` → confirm the agent uses it (a dedicated browser harness using the real fixture backend; WDK MCP smoke alone does not satisfy this task). <!-- sdd-owner: implementation -->

## Parent-Owned Gates (after implementation work)

- [ ] Confirm the canonical `openspec/specs/recipient-address-memory/spec.md` baseline exists before archiving this change; if `recipient-address-memory` is not yet archived, the archive step fails with a clear message (no silent re-derivation). <!-- sdd-owner: parent -->
- [ ] Run the native bounded review over the frozen candidate before the terminal delivery gate; carry the review receipt into the gate. <!-- sdd-owner: parent -->
- [ ] Follow `delivery_strategy: chained` and `chain_strategy: stacked-to-main`; record exact PR boundaries and validation receipts. <!-- sdd-owner: parent -->

## Revision 2026-09-08: required tasks before final verification

- [ ] **PMU-022 / WU1** Add the users owner-specific provisioning policy, recipient_app self-read policy, explicit function revocations and safe search_path. Verify normal NOBYPASSRLS owner provisioning, recipient_app denial and role-membership rejection. Extend first-login concurrency and sentinel conflict tests.
- [ ] **PMU-023 / WU1** Make local conversation/live-lease prerequisites precede users FKs. Test fresh local and Supabase migration sequences, upgrade from existing demo data, repeat migration and partial-failure rollback on a dedicated connection. Update planned migration paths and tests to the actual ordered filenames.
- [ ] **Contacts / WU3** Implement the stable recipients current projection and owner-scoped recipient_versions history specified in design. Require expectedVersion on PATCH, lock/check/snapshot/update atomically and return 409 on stale versions. Generate required normalized name, embedding and revision on contact writes. Test two competing updates, old-address invalidation, historical reveal denial and agent retrieval of a newly created contact.
- [ ] **PMU-020 / WU2** Authenticate `/v1/voice/room-token`, RLS-fetch owned conversation, derive UUID and room, restrict agent dispatch. Test absent/invalid/expired auth, foreign/missing IDs, issuer not called on denial and valid owned grant/binding identity.
- [ ] **PMU-020 / WU4** Remove fixed environment identity in Privy mode. Use `/v1/me` and the authenticated Nana endpoint for local and hosted LiveKit. Reject demo token-server selection in Privy mode. Preserve demo-only compatibility.
- [ ] **PMU-021 / WU4** Key caches by UUID; implement session-generation guards, aborts, cache/persistence clearing, room disconnect and preview reset. Test delayed responses, concurrent 401s, no cross-user retry and no stale confirm after A-to-B switch.
- [ ] **PMU-024 / WU2** Authenticate user-facing wallet, conversation and paid voice routes in Privy mode. Add startup rejection for live/funded singleton providers until the per-user wallet change replaces that guard. Test the provider/identity matrix and unchanged explicit demo fixture behavior.
- [ ] **PMU-025 / WU6** Add and run a browser E2E harness with two sessions, real fixture API/database and Portless servers: login, create contact, agent retrieval, preview/cancel, logout and account switch; include unauthorized voice requests. Confirm there are no skipped isolation checks.
- [ ] **PMU-025 / WU6** Execute live Privy web login smoke for email and the configured phone channel with session persistence/logout. Provision credentials through vault-env. Record exact missing key names, OTP or dashboard blockers; never equate fixture success with live success. Mobile remains deferred.
- [ ] **PMU-025 / WU6** Run backend lint/typecheck/test/eval/build and frontend lint/typecheck/test/build. Run relevant WDK and voice regressions in fixtures. Record commands, counts, skipped cases and environmental blockers.

- [ ] **PMU-026 / before WU4** Read and record the configured Privy phone channel (SMS or WhatsApp), or resolve D7 if it is unavailable/unconfigured. Advertise and smoke-test email plus that channel only; do not mutate dashboard configuration implicitly.
- [ ] **PMU-002 / WU2** Require JWT sub/iss/aud/exp, allow only ES256 and test missing expiry. Pin supported token retrieval/refresh behavior and wait for PrivyProvider readiness; do not invent a force-refresh API.
