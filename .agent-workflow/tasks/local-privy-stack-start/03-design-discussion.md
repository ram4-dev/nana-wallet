# Design discussion

Revision: 1
Status: approved by user on 2026-10-22; intermediate permission gates waived

## Current and desired behavior

The running services use three inconsistent browser configurations: the old HTTP frontend origin in API CORS, a direct HTTP API URL in Vite, and a plain WebSocket LiveKit URL returned to an HTTPS page. Services were started independently, and a frontend 200 hid both routing failures and a degraded wallet provider.

The desired entry point is `npm run dev:stack`. It should start the required local processes and containers and return `https://nana-privy.localhost` only after the checks described below pass. The existing Nana Wallet Supabase project remains the remote runtime database. The Nana Landing project is excluded.

## Options

1. Same-origin routing, recommended. Keep the allowlisted frontend origin and expose `/api` and `/livekit` through its development proxy. Set `VITE_API_URL=/api`, browser signaling to `wss://nana-privy.localhost/livekit`, and API CORS explicitly to the same origin. This reuses the existing Docker Nginx routing contract. It requires Vite proxy configuration and startup ownership checks but removes independently configured browser API origins from the normal path.
2. Separate HTTPS domains. Serve API and signaling on distinct Portless hostnames and synchronize CORS and the frontend API environment. This requires fewer path rewrites but keeps several public URLs coupled and preserves the class of configuration drift seen here.

## Proposed scope

- Add a Privy-specific launcher and package command, independent of the obsolete WDK launcher.
- Start Docker/Colima when available and required. Start API, worker, LiveKit, and required Privy signer services under one owned stack; keep the frontend in Vite for development.
- Reuse the repository's existing signer boundary. Do not place a private authorization key in the API or frontend. Report missing signer prerequisites explicitly.
- Inject secrets through `vault-env` and existing opaque provisioning. Never print, parse for display, or commit provisioned `.env` contents. Keep any generated key material in restricted, ignored storage and scoped to the processes that require it.
- Resolve the existing remote project/pooler target from approved configuration. Check that it matches Nana Wallet before connecting. Do not silently substitute local Postgres, a different remote project, or a mock wallet.
- Use Portless HTTPS on 443, preserving the exact Privy origin. Explain and request macOS administrator authorization when required. Reject HTTP, custom-port fallback, and TLS verification failures as startup failures.
- Disable development mocks for this real-stack path using the existing flag and verify stale worker handling.
- Make repeated startup idempotent for owned resources. Do not stop other projects, reset data, delete volumes, or alter unrelated Portless aliases.
- Keep local test/E2E databases isolated from the remote runtime. Do not run migrations during startup.

## Readiness and tests

Startup must verify the actual public HTTPS frontend, same-origin API health, binding-route reachability without a CORS failure, browser signaling URL and proxy path, remote database read/schema prerequisites, worker registration, and signer readiness. An unauthenticated binding response is expected to be 401; it must not be mistaken for successful authenticated voice.

Add regression tests for origin consistency, insecure fallback rejection, remote-target validation, redaction, ownership, and failed readiness checks. Run the repository's required static and automated checks. Run the relevant browser/network and synthetic LiveKit E2E against disposable local dependencies. Report real Privy login, microphone permissions, and audible output as manual checks until actually confirmed.

## Proposed files

The implementation outline will be written after design approval. Expected areas are a new startup script and tests under `scripts/`, the root package command, Vite proxy configuration, any dedicated non-secret Compose configuration, and a runbook linked from README. No backend HTTP contract or payment behavior change is proposed.

## Decision and approval

Decision: use same-origin routing. The user answered: "Si hacelo aunque skipeemos los permisos porque son pocos cambios," authorizing implementation and skipping intermediate permission requests. Continue in this session, as previously requested when Pi's provider quota ran out. Do not claim an independent Pi outline review was performed.

Gate ID: local-privy-stack-design-v1

Decision / allowed mutation: implement the startup and proxy design above, including tests, runtime checks, and documentation.

Explicit exclusions: payment changes, remote migrations/writes during probes, Nana Landing changes, unrelated runtime cleanup, merge/push.

Owning artifact / revision: this document, revision 1.

Decision owner: Ramiro.

Approved by / trusted identity: Ramiro, direct message in this session.

Approved at: 2026-10-22.

Status: approved.

Invalidated by: a change to routing, target project, signing boundary, authority, or scope.

Next: execute the recorded SDD tasks and verify the running stack. The user's instruction supersedes intermediate permission requests. Verify with automated checks and actual browser/network probes, and report any unperformed live authentication/audio check.
