# Research evidence

Observed on 2026-10-22 against source commit `22cb8e18b72a4e356aa5035bfd19660db7b82f1e`. Runtime ports and container names below describe this incident, not permanent defaults.

## Immediate failure

The frontend is served at `https://nana-privy.localhost` but was started with `VITE_API_URL=http://localhost:3100`. The active API container reports `CORS_ORIGINS=http://localhost:4144`. Fastify compares origins against the configured list (`src/server.ts:111`, `src/server.ts:188`). Moving only the frontend to HTTPS left that list stale.

Reproduction:

```sh
curl -i -X OPTIONS http://localhost:3100/v1/live-bindings \
  -H 'Origin: https://nana-privy.localhost' \
  -H 'Access-Control-Request-Method: POST' \
  -H 'Access-Control-Request-Headers: authorization,content-type'
```

Observed: HTTP 204 with methods and headers, but no `Access-Control-Allow-Origin`. That status is insufficient for browser CORS approval. The browser blocks the subsequent authenticated binding request and the frontend wraps the network failure in the generic `ApiError`.

## Next failure waiting behind CORS

The active API also reports `LIVEKIT_BROWSER_URL=ws://localhost:7882`. The secure frontend needs a secure signaling URL. Fixing only CORS would leave browser LiveKit signaling misconfigured.

The Vite server currently has no `/api` or `/livekit` reverse-proxy configuration (`apps/nana-wallet/vite.config.ts`). A request to `https://nana-privy.localhost/api/health` returned 404. The existing Docker frontend already implements the desired proxy boundary in `apps/nana-wallet/docker/nginx.conf`: `/api/` forwards to the API and `/livekit/` forwards to LiveKit with WebSocket upgrade handling.

## HTTPS and earlier startup attempts

`curl https://nana-privy.localhost/` now returns 200 without `-k`. Portless listens on 443 and the CA validates. It routes the frontend to Vite on port 4549. The active route `nana-wallet-api.localhost` points at the current API on 3100; `nana-privy-api.localhost` still points at an older backend on 32800. These two aliases must not be confused.

HTTP on `:1355` was an unsuitable fallback: Privy rejected embedded wallet startup. Earlier shell `sudo` attempts fell back to 1355, and a privileged `nohup` attempt failed with `can't detach from console`. The successful invocation used Portless's own daemon mode with explicit `--port 443 --https` under macOS administrator authorization. A launcher must verify the resulting origin and TLS mode and fail clearly if they differ.

## Service-worker trace

`apps/nana-wallet/src/client.tsx` starts MSW in development unless `VITE_E2E_REAL_BACKEND=1`. The supplied trace is from MSW's passthrough path and ends in the browser's failed fetch. It does not prove an MSW defect or a remote database failure. A dedicated real-stack startup should bypass development mocks using the existing flag and account for a previously installed worker.

## Remote database and readiness

The API and worker both classify their configured database target as remote Supabase. The API targets a Supabase session pooler on port 5432 with SSL required. A read-only query through the application's database client returned `SELECT 1` successfully and confirmed `public.users` exists. No migrations or remote writes were performed for this investigation.

The current API `/health` returns 200 and `status=ok`, while `provider.status=degraded`. The active API has no configured signer URL, signer token, or inline authorization key. The older Privy Compose stack has separate backend and voice-worker signer services. Thus the current API/worker/LiveKit trio is not proof that every wallet capability is ready.

Current checks:

| Probe | Observed result |
| --- | --- |
| Frontend HTTPS `/` | 200, certificate validated |
| Current API HTTPS `/health` | 200, provider degraded |
| Current origin binding preflight | 204, allow-origin missing |
| Same-origin `/api/health` | 404 |
| Secure LiveKit host `/` | 200 |
| Remote Supabase read | Passed; users table exists |
| Authenticated browser voice session | Not verified |

## Existing tooling gaps

- `compose.yaml` starts an API/worker with an explicit local Postgres target, regardless of an env-file database value. It cannot be reused for remote startup without deliberate overrides.
- `compose.privy-local.yaml` supplies the correct same-origin browser URL, CORS, frontend Nginx, and signer topology, but also targets local Postgres and assumes existing local secrets/volumes.
- `scripts/docker-real-wallet.mjs` still requires WDK and targets Sepolia. It is unsuitable for the repository's single Privy/Solana-devnet runtime.
- `HANDOFF_v2.md:133` already documents the intended HTTPS/WSS browser origin. The ad hoc Vite/API startup did not apply that configuration.
- No current single command reconciles Portless, Vite, the remote database, LiveKit signaling, worker registration, and signer readiness.

## Verification boundaries

Launcher tests and synthetic voice E2E must use disposable local storage. Startup against the approved remote Supabase project may perform read-only connectivity/schema checks. Real Privy login and microphone/audio output require a user session and must be reported separately from HTTP status and worker-container state.
