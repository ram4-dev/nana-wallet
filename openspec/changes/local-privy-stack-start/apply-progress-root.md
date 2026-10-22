# Root apply evidence

Mode: standard (`strict_tdd: false` in existing project config).

## Work unit 1: frontend proxy boundary

| Evidence | Result |
| --- | --- |
| Focused regression | `npm test -- src/test/dev-proxy.test.ts`: 6 passed |
| Frontend required checks | lint/typecheck passed; full tests 31 files, 224 passed |
| Build | `npm run build:mobile`: passed; existing chunk-size warnings |
| Browser/runtime harness | `node --import tsx apps/nana-wallet/scripts/dev-proxy-e2e.mjs`: passed, trusted Portless HTTPS 200, browser binding fetch 401 without CORS, real WSS upgrade, prefixes stripped and query preserved |
| Harness isolation | Ephemeral local HTTP/WebSocket upstream; unique temporary Portless route removed in `finally`; no remote DB or wallet requests |
| Rollback boundary | Vite proxy opt-in, helper/tests, and proxy E2E harness only; no backend contract changes |

Normal development has no configured proxies unless launcher environment explicitly sets them. Mobile build passed with the default empty proxy configuration.

## Validation in progress

Backend lint passed. Initial typecheck could not resolve `@bonfida/spl-name-service` because the source checkout's dependency install predates the current package manifest. Installing the worktree's locked dependencies with `npm ci`; the source checkout's dependency tree remains untouched.

Disposable local test DB: `nana-stack-start-test-db`, dynamically published loopback port 32770, pgvector Postgres 16. Applied `supabase/roles.sql` and the Supabase migration chain as CI does. It is separate from the remote runtime database and will be removed after verification.
