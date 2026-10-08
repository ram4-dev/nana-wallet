# Archive report — solana-wallet-onboarding

## Summary

La wallet embebida de Solana se crea en el login y puede crearse manualmente desde Nana.

## Delivered

- `embeddedWallets.solana.createOnLogin = 'all-users'` in the Privy provider config.
- Manual fallback component using the Solana-subpath `useCreateWallet`, followed by a re-sync so the backend binding becomes ready.
- Bugfix: payment-permission activation was dead-locked for Privy users (`canActivate` excluded privy mode).

## Evidence

- Merged as PR #6 (`460cb26`).
- Verified live: the Solana wallet `AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX` was created at login and both bindings reached `ready`.

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
