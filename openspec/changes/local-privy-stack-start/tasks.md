# Tasks

Delivery strategy: single-pr; no PR/push requested. Keep implementation compact and report authored diff size. The user explicitly requested skipping intermediate permission requests for this bounded change.
Decision needed before apply: No
Chained PRs recommended: No
400-line budget risk: Medium

- [x] 1. Add opt-in same-origin Vite proxies and tests; preserve normal/mobile builds.
- [x] 2. Implement the Vault-backed, remote-Supabase startup command with owned Docker services, signer boundary, strict Portless origin, frontend environment, and safe readiness checks.
- [x] 3. Add focused launcher regression tests and the single-command runbook.
- [x] 4. Run required static/unit/build checks and relevant browser/proxy and LiveKit E2E; start the real stack and verify readiness plus a second invocation.

Work unit evidence must record focused checks, actual runtime harness results, and rollback boundaries. Strict TDD is false in project config; regression tests and live E2E remain required.
