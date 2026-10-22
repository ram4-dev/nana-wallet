# Launcher apply evidence

Mode: standard (`strict_tdd: false`).

## Work unit 2: stack launcher

| Evidence | Result |
| --- | --- |
| Focused check | `npm run dev:stack -- --check`: passed, with Vault injection, Portless HTTPS/443 and linked Supabase validation. |
| Runtime harness | Handed to the coordinating task for the real stack launch. The launcher performs trusted HTTPS, same-origin API/binding, WSS, read-only remote DB, signer and worker-registration checks before it prints ready. |
| Rollback boundary | `scripts/dev-stack.mjs`, `docker/compose.dev-stack.yaml` and package script. Revert these files; only Docker project `nana-dev-stack`, Portless route `nana-privy` owned by the launcher and ignored `.cache/dev-stack` state are affected. |

## Work unit 3: regression tests and runbook

| Evidence | Result |
| --- | --- |
| Focused check | `npm run test:dev-stack`: 8 passed. |
| Runtime harness | `npm run dev:stack -- --check`: passed without containers or remote writes. |
| Rollback boundary | `scripts/dev-stack.test.mjs`, `docs/local-stack.md`, README link and test script. |

The health acceptance recognizes Privy's documented per-user deferred provider state only when mode and Solana network match and the signer capability is verified. Login, microphone and audio remain manual user-session checks.
