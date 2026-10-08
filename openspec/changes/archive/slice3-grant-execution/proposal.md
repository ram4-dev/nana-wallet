# Proposal: Delegated Grant Execution (Slice 3)

## Intent and Outcome

A transfer fully covered by an **already-active, non-expired, policy-ready grant** executes **without the second explicit confirmation**; anything else degrades to the existing preview + explicit-confirmation flow — never a hard conversation error. Implements Slice 3, wiring the built-but-unwired Slice 1 grant engine into the execution path.

## Design Resolutions (Q1–Q4)

Orchestrator-selected conservative resolutions within the Ramiro-approved slice scope ("execute only when fully covered; fail closed otherwise") — not direct user-authored wording; binding for this change. Q1: coverage decided only on the original request; later grants never auto-execute older pending previews; revocation/expiry re-checked atomically at the claim. Q2: covered ⇒ no cancel window; user request + active grant IS authorization; honest narration; existing `uncertain` wording preserved. Q3: deterministic least-privilege selection (per-transfer cap ↑ → cumulative cap ↑ → earliest expiry → stable id) among claim-passing candidates; next-candidate fallback; never model/client influenced. Q4: simple degrade copy; reason codes internal, none in HTTP.

Preserved: D-2 one server-resolved wallet; D-3 HTTP-only grants, skip never model-delegable; D-4 hybrid Privy policy + Postgres ledger (sole authority); D-7 multi-execution within cap/window.

## Scope

In: coverage decision at the conversation service execution boundary (`resolveDecision`/`runFinancialTransfer`); Q3 selection + atomic claim via `claimConsumption`; fail-closed units conversion (provider `listTokens` decimals; SOL lamports, 0.01 SOL ceiling); covered path reuses the existing `sent` shape — zero contract delta expected (mirror = no-op assertion; any delta mirrored in `src/contracts/http.ts` + `apps/nana-wallet/src/lib/api-types.ts` same PR).

Safety controls: idempotency key `grant-exec:{userId}:{attemptId}` from the persisted preview attempt — no third ledger; DB claim + `used` audit before broadcast; `claimConsumption` sole authoritative recheck (`consumedInWindow` never called with an anonymous client; `evaluateGrant` pre-filter/copy only); no new execution-time Privy readback; skip only on the authenticated original turn/transcript with exact amount + recipient bound to user text — model tool previews stay confirmation-gated.
Out: provider signing/submission/finality; LiveKit tool surface; grant lifecycle endpoints; `src/wallet/transfer-pipeline.ts`; swaps/mainnet; new ledgers.

Amendment (2026-10-05, Ramiro-approved, binding): grant budget claims are RESERVATIONS until dispatch certainty. On definitive non-dispatch (provider `not_dispatched`) or preflight rejection (policy/recipient revalidation) inside `runFinancialTransfer` — which enters with the attempt ALREADY `broadcasting` under the winner's persisted `claim_id` — the reservation is released ONLY through the atomic settlement: the EXACT-OWNER compare-and-set `broadcasting → cancelled` (id + status + `claim_id` all match) plus the `released_at`/`released_reason` columns and compensating `released` audit row, all in the SAME user-scoped transaction under the per-grant advisory lock; a lost/absent CAS, absent row, already-`cancelled` status, or ambiguous ownership NEVER releases standalone (retention). Every dispatched/uncertain state (`broadcasting` unowned, `submitted`, `uncertain`, `confirmed`, `reverted`, `receipt_invalid`) RETAINS (recovery by reference-id reconciliation only). NO re-activation: a released key is permanently retired (replay fails closed, never broadcasts) and a retry requires a fresh persisted `previewId` with a fresh key/reservation. One additive migration (release columns + `released` audit event, forced RLS unchanged); BOTH window sums are explicitly rewritten to unreleased ledger rows so released budget returns. Tracked as spec requirement "Reserved budget release on definitive no-dispatch" (12 scenarios), design AD-10, tasks Phase 8. The `claimPendingTransfer` winner result returns the persisted `claim_id` ownership token, threaded through `runFinancialTransfer` to settle; the broadcasting-to-previewed reset is replaced — released attempts are never re-opened.

## Rules (RFC 2119)

Skip only on `covered`; all errors degrade closed. Q1–Q4, D-2/3/4/7 above. Ledger sole authority. Audit-before-effect. Replay returns the same budget claim without second consumption/audit — never a completed transfer; broadcast additionally requires winning the single-winner `claimPendingTransfer` transition (crash-retry safe). Fail-closed units. `WDK_TOOLS_SOURCE=fixture` default. Contract mirroring. **Strict TDD** (user-mandated, overrides `strict_tdd: false`; RED first; `npm test` + `npm run typecheck`); DB suites must actually run (pgvector compose up).

## Delivery

New capability `delegated-grant-execution`. Areas: `src/conversations/service.ts`, `src/wallet/grants/*` (minimal), contract mirrors, tests. Rollback: additive optional deps; absent ⇒ today's behavior; no schema changes. PR stacked on `origin/slice2-provider-solana-devnet` (PR #2 unmerged); `delivery_strategy: exception-ok` (size exception recorded).

## Epistemic Status

Code evidence: exploration.md. Design gate **satisfied** by Ramiro's no-more-approvals standing instruction (sequential 2→3→4→5, same SDD/TDD/worktree/PR flow); Hermes PR testing + review remain post-PR gates.
