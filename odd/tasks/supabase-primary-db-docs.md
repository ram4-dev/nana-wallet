# Feature: Supabase local as the primary database (docs + config alignment)

- Branch: `docs/supabase-primary-db` (worktree `colloseum.docs-supabase-primary-db`)
- Base: `main @ 76473ea`
- Decision (Ramiro, 2026-10-21): **Supabase local (`npx supabase start`, PG17, `127.0.0.1:54322`, chain `supabase/migrations`) is THE primary development database.** The compose Postgres (PG16, `:5432`) is demoted to the docker/CI database. Documentation-only alignment plus dead-config removal; no connection/migration code changes.
- **DECISION AMENDED (Ramiro, 2026-10-21, supersedes the line above): the primary database is a REMOTE Supabase project — reuse of `nana_wallet_landing`, ref `aitxhgxmiwfazynmcchs` (us-east-1, PG17.11, host `db.aitxhgxmiwfazynmcchs.supabase.co`), was chosen from the account's project list.** New hierarchy: (1) remote project = authoritative primary (deployed app + migration target via `supabase link` + `db push`), (2) local Supabase `:54322` = disposable dev stand-in, (3) compose PG16 `:5432` = docker/CI stand-in. Local `.env` and test suites must NEVER point at the remote. The project is currently PAUSED (`LegacyProjectPausedError` — an admin must restore it from `https://supabase.com/dashboard/project/aitxhgxmiwfazynmcchs`); live verification of link/db push/roles bootstrap is pending on that human action (task T10).
- Scope decision: item 2 of the review (security re-read clause) is deferred by user decision; item 3 (B3 policy) stays as is.

## Context (audit findings this feature closes)

- `DEMO_USER_ID` no longer exists in code (identity is Privy per-request, `src/api/voice.ts:22-24` PMU-020) but is still documented in `docs/architecture.md:114-118`, `docs/api.md:206,216`, 6 runbooks, and `Dockerfile:25,40`.
- `npm run db:seed` is documented without its now-required `<userId>` argument (`README.md:361,520`, `docs/demo-runbook.md:37`, `docs/local-docker-runbook.md:108`); `src/memory/seed.ts:65-70` throws without it.
- `npm run db:migrate` is presented as universal but applies only `src/db/migrations` (local-runner mirror) and fails on a Supabase-chain DB (`relation "conversations" already exists`).
- Two mirrored migration chains exist, convention lives only in file headers: `supabase/migrations/` (Supabase chain: hosted-or-local `npx supabase db reset`, AND CI via psql) vs `src/db/migrations/` (mirror applied by `npm run db:migrate`).
- `README.md:396` claims PostgreSQL 16 as the durable store while `docs/architecture.md:105` says Supabase PostgreSQL 17 (`supabase/config.toml` = PG17 `:54322`); `README.md:476-480` presents two local DB setups as equally valid and never names a primary.
- `DATABASE_URL` claims diverge across docs (`.env.example:91` `:5432/wdk_agent`, `README.md:353-354` `recipient_app@…:5432`, runbooks `:54322/postgres`, `HANDOFF_v2.md` legacy).
- `docs/local-live-runbook.md:33-37` quotes a `.env.example` (`…54322/postgres`) that does not match the real file.

## Tasks

- [x] T1 `README.md`: unify the DB story — Supabase local (PG17, `:54322`, `npx supabase db reset`) as primary dev DB; compose PG16 (`:5432`) as the docker/CI database; explain the two migration chains; fix the PG16/PG17 contradiction; fix `db:seed` usage; correct the `recipient_app` connection claims; replace "both setups are equally valid" with role-scoped guidance.
- [x] T2 `docs/architecture.md`: remove the demo-tenant / `DEMO_USER_ID` claims (identity is Privy per-request); state Supabase as primary DB with chain ownership.
- [x] T3 `docs/api.md`: remove the `DEMO_USER_ID`-missing → 503 claim and the "token identity is the demo identity" claim; voice token identity is server-derived (PMU-020).
- [x] T4 Runbooks (`docs/demo-runbook.md`, `docs/local-live-runbook.md`, `docs/livekit-development-runbook.md`, `docs/nani-e2e-runbook.md`, `docs/local-docker-runbook.md`): drop dead `DEMO_USER_ID` references, fix the `.env.example` quote, add the required `db:seed <userId>` arg, correct "same as CI" identity claims.
- [x] T5 `.env.example`: point `DATABASE_URL` at Supabase local (`127.0.0.1:54322/postgres`) as the primary dev connection and comment the chain split (`supabase/` chain vs `src/db/migrations` mirror). No secrets, values only.
- [x] T6 `AGENTS.md`: correct the `db:migrate` framing and the CI description (CI applies the `supabase/` chain via psql on a compose PG16). Added text follows the document's existing Spanish register.
- [x] T7 `Dockerfile`: remove the dead `DEMO_USER_ID` references **only after** grepping `compose*.yaml`, `src/`, `scripts/` to confirm nothing interpolates them; keep if referenced. Confirmed zero references outside the two comments; production-gate comment also updated to the real requirements (`DATABASE_URL`, `PRIVY_APP_ID` + `PRIVY_VERIFICATION_KEY`, `LIVE_VOICE_BINDING_PRIVATE_KEY` per `src/config/process.ts:148-162`).
- [x] T8 Verify: greps show zero stale refs in live docs (`DEMO_USER_ID` outside archives, `demo:arc`, `db:seed` without arg); relative links resolve; code fences balanced; lint/typecheck NOT applicable (docs-only, no TypeScript touched, no install in the worktree).
- [x] T9 Re-frame every surface written in T1–T6 from "Supabase local is THE primary" to "remote project `nana_wallet_landing` (`aitxhgxmiwfazynmcchs`) is THE primary; local Supabase = disposable dev stand-in; compose PG16 = docker/CI stand-in". Remote migration/bootstrap steps are documented as pending-first-application; deployed `DATABASE_URL` remains provisioned outside the repo. `.env.example` now names the remote production primary while retaining the local development URL.
-  - **Historical decision (Ramiro, 2026-10-21):** the `.env.example` edit was deferred at that time. Ramiro authorized completing the documentation alignment on 2026-10-22; no production secret or remote URL was added to the example.
- [ ] T10 Live verification of the remote workflow — **BLOCKED on authenticated Supabase admin access**. The project was previously confirmed paused. Current CLI attempt `npx supabase projects list --output json` returned `Access token not provided`; no Supabase dashboard session was available through the browser tools. No `DATABASE_URL` or `SUPABASE_ACCESS_TOKEN` is present in the Vault inventory. Once admin access and the app database connection secret are available: restore the project, verify `supabase link`, apply migrations and the one-time roles bootstrap, provision the deployed connection string, and record evidence here.

## Receipts

- Worktree: `/Users/ramiro/Desktop/projects/colloseum.docs-supabase-primary-db`
- Branch: `docs/supabase-primary-db` (from `main @ 76473ea`), NOT pushed.
- Commits:
  - `6aab818` T1 README primary-DB story
  - `831266a` T1 db:seed RAG demo note
  - `05b333c` T2 architecture.md
  - `b14921e` T3 api.md
  - `bcb53d5` T4 runbooks
  - `e9cc488` T5 .env.example
  - `90945ab` T6 AGENTS.md
  - `4dbee94` T7 Dockerfile
  - `d6715e2` T9 README re-framed to remote primary
  - `1857291` T9 architecture.md + local-live-runbook.md re-framed (incl. pause/restore note)
  - `8b968dd` T9 AGENTS.md re-framed (Spanish register)
  - Pending commit in `docs/supabase-remote-primary-env`: T9 `.env.example` re-frame, authorized by Ramiro on 2026-10-22; local example remains local, no secret added.
- Process note: the delegated writer timed out (20 min cap) after landing T1–T5; T6–T8 were completed inline by the orchestrator.
- Checks (T8, structural — docs-only change):
  - `grep DEMO_USER_ID|demo:arc|ensureDemoSentinel|demo-sentinel` over README/docs/AGENTS/.env.example/Dockerfile → zero.
  - Every `db:seed` mention carries `-- <userId>` (README ×4, demo-runbook ×2, local-docker-runbook `node dist/memory/seed.js <userId>`, AGENTS ×1).
  - Relative markdown links: all resolve; code fences: all balanced.
  - One canonical dev URL everywhere (README, 4 runbooks, .env.example): `postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-csearch_path%3Dpublic,extensions`.
  - PG16/PG17 contradiction resolved: README:400-401 + architecture.md:105-109 both state Supabase PG17 primary / compose PG16 docker-CI.
  - lint/typecheck: not applicable — no TypeScript or build files changed.
- Checks (T9, structural — docs-only):
  - `grep -rni "primary" README.md docs/ AGENTS.md .env.example` → remote project is primary for deployment and local Supabase is the disposable development stand-in.
  - Remote ref `aitxhgxmiwfazynmcchs` is named consistently in README, `docs/architecture.md`, `docs/local-live-runbook.md`, `AGENTS.md`, and `.env.example`; local example `DATABASE_URL` remains on `127.0.0.1:54322`.
  - Pending-first-application phrasing for `supabase/roles.sql` + paused-project/`LegacyProjectPausedError`/dashboard-restore note present in README, architecture, runbook, AGENTS; no claim that remote bootstrap already works.
  - Relative markdown links: all resolve (python check over README, AGENTS, docs/). Code fences: all balanced (per-file ``` counts even).
- **T10 access check (2026-10-22):** not operationally verified. `npx supabase projects list --output json` returned `Access token not provided`; `npx supabase status` found no local Supabase DB container; the project dashboard could not be accessed with the available browser surface. Vault inventory has no `DATABASE_URL` or `SUPABASE_ACCESS_TOKEN` entry. No credential values were read or added. Remote restore, `supabase link`/`db push`, roles bootstrap, and deployed DB URL provisioning remain blocked pending an authenticated admin session and the app's database connection secret.
