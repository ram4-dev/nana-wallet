# Proposal: Delegated Grant Core (Slice 1)

## Intent and Outcome

Provide server-side, chain-agnostic bounded delegation: a user grants the assistant
a bounded authorization (action, wallet, per-transfer cap, cumulative cap with
rolling window, expiration, recipient allowlist) through an authenticated HTTP
endpoint — never through voice. A covered action executes without re-confirmation;
anything outside the grant degrades closed to the existing preview + explicit
confirmation flow. Every grant creation, use, and rejection is audited.

This implements Slice 1 of the approved plan
(`.agent-workflow/tasks/financial-assistant-development/01-propuesta-plan.md`).

## User Decisions Bound Into This Change (approved 2026-10-03, G0)

| Decision | Resolution |
| --- | --- |
| D-2 Wallet classes | Provider **embedded wallets**, ONE wallet per user in the MVP. Read-only external wallets are post-MVP extension. Operable external wallets excluded. |
| D-3 Grant channel | Grant/revoke via **authenticated HTTP endpoint** using the configured `RequestIdentityProvider` (`src/server.ts`, pattern of `src/api/wallets.ts`). **Never via voice.** |
| D-6 Multi-wallet scope | **One wallet per user** (current data model). Slice 6 (N wallets/portfolio) stays conditional and out of this change. |
| D-7 Grant cardinality | **Multiple executions covered within cap/rolling window until expiry or revocation** (plan default, ratifiable — see Open Questions). |
| D-4 Grant mechanism | **Hybrid** (ADR-1, see design.md): Privy custody + per-transaction enforcement via Solana signer policies (max per transfer, recipient allowlist, temporal window), plus an own PostgreSQL grants ledger for what Privy policies do not cover: cumulative rolling cap, TTL/expiration, revocation, full audit. The Postgres ledger decides creation/rotation/revocation of the Privy policy. On-chain session keys are **discarded** with evidence. |

## Scope

### In Scope

- New migration: `delegated_grants` table (scoped grant model) + `grant_audit_log`.
- Grant engine (server-side validation at execution time): coverage check,
  per-transfer cap, cumulative rolling-window cap, expiration, revocation,
  recipient allowlist (Solana base58 validator plug-in point).
- Authenticated HTTP endpoints: create grant, list grants, revoke grant
  (`RequestIdentityProvider`-protected, pattern of `src/api/wallets.ts`).
- Privy policy sync: create/rotate/revoke the signer's Solana policy from the
  grants ledger (per the D-4 hybrid decision).
- Audit trail: grant created, used (with consumed amounts), rejected (with reason),
  revoked, expired.
- Idempotency keys per execution intention (DB unique-constraint level, extending
  the existing `wallet_operations` pattern).
- Degradation contract: out-of-scope/expired/revoked → existing preview +
  confirmation flow, never a hard failure of the conversation.
- Minimal frontend surface: grants list + grant/revoke UI over the authenticated
  HTTP channel (mirrored contract in `apps/nana-wallet/src/lib/api-types.ts`).

### Out of Scope / Non-goals

- Solana `WalletProvider` itself (Slice 2). The engine is chain-agnostic; the
  base58 validator ships behind the plug-in interface.
- Voice-mediated grant creation, modification, or revocation (forbidden by D-3).
- N wallets per user, portfolio aggregation (Slice 6, conditional).
- Swaps/purchases (Slice 7).
- Webhooks/notifications channel (Slice 5; grant events emit internal revision
  events only).
- Mainnet, live funds, production custody migration. All verification is devnet.
- On-chain session-key mechanisms (discarded by ADR-1 evidence).

## Business Rules and Constraints

- Grant validation MUST happen server-side at execution time, never at turn time
  and never inside the voice session state.
- A grant MUST NOT be created, extended, or revoked through voice tools. The voice
  path MAY narrate existing grant state but MUST NOT mutate it.
- Execution under a valid grant MUST still: enforce per-transfer cap, cumulative
  rolling-window cap, expiration, revocation (checked at the moment of execution),
  and recipient allowlist.
- Every grant decision (allow/reject) MUST append an immutable audit row before the
  on-chain operation proceeds.
- Exceeded/expired/revoked/out-of-allowlist MUST degrade closed to preview +
  explicit confirmation; the conversation MUST NOT fail hard.
- Idempotency for grant-covered executions MUST be enforced at the database level
  (unique constraint path), not with in-memory counters.
- Revocation MUST take effect before the next execution attempt (checked per
  execution; no cached grant state).
- The demo boundary holds: `WDK_TOOLS_SOURCE=fixture` default unchanged; live
  Privy policy enforcement is exercised only against Solana devnet with test
  credentials.

## Capabilities

### New Capabilities

- `delegated-grant-core`: bounded delegation grants — authenticated grant
  lifecycle (create/list/revoke), server-side coverage validation with cumulative
  rolling cap, Privy Solana policy sync, audit trail, and closed degradation to
  preview + confirmation.

### Modified Capabilities

- None. The existing `signer_grants` experimental table and
  `src/wallet/transfer-pipeline.ts` grant read path are NOT retroactively mutated;
  the new model is additive and will replace the read path in Slice 3.

## Affected Areas

| Area | Impact | Description |
| --- | --- | --- |
| Database (`supabase/migrations/`, `src/db/migrations/`) | New | `delegated_grants`, `grant_audit_log` + local mirror migration |
| Backend `src/wallet/grants/` (new) | New | Grant engine, rolling-window accounting, validators plug-in |
| Backend `src/api/grants.ts` (new) | New | Authenticated grant lifecycle endpoints |
| Backend `src/contracts/http.ts` | Modified | Grant request/response schemas (mirrored same PR in front) |
| Frontend `apps/nana-wallet/src/lib/api-types.ts` | Modified | Duplicated contract types (hard repo rule: same PR) |
| Frontend grants UI (new feature module) | New | List/create/revoke over HTTP; the server resolves the sole ready wallet; no voice path |
| Privy integration `src/wallet/privy-*` | Modified | Policy create/rotate/revoke helpers for Solana signer policies |

## Rollback Plan

The change is additive: new tables, new endpoints, new module. Rollback =
revert the PR; no existing table semantics are altered. The
`transfer-pipeline.ts` integration is deferred to Slice 3, so a rollback of this
slice leaves the current transfer flow untouched. Privy policy operations are
logged and idempotent; a failed policy sync leaves the grant in a non-active
state (fail-closed) and never enables enforcement-less execution.

## Epistemic Status

- Repo evidence in this proposal: facts verified in checkout `c64f6e6`.
- D-4 vendor evidence: primary sources dated 2026-10-03 (Privy Solana
  networks/config docs; Solana example policies incl. documented ALT limitation —
  irrelevant for simple transfers; one policy override per signer; May 2026
  changelog: transfer policies live). Crossmint evaluated and discarded: more
  custodial recovery model, per-signer email-OTP approval flow incompatible with
  voice UX, transfer-only scope.
- D-7 is the plan default (multiple executions within cap/window), applied as the
  design baseline and flagged ratifiable before Slice 3 consumes it.
