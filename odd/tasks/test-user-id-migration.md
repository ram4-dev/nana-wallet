# Feature: Self-provisioning test suites — eliminate the TEST_USER_ID fresh-DB precondition

- Branch: `test/self-provisioning-suites` (worktree `colloseum.test-self-provisioning-suites`)
- Base: `main @ 76473ea`
- Decision (Ramiro, 2026-10-21): **migrate the affected suites to the shared provisioning helper** ("migrar las 10 suites a un helper de provisioning") — the explicit alternative he chose over provisioning the shared constant via a global setup. Suites must not rely on a pre-existing `users` row; `scripts/*.mjs` E2E drivers and DB-less unit suites are out of scope.

## Problem (root-caused, do not re-derive)

- CI on `main` is red at Tests: 12 files, `recipients_user_id_users_fk` violation → `expected 500 to be 201` on contact creation.
- `tests/fixtures/test-server.ts:24` defines `TEST_USER_ID = "00000000-0000-4000-8000-000000000001"`; `:84` makes it the default identity (`userId ?? TEST_USER_ID`).
- `supabase/migrations/20260901000300_users.sql` deliberately inserts no user row; commit `de15a5f` deleted the `src/auth/demo-sentinel.ts` hook that used to provision it. `src/` is clean of the constant (verified).
- On a FRESH database (CI) `users` = 0 rows → any server-based suite that writes rows for `TEST_USER_ID` fails. Warm local DBs mask it (the dev DB accumulated 24.560 users).
- A shared helper already exists: `tests/fixtures/provision-user.ts:9-24` `provisionTestUser(userId)` — `INSERT INTO users (id, privy_did, display_name) … ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()`. 4 suites already call it (~40 more self-provision with inline random-user inserts).
- `users` shape (`supabase/migrations/20260901000300_users.sql:6-12`): `id` PK, `privy_did` NOT NULL UNIQUE, `display_name` nullable. FKs are `NOT VALID` but **enforced on new inserts** → fresh-DB failures.
- Known edge: a legacy dev DB may hold `id = TEST_USER_ID` with a *different* `privy_did`; the current arbiter (`privy_did`) would hit the PK conflict and error. Fresh CI DBs are safe; the helper must be robust for both.

## Candidate call sites (scout map — confirm against T1's failing list)

DB-dependent: `tests/integration/api-contacts.test.ts`, `api-contacts-policy.test.ts`, `api-conversation-service.test.ts`, `api-contacts-alias-field.test.ts`, `recipient-alias-create.test.ts`, `api-recipient-aliases-resolve.test.ts`, `wallets-sync.test.ts` (self-provisions some users but `USER_A` sync needs a row).
Already safe (do not touch): `conversation-live-leases`, `voice-touch-decision-race`, `api-conversation-resolution`, `conversation-preview-claim-race` (use `provisionTestUser`), `recipient-name-matching` (inline random).
DB-less (do not touch): `tests/unit/server-contacts-wiring.test.ts`, `tests/unit/memory-runtime-per-user.test.ts` (local literals, no DB), `contact-action-address.test.ts` (dead import + own `provisionUser()` — remove the dead import only if trivial).
Out of scope: `scripts/*.mjs` / `*.ts` E2E drivers that re-declare the literal in plain node.

## Tasks

- [x] T1 RED evidence — authoritative source: CI run `38337428633` (push of `76473ea`, main, 2026-10-13): **Test Files 12 failed | 230 passed | 4 skipped (246); Tests 26 failed | 1823 passed (1859)**. Classification by failure signature:
  - **Class A — users/TEST_USER_ID provisioning (THIS feature's target), 8 files** (signature `expected 500 to be 201`, `recipients_user_id_users_fk`, or setup FK): `tests/integration/api-contacts.test.ts`, `api-contacts-policy.test.ts`, `api-contacts-alias-field.test.ts`, `api-contact-check-alias.test.ts`, `api-conversation-service.test.ts`, `api-conversations.test.ts`, `recipient-alias-create.test.ts`, `wallets-sync.test.ts` (USER_A row; note it ALSO carries documented baseline PEW-013).
  - **Class B — pre-existing documented baseline, NOT provisioning, 4 files (out of scope here, follow-up)**: `conversation-preview-claim-race` (load flake: `broadcastTransfer` called 0 times, passes 3/3 isolated), `realtime-agent-session` (its parked test `allows one re-read when a confirmation is refused for an incomplete read-back` — the security clause Ramiro parked), `realtime-tool-binding` (send_token), `realtime-tools` (send_token mock assertion, no DB). ⚠️ Note: CI on old main passed fully on 2026-10-08 (`be4dbca`), so class B failing now deserves its own investigation — full main green needs class B handled separately.
  - Evidence log: `/tmp/ci383374.log` + `/tmp/ci.clean.log` (ANSI-stripped) on the orchestrator machine.
- [x] T2 Shared helper: keep ONE provisioning path. If T1/edge evidence requires it, harden `provisionTestUser` so it succeeds both on a fresh DB and on a legacy DB where `id = TEST_USER_ID` already exists under a different `privy_did` — without breaking its 4 existing callers. No per-suite insert duplication. DONE (commit `cefd546`): select-by-id fast path + `23505` tolerance on the insert; contract test `tests/integration/provision-user.test.ts` covers all 4 row shapes (random uuids, delta cleanup) and is GREEN on the fresh DB (4/4).
- [x] T3 Migrate every failing server-based suite: `beforeAll` → `await provisionTestUser(<id>)` before any row write; pass the same id to `buildTestServer`. Also fix the stale fixture comment at `test-server.ts:24` (it references a demo `privy_did` slot that no longer exists). DONE: all 8 class-A suites provision (`cefd546` for the comment, `58270b8` for the suites); `api-contact-check-alias` also gained the missing `TEST_USER_ID` import (caught by `npm run typecheck`).
- [ ] T4 GREEN: fresh-DB run of the migrated suites passes (recipe below); standard local run keeps the documented baseline (5–6 named failures + `notifications-reconciliation` load flake); `npm run lint` and `npm run typecheck` (uses `tsconfig.test.json` — NEVER `npx tsc -p tsconfig.json`). **BLOCKED at run time (not a code failure):** the shared `node_modules` (symlink → main checkout, synced 2026-10-06) does not contain `@bonfida/spl-name-service`, which `package.json` gained on 2026-10-10 (`80fdbf6`). Every suite importing `buildTestServer` → `src/server.ts` → `src/wallet/sns/transport.ts` dies at import with `Cannot find package '@bonfida/spl-name-service'`. Installing dependencies was out of this work unit's authority. What DID run on the fresh DB (2026-10-22, `prov-fresh-db` on 127.0.0.1:55991, recipe = CI chain + CI's `CREATE SCHEMA extensions` prelude, which the recipe line had omitted): `provision-user`, `api-conversation-resolution`, `conversation-live-leases`, `voice-touch-decision-race` PASS; `conversation-preview-claim-race` fails with its documented baseline signature (`broadcastTransfer` called 0 times); the 8 migrated suites NOT RUN (import blocker above). `npm run lint` GREEN; `npm run typecheck` reduced to the same env-only error (`src/wallet/sns/transport.ts(2,33) TS2307`) after fixing the `TEST_USER_ID` import.
- [ ] T5 Receipts: evidence per task, one work-unit commit per batch (English, conventional, no AI attribution). Push to the branch allowed, never to `main`.

## Fresh-DB recipe (reproduces CI; use for T1 corroboration and T4 GREEN)

```
docker run -d --name <n> -e POSTGRES_DB=wdk_agent -e POSTGRES_USER=postgres \
  -e POSTGRES_HOST_AUTH_METHOD=trust -p 127.0.0.1:<free-port>:5432 \
  pgvector/pgvector:0.8.1-pg16
psql: supabase/roles.sql, then each supabase/migrations/*.sql with -v ON_ERROR_STOP=1
DATABASE_URL='postgres://postgres@127.0.0.1:<port>/wdk_agent?options=-csearch_path%3Dpublic,extensions'
```

Notes: run suites with `--maxWorkers=4` to avoid DB-saturation timeout noise (default parallelism inflates failures with 5000ms timeouts); classify any residual failure as FK (ours) vs documented baseline vs flake; `npm test` in CI runs plain against this same shape.

## Environment notes (worktree)

- `node_modules` and `.cache` are symlinks to the main checkout `/Users/ramiro/Desktop/projects/colloseum` (same lockfile at base commit); `.env` was copied un-read (local only, gitignored).
- Never: `git stash/checkout/reset/restore/clean`, `--legacy-peer-deps`, host-npm lockfile regeneration, reading/printing secrets.

## Receipts

- T1 (CI RED classification): recorded above; log artifacts `/tmp/ci383374.log` / `/tmp/ci.clean.log`.
- Commits: `cefd546` test(fixture): make provisionTestUser total over every users-row shape (helper + contract test + stale comment); `58270b8` test(integration): self-provision the fixture identity in the 8 class-A suites; plus this docs commit. Base: `a82d006`.
- T1 failing list: recorded in T1 above (8 class-A files).
- Helper RED→GREEN: test and hardening were authored together in run 1 — RED was NOT re-observed in run 2; GREEN observed 4/4 on the fresh DB (2026-10-22). Case (iii) is the legacy-DID edge the pre-hardening `INSERT … ON CONFLICT (privy_did)` threw on (PK conflict on `id`), per the helper header.
- Fresh-DB evidence: container `prov-fresh-db`, image `pgvector/pgvector:0.8.1-pg16`, port 55991; chain `CREATE SCHEMA extensions` + `roles.sql` + all 16 migrations applied with `ON_ERROR_STOP=1`, zero errors (fresh container; per T1 the users migration inserts no row).
- Checks: `npm run lint` PASS; `npm run typecheck` — 1 remaining error, `src/wallet/sns/transport.ts TS2307`, environment-only (stale shared `node_modules`, no install authority); `tests/integration/api-contact-check-alias.test.ts TS2304` found and fixed in `58270b8`.
- Baseline residuals observed: `conversation-preview-claim-race` (V8.5, `broadcastTransfer` called 0 times) — documented, out of scope. Not observed (blocked, not green/red): `realtime-agent-session`, `realtime-tool-binding`, `realtime-tools`, `wallets-sync` PEW-013, and the 8 migrated suites.
- Fresh-DB container left running (`prov-fresh-db`) pending a dependency-install decision; cleanup: `docker rm -f prov-fresh-db`.
