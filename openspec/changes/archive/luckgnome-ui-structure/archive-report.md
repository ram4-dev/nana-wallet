# Archive report — luckgnome-ui-structure

## Summary

Todas las vistas adoptan la estructura del prototipo LuckGnome manteniendo la paleta violeta/crema y la mascota Nani.

## Delivered

- Floating pill bottom nav with a raised central voice orb.
- Voice orbit with dual ring and per-state waves; balance card; row lists for contacts; profile card; settings groups.
- Wallet screen reduced to balance, recipients/actions and activity; payment authorization moved into its own section on the account screen.
- Delegated-grant and Solana-setup sections removed from the UI (grant creation lives in Nani conversation).
- Provider overshoot and hourly-limit advisory blocks removed from the permission view.

## Evidence

- Merged PRs #9 (`afe5dfe`), #10 (`05df986`), #11 (`92d94a0`), #15 (`4cd8092`).
- Frontend suite green; Tailwind v4 compile verified with `@tailwindcss/cli`.

## Open items and deferrals

Recorded, not hidden: removing the advisory blocks does not change enforcement — the cumulative hourly limit remains unenforced by the provider until wallet-identity grouping is proven.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
