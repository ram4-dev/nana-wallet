# Structure outline — isolated Nana Wallet Supabase project

Revision: 2
Status: completed inline by user direction; evidence in `05-implementation-evidence.md`.

## Slice 1 — Provision and identify project

- Outcome: Nana Wallet uses a separate project from Nana Landing's waitlist.
- Result: adopted active `nana_app` (`jnhemqouecznsziytzhm`) in org `qaodimxknesgkicsqtoo`, `us-east-1`, PostgreSQL 17.11. No new project was created because the intended separate project already existed and was healthy.

## Slice 2 — Link the Nana Wallet repo

- Result: linked this Nana Wallet repository/worktree to `jnhemqouecznsziytzhm`; old Landing ref is not the target.
- Check: `supabase migration list --linked` shows all 18 local versions paired with their remote versions.

## Slice 3 — Apply Nana Wallet schema

- Result: all 18 migrations and idempotent `supabase/roles.sql` bootstrap are applied. No reset or data copy was used.
- Tooling note: repo-pinned npm CLI 2.80.0 failed parsing `per_transfer_atomic6` at migration 6. Continued with installed official Supabase CLI 2.113.0; it applied the remainder. Dry-run now has no pending migrations.

## Slice 4 — Runtime connection

- Status: deployed application `DATABASE_URL` is not proven provisioned. Vault currently has `SUPABASE_PASSWORD_NANA_WALLET`, `NANA_SUPABASE_URL`, and `NANA_SUPABASE_SERVICE_ROLE_KEY`; the DB password and project ref are sufficient for CLI migration operations. No runtime URL was materialized into local `.env` and no test was pointed at the remote database.
- Follow-up: configure the deployed app's connection via its authorized secret store, then perform a safe connection/health check there. Do not use remote DB for local tests.

## Exclusions and incident record

- Nana Landing remains the separate waitlist project; no schema/data was copied from it.
- Earlier in this conversation, before the user clarified the separation, the previous assistant applied the idempotent `recipient_app` role bootstrap to Nana Landing. No wallet migration or data change was made there. Per user direction, no cleanup was attempted; report this transparently.
- An independent Pi review could not complete: the NaN API returned HTTP 402 (monthly cap). The user then explicitly directed inline execution. No Pi retry was made.
