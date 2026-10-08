# Verification: circle-arc-runtime-integration

## Verdict

**PASS (with follow-ups).** The committed implementation satisfies requirements CAR-001..CAR-017 on the `circle-arc` live runtime. No CRITICAL defects found. Two WARNING-level follow-ups and one SUGGESTION are recorded below. Archive is **NOT ready** until the single remaining manual E2E box (7.4) is completed by a human and the parent-owned post-apply review runs.

- Worktree: `.arc-migration` branch `arc-migration`, HEAD `06b89b9` (commit `d360a91` PR A, `2a6c5e1` PR B, `06b89b9` PR C). `git status --porcelain` is **clean** — no uncommitted drift; verification ran against the exact committed state.
- Test runner / framework: Vitest. `strict_tdd: false` (Standard Mode) — confirmed in `openspec/config.yaml` and `tasks.md`; no RED/GREEN ceremony expected.

## Reference invocation

Commands run in `/Users/ramiro/Desktop/projects/personales/aleph-hackathon.arc-migration`:

| Command | Result |
| --- | --- |
| `npm run lint` (`eslint src tests --max-warnings=0`) | exit 0 |
| `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | exit 0 |
| `npm test` (Vitest, backend) | **71 files passed, 8 skipped; 423 passed, 17 skipped** |
| `npm --prefix apps/nana-wallet run typecheck` | exit 0 |
| `npm --prefix apps/nana-wallet test` | **12 files / 42 tests passed** |
| `docker compose config` | valid; `grep -nE 'WDK_\|SEPOLIA\|CIRCLE\|ARC' compose.yaml` → no matches (exit 1) |

No regression observed on the `fixture` / `live` / WDK paths. Frontend suite green with no source change (CAR-016).

## Spec coverage

### CAR-001 Provider selection by `WDK_TOOLS_SOURCE` — **PASS**

`createWalletProvider` returns `CircleArcProvider` for `WDK_TOOLS_SOURCE=circle-arc`; the provider's `id='circle-arc'` and `mode='live'`.
- `src/runtime/dependencies.ts:57` (circle-arc branch → `readCircleArcProviderConfig` + `new CircleArcProvider`).
- `src/wallet/circle-arc-provider.ts:68-69` (`id = 'circle-arc'`, `mode = 'live' as const`).
- `fixture`/`live` keep returning `FixtureWalletProvider`/`WdkWalletProvider` (`dependencies.ts:74-77`).
- Evidence: `tests/unit/circle-arc-provider.test.ts:112-124`, selection+no-fallback.

### CAR-002 Circle Arc config validation fails closed — **PASS**

`readCircleArcProviderConfig` throws `CircleArcConfigError` for a missing credential and for a non-64-hex entity secret. The read is invoked only from `createWalletProvider` (boot), never at module import.
- `src/wallet/circle-arc-provider.ts:65-78` (config read; `64 hex` regex at 74-77).
- No top-level config read → import without env does not throw (all provider tests import the module and pass).
- Evidence: `tests/unit/circle-arc-provider.test.ts:88-109`.

### CAR-003 No silent fallback under circle-arc — **PASS**

The circle-arc branch fails closed on bad config; `createCoreDependencies` routes `circle-arc` to the shared `walletReads` (`dependencies.ts:88-91`), so a missing config or a down Circle API produces explicit `CircleArcConfigError`, `wallet_unavailable`/`broadcast_uncertain`, or an unhealthy `/health` — never a switch to the WDK or fixture provider. `broadcastTransfer` maps SDK/transient errors to `uncertain` (never a fixture-style success) at `circle-arc-provider.ts:214-233`.

### CAR-004 Policy parity for circle-arc live transfers — **PASS**

A single shared predicate `isLiveTransferSource` (`live` OR `circle-arc`) gates **both** policy functions:
- `src/agent/definition.ts:95-97` (`isLiveTransferSource`); `validateWalletTransferPolicy` uses it at `definition.ts:100-118`.
- `src/agent/wallet-agent.ts:64` (`validateLiveTransferPolicy` uses it).

For circle-arc: missing `WDK_MAX_TRANSFER_AMOUNT`/`WDK_ALLOWED_RECIPIENTS` → fail closed; over-limit amount, non-allowlisted/burn/self recipient, and wallet/network/token mismatch → `policy_rejected`; matching transfer passes.
- The service path reuses the same `validateWalletTransferPolicy` via re-export (`src/wallet/agent-tools.ts:10`), so no gate can drift.
- Evidence: circle-arc parity matrices in `tests/unit/wallet-agent-policy.test.ts:184+` and `tests/unit/wallet-agent-definition.test.ts:82+`.

### CAR-005 `policy_rejected` taxonomy parity — **PASS**

Both gates return the `{ error: 'policy_rejected', message }` shape (`definition.ts:101,103...`; `wallet-agent.ts:53-60`). `policy_rejected` is a supported conversation error code (`src/conversations/service.ts` `sanitizeResult`), so frontend/conversation handling is mode-agnostic.

### CAR-006 Broadcast idempotency key derived from persisted `previewId` — **PASS**

`previewId` is transported end-to-end and is never model-generated:
- `SendTokenBroadcastInput = SendTokenInput & { previewId?: string }` in `definition.ts:44-49`; `sendToken` copies it into the `TransferRequest` at `definition.ts:171-176`.
- `sendTokenInputSchema` is unchanged — the model never sees `previewId` (`definition.ts:24-31`), so a hallucinated key cannot defeat duplicate protection.
- `buildGuardedTools.guardedSendToken` injects `session.pendingTransfer.previewId` into the broadcast input only when `dryRun:false` and a preview exists (`wallet-agent.ts:262-269`).
- `toTransferRequest` forwards `transfer.previewId` (`service.ts:300-307`).
- `broadcastTransfer` uses `request.previewId ?? randomUUID()` (`circle-arc-provider.ts:170`), so a confirmed preview never falls back to a fresh key; `randomUUID()` remains only the last-resort for a direct call.
- Evidence: `tests/unit/circle-arc-provider.test.ts:320+` (idempotency), `tests/unit/conversation-preview-id.test.ts:166+`, and `tests/integration/fake-circle-transfers.test.ts` (happy path asserts `idempotencyKey`/`refId` === persisted `previewId`).

### CAR-007 Duplicate confirm and retry fail closed — **PASS**

`claimPendingTransfer` returns `broadcasting`/`uncertain`/`missing`, mapping to `broadcast_in_progress`/`broadcast_uncertain`/`stale_preview` (`wallet-agent.ts:357-359`, `service.ts` resolveDecision claim branch). Retry after an uncertain outcome is blocked and does not re-broadcast.
- Evidence: `tests/unit/wallet-agent-confirm-seam.test.ts:115-149`, and fake-Circle test `blocks the session as broadcast_uncertain … never re-broadcasts on retry` (asserts exactly one `createTransaction`).

### CAR-008 Receipt verification uses a real Arc receipt — **PASS**

No fixture/immediate confirmation for circle-arc:
- Text path: `executeConfirmedTransfer` selects the waiter from the provider (`walletProvider.waitForFinality` when a provider is present) at `wallet-agent.ts:452-463`.
- Service path: `runFinancialTransfer` uses `dependencies.wallet.waitForFinality({ transaction })` at `service.ts`.
- `CircleArcProvider.waitForFinality` polls Arc's `eth_getTransactionReceipt`, chain-validates (`eth_chainId === 5042002`), validates the receipt echoes the requested hash, and interprets `0x1`→`confirmed`, `0x0`→`reverted` (`circle-arc-provider.ts:267-307`).
- `src/wdk/transaction-receipt.ts` is **byte-identical** (no `arc-testnet` branch) and is never selected for a circle-arc confirmation, so the fixture `immediateTransactionReceiptWaiter` cannot produce a fake success on that path.
- Evidence: `tests/integration/fake-circle-transfers.test.ts` (`0x0` → `transfer_reverted`), `tests/unit/wallet-agent-confirm-seam.test.ts:172-186`.

### CAR-009 Explicit uncertain state on verification failure — **PASS**

Provider failures map to explicit `transaction_receipt_invalid` (text) / `receipt_invalid` (service) and never clear a transfer as confirmed: chain-id parse failure/mismatch, receipt-hash echo mismatch, deadline timeout, and transient RPC failures all throw (never silent success) at `circle-arc-provider.ts:279-302`. Dispatch unknown → `broadcast_uncertain`.
- Evidence: `circle-arc-provider.test.ts:259-317`, `wallet-agent-confirm-seam.test.ts:185`, fake-Circle uncertain test.

### CAR-010 Network-aware explorer URL — **PASS**

`normalizeBroadcastResult` uses `explorerUrlFor(network, hash)` instead of a hardcoded Sepolia URL (`definition.ts:106`); `explorerUrlFor` maps `arc-testnet` → `https://testnet.arcscan.app/tx/` and `sepolia` → etherscan (`provider.ts:36-40`).
- Evidence: `tests/unit/wallet-agent-definition.test.ts:175-186` asserts both the arcscan and sepolia URLs.

### CAR-011 Honest empty transfer history — **PASS**

`getHistory` returns an explicit empty ledger `{ network: 'arc-testnet', transactions: [] }` (`circle-arc-provider.ts:175-178`), never fabricated entries. No narration or frontend code claims zero-spend or renders fabricated history (no history references exist in `apps/nana-wallet/src/`); the referential narration only tells a user to "check wallet history" in the uncertain state, which is guidance, not a spend claim.
- Real Arc history remains a documented follow-up (out of scope).
- Evidence: `circle-arc-provider.test.ts:176-180`.

### CAR-012 Health contract exposes provider status — **PASS**

`GET /health` returns the additive optional `provider: { status, reason? }` and keeps `status`/`mode`/`mcp`/`wallet`/`network`. For circle-arc, `mode='live'` and `network='arc-testnet'` (`health.ts` `MODE()`/`NETWORK()`; `contracts/http.ts:5-15`).
- Evidence: `tests/unit/health-route.test.ts` (healthy, unavailable, fixture-parity cases).

### CAR-013 Voice and text share one provider seam — **PASS**

- Voice: `src/livekit/worker.ts:91-101` builds `createWalletConversationService({ wallet: dependencies.wallet })` and `createRealtimeTools({ wallet: dependencies.wallet })` from the same provider.
- Text: `handleMessage` receives `options.walletProvider` = `dependencies.wallet` (service.ts); the confirm branch builds definition tools from the provider via `createWalletAgentDefinition()+toAiSdkTools` and only falls back to `getWdkTools()` when no provider is supplied (`wallet-agent.ts:363-375`).
- No alternate broadcast path bypasses the provider seam, policy gate, or confirmation cycle.

### CAR-014 Testnet-only boundary — **PASS**

Three layers: `assertNetwork` throws for any non-`arc-testnet` source/transfer (`circle-arc-provider.ts:344-348`); the D8 boot guard throws `CircleArcConfigError` for a set-but-mismatched `WDK_NETWORK`/`WDK_TOKEN` (`dependencies.ts:60-71`); `listNetworks` → only `{arc-testnet,testnet}` and `listTokens` → only `{arc-testnet, USDC, 18}`; `eth_chainId === 5042002` pre-check on finality.
- Evidence: `circle-arc-provider.test.ts:365-380` (testnet-only describe), `dependencies.ts` boot-guard describe at `circle-arc-provider.test.ts:125-152`.

### CAR-015 WDK stays intact and selectable — **PASS**

No WDK-path source file was modified across PRs A/B/C: `git show --stat` for all three commits lists no `src/wdk/*` or `src/wallet/wdk-provider.ts` edit. `fixture`/`live` selection is unchanged (`dependencies.ts:74-77`). The guarded `previewId` injection is conditional on a preview existing, so the legacy WDK in-memory pending (no `previewId`) stays byte-identical. Rollback is configuration-only.

### CAR-016 Front/back HTTP contract unchanged — **PASS**

The only `src/contracts/http.ts` change across all PRs is the additive optional `provider` object on `healthResponseSchema` (PR B `2a6c5e1`). No `/v1` request/response shape changed. `apps/nana-wallet/src/lib/api-types.ts` contains no health type to mirror (no `health` references anywhere in `apps/nana-wallet/src/`), and the additive-optional field is a consumer no-op (unknown JSON fields are ignored).
- Evidence: `tests/unit/health-route.test.ts` fixture-parity test; frontend typecheck+suite green.

### CAR-017 Circle credentials are never exposed — **PASS (one WARNING)**

- `readCircleArcProviderConfig` validates shape only and never logs (`circle-arc-provider.ts:65-78`).
- `.env.example:18-45` and both runbook docs state the trust model (Circle holds wallet keys server-side; backend holds the entity secret; device never signs), the testnet-only boundary, and the never-logged/never-sent constraint.
- The `/health` route maps a **throwing** provider health check to a scrubbed generic reason (`health.ts:24-29`), and the health-route tests assert no API key, entity secret, or wallet id appears in the reason (including the throwing path).
- **WARNING:** `CircleArcProvider.health()` returns the raw `error.message` from the Circle SDK when `getAddress`/`getWallet` throws (the non-throwing `{ status: 'unavailable', reason: <sdkmessage> }` path at `circle-arc-provider.ts:82-87`). That reason is not scrubbed at the provider or route layer, and there is **no provider-level credential-scrub test** (the only scrub test mocks the provider). If an SDK error message interpolates a config value, it could reach `/health`. Low exploit-likelihood (Circle SDK messages are typically generic), but the design intent in D5 says raw errors must not echo config. **Recommendation:** have the provider return a generic reason (e.g. `'Circle wallet is unavailable.'`) instead of `error.message`, or add a provider-level scrub test.

## Task completion status

All implementation task boxes are checked. Exact unchecked `- [ ]` lines remaining:

- `- [ ] 7.4 Manual E2E runbook execution (real CIRCLE_* creds, real testnet USDC, explicit user consent) …` (`tasks.md:85`) — **intentionally UNCHECKED for the user** (pending human verification), as designed and as documented in `docs/local-live-runbook.md → "Arc Testnet (Circle developer-controlled wallet) → Manual E2E"`. This is the sole remaining scope item; archive is **not ready** until a human executes it against real Arc testnet USDC.
- `- [ ] Start or reuse a bounded review … (<!-- sdd-owner: parent -->)` (`tasks.md:89`) — **parent-owned** deferred lifecycle action, not an implementation task.

No implementation task remains that is within the executor's/owner's actionable scope.

## Structured status and action context findings

- **Active change:** `circle-arc-runtime-integration`; **phase:** verify; **mode:** SDD verify (read-only), no source edits performed.
- **Artifact store:** OpenSpec files under `openspec/changes/circle-arc-runtime-integration/` (worktree). Native `gentle-ai sdd-status` was not invoked (blind to this worktree path; Engram was unreachable in prior runs per apply-progress). Status was derived from the openspec artifacts directly.
- **Workspace authority:** verification ran in the dedicated worktree `.arc-migration` (`arc-migration` branch), matching the commits under review; no source edits were made. Only `openspec/changes/circle-arc-runtime-integration/verify-report.md` was written.
- **Review workload forecast:** 3 stacked PRs (PR A/B/C) under `size:ok`; `delivery_strategy: ask-on-risk`; `chain_strategy` resolved by parent as stacked. Each PR stayed bounded (A ~175 src lines + mandated tests; B 5 files +130/−3; C src +1 file, docs/.env +~130, tests +~380). No scope creep beyond the assigned slice; no test dropped to fit a budget.
- **Non-standard files:** `.env.example` section finalized; `docs/local-live-runbook.md` and `docs/livekit-development-runbook.md` gained Arc sections; `compose.yaml` and `docs/api.md` untouched (no `/v1` change).

## Follow-ups and observations

- **WARNING — `src/api/wallet.ts` freezes `NETWORK`/`WALLET` at module import** (`const NETWORK = process.env.WDK_NETWORK ?? 'sepolia'`, `wallet.ts:17-18`). This is the follow-up flagged by apply. In circle-arc mode, if the module is ever evaluated before `import "dotenv/config"` (hermetic/test contexts, or a non-`server.ts` entry), `NETWORK` defaults to `'sepolia'` and `CircleArcProvider.assertNetwork('sepolia')` throws for `/v1/wallet/*`. In the canonical `server.ts` boot, `import "dotenv/config"` is the first statement, so production boot is correct. The D8 boot guard in `createWalletProvider` already validates at dependency-build time. **Assessment: robustness follow-up, not a blocker** — the `lazy-read` pattern already used by `src/api/health.ts` (`NETWORK = () => process.env.WDK_NETWORK ?? 'sepolia'`) would fix it; defer to the parent as outside this slice's edit surfaces.
- **WARNING — provider-level health-reason credential scrub gap** (see CAR-017). Recommend scrubbing the provider's `health()` reason or adding a provider-level scrub test.
- **SUGGESTION — D8 boot guard allows an *unset* `WDK_TOKEN` under circle-arc** (only a *set-but-mismatched* value throws). When unset, `getWalletAgentConfig` defaults `token` to `'USDT'`, which is inconsistent with the provider's hardcoded USDC and could surface as a policy-token-mismatch on the guard. `.env.example` documents `WDK_TOKEN=USDC` as required for circle-arc; recommend normalizing an unset value to `USDC` (or rejecting it) in the circle-arc branch to keep the configured token consistent. Low severity; documented requirement mitigates real-world exposure.

## Boundaries / exclusions

- **Out of scope (confirmed untouched):** device passkey signing (stage 3), WDK removal (stage 5), real Arc history, mainnet. The `@tetherto/*` and WDK MCP path is selectable and intact.
- **7.4 manual E2E** with real `CIRCLE_*` credentials is the only remaining verification gap and is deferred to the user by design; it is not treated as a code failure.