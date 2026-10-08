# Proposal: Privy Multi-User Foundation

Revision: 2026-09-08. Authorized scope: correct the reviewed identity foundation and draft the dependent embedded-wallet change. Application code has not been implemented.

## Intent and Outcome

Turn the Nana system into a real multi-user application: users log in with Privy (email + configured phone OTP (SMS or WhatsApp)) end-to-end (front, backend, and database), every request carries a verified Privy access token, and data stays isolated per user through the existing server-mediated RLS mechanism. The backend resolves each Privy identity to an internal user record and serves the identity bootstrap (`/v1/me`) and contacts (`/v1/contacts`) endpoints the front already consumes.

## Scope

### In Scope

- Privy login end-to-end on the front (TanStack Start): `PrivyProvider`, login screen with email + configured phone OTP (SMS or WhatsApp), session persistence, and logout. Access token sent as `Authorization: Bearer` on every request; on `401`, refresh the token and retry once. The `sessionStorage` token and the `"token-de-desarrollo"` fallback are retired (demo fallback only when `VITE_IDENTITY_PROVIDER=demo`).
- Backend `PrivyIdentityProvider`: verifies the Privy access token JWT (ES256, `iss=privy.io`, `aud=PRIVY_APP_ID`), extracts the Privy DID, upserts the user, and returns the internal UUID as the request identity. Selected via `IDENTITY_PROVIDER=demo|privy`; `demo` stays the default for dev/tests/CI with no Privy or network dependency.
- `users` table: internal UUID primary key, `privy_did` `UNIQUE`, display name, and timestamps. First-login provisioning via a `SECURITY DEFINER` function `users_ensure_for_privy_did(did, display_name)` called on the trusted owner connection. A policy restricted to the actual migration owner permits provisioning under FORCE RLS; `recipient_app` cannot invoke the function or assume that owner. No new `BYPASSRLS` role. Demo startup or the demo seed provisions `privy_did='demo'` with the configured `DEMO_USER_ID` before any user-scoped writes.
- Server-mediated RLS unchanged: every user-scoped query keeps flowing through `withUserTransaction` (`SET LOCAL ROLE recipient_app` + `app.user_id`). New RLS policy on `users` itself (row `id` equals `app.user_id`) for `/v1/me`. Existing policies untouched.
- `GET /v1/me`: identity-only bootstrap (no wallet or balance data).
- `GET/POST/PATCH/DELETE /v1/contacts` plus `POST /v1/contacts/:id/reveal-cbu`, served over `recipients` as the single source for agent and user contacts: create with `provenance='user'` and `status='confirmed'`, update as a new version, soft delete (`status='archived'`), and reveal returns the plain address for tap-to-copy behind the authenticated endpoint.
- Voice room-token authorization: verified identity, owned conversation lookup before issuance, internal UUID as participant identity, and browser identity from `/v1/me`. Demo token-server paths remain demo-only.
- Session transitions: cancel in-flight requests, disconnect voice, clear user data and invalidate pending UI approvals before another account becomes active.
- Text path identity per request: the memory runtime is built per request with the resolved `userId` (parity with the voice path's `binding.sub`), removing the fixed `demoUserId`.
- `apps/nana-wallet/src/lib/api-types.ts` mirrored from `src/contracts/http.ts` in the same PR (hard repo rule).
- Cross-user isolation tests (user A never reads or mutates user B's data) and provider tests with tokens signed by a test key.

### Out of Scope / Non-goals

- Per-user wallets (Privy embedded wallets / ZeroDev): the agent's singleton wallet remains; wallet-per-user belongs to the dependent `privy-embedded-wallets` draft. Privy identity alone MUST NOT enable a shared funded wallet for multiple users; Privy foundation validation uses fixtures.
- Bills, agenda, and transfers endpoints the front calls but this backend does not serve.
- Supabase Auth migration (`auth.users` / `auth.uid()`): RLS stays server-mediated.
- Migration of existing demo-user data beyond the sentinel demo row (demo data remains a dev seed).
- Cookie or httpOnly session transport: Privy default localStorage session with Bearer tokens only.

## Business Rules and Constraints

- Every incoming request to authenticated endpoints MUST carry a Privy access token verified against the app verification key; the resolved identity is the sole source of `app.user_id` for RLS.
- The Privy DID lives only in `users.privy_did`; the rest of the system (RLS, repositories, live bindings, seeds) speaks internal UUID exclusively. No existing column types change.
- `IDENTITY_PROVIDER=demo` MUST allow tests, evals, and CI to run without Privy or network access; the recipient-memory seed runs only in demo mode.
- Contacts created by the user (`provenance='user'`) and contacts confirmed by the agent share the `recipients` source; versioning prevents either side from silently overwriting the other.
- User-facing contact creation implies the address is user-confirmed at creation time (`status='confirmed'`).
- Privy verification credentials are server-side only (never committed; `.env` / Secret Vault); `PRIVY_APP_ID`/`VITE_PRIVY_APP_ID` are the only public values.
- The wallet-agnostic refactor (`WALLET_*` envs) and the preview→confirm transfer flow stay untouched.

## Capabilities

### New Capabilities

- `privy-multi-user-foundation`: verified Privy identity per request, internal `users` mapping, identity-only `/v1/me`, user-scoped contacts CRUD over `recipients`, and per-request identity in the text path.

### Modified Capabilities

- `recipient-address-memory`: its per-user scoping now resolves from a verified Privy identity instead of the configured demo user; text path runtime construction changes accordingly.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| Database | New | `users` table, RLS policy, `SECURITY DEFINER` upsert, demo sentinel row |
| Backend identity | Modified | `DemoIdentityProvider` joined by `PrivyIdentityProvider` via `IDENTITY_PROVIDER` |
| HTTP API | New | `/v1/me` and `/v1/contacts` CRUD + reveal-cbu, contracts in `src/contracts/http.ts` |
| Text path | Modified | Per-request memory runtime keyed by resolved `userId` |
| Front (nana-wallet) | Modified | Privy SDK + login UI, Bearer plumbing with 401 retry, `/v1/me` bootstrap, contacts in `/perfil`, `api-types.ts` mirror |

## Risks

| Risk | Mitigation |
|---|---|
| JWT verification breaks in CI (no Privy network) | `IDENTITY_PROVIDER=demo` default for tests/CI; provider unit tests with a test signing key |
| Agent overwrites user-created contacts (or vice versa) | `provenance` distinguishes origin; existing record versioning guards updates |
| Cross-user data leak | Existing FORCED RLS plus cross-user isolation tests on every new endpoint |
| Capacitor WebView incompatibility with Privy popups | Deferred to `capacitor-privy-webview-login`; web success is not mobile evidence |
| First-login upsert races | Idempotent `SECURITY DEFINER` upsert keyed on unique `privy_did` |

## Rollback Plan

In an isolated development deployment, restore `DEMO_USER_ID`, set `IDENTITY_PROVIDER=demo` and `VITE_IDENTITY_PROVIDER=demo`, and drain active sessions to restore the previous single-user behavior without code changes; the demo sentinel row keeps the existing demo data valid. Front token plumbing falls back to the demo token when `VITE_IDENTITY_PROVIDER=demo`. The `users` migration is additive — no existing columns or policies change — so rolling back the endpoints and provider wiring leaves the database consistent.

## Success Criteria

- [ ] Privy login works end-to-end on the front: email + configured phone OTP (SMS or WhatsApp), session persistence, logout, and every API call carries a Bearer access token with 401 refresh-and-retry.
- [ ] `IDENTITY_PROVIDER=privy` verifies each request token, resolves DID → `users` row (idempotent upsert), and `demo` mode runs tests/CI with no Privy dependency.
- [ ] `/v1/me` returns only identity data; `/v1/contacts` CRUD + reveal-cbu operate on `recipients` isolated per user.
- [ ] Cross-user RLS tests prove user A cannot read or mutate user B's users/contacts rows on any endpoint.
- [ ] Text and voice paths resolve identity per request with no fixed `demoUserId`.
- [ ] `api-types.ts` mirrors `src/contracts/http.ts` in the same PR; front and back suites are green.

The privileged provisioning policy applies only to the new `users` table. The migration must reject a role topology in which `recipient_app` can assume the provisioning owner. The dependent wallet change owns payment execution by user; this foundation must reject funded singleton providers in Privy mode.
