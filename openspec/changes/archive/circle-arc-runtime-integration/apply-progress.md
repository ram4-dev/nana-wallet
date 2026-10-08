# Apply Progress: circle-arc-runtime-integration

## Batch 3 = PR C (this run)

Scope: PR C (final) of 3 stacked PRs — tasks 6.1–6.5 (batch 6: D8 boot guard, `.env.example`, compose check, docs) and 7.1–7.3 (batch 7: root gates, frontend suite, fake-Circle integration). 7.4 (manual E2E) intentionally UNCHECKED for the user.

### Completed tasks (all checked off in tasks.md)

- 6.1: D8 config-shape guard in `createWalletProvider`'s circle-arc branch (`src/runtime/dependencies.ts`): a set-but-mismatched `WDK_NETWORK` (≠ `arc-testnet`, uses the exported `ARC_TESTNET_NETWORK` constant) or `WDK_TOKEN` (≠ `USDC`) throws `CircleArcConfigError` at boot. Unset values remain allowed (provider defaults hold); an empty string throws (fail closed).
- 6.2: boot-guard tests in `tests/unit/circle-arc-provider.test.ts` (new describe): `WDK_NETWORK=sepolia` → `CircleArcConfigError` naming `WDK_NETWORK=arc-testnet`; `WDK_TOKEN=USDT` → naming `WDK_TOKEN=USDC`; matching pair → `circle-arc`/`live` provider built. Suite: 31 tests green.
- 6.3: `.env.example` circle-arc section finalized — credential provenance (Circle Console → Developer Control), 64-hex entity-secret note, secret-hygiene guidance (production-grade secret, never logged/never sent to client), `WDK_NETWORK=arc-testnet` + `WDK_TOKEN=USDC`, trust model (Circle holds keys server-side, device never signs, Arc TESTNET only, chain id 5042002), and the policy vars block re-labeled "Required in live or circle-arc mode" (fail closed → `policy_rejected`).
- 6.4: compose verification — `grep -E 'WDK_|SEPOLIA|CIRCLE|ARC' compose.yaml` → no matches (exit 1); `docker compose config` → valid. NO compose change required; `.env` interpolation alone drives circle-arc. Recorded in the runbook note.
- 6.5: Arc sections added to BOTH parent-named runbooks. Note: `docs/local-docker-runbook.md` does not exist on this branch; the wallet runbook on `arc-migration` is `docs/local-live-runbook.md` (the file tasks.md named) — the full Arc section (env setup, trust model, testnet-only boundary, `/health` provider field, docs/api.md-untouched note, compose note, and the 6-step consent-first Manual E2E for 7.4) went there, plus a condensed Arc section (selection, `CIRCLE_*` envs, testnet-only, real-USDC consent warning, `/health` field note) in `docs/livekit-development-runbook.md`. `docs/api.md` untouched (no `/v1` change; `/health` is not a `/v1` route).
- 7.1: root gates green — `npm run lint` exit 0; `npm run typecheck` exit 0; full `npm test` → 71 files passed, 8 skipped; 423 passed, 17 skipped. No regression on fixture/live/WDK paths.
- 7.2: frontend suite as-is (installed `apps/nana-wallet` deps in the worktree first — `node_modules` was absent): `npm run typecheck` exit 0; `npm test` → 12 files / 42 tests passed. No frontend source change; no `/v1` shape changed.
- 7.3: new `tests/integration/fake-circle-transfers.test.ts` (3 tests) — typed conversation flow (previewTransfer → resolveDecision confirm → runFinancialTransfer) with a real `CircleArcProvider` over an injected fake Circle client + fake Arc RPC + an in-memory repository, virtual instant clock, no network: (a) happy path → `sent` with the Arcscan explorer URL, `progress.phase: completed`, and `createTransaction` receiving `idempotencyKey`/`refId` = persisted `previewId` (CAR-006 via `toTransferRequest`); (b) Circle API failure mid-broadcast → `broadcast_uncertain`, session blocked (`phase: uncertain`, `transferResolutionState: uncertain`), retry → `broadcast_uncertain` with NO second `createTransaction` (CAR-007); (c) `0x0` receipt → `transfer_reverted` with `phase: failed` (CAR-008/009).

### Files changed (this run)

- `src/runtime/dependencies.ts` — D8 boot guard (imports `ARC_TESTNET_NETWORK` + `CircleArcConfigError`).
- `.env.example` — finalized circle-arc section + policy-vars comment.
- `docs/local-live-runbook.md`, `docs/livekit-development-runbook.md` — Arc Testnet sections (+ Manual E2E steps in the former).
- Tests: `tests/unit/circle-arc-provider.test.ts` (+boot-guard describe), `tests/integration/fake-circle-transfers.test.ts` (new), `tests/integration/api-health.test.ts` and `tests/integration/api-wallet.test.ts` (hermeticity hardening, see deviations).
- `compose.yaml`, `src/wallet/circle-arc-provider.ts`, `docs/api.md`, `apps/nana-wallet` — no change (asserted).

### Verification evidence (exact commands, in the worktree `/Users/ramiro/Desktop/projects/personales/aleph-hackathon.arc-migration`)

| Command | Result |
| --- | --- |
| `npx vitest run tests/unit/circle-arc-provider.test.ts` | 31 passed |
| `npx vitest run tests/integration/fake-circle-transfers.test.ts` | 3 passed |
| `npm run lint` (`eslint src tests --max-warnings=0`) | exit 0 |
| `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | exit 0 |
| `npm test` (full Vitest suite) | 71 files passed, 8 skipped; 423 passed, 17 skipped — no regression on fixture/live/WDK paths |
| `npm --prefix apps/nana-wallet run typecheck` | exit 0 |
| `npm --prefix apps/nana-wallet test` | 12 files / 42 tests passed |
| `docker compose config` | valid |

Standard Mode (strict_tdd: false per tasks.md): tests written alongside each change.

### Deviations from design

- Runbook file: parent slice named `docs/local-docker-runbook.md`; that file does not exist on `arc-migration` — used `docs/local-live-runbook.md` (tasks.md's name) plus `docs/livekit-development-runbook.md`. Flag to the parent if a docker runbook was intended elsewhere.
- Worktree `.env` (untracked, never committed): it carried `WDK_TOOLS_SOURCE=circle-arc` + `WDK_NETWORK=sepolia`/`WDK_TOKEN=USDT` — exactly the misconfiguration D8 now rejects at boot. The first full-suite run failed 9 tests with `CircleArcConfigError` (the guard working as designed). Fixed the two non-secret lines in place to `WDK_NETWORK=arc-testnet` / `WDK_TOKEN=USDC` (the 3 `CIRCLE_*` secrets were not read or printed). Without this, a real `npm run dev` in the worktree would fail boot by design.
- `tests/integration/api-wallet.test.ts` + `api-health.test.ts` hermeticity hardening: these fixture-mode suites pinned `WDK_TOOLS_SOURCE` at module top level, but the pin ran AFTER the `import { buildServer }` chain — during which dotenv loads the ambient `.env` and `src/api/wallet.ts` freezes `NETWORK = process.env.WDK_NETWORK` at module import. With the corrected `.env` the address test deterministically read `arc-testnet`. Moved the pins into `vi.hoisted(...)` so they execute before the import (behavior for a given env unchanged; source untouched — the lazy-read refactor of `src/api/wallet.ts` matches the existing `src/api/health.ts` pattern but is OUTSIDE this slice's allowed edit surfaces, left as a follow-up suggestion for the parent).

### Remaining tasks (unchecked)

- `- [ ] 7.4 Manual E2E runbook execution (real CIRCLE_* creds, real testnet USDC, explicit user consent) ...` — intentionally left UNCHECKED for the user; the numbered steps are documented in `docs/local-live-runbook.md` → "Arc Testnet (Circle developer-controlled wallet)" → "Manual E2E".
- `- [ ] Start or reuse a bounded review of the candidate after the apply phase completes ...` (`<!-- sdd-owner: parent -->`) — parent-owned deferred lifecycle action.

### Workload / PR boundary

- PR C of 3 stacked PRs (parent-resolved delivery path). Diff vs PR B commit (2a6c5e1): src +1 file/+18 lines, `.env.example`/docs +~130 lines, tests +~380 lines — the mandated fake-Circle integration suite and boot-guard/health hermeticity tests dominate; no test dropped to fit a budget.

### Notes

- Artifact store for this change remains the openspec files in the worktree (Engram was unreachable in earlier runs; not retried here).
- No git commit performed (parent owns commits).

## Batch 2 = PR B (previous run)

Scope: PR B of 3 stacked PRs — tasks 4.2, 4.3 (completion of batch 4), and batch 5 (health contract, D5) + D6 explorer URL. Batches 6–7 (PR C) untouched.

### Completed tasks (all checked off in tasks.md)

- 4.2: `normalizeBroadcastResult` now uses `explorerUrlFor(network, hash)` (arc-testnet → `https://testnet.arcscan.app/tx/`, sepolia → etherscan; `src/wdk` provider URL untouched, CAR-015).
- 4.3: (a) explorer tests for arc-testnet/sepolia in `wallet-agent-definition.test.ts`; (b) waiter-selection matrix — provider-present reverted → `transfer_reverted` and throw → `transaction_receipt_invalid` were already pinned by PR A's seam tests; this run added the provider-absent legacy path (fixture-mode confirm via `defaultTransactionReceiptWaiter`'s immediate outcome, zero provider calls) and the precedence test (injected `transactionReceiptWaiter` wins over `walletProvider.waitForFinality`, which must never run in parallel).
- 5.1: `healthResponseSchema` gains additive optional `provider: { status: 'healthy'|'degraded'|'unavailable', reason? }`. Only `/v1`-adjacent change; no `/v1` request/response shape touched.
- 5.2: `/health` route calls `dependencies.wallet.health({ wallet: WALLET(), network: NETWORK() })` and includes the `provider` field; legacy fields and lazy env reads unchanged. A throwing `health()` degrades to `{ status: 'unavailable', reason: 'The wallet provider health check failed.' }` — the raw error is intentionally NOT echoed (SDK errors can interpolate config; CAR-017).
- 5.3: new `tests/unit/health-route.test.ts` (5 tests): healthy no-reason, unavailable with scrubbed reason + legacy fields intact, credential-scrub assertion (CAR-017), throw-degradation, and fixture-mode parity (`mode:'fixture'`, `network:'sepolia'`). Circle-arc env → `mode:'live'`, `network:'arc-testnet'` asserted in the healthy/unavailable cases.
- 5.4: frontend mirror VERIFIED — `apps/nana-wallet/src/lib/api-types.ts` (250 lines) contains only `/v1` domain types; grep found zero `health` references anywhere in `apps/nana-wallet/src/`. No source change needed; additive optional field is a consumer no-op.

### Files changed (this run)

- `src/agent/definition.ts` — `normalizeBroadcastResult` → `explorerUrlFor` (import added from `../wallet/provider.js`).
- `src/contracts/http.ts` — `healthResponseSchema` additive optional `provider` object.
- `src/api/health.ts` — route calls provider `health()` and includes the field; new private `providerHealth()` helper with fail-closed throw mapping.
- Tests: `tests/unit/health-route.test.ts` (new), `tests/unit/wallet-agent-definition.test.ts` (+2 explorer tests), `tests/unit/wallet-agent-confirm-seam.test.ts` (+2 waiter-selection tests in a new describe).
- `apps/nana-wallet`: no change (5.4 verified, nothing to mirror).

### Verification evidence (exact commands, in the worktree `/Users/ramiro/Desktop/projects/personales/aleph-hackathon.arc-migration`)

| Command | Result |
| --- | --- |
| `npm run lint` (`eslint src tests --max-warnings=0`) | exit 0 |
| `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | exit 0 |
| `npx vitest run tests/unit/health-route.test.ts tests/unit/wallet-agent-definition.test.ts tests/unit/wallet-agent-confirm-seam.test.ts tests/integration/api-health.test.ts` | 4 files / 32 tests passed |
| `npm test` (full Vitest suite) | 70 files passed, 8 skipped; 417 passed, 17 skipped — no regression on fixture/live/WDK paths |

Standard Mode (strict_tdd: false per tasks.md): tests written alongside each change.

### Deviations from design

- None material. 4.1 (PR A) + this run complete batch 4 as sliced by the parent. The route-level health-throw mapping (generic reason instead of raw error) is a stricter-than-design safety choice aligned with D5's CAR-017 requirement.

### Remaining tasks (unchecked)

- Batch 6 (6.1–6.5: D8 boot guard, `.env.example`, compose check, runbook docs) and Batch 7 (7.1–7.4: root gates already green this run, frontend suite, fake-Circle integration test, manual E2E — 7.4 intentionally unchecked for the user) — PR C.
- Post-Apply Review (`<!-- sdd-owner: parent -->`) — parent-owned deferred lifecycle action.

### Workload / PR boundary

- PR B of 3 stacked PRs (parent-resolved delivery path: 3 stacked, size:ok ≤400 lines).
- Diff vs PR A commit (d360a91): 5 files, +130/−3 lines — well inside budget.

### Notes

- Engram unreachable (`127.0.0.1:7437` down) in the PR A run; artifact store for this change remains the openspec files in the worktree. This file is cumulative: Batch 1 section (PR A) below is preserved unchanged.
- No git commit performed (parent owns commits).

## Batch 1 = PR A (previous run)

Scope: design batches 1–3 (tasks batches 1, 2, 3) + the D3/D7 confirm-path seam. PR B/C (batches 4–6, fake-Circle integration) untouched.

### Completed tasks (all checked off in tasks.md)

- Batch 1: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6
- Batch 2: 2.1, 2.2, 2.3, 2.4, 2.5, 2.6
- Batch 3: 3.1, 3.2, 3.3, 3.4
- Batch 4 (partial, per explicit parent slice): 4.1 (waiter selection in `executeConfirmedTransfer`) — the parent slice instruction required it; `src/wdk/transaction-receipt.ts` left byte-identical as mandated.

### Files changed

- `src/wallet/circle-arc-provider.ts` — `waitForFinality` hardened: single `eth_chainId` pre-check (parse failure or mismatch → immediate throw naming `arc-testnet` chain id; NOT swallowed into keep-polling), receipt-hash echo validation (case-insensitive; mismatch → `Arc RPC returned a receipt for a different transaction.`), transient receipt-read errors keep polling to the 120 s deadline then throw. Dropped the unused `eth_getTransactionByHash` leg of the poll. Idempotency (`previewId ?? randomUUID()`), 20 s/120 s deadlines, `uncertain`-on-timeout, empty ledger, `assertNetwork`, recipient/burn/self guards all preserved.
- `src/agent/definition.ts` — exported `SendTokenBroadcastInput = SendTokenInput & { previewId?: string }` (zod schema unchanged, model never sees `previewId`); `sendToken` copies a present `previewId` into the outgoing `TransferRequest`; exported `isLiveTransferSource(environment = process.env)` (`live` || `circle-arc`); `validateWalletTransferPolicy` gates on it.
- `src/agent/wallet-agent.ts` — `validateLiveTransferPolicy` gates on the shared `isLiveTransferSource`; `buildGuardedTools.guardedSendToken` injects `session.pendingTransfer.previewId` into the broadcast call input only when `dryRun:false`, `pendingMatches`, and a `previewId` exists (legacy WDK in-memory pending has none → WDK path byte-identical, CAR-015); confirm branch of `handleMessage` builds definition tools via `createWalletAgentDefinition()` + `toAiSdkTools` with `options.walletProvider` and only falls back to `getWdkTools()` without a provider; `executeConfirmedTransfer` widened with `walletProvider?`, selects the waiter (explicit injected waiter > `walletProvider.waitForFinality` > `defaultTransactionReceiptWaiter`), and its receipt/reverted messages are network-parameterized (`The ${pending.network} receipt ...`, `The transfer reverted on ${pending.network}.`); waiter exceptions surface their reason (`...could not be verified: <error.message>`).
- `src/conversations/service.ts` — `toTransferRequest` forwards `transfer.previewId` (conditional spread).
- Tests: extended `tests/unit/circle-arc-provider.test.ts` (fixture now returns echoing receipts + captures `createTransaction` inputs; new chain-id fail-closed, echo-mismatch, case-insensitive echo, transient-keep-polling, idempotency key/refId reuse vs last-resort key, testnet-only broadcast rejection tests); extended `tests/unit/wallet-agent-policy.test.ts` and `tests/unit/wallet-agent-definition.test.ts` with circle-arc parity matrices for BOTH gates (missing vars, over-limit, non-allowlisted/burn/malformed recipients, wallet/network/token mismatch, matching passes); new `tests/unit/wallet-agent-confirm-seam.test.ts` (duplicate confirm → `broadcast_in_progress`, uncertain retry → `broadcast_uncertain` with no second broadcast, missing preview → `no_pending_preview`, previewId preserved end-to-end through the provider seam, reverted → `transfer_reverted` naming the network, verification throw → `transaction_receipt_invalid` with reason); new `tests/unit/conversation-preview-id.test.ts` (typed `resolveDecision` confirm carries the persisted `previewId` from the claimed transfer through `toTransferRequest` into the broadcast request).

### Verification evidence (exact commands, in the worktree `/Users/ramiro/Desktop/projects/personales/aleph-hackathon.arc-migration`)

| Command | Result |
| --- | --- |
| `npm run typecheck` | exit 0 |
| `npm run lint` (`eslint src tests --max-warnings=0`) | exit 0 |
| `npx vitest run tests/unit/circle-arc-provider.test.ts tests/unit/wallet-agent-policy.test.ts tests/unit/wallet-agent-definition.test.ts tests/unit/wallet-agent-confirm-seam.test.ts tests/unit/conversation-preview-id.test.ts` | 5 files / 83 tests passed |
| `npm test` (full Vitest suite) | 69 files passed, 8 skipped; 408 passed, 17 skipped — no regression on fixture/live/WDK paths |

Standard Mode (strict_tdd: false per tasks.md): tests written alongside each change; verification evidence above.

### Deviations from design

- 4.1 implemented in PR A (parent slice instruction) even though tasks.md schedules it for batch 4/PR B; its dedicated test matrix (4.3) is NOT done — PR B.
- The guarded previewId injection is conditional on `previewId` existing (design says inject `session.pendingTransfer.previewId` unconditionally); the conditional spread keeps the legacy WDK path byte-identical (CAR-015) while satisfying CAR-006.
- Removed the unused `eth_getTransactionByHash` call in the finality poll (it was fetched and never read).

### Remaining tasks (unchecked)

- 4.2 (`normalizeBroadcastResult` → `explorerUrlFor`), 4.3 (explorer/waiter-selection tests) — PR B.
- Batches 5 (health contract), 6 (boot guard, `.env.example`, compose, docs), 7 (root verification, frontend suite, fake-Circle integration, manual E2E — 7.4 intentionally unchecked for the user) — PR B/C.
- Post-Apply Review (`<!-- sdd-owner: parent -->`) — parent-owned deferred lifecycle action.

### Workload / PR boundary

- PR A of 3 stacked PRs; delivery path resolved by parent (3 stacked, size:ok ≤400 lines).
- Actual diff: ~175 changed lines in `src/` (well inside budget) + ~465 lines of required test extensions/new suites → total ~640 changed lines, above the 400-line target. All extra lines are mandated tests (1.3, 1.4, 1.5, 2.6, 3.4 + seam tests); no test was dropped to fit the budget. Flagging to the parent for the PR boundary decision.

### Notes

- Engram was unreachable during this run (`127.0.0.1:7437` down); the artifact store for this change is the openspec files in the worktree — this file and the tasks.md checkboxes are the persisted progress (first apply-progress; nothing to merge from a prior run).
- No git commit performed (parent owns commits).
