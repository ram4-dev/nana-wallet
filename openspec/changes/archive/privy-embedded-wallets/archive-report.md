# Archive report — privy-embedded-wallets

## Summary

Wallets embebidas por usuario con Privy: sync owner-verified, enrollment de signer con política inmutable y pipeline de transferencias fixture-first.

## Delivered

- Migrations: `user_wallets`, `signer_grants`, `wallet_operations` with FORCE RLS (no expiry column, no budget columns).
- Idempotent owner-verified sync, conflict detection, forged-owner rejection.
- Enrollment: prepare → consent → complete with server read-back proving owner + exact policy before activation (never on a client flag).
- Transfer pipeline: atomic operation claim, per-wallet nonce serialization, exact ERC-20 calldata (chain 5042002, USDC `0x3600…0000`), decode/verify, restricted persistence, broadcast, receipt verification, F6 lost-signing vs lost-broadcast reconciliation, identical-bytes-only retry.
- Authenticated HTTP routes + frontend wallet lifecycle and permission UI.

Later sessions completed and hardened the live path on the same main branch:

- Real Privy policy API alignment (PR #13): current rule shape `{name ≤50 chars, method, action, conditions[]}`, `chain_id` as string, `in` operator for the recipient allowlist — verified live with a 200 on policy creation.
- TEE-compatible consent (PR #14): `useSigners().addSigners({address, signers:[{signerId: quorumId, policyIds:[policyId]}]})` replacing the on-device `delegateWallet` action.
- Per-user multi-network bindings (PRs #7, #8) so balances read across Arc and Solana devnet.

## Evidence

- Deliverable files present and tested on `main`: `src/auth/privy-identity.ts`, `src/wallet/embedded.ts`, `src/wallet/privy-server-client.ts`, `src/wallet/transfer-pipeline.ts`, `src/api/contacts.ts`, `supabase/migrations/20260901000300_users.sql`.
- Merged PRs #1 and #5–#15 on `ram4-dev/nana-wallet`; backend suite 1015/1015 with evals 27/27 at 100% at archive time.
- Detailed session record: `.agent-workflow/tasks/privy-embedded-wallets/development-status.md` and `signer-enrollment-status.md`.

## Open items and deferrals

**Ledger honesty note**: this change's `tasks.md` kept a legacy checklist format and was not maintained task-by-task after the planning revision, so its checkboxes were never flipped even though the deliverables landed. The delivered/verified state above is evidenced by files on `main` and the current green suite, not by retroactively checked boxes.

Deferred / blocked at archive time (recorded, not hidden):

1. **Rolling 50 USDC / 3600 s aggregate** — blocked on provider wallet-identity grouping (`group_by` only supports request fields). The per-transfer cap (10 USDC), the recipient allowlist and the chain/contract pinning ARE enforced by the provider policy.
2. **Live acceptance of a real transfer end-to-end** — requires a funded Arc wallet, a human-consented enrollment and explicit user authorization to move money.
3. **Independent (Codex) verification receipt** — ownership outside this implementation session.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
