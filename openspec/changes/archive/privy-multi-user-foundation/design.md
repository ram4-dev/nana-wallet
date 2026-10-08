# Design: Privy Multi-User Foundation

## Technical Approach

The isolation infrastructure already exists: RLS `FORCED` on every user-scoped table, transaction-local `SET LOCAL ROLE recipient_app` + `app.user_id` in `withUserTransaction`, and a per-call tenant-scoped memory service. This sprint does not invent isolation — it replaces the one missing seam, the `DemoIdentityProvider`, with a verified Privy identity provider, and serves the `/v1/me` and `/v1/contacts` endpoints the front already consumes.

Every incoming request carries `Authorization: Bearer <privy access token>`; `PrivyIdentityProvider` verifies the JWT (ES256, `iss=privy.io`, `aud=PRIVY_APP_ID`), resolves the Privy DID to an internal `users` UUID through an idempotent `SECURITY DEFINER` upsert, and that UUID becomes the sole source of `app.user_id`. The Privy DID lives only in `users.privy_did`; everything else (RLS policies, repositories, live bindings, seeds) keeps speaking internal UUID. No existing column types change and no policy on existing tables is modified. New users policies cover self-read and owner-only provisioning.

## Architecture Decisions

| Decision | Choice and rationale | Alternatives considered |
|---|---|---|
| Identity mapping (D1, approved) | New `users` table: internal UUID PK, `privy_did TEXT UNIQUE NOT NULL`, `display_name`, timestamps. `PrivyIdentityProvider` verifies the JWT → `sub` (DID) → upsert → returns the internal UUID as `RequestIdentity.userId`. | Reusing an external subject key across tables would change existing column types and every policy; rejected. |
| Provider selection (D2, approved) | `IDENTITY_PROVIDER=demo\|privy` read in config; `demo` is the default for dev/tests/CI with zero Privy/network dependency. `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY` are required only in `privy` mode. | Env-detection hacks (token shape sniffing) are fragile and fail open. |
| First-login provisioning (R4/D3, approved) | `SECURITY DEFINER` function `users_ensure_for_privy_did(did, display_name)` owned by the migration owner, called by `PrivyIdentityProvider` on the owner pool connection (the pool's default role), not through `withUserTransaction`. A users-only policy permits the actual migration owner under FORCE RLS; recipient_app has no owner membership or function EXECUTE. No new `BYPASSRLS` role. | Writing `users` through `recipient_app` needs a pre-existing `app.user_id` (chicken-and-egg at first login); a `BYPASSRLS` role widens the trust surface. |
| Contacts storage (D4, approved) | `/v1/contacts` CRUD operates on `recipients` — single source for agent and user contacts. `provenance` distinguishes origin (`{"origin":"user"}` vs agent); versioning prevents silent overwrites. No new `contacts` table. | A parallel `contacts` table would dual-write and drift from agent memory. |
| Recipient status vocabulary | **Contract-level mapping only, no schema change.** Physical `recipients.status` stays `('active','inactive')`; the API contract exposes logical `status: 'confirmed' | 'archived'`. Create maps `confirmed` → insert `status='active'` + `provenance {"origin":"user"}` + `address_confirmed_at=now()`; soft delete maps `archived` → set `status='inactive'`. | Extending the CHECK to `'confirmed'/'archived'` would break every agent query that hardcodes `status='active'` (`src/memory/repository.ts:67,81,100`) and silently hide user contacts from the agent, violating D4. New status columns add a second source of truth. |
| Demo sentinel (PMU-004) | The migration creates no demo row. Demo-mode startup and the demo seed call `ensureDemoSentinelUser` with `id = DEMO_USER_ID` before serving traffic or writing recipients. Repeated calls preserve that UUID; an existing demo row with a different UUID rejects startup without changing data. | A fixed hard-coded sentinel UUID would orphan every existing dev database seeded with a random `DEMO_USER_ID`. |
| Front token plumbing (D6, approved) | `PrivyProvider` + async `getAccessToken()` before every request; on `401`, refresh and retry once. `sessionStorage nana-wallet-token` and the `"token-de-desarrollo"` fallback retire except when `VITE_IDENTITY_PROVIDER=demo`. | Cookie/httpOnly transport remains deferred; Privy initialization and token access must be browser-only despite the TanStack Start rendering lifecycle. |
| Capacitor WebView + Privy popups | **Deferred.** Web build validates Privy popups in-sprint; the Capacitor iOS/Android WebView popup behavior is an explicit follow-up change, `capacitor-privy-webview-login` (validated, not silently assumed, next sprint). | Validating Capacitor in-sprint would couple mobile store builds to this PR's delivery. |
| `/v1/me` payload (PMU-007) | Identity-only: `{ userId, displayName }` under the same `ApiEnvelope` as wallet-style endpoints. `privy_did` is **not** exposed — it is an internal identity key; the front never needs it. No wallet, balance, or KYC fields. | The front's legacy `Me` type (dailyLimit, documentLast3, …) is not served by this backend and stays out of scope per D5. |

## Spec-Findings Resolutions (from the spec phase)

1. **No canonical `openspec/specs/` baseline.** Archive sequencing is mandatory and ordered: (a) archive `recipient-address-memory` first — its delta becomes the canonical `openspec/specs/recipient-address-memory/spec.md`; (b) then archive `privy-multi-user-foundation`, whose `recipient-address-memory` delta applies on top of the now-canonical baseline. The archive step for this change MUST verify the canonical baseline exists before merging and fail with a clear message if the other change has not been archived yet (no silent re-derivation).
2. **Domain overlap on `recipient-address-memory`.** This change's delta for that capability only modifies the scoping source (verified Privy identity per request instead of the configured demo user; text path parity with voice `binding.sub`). At archive time the reconciliation is a per-requirement merge: RAM-001..RAM-007 requirements stay; their scenarios' identity source references change. If `recipient-address-memory` is archived between this change's spec and archive phases, the delta re-applies cleanly because it names no requirement IDs that would collide — it adds/modifies scoping text only.
3. **`recipients.status` CHECK vs spec vocabulary.** Resolved with the contract-level mapping in the Architecture Decisions table: no CHECK migration, `confirmed` → `status='active'` + `provenance {"origin":"user"}`, `archived` → `status='inactive'`. The agent memory flow keeps working **unchanged**: every repository query already filters `status='active'`, and user-created contacts are physically active, so the agent can use contacts the user confirmed in `/perfil` (exactly D4's intent). Archived contacts are physically `inactive` and excluded from both agent search and user lists. `provenance` JSONB already exists; we only define a `{"origin":"user"|"agent"}` shape inside it.
4. **`DEMO_USER_ID` config validation.** Exact change in `src/config/process.ts` (`readApiProcessConfig` and `readWorkerProcessConfig`) and `src/config/env.ts` (`readRecipientMemoryConfig`): introduce `IDENTITY_PROVIDER` (enum `demo|privy`, default `demo`, any other value rejects startup). In `demo` mode, `DEMO_USER_ID` must be a UUID whenever `DATABASE_URL` is set (current behavior, error message unchanged in intent). In `privy` mode: `PRIVY_APP_ID` and `PRIVY_VERIFICATION_KEY` are required (startup rejects when missing) and `DEMO_USER_ID` is **rejected** (fail fast against split-brain identity; switching to Privy requires unsetting it; rollback to demo restores it — documented in Rollout). `readRecipientMemoryConfig` drops its unconditional `DEMO_USER_ID` requirement when `RECIPIENT_MEMORY_ENABLED=true`: the requirement holds only when `IDENTITY_PROVIDER=demo`; in `privy` mode the tenant-agnostic service needs no demo user. `readWorkerProcessConfig` follows the same rule: `DEMO_USER_ID` required only in demo mode.
5. **Optional FK `user_id → users.id`.** Migration adds `FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID` on `recipients` and `conversations` (exactly the tables named in the approved outline; other conversation tables keep their own isolation through the conversations FK chain and RLS). `NOT VALID` grandfather-robots existing demo rows: the constraint is enforced on new inserts/updates but existing rows are not validated, so a dev database seeded before the demo sentinel is ensured never breaks migration. Demo-mode startup ensures the sentinel (`id = DEMO_USER_ID`, `privy_did='demo'`) before serving traffic, so all subsequent writes satisfy the FK. Running `VALIDATE CONSTRAINT` is a documented post-migration step for fresh databases.
6. **Capacitor WebView + Privy popups.** Explicit follow-up `capacitor-privy-webview-login`; out of this change's scope (non-goal re-affirmed). The TanStack Start web build login flow is validated in-sprint.
7. **`/v1/me` payload.** Pinned to `{ userId: string; displayName: string | null }` inside the standard `ApiEnvelope`; `privy_did` is not exposed (see Architecture Decisions table).

## Components and Planned Files

| Path | Action and responsibility |
|---|---|
| `supabase/migrations/20260901000300_users.sql` | **Create.** `users` table, RLS ENABLED+FORCED, `user_self_isolation` policy, `SECURITY DEFINER` upsert function, `NOT VALID` FKs, grants. Sketch below. |
| `src/db/migrations/004_users.sql` | **Create.** Mirror of the Supabase migration for the local compose dev database (same pattern as `001_recipient_memory.sql`). |
| `src/auth/identity.ts` | **Modify.** Keep `RequestIdentity`/`RequestIdentityProvider`; keep `DemoIdentityProvider`. Remove the "replace before multi-user" comment. |
| `src/auth/privy-identity.ts` | **Create.** `PrivyIdentityProvider`: ES256 JWT verification via `jose` (already a dependency used by `live-binding.ts`), `iss='privy.io'`, `aud=PRIVY_APP_ID`, expiry enforced by `jwtVerify`; extracts `sub` (DID, validated `did:privy:` prefix); upserts via `users_ensure_for_privy_did` on the owner connection; throws `PrivyIdentityError('unauthenticated')` mapped to `401`. |
| `src/config/process.ts` | **Modify.** `IDENTITY_PROVIDER` enum with default `demo`; per-mode validation per Finding 4 (API and worker configs). |
| `src/config/env.ts` | **Modify.** `IDENTITY_PROVIDER` plumbed into `readRecipientMemoryConfig`; `DEMO_USER_ID` requirement gated to demo mode. |
| `src/server.ts` | **Modify.** Build `DemoIdentityProvider` or `PrivyIdentityProvider` from config; demo-mode startup calls `ensureDemoSentinelUser(database, demoUserId)`; register `/v1/me` and `/v1/contacts` routes with the per-request `resolveUserId`. |
| `src/auth/demo-sentinel.ts` | **Create.** `ensureDemoSentinelUser`: idempotent upsert of `users (id = DEMO_USER_ID, privy_did='demo')`; fails loudly on `privy_did='demo'` ↔ id mismatch. |
| `src/api/me.ts` | **Create.** `GET /v1/me` handler: `resolveUserId` → `withUserTransaction` → `SELECT id, display_name FROM users` (RLS self-policy) → envelope response. |
| `src/api/contacts.ts` | **Create.** `GET/POST/PATCH/DELETE /v1/contacts`, `POST /v1/contacts/:id/reveal-cbu`; all scoped through `withUserTransaction`; status mapping per Finding 3. |
| `src/memory/contacts-repository.ts` | **Create.** Recipient queries for the user-facing surface (list active, insert with `provenance {"origin":"user"}`, versioned update, soft delete, fetch-by-id) — separate from the agent memory repository so agent queries stay untouched. |
| `src/contracts/http.ts` | **Modify.** Add zod schemas: `meResponseSchema`, `contactSchema`, `createContactInputSchema`, `updateContactInputSchema`, `revealedCbuSchema`. |
| `src/memory/runtime.ts` | **Modify.** Deprecate `getConfiguredRecipientMemoryRuntime` (fixed `demoUserId`); export a factory `getMemoryRuntimeForUser(userId): RecipientMemoryRuntime` wrapping the shared tenant-agnostic service. |
| `src/runtime/dependencies.ts` | **Modify.** Worker dependencies stop keying the claimed-recipient revalidation to the demo tenant; they use the shared service with the conversation's resolved internal UUID (already carried by `binding.sub`). |
| `src/conversations/service.ts` | **Modify.** Accept a per-request memory runtime provider (`(userId) => runtime`) instead of a fixed demo-tenant runtime; text path parity with voice (PMU-014). |
| `src/memory/seed.ts` | **Modify.** Reject seeding unless `IDENTITY_PROVIDER=demo`; then call `ensureDemoSentinelUser` with `DEMO_USER_ID` before writing recipients (PMU-004). |
| `apps/nana-wallet/src/lib/api.ts` | **Modify.** Async `getApiToken()` → Privy `getAccessToken()`; `Authorization: Bearer` on every request; `401` → refresh + retry once, no second retry; demo fallback only when `VITE_IDENTITY_PROVIDER=demo`; retire `sessionStorage nana-wallet-token` and the unconditional `"token-de-desarrollo"` fallback. |
| `apps/nana-wallet/src/lib/api-types.ts` | **Modify.** Mirror the new `src/contracts/http.ts` types in the same PR (PMU-018, hard repo rule). |
| `apps/nana-wallet/src/routes/__root.tsx` + new `apps/nana-wallet/src/routes/login.tsx` | **Modify/Create.** `PrivyProvider` (`VITE_PRIVY_APP_ID`) wraps the app in `__root`; login screen with email + configured phone OTP (SMS or WhatsApp); unauthenticated guard redirects to `/login`; logout clears local auth state (`routeTree.gen.ts` regenerates). |
| `apps/nana-wallet/src/components/perfil/*` | **Modify.** `/perfil` contacts CRUD against the real backend (`api.getContacts/createContact/updateContact/deleteContact/revealContactCbu` already exist). |

## Migration Sketch (`supabase/migrations/20260901000300_users.sql`)

```sql
CREATE TABLE IF NOT EXISTS public.users (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  privy_did TEXT UNIQUE NOT NULL CHECK (length(trim(privy_did)) > 0),
  display_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.users FORCE ROW LEVEL SECURITY;

CREATE POLICY user_self_isolation ON public.users TO recipient_app
  USING (id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.user_id', true), '')::uuid);

-- Use the role that actually owns this migration; do not hardcode postgres.
DO $policy$
BEGIN
  EXECUTE format(
    'CREATE POLICY users_owner_provisioning ON public.users TO %I USING (true) WITH CHECK (true)',
    current_user
  );
END $policy$;
GRANT SELECT ON public.users TO recipient_app;

-- First-login provisioning: owner connection only, no BYPASSRLS role (R4/D3).
CREATE OR REPLACE FUNCTION public.users_ensure_for_privy_did(
  p_did TEXT, p_display_name TEXT
) RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog AS $$
DECLARE new_id UUID;
BEGIN
  IF p_did IS NULL OR p_did !~ '^did:privy:[A-Za-z0-9]+$' THEN
    RAISE EXCEPTION 'invalid identity subject';
  END IF;
  INSERT INTO public.users (privy_did, display_name)
  VALUES (p_did, p_display_name)
  ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
  RETURNING id INTO new_id;
  RETURN new_id;
END $$;
REVOKE ALL ON FUNCTION public.users_ensure_for_privy_did(TEXT, TEXT) FROM PUBLIC, recipient_app;

-- Demo provisioning belongs to ensureDemoSentinelUser at startup/seed time.
-- The migration cannot choose an id without the configured DEMO_USER_ID.

-- NOT VALID: existing demo rows are grandfathered; demo-mode startup ensures the
-- sentinel (id = DEMO_USER_ID) before serving, so all new writes satisfy the FK.
ALTER TABLE public.recipients
  ADD CONSTRAINT recipients_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
ALTER TABLE public.conversations
  ADD CONSTRAINT conversations_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
```

## Interfaces

```ts
// src/contracts/http.ts (additions, zod-inferred)
MeResponse              = { userId: string; displayName: string | null }
Contact                 = { id: string; name: string; description: string;
                            addressLast4: string; status: 'confirmed' | 'archived';
                            provenance: 'user' | 'agent'; version: number;
                            createdAt: string; updatedAt: string }
CreateContactInput      = { name: string; description?: string; address: string }
UpdateContactInput      = Partial<CreateContactInput> & { expectedVersion: number }
RevealedCbu             = { cbu: string }
```

- All `/v1/me` and `/v1/contacts` responses use the existing `ApiEnvelope` (`{ ok: true, data }` / `{ ok: false, error }`) so the front's `request<T>` plumbing stays uniform.
- `privy_did` is never serialized in any response.
- `GET /v1/contacts` returns logical-active rows (`status='confirmed'`); `DELETE` soft-deletes (logical `archived`); `reveal-cbu` returns the plain address only after an authenticated, owner-scoped fetch (`404` shape when the id does not exist for the caller, per PMU-013 — existence of foreign records is never revealed).
- `PrivyIdentityProvider.resolve(request): Promise<RequestIdentity>` — the same seam the conversation routes already consume via `resolveUserId`.

## Data Flow

```mermaid
sequenceDiagram
  participant F as Front (Privy)
  participant S as Fastify
  participant P as PrivyIdentityProvider
  participant D as PostgreSQL
  F->>S: Bearer <privy access token>
  S->>P: resolve(request)
  P->>P: jwtVerify (ES256, iss=privy.io, aud=PRIVY_APP_ID)
  P->>D: SELECT users_ensure_for_privy_did(did, null)  -- owner connection
  D-->>P: internal UUID (idempotent)
  P->>S: RequestIdentity { userId }
  S->>D: withUserTransaction(userId) → SET LOCAL ROLE recipient_app; app.user_id
  D-->>S: RLS-scoped rows only
  S-->>F: ApiEnvelope data
```

Text path: the conversation service receives `(userId) => memoryRuntime` and builds the runtime per request with the resolved identity — the same scoping the voice path already gets from `binding.sub` (PMU-014). Voice token issuance and browser identity change under PMU-020; the worker continues validating binding.sub.

## Failure, Security, and Observability

- Invalid, expired, wrong-key, wrong-issuer, or wrong-audience tokens reject as `401` before any handler runs; the front refreshes and retries once, then surfaces the failure (PMU-016 retry-once-only).
- `users_ensure_for_privy_did` is idempotent under concurrent first logins: the `UNIQUE` constraint plus `ON CONFLICT` guarantees one row and one UUID for both requests (PMU-003).
- Cross-user isolation is enforced by FORCED RLS on `users`, `recipients`, `conversations` plus parameterized (bind) queries; the contacts handlers never accept a `userId` argument from the request payload (PMU-009 create-for-another-user is structurally impossible).
- Logs never include tokens, DIDs, or addresses; structured errors keep the existing envelope error codes.
- `IDENTITY_PROVIDER=privy` with missing `PRIVY_APP_ID`/`PRIVY_VERIFICATION_KEY` fails at config-read time, before listen.

## Testing Strategy

- **Unit (backend):** token verification with a test ES256 signing key — valid, expired, wrong-key, wrong-issuer, wrong-audience rejected (PMU-019); DID shape validation; config-validation matrix per Finding 4 (demo/privy × env present/absent); status mapping (`confirmed→active`, `archived→inactive`) and `provenance {"origin":"user"}` on create.
- **Integration (docker `db` up):** `users_ensure_for_privy_did` idempotency and concurrency (two parallel resolutions, one row, same UUID); demo sentinel ensure; contacts CRUD over `recipients` with RLS; soft delete excluded from lists; FK `NOT VALID` behavior with pre-existing demo rows.
- **RLS/e2e cross-user (WU6):** two users A and B in the same database; per endpoint (me, list, create, patch, delete, reveal) prove A never reads or mutates B and foreign ids return the not-found shape.
- **Front (vitest):** Bearer on every request; `401` → refresh → single retry, second `401` surfaces failure; demo fallback strictly gated by `VITE_IDENTITY_PROVIDER=demo`; logout clears state; `api-types.ts` mirror kept in sync (identical JSON contract examples validated independently in front and back, without cross-project imports).
- **Gates:** backend `npm run lint && npm run typecheck && npm test && npm run eval && npm run build`; frontend `npm run lint && npm run typecheck && npm test && npm run build`; browser and live-provider evidence per PMU-025.

## Threat Matrix

Threats in scope: forged identity, cross-user room access, privileged provisioning, stale session responses and shared wallet exposure. PMU-020 through PMU-024 define the controls and negative tests. Shell/subprocess/VCS automation is outside this application change.

## Work-Unit Mapping (04-structure-outline.md)

| Work unit | Design coverage |
|---|---|
| WU1 — DB | `supabase/migrations/20260901000300_users.sql` + `src/db/migrations/004_users.sql`: users table, RLS, `SECURITY DEFINER` upsert, demo sentinel, `NOT VALID` FKs; seed gating in `src/memory/seed.ts`; `ensureDemoSentinelUser`. |
| WU2 — Identity + `/v1/me` | `src/auth/privy-identity.ts`, `src/config/process.ts`, `src/config/env.ts`, `src/server.ts` wiring, `src/api/me.ts`, contracts in `src/contracts/http.ts`; provider + config tests. |
| WU3 — `/v1/contacts` | `src/api/contacts.ts`, `src/memory/contacts-repository.ts`, contract types; cross-user isolation tests; guard test (contact without confirmed address is not transferable — unchanged from RAM-007). |
| WU4 — Front | `PrivyProvider` + login route, `api.ts` token plumbing with 401 retry, demo fallback gating, `/v1/me` bootstrap at app start, `/perfil` contacts against the real backend, `api-types.ts` mirror. |
| WU5 — Text path per-request identity | `src/memory/runtime.ts` factory, `src/conversations/service.ts` provider shape, `src/runtime/dependencies.ts` worker fix; authorized voice issuance and browser identity (PMU-020), with worker scoping through `binding.sub`. |
| WU6 — Verification | Backend + front gates; RLS A/B e2e per endpoint; smoke: login → create contact in `/perfil` → agent uses it (fixture mode). |

Order: WU1 → WU2 → WU3 (backend green) ∥ WU4 → WU5 → WU6. Reconcile shared edits in runtime dependencies and server wiring with wallet-provider work; the preview→confirm transfer flow and the singleton wallet are untouched.

## Migration and Rollout

Rollout order per work unit, backend green before front. Rollback in an isolated development deployment: drain sessions, restore `DEMO_USER_ID`, and set both `IDENTITY_PROVIDER=demo` and `VITE_IDENTITY_PROVIDER=demo`; the demo sentinel row keeps existing demo data valid; the `users` migration is additive — no existing columns or policies change — so rolling back endpoints/provider wiring leaves the database consistent. Fresh databases run `VALIDATE CONSTRAINT` on both FKs post-seed.

## Open Questions

- This correction is authorized by the 2026-09-08 request. Wallet signing/recovery decisions are tracked in the dependent draft and do not block fixture-only identity work. Mobile WebView remains an explicit follow-up.

## Revision 2026-09-08: application boundaries and verification

PMU-020: move the identity provider outside the current demo-only registration block in `src/server.ts`. Inject request identity and owned-conversation lookup into voice routes. Pass the resolved UUID into the token issuer for each request. Reject foreign/missing conversations before issuing tokens and choose the configured agent on the server. Keep the signed binding, room grant and TTL checks. In `livekit-web-client.ts`, use `/v1/me` for identity; the hosted LiveKit deployment uses the same authenticated Nana endpoint. The demo cloud token server is not a Privy authentication mechanism.

PMU-021: introduce a session generation counter and per-user query keys. On logout or identity change, increment the generation, abort requests and streams, cancel queries, clear caches and persisted conversation references, disconnect the room and discard previews. Apply an async result only if both user and generation still match. A 401 retry retains the original operation's body and idempotency key and aborts on identity change. Test a delayed A response after B authenticates.

PMU-022: the provisioning function is owned by the actual migration owner and called through the trusted backend pool. Only the new users table receives an owner-specific permissive policy. Its separate self-read policy targets recipient_app. Revoke PUBLIC/recipient_app EXECUTE and verify role membership does not permit recipient_app to assume the owner. Reject an unsafe topology. Test using an ordinary owner, not just postgres. Do not set a fabricated app.user_id to bypass first-login RLS. Demo sentinel provisioning stays a trusted startup operation with UUID conflict checks. The existing backend owner connection remains part of the trust boundary; this change does not claim to protect against compromise of that trusted connection.

PMU-023: `src/db/migrations` currently contains only recipient memory, while conversations and live leases exist under `supabase/migrations`. Before adding users FKs, supply local prerequisites in order and test both fresh and upgraded schemas. Use `002_conversations.sql` and `003_conversation_live_leases.sql` as local prerequisites, followed by `004_users.sql`. Mirror the existing Supabase conversation/live-lease migrations with local-role/bootstrap compatibility verified; preserve their existing Supabase filenames. The known migration runner also issues transaction statements via pool-level calls; migration verification must establish that a migration and its ledger insert use the same checked-out connection, including rollback on a failing statement.

Contacts create/update must populate normalized_name, the 384-dimensional embedding and its model revision; those existing columns are NOT NULL. Address edits require explicit user confirmation, preserve historical versions and invalidate stale previews. Keep `recipients` as the current projection with a stable id. Add owner-scoped `recipient_versions` with primary key (recipient_id, version), containing snapshots of prior values. PATCH locks the owned current row, checks required expectedVersion, inserts its prior snapshot and updates the current projection with version+1 in one transaction. A stale expectedVersion returns 409; require at least one editable field. The history table has FORCE RLS and user_id policy; normal reveal reads only the active current projection. Add a separate ordered history migration after users in each migration chain. Concurrent PATCH requests must not lose updates. List/search return only the current active version; historical addresses remain inaccessible through normal reveal.

PMU-024: identity-only rollout is fixture-only in Privy mode. Authenticate wallet reads, conversation operations and paid voice endpoints. Preserve demo behavior behind explicit demo configuration. Preview/confirm remains enforced, and no authenticated user obtains access to a funded singleton wallet through this foundation.

PMU-025: add an actual browser harness, since no current npm script covers Privy login end-to-end. Launch the backend and frontend through Portless with stable names; fixed ports are reserved for infrastructure dependencies such as Postgres and LiveKit. Exercise HTTP against the running fixture backend instead of MSW. Keep provider JWT tests offline with a test key. A separate live Privy web smoke proves email and the configured phone channel plus session persistence; fixture success cannot stand in for OTP delivery or SDK compatibility. Provision missing secrets through vault-env by name only. Record exact blockers and do not mark the live check complete if it cannot run.

Delivery follows state.yaml: chained PRs, each with its own applicable checks. Proposed boundaries are database/prerequisites, authenticated backend including voice, and frontend/session isolation plus browser evidence. Do not ship the mode as production-ready between slices. Evals and both builds are required at final verification. Existing WDK MCP smoke is a regression check, not the authentication E2E.

## Phone-login constraint discovered during this revision

Privy documents one phone delivery channel per app: SMS or WhatsApp, alongside email. Do not promise both phone channels simultaneously or change the configured provider during implementation. Read the configured app capability through an authorized read-only path before choosing the UI; if not accessible, D7 remains pending. The acceptance smoke covers email plus the configured channel. If the product requires both SMS and WhatsApp together, that is a separate provider/design decision.

Source checked 2026-09-08: https://docs.privy.io/authentication/user-authentication/login-methods/sms-whatsapp

JWT verification must require sub, iss, aud and exp explicitly, enforce ES256 and reject missing expiry as well as expired tokens. Obtain/refresh tokens only after PrivyProvider is ready; the documented getAccessToken refreshes near-expiry tokens and does not imply an invented forceRefresh API. Keep the one-retry and session-generation limits. Source: https://docs.privy.io/authentication/user-authentication/access-tokens
