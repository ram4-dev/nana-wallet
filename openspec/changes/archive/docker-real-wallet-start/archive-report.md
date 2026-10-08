# Archive report — docker-real-wallet-start

## Summary

Arranque reproducible del stack con wallet real (WDK o Circle Arc) mediante `scripts/docker-real-wallet.mjs`, con preflight de secretos y ledger de migraciones.

## Delivered

- Preflight that reports missing secret names without printing values, sourced from `vault-env`.
- Dedicated compose project, ledger/checksum migration application, Portless publication.
- Docker startup script tests (`node --test scripts/docker-real-wallet.test.mjs`) wired into CI.
- Runbook: `docs/docker-real-wallet-start.md`.

## Evidence

- Tasks ledger: 5/5 complete.
- CI step "Docker startup script tests" green on every PR.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
