# Verification

Date: 2026-10-22. Implementation branch: `fix/local-privy-stack-start`, based on `22cb8e1`.

## Observed runtime result

`npm run dev:stack` completed successfully multiple times. Portless serves the real frontend at `https://nana-privy.localhost`. Trusted HTTPS probes return frontend 200, same-origin `/api/health` 200, and unauthenticated POST `/api/v1/live-bindings` 401. Readiness verifies a signed WSS upgrade through `/livekit`, a read-only remote database query, the API and worker signing capabilities, signer network namespaces, and worker registration.

The second successful invocation reused the API/worker/LiveKit and owned frontend instead of duplicating them, and recreated only the two sidecars to ensure their current network namespaces. Repeated startup completed again after moving runtime state to the common checkout. Binding keys and signer token were preserved through that move without displaying their contents.

The actual browser check passed with Chromium and certificate verification enabled: frontend 200, API 200, binding 401 without CORS failure, WSS upgrade, and removal of a deliberately installed stale MSW worker after navigation. No login, microphone input, wallet calls, or transfers were exercised by the browser probe. The probe used a temporary local LiveKit room and deleted it afterwards.

## Automated checks

| Check | Result |
| --- | --- |
| Frontend lint and typecheck | Passed after final frontend changes |
| Frontend tests | 32 files, 226 passed |
| Frontend mobile build | Passed after final frontend changes; existing chunk warnings |
| Isolated browser proxy E2E | Passed: trusted HTTPS 200, browser binding 401 without CORS, WSS, prefix/query preservation; temporary local upstream and alias cleaned up |
| Launcher tests | 9 passed locally |
| Startup tests in CI's Node 22.18 Docker image | 17 passed: existing WDK launcher tests plus the new launcher tests |
| Backend lint, typecheck, build | Passed; source-checkout stale dependencies were avoided by installing locked dependencies in the task worktree |
| Backend evals | Exit 0; 10 files, 29 evals, score 94%, configured threshold passed |
| Full backend suite with local pgvector | 1868 passed, 3 failed, 10 skipped; details below |
| Whitespace and script syntax | `git diff --check` and `node --check scripts/dev-stack.mjs` passed |

The full suite used a disposable local pgvector database and the CI migration chain. No test suite received the remote runtime database URL. The database container `nana-stack-start-test-db` was removed afterwards.

## Existing/unrelated failures

- `tests/unit/realtime-agent-session.test.ts`: expected persona wording does not match current persona. This was already listed as parked in the earlier handoff; this change does not modify that source or test.
- `tests/integration/wallets-sync.test.ts`, PEW-013: expected 200, received 422. The earlier handoff also records this failure; this change does not modify wallet activation behavior.
- `tests/integration/api-contact-check-alias.test.ts`: one full-suite case timed out at 5 seconds. A focused rerun passed all 8 tests.
- The legacy startup CLI orchestration tests failed on host Node 26 with child-process pipe errors. All 8 passed unchanged under the pinned Node 22.18 Docker image; the combined CI startup command passed all 17.

## Changes driven by runtime evidence

1. Four concurrent TypeScript compilers and retained duplicate API/worker containers caused an actual OOM kill (`OOMKilled=true`, exit 137). The dedicated image now compiles once during the image build. Only the previous ad hoc containers owned by this session were stopped: `colloseum-backend-supabase-check`, `colloseum-voice-worker-supabase-check`, and `colloseum-livekit-1`. Other projects and existing data were preserved.
2. A strict database connection initially failed with `SELF_SIGNED_CERT_IN_CHAIN`. The launcher now mounts the public Supabase CA into API and worker and uses `sslmode=verify-full` with `sslrootcert`. A read-only query passed with that verification before startup was rerun. No TLS verification was disabled.
3. The global Privy health projection is intentionally `degraded` without an authenticated user. The launcher accepts only that exact documented projection with `policySigner.capable=true` and code `verified`; it does not claim an individual wallet is ready.

## Manual limits and authority

Real Privy login, permission enrollment, microphone permissions, and audible voice output remain unverified. The browser automation context has no user's authenticated Privy session, and native app automation is unavailable. Transport readiness and worker registration are verified; actual user audio is not inferred from them.

The user approved the proposed same-origin design and explicitly requested skipping intermediate permission gates. No independent Pi outline review is claimed. System authorization for HTTPS/443 remains a macOS requirement when the proxy is absent.

No remote schema/data migration, Nana Landing change, remote push, or payment was performed.

## Independent verification

A separate SDD verifier returned PASS WITH WARNINGS, no critical findings, and accepted verification-envelope validation. It reran the 9 launcher tests, 8 focused frontend proxy/MSW tests, the isolated Chromium proxy E2E, and public endpoint probes. Its warnings cover the existing full-suite failures and the unverified authenticated audio session. No Pi review was claimed.

The final startup probe also checks the `users` and `conversations` tables, visibility of the `vector` type, and existence of `recipient_app` using read-only SQL. It fails with an explicit connection/TLS/schema diagnostic and never runs a migration.

## Repeated-start readiness correction

A later repeat exposed a false failure: active worker job logs pushed its registration outside the last 120 lines. The launcher now discovers the SDK health listener from container logs and requests its current health endpoint inside the worker container. The SDK returns 503 while disconnected, so an old registration cannot satisfy readiness. The new regression covers log truncation, listener replacement, and invalid ports. All 10 launcher tests passed; complete startup passed after this correction.
