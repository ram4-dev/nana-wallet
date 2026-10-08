# Tasks: Privy Embedded Wallets

Revision r3 (2026-09-08). Implementable scope after consolidation: indefinite user-revocable permission; 10 USDC per transfer; 50 USDC per rolling 3600 seconds; enforcement exclusively through Privy policy configuration; no local SQL spending cap; aggregate concurrency limitation accepted; F6 broadcast-actor fix. Fee accounting: recorded implementation assumption (amount-only caps, fees separate, bounded by Privy gas policy) pending Q2. Implementation authorized by the user.

## Current acceptance correction (2026-09-09)

Earlier checked items included fixture-only assertions and are not proof of live wallet acceptance. Real per-user reads and automatic frontend wallet creation are implemented in the resumed slice; transaction transport primitives are verified offline but are not yet connected to durable real execution. Provider policy scope/fee enforcement and first authenticated embedded-wallet creation remain unverified. See runtime-provider-evidence.md under the task receipt folder. No live transfer success may be inferred from this checklist.

## Review Workload Forecast

Chained slices following the r3 outline. Privy app credentials and signer registration are available through vault-env. Missing live user wallet and unproven provider protections block live acceptance; fixture checks do not satisfy these gates. Live signing stays disabled until the provider-side gas bound is proven.

## Work Units

### WU-E1 — Privy/Arc capability pinning (docs + offline harness)

- [ ] Revalidated doc pinning (main-Pi-high web research): exact @privy-io/react-auth + @privy-io/server-auth versions, verifyAuth API, wallet/policy/eth_signTransaction endpoints, stateful-policy 3600s window semantics, recovery behavior; exact Arc chain id/RPC/USDC contract/decimals. Record in docs/privy-arc-runbook.md with source URLs. Blocked parts (live) recorded as such.
- [ ] Offline capability harness skeleton (tests/integration/privy-capabilities): provider-negative tests against a fake contract boundary; live probes marked blocked while keys are missing. Live signing remains disabled.

### WU-E2 — Durable wallet bindings and permission records

- [x] Migration `user_wallets` + `signer_grants` (no expires_at, no budget columns; states pending/active/revoking/revoked/unavailable) with FORCE RLS scoped by user_id; local + Supabase variants ordered after foundation migrations.
- [x] Wallet sync: verify ownership via Privy server API (trusted server response), idempotent binding, unique active wallet per user/chain-family, explicit conflict on multiple candidates; concurrent-first-login and provider-success/DB-failure reconciliation tests; forged owner rejected.
- [x] HTTP: GET /v1/wallets/current, POST /v1/wallets/sync, GET /v1/wallets/current/permission, POST /v1/wallets/current/permission/revoke — ApiEnvelope, 401/404/409/503 semantics; contracts mirrored to api-types.ts; independent HTTP example tests both sides.
- [ ] Grant activation reads back effective signer/policy settings before marking active; missing/unverified restrictions block activation.

### WU-E3 — Per-user provider and durable transfer path (fixture-first)

- [x] Per-user wallet/grant resolver in src/runtime/dependencies.ts + src/conversations/service.ts + voice deps; LLM cannot supply authority-bearing overrides; singleton guard replaced only for the verified per-user provider.
- [x] Preview/confirm flow unchanged (user/wallet/chain/token/recipient-version/amount/fee-ceiling/expiry/conversation/preview binding + explicit confirmation + idempotency key).
- [ ] Signing pipeline: atomic operation claim + per-wallet nonce serialization → construct exact transfer calldata → eth_signTransaction (provider policy enforces 10/50/3600 + gas) → decode + verify signed bytes → persist bytes/hash in restricted storage → eth_sendRawTransaction to Arc → receipt verification. Lost-signing-response vs lost-broadcast-response reconciliation per F6; identical-bytes-only retry; no new nonce/fee bump.
- [x] Fixture mode implements the same pipeline against the deterministic fake signer with restricted-bytes semantics and reconciliation states (signed/submitted/confirmed/reverted/uncertain). Live Privy signing behind an explicit capability gate that is closed until WU-E1 proves the gas bound and keys exist.

### WU-E4 — Web wallet lifecycle and permission UI

- [x] Wallet readiness vs permission readiness distinct states (unprovisioned/provisioning/ready/recovery_required/conflict/unavailable).
- [x] Permission screen: indefinite revocable permission, reviewable limits (10 USDC/transfer; 50 USDC/rolling hour) + aggregate-overshoot caveat; fees shown separately; revoke flow.
- [x] Session isolation via foundation generation guard: wallet/permission cache cleared, late callbacks generation-scoped.
- [ ] Front tests + two-user Portless browser E2E against real fixture backend (enrollment, preview/confirm/cancel, revoke, logout/race, recovery doubles).

### WU-E5 — Final verification and delivery

- [x] Backend lint/typecheck/test/eval/build; frontend lint/typecheck/test/build; WDK/voice fixture regressions; record commands/counts/skips/blockers in development-status.md.
- [ ] Live acceptance: authenticated embedded-wallet creation, real owned balance, provider policy enforcement, real enrollment/revocation and durable transfer reconciliation. App credentials are configured; provider-policy proof and the authenticated user flow remain blockers. No real transfers have been sent.

## Parent-Owned Gates

- [ ] Independent verification (Codex) and review receipt; commit/push/merge remains outside this implementation session's authority.
