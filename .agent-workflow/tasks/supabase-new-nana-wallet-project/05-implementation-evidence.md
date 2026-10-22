# Implementation evidence

Date: 2026-10-22
Target: Supabase `nana_app`, ref `jnhemqouecznsziytzhm` (us-east-1, PostgreSQL 17.11).

- Supabase CLI 2.113.0 linked the repo/worktree to the target project.
- `supabase migration list --linked`: all 18 local migration versions match the remote ledger, from `20260901000000` through `20261005000600`.
- `supabase db push --dry-run --include-roles`: `migrations: []`; role bootstrap is idempotently reported for inclusion.
- Schema push completed with the official CLI after the pinned npm wrapper v2.80.0 stopped at migration `20260901000500_embedded_wallets.sql` due its parser treating `per_transfer_atomic6` as `BEGIN ATOMIC`. The newer CLI then applied the remaining migrations. No reset was used.
- Runtime app `DATABASE_URL` remains unverified/unprovisioned by this task. Keep local `.env.example` on `127.0.0.1:54322` and never run local tests against remote Supabase.
- E2E/runtime health check against the deployed app remains pending its deployment secret-store configuration.
- Independent Pi review was requested before the inline direction, but NaN returned HTTP 402 monthly cap. The user directed inline completion; no review findings are claimed.

Incident: prior to the user's instruction to leave Nana Landing untouched, the previous assistant had already applied the idempotent `recipient_app` role bootstrap there. No Nana Wallet migrations or data were applied to Landing. No cleanup was attempted after the user's correction.
