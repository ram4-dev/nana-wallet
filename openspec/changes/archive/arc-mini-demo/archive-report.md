# Archive report — arc-mini-demo

## Summary

Escritorio de comandos guiados que ejecuta un micropago real de 0.000001 USDC en Arc Testnet con preview y confirmación explícita.

## Delivered

- Guided CLI demo (`scripts/arc-demo/`) with API key read without echo, entity secret and journal kept out of Git.
- Verified against Arc Testnet RPC with a confirmed on-chain transaction (Arcscan link recorded in `docs/arc-mini-demo.md`).
- Public wallet configuration in `scripts/arc-demo/config.json`; no exported wallet private keys required.

## Evidence

- `docs/arc-mini-demo.md`, `scripts/arc-demo/README.md`
- Tasks ledger: 10/10 complete.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
