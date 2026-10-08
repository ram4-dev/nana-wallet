# DGC-7 manual verification evidence (Slice 1)

Date: 2026-10-03. Checkout: worktree colloseum.delegated-grant-core @ 651784a.
DB: local pgvector container on 127.0.0.1:55433, schema applied
(src/db/migrations 001-008 + supabase chain incl. 20260901000700).

## 7.1 Backend gates
- npm run lint: PASS (eslint --max-warnings=0)
- npm run typecheck: PASS (tsc, 0 errors)
- npm test: PASS — 687 passed, 10 skipped (no-file-parallelism; the default
  parallel pool has a pre-existing flakiness class in buildServer-based tests:
  5s avvio onReady timeout under file-parallel DB contention; all affected
  suites pass serially and in isolated runs; reproduced also on base c64f6e6)

## 7.2 Frontend gates (apps/nana-wallet)
- npm run lint: PASS
- npm run typecheck: PASS
- npm test: PASS — 87 tests, 18 files

## 7.3 Manual checks (spec scenarios)
- Revocation takes effect before next execution attempt:
  PASS — revokeGrant flips state + revoked_at in one tx under advisory lock;
  claimConsumption re-reads state per execution (integration: delegated-grants-
  consumption.test.ts "revocation marks the grant…", engine test "rejects a
  revoked grant", "rejects a non-active state").
- Failed policy sync blocks covered execution (fail-closed):
  PASS — privy-policy-sync.test.ts "fails closed": provider error leaves
  provider_policy_id NULL + policy_sync_failed audit; grant response exposes
  policyReady:false; no covered-execution path exists without the policy.
- Degradation is user-observable, never a hard conversation error:
  PASS — evaluateGrant returns {decision:'degrade', reason} for every
  out-of-scope case (14 unit cases); the contract degrades to the existing
  preview+confirmation flow (wired into the conversation service in Slice 3;
  no throw path from the engine).
- No voice path mutates grants:
  PASS — no grant mutation exists in any realtime tool schema
  (create-realtime-tools.ts untouched); grants surface is HTTP-only
  (src/api/grants.ts + RequestIdentityProvider).

## 7.4 Demo boundary
- WDK_TOOLS_SOURCE default (fixture) unchanged; no live keys touched; no
  secrets read; no transactions executed. Policy sync tested only with a fake
  provisioner; live Privy Solana policy path is exercised on devnet in Slice 2.

## PR review remediation (2026-10-04)

The evidence above describes the original apply at commit `58ef618`. A later
read-only PR review found that the production server did not register the grant
routes, the UI was not mounted, provider-policy readiness was not enforced at
the atomic claim boundary, rejected claims were not audited, idempotency replay
did not return the original result, and expiration was not rechecked under the
locked row. These findings are addressed in the current PR remediation diff.

The remediation also makes wallet identity server-selected: `POST /v1/grants`
accepts constraints only and the server resolves exactly one ready embedded
wallet for the requested chain. A missing or ambiguous wallet fails closed.
The production policy provisioner remains unavailable in Slice 1 because the
denomination-safe Solana adapter is scoped to Slice 2. Creation therefore
returns an active lifecycle row with `policyReady: false`; the engine and
atomic claim both refuse execution until a real provider policy is bound. The
UI labels this state as pending and does not describe it as executable.

### Verification status for remediation

- Regression tests were added/updated for server registration, wallet
  resolution, policy readiness, rejection audit, expiry, replay, and UI create
  behavior.
- Pi ran the focused command
  `npx vitest run tests/unit/grants-engine.test.ts tests/unit/grants-validators.test.ts`
  once during implementation; the red run failed on the new policy-readiness
  case and the green run passed 19 tests. This was before the remaining route,
  policy lifecycle, UI, and contract changes.
- Hermes owns all current PR test execution. Backend/frontend suites, lint,
  typecheck, build, E2E, and fresh CI are still pending for the remediation
  commit; no result above is evidence for that commit.
