# Archive report — privy-multi-user-foundation

## Summary

Fundación multi-usuario: identidad Privy verificada (ES256), provisioning idempotente, RLS por usuario y contactos autenticados.

## Delivered

- `users` table with FORCE RLS, `user_self_isolation` policy and the `SECURITY DEFINER` `users_ensure_for_privy_did` idempotent upsert.
- `PrivyIdentityProvider` verifying ES256 tokens with `jose` (iss/aud/sub/exp mandatory) and an app-specific JWKS PEM bundle that tolerates key rotation.
- Config matrix (`IDENTITY_PROVIDER=demo|privy`) plus the PMU-024 guard rejecting funded singleton wallets in privy mode.
- `GET /v1/me`, contacts CRUD with versioned history (`recipient_versions`) and cross-user RLS isolation proven by tests.
- Authenticated room-token issuance (PMU-020) with indistinguishable 404s for foreign resources.
- Frontend: Privy login, Bearer + 401-retry-once, session-isolation generation guard, per-request memory runtime.

## Evidence

- Deliverable files present and tested on `main`: `src/auth/privy-identity.ts`, `src/api/me.ts`, `src/api/contacts.ts`, `supabase/migrations/20260901000300_users.sql`, `04_users.sql` local mirror.
- Merged PRs on `ram4-dev/nana-wallet` (foundation landed before PR #1 and in the slice PRs).
- Backend suite green at archive time (1015/1015).

## Open items and deferrals

**Ledger honesty note**: this change's `tasks.md` used a legacy nested checklist that was never flipped, so its 55 open boxes do not reflect missing work — the deliverables are on `main`. The final state is evidenced by the files and the green suite above.

Deferred at archive time:

1. **Live signer enrollment acceptance** — completed later in `privy-embedded-wallets` (PRs #13, #14).
2. **Independent review receipt** — ownership outside this session.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
