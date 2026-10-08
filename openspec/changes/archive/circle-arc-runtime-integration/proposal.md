# Proposal: Circle Arc Testnet Runtime for Nana's Financial Flow

## Intent and Outcome

Run Nana's financial runtime (voice, text, and frontend) on **Circle developer-controlled wallets over Arc Testnet with USDC**, through the existing `WalletProvider` seam, as the first runtime increment of the arc-migration roadmap. After this change, selecting `WDK_TOOLS_SOURCE=circle-arc` makes every financial path — balance reads, preview → explicit confirmation → broadcast → on-chain verification, health, and progress narration — operate against Circle's API and the Arc testnet RPC, with the same safety taxonomy the WDK path has today (policy limits, allowlist, idempotency, uncertain-state handling). The WDK/MCP path stays intact and selectable; WDK removal is a separate later work unit.

This change is a **pragmatic bridge of roadmap stages 1 + 2 + 4** (provider integration behind the provider seam; no per-device passkey signing; no WDK deletion). Stage 3 (device passkey signing) and stage 5 (WDK removal) are explicit follow-ups.

## Why

The hackathon demo must show real balances and real transfers on Arc Testnet with USDC, not Sepolia/USDT via WDK MCP. A `CircleArcProvider` was rescued from a lost worktree (`feat/circle-arc-provider` branch, rescued WIP commit) and already implements the full `WalletProvider` interface (`health`, `listNetworks`, `listTokens`, `getAddress`, `getBalance`, `getHistory`, `previewTransfer`, `broadcastTransfer`, `waitForFinality`, `close`) against Circle's developer-controlled-wallets API and Arc testnet, with unit tests (`tests/unit/circle-arc-provider.test.ts`). However, the rescued wiring has concrete safety and verification gaps that make it **unsafe to enable today**: the live-transfer policy gate ignores the `circle-arc` source (transfers would bypass max-amount/allowlist checks), the text confirmation path returns an immediate fixture-style receipt for `circle-arc` (no on-chain verification), broadcast idempotency keys fall back to `randomUUID()` because the service drops `previewId` when converting a pending transfer to a `TransferRequest`, and the Sepolia explorer URL is hardcoded in broadcast result normalization. Enabling Circle Arc is therefore a wiring-plus-hardening change, not just an env switch.

## Scope

### In Scope

- **Provider selection** (following the existing seam pattern): `WDK_TOOLS_SOURCE=circle-arc` selects `CircleArcProvider` in `createWalletProvider` (`src/runtime/dependencies.ts`); `fixture` and `live` (WDK MCP) keep their current behavior, with **no silent fallback to WDK** under the `circle-arc` value. The provider's own config comes from `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` (64-hex), `CIRCLE_SENDER_WALLET_ID` (read by `readCircleArcProviderConfig`, failing closed), plus the existing shared runtime selectors (`WDK_NETWORK=arc-testnet`, `WDK_TOKEN=USDC`, `WDK_WALLET_NAME=<sender wallet uuid>`). The `WDK_*` prefix is an accepted bridge wart; renaming these variables belongs to the stage-5 WDK-removal follow-up.
- **Policy parity (hardening, mandatory)**: extend the live-transfer policy gate (`validateWalletTransferPolicy` in `src/agent/definition.ts`, and the equivalent legacy gate in `src/agent/wallet-agent.ts`) so `WDK_TOOLS_SOURCE=circle-arc` enforces the same invariants as `live`: `WDK_MAX_TRANSFER_AMOUNT` (positive decimal, amount ≤ max), `WDK_ALLOWED_RECIPIENTS` (valid non-burn EVM allowlist), and exact wallet/network/token match with the configured runtime. A circle-arc configuration without policy vars MUST reject live transfers, not silently allow them.
- **Idempotency end-to-end**: forward `previewId` through `TransferRequest` (including `toTransferRequest` in `src/conversations/service.ts` and the voice preview path) so `CircleArcProvider.broadcastTransfer` reuses the confirmed preview's idempotency key; a retry after an uncertain outcome must not double-broadcast. `randomUUID()` remains only the last-resort fallback for direct calls without a preview.
- **On-chain verification parity**: wire `circle-arc` into receipt/finality verification — the text confirmation path (`defaultTransactionReceiptWaiter` / `executeConfirmedTransfer` in `src/wallet-agent.ts`) and the service path must both end in a real `waitForFinality` (Arc RPC `eth_getTransactionReceipt`, chain-validated) instead of the immediate fixture confirmation. `network: 'arc-testnet'` receipts must be verifiable, not auto-confirmed.
- **Explorer URL correctness**: `normalizeBroadcastResult` must use `explorerUrlFor(network, hash)` (`src/wallet/provider.ts`) instead of the hardcoded Sepolia etherscan URL, so the Confirm/Cancel card and transaction results link to `testnet.arcscan.app`.
- **Health report exposure**: surface `CircleArcProvider.health()` in `GET /health` for the circle-arc mode (report Circle API + Arc RPC reachability and the failing reason), keeping the existing `mode`/`mcp`/`wallet`/`network` contract semantics (`mode: 'live'`, `network: 'arc-testnet'`).
- **Honest empty history**: keep `getHistory` returning an explicitly empty ledger (no fabricated entries) for this increment, and ensure the frontend/narration treats an empty Arc history as "no history available on this network yet" — never as bank data or zero-spend claims. Real transfer history (Arc explorer/`) is a follow-up.
- **Error taxonomy parity**: preserve the `BroadcastOutcome` mapping (`submitted` / `uncertain` / `not_dispatched`) into conversation error codes (`transfer confirmed` / `broadcast_uncertain` / `wallet_unavailable`) and the `FinalityOutcome` statuses (`confirmed` / `reverted` / `receipt_invalid`), including "do not re-broadcast" messaging for Circle-accepted-but-hashless timeouts.
- **Trust model documentation and guards**: `.env.example` circle-arc section and repo docs state the model: Circle holds the wallet keys server-side under the developer entity; the Nana backend holds the entity secret as a production-grade secret (never logged, never sent to the client); the user's device never signs; **Arc TESTNET only** — the provider hardcodes `arc-testnet` as its only network and the demo boundary stays testnet-only.
- **Baseline evidence**: the work starts from `main` at `401ccf3` plus the rescued WIP commit on `feat/circle-arc-provider` (provider + wiring + `tests/unit/circle-arc-provider.test.ts`); lint, typecheck, and the 369-test suite are green on that baseline and must remain green.

### Out of Scope / Non-goals

- **Device passkey signing** (roadmap stage 3): the Circle wallet remains a developer-controlled (server-side) wallet; no frontend key ceremony, no UserOperation/passkey flow, no account-association work.
- **WDK removal** (roadmap stage 5): `@tetherto/*` dependencies, the WDK MCP client, `WdkWalletProvider`, legacy tools, and Sepolia/USDT references stay untouched and selectable.
- **Family recovery rules, ENS, Ledger, bridges, multisig** (post-replacement backlog).
- **Real transfer history** on Arc (stage-4 refinement after the bridge is verified).
- **Mainnet**, gas sponsorship/paymaster work, token swaps, or any non-USDC asset.
- **Frontend rewrites**: the web app is data-driven over the HTTP contract (`network`/`token`/`explorerUrl` come from the backend); only honest-empty-state handling and, if needed, test fixture updates are in scope. No HTTP contract shape changes (no new `/v1` endpoints).
- Renaming `WDK_*` environment variables (deferred to stage 5).

## Business Rules and Constraints

- **Testnet-only invariant**: the provider MUST only operate on `arc-testnet` (`chainId 5042002`, hardcoded USDC token address `0x3600…0000` verified on-chain in `docs/arc-mini-demo.md`); any other requested network is rejected. No configuration can point the Circle path at mainnet in this change.
- **Preview + explicit confirmation unchanged**: a broadcast may only execute when it matches a pending, confirmed preview in the session (`confirmation_required` guard, recipient revalidation against versioned recipient memory, and the financial-task claim to serialize concurrent confirms). Voice and text use the same authorization cycle.
- **Policy limits mandatory in live circle-arc mode**: max transfer amount and recipient allowlist MUST be configured and enforced; missing policy config fails the transfer (fail closed), mirroring the `live` WDK behavior.
- **Idempotency**: the broadcast idempotency key MUST derive from the confirmed preview's `previewId`; Circle's idempotency key plus the `not_dispatched`/`uncertain` taxonomy must prevent duplicate spending on retries, double clicks, or restarts. An uncertain outcome blocks further transfers in the session until resolved (`broadcast_uncertain`).
- **Fee policy**: estimated fee comes from Circle's `estimateTransferFee` with concrete evidence; fees above the `0.1` USDC cap are rejected before broadcast; a preview without usable fee evidence is rejected.
- **Recipient safety**: EVM address validation, zero/burn address rejection, and self-transfer refusal are enforced by the provider AND the policy gate; named recipients must resolve through versioned recipient memory (address equality revalidated at broadcast time).
- **Secret handling**: `CIRCLE_ENTITY_SECRET` is 64-hex, validated at config read, and treated as a production-grade secret — never logged, never echoed in health/errors, never sent to the frontend.
- **No fabricated data**: balances come from the Arc RPC (`eth_getBalance`; Arc's native gas asset is USDC with 18 decimals — the balance read is the wallet's native balance presented as USDC, per the verified demo), history is an explicit empty ledger, and narration never claims "sent" before on-chain confirmation.
- **No silent fallback**: with `WDK_TOOLS_SOURCE=circle-arc`, missing Circle config or a down Circle API produces explicit failures (`wallet_unavailable`, unhealthy health report) — never a silent switch to WDK or fixture.

## Capabilities

### New Capabilities

- `circle-arc-runtime`: Circle developer-controlled wallet provider on Arc Testnet USDC as a selectable live wallet runtime (`WDK_TOOLS_SOURCE=circle-arc`), with policy parity, idempotent broadcast, Arc-based finality verification, and health exposure.

### Modified Capabilities

- `wallet-provider` seam: `FinalityOutcome.network` widened from `'sepolia'` to network-specific values and `explorerUrlFor` extended to `arc-testnet` (already in the rescued WIP; finalized here).
- `financial-conversation` flow: unchanged behavior when `WDK_TOOLS_SOURCE` is `fixture` or `live`; only the circle-arc mode changes which provider executes reads/transfers. All existing error codes and frontend cards stay valid.

## Affected Areas

| Area | Impact | Description |
| --- | --- | --- |
| `src/wallet/circle-arc-provider.ts` | Already rescued, finalized here | Full `WalletProvider` implementation over Circle API + Arc RPC; provider-level policy-aligned guards (fee cap, recipient/sender checks), idempotency, polling deadlines, uncertain states |
| `src/wallet/provider.ts` | Modified (in WIP) | `FinalityOutcome.network: string`, `explorerUrlFor` with `arc-testnet` entry |
| `src/runtime/dependencies.ts` | Modified (in WIP) | `WDK_TOOLS_SOURCE=circle-arc` → `CircleArcProvider`; no fallback |
| `src/agent/definition.ts` + `src/agent/wallet-agent.ts` | Modified | Policy gate applies to `circle-arc`; `normalizeBroadcastResult` uses `explorerUrlFor`; confirmed-transfer path verifies via Arc (`waitForFinality`), not immediate fixture receipt |
| `src/conversations/service.ts` | Modified | `toTransferRequest` forwards `previewId` (idempotency); voice preview path unchanged otherwise |
| `src/api/health.ts` | Modified | `mode: 'live'` for circle-arc; surface provider `health()` status/reason; `network: 'arc-testnet'` |
| `src/wdk/transaction-receipt.ts` | Modified | `defaultTransactionReceiptWaiter` routes `arc-testnet` to real verification (or delegates to the provider's `waitForFinality`) |
| `tests/unit/circle-arc-provider.test.ts` + related suites | Extended | Provider unit tests (already in WIP) + policy-parity, idempotency (`previewId` reuse), receipt-verification, and health tests |
| `.env.example`, docs | Modified | Circle-arc envs documented; trust model and testnet-only boundary stated |
| Frontend (`apps/nana-wallet`) | Touch-only | Honest empty-state for Arc history; fixtures/tests updated if they hardcode Sepolia/USDT labels; no contract changes |

## Risks

| Risk | Mitigation |
| --- | --- |
| Policy gate left bypassed for circle-arc (the rescued WIP state) | Mandatory hardening item with a dedicated fail-closed test: circle-arc without `WDK_MAX_TRANSFER_AMOUNT`/`WDK_ALLOWED_RECIPIENTS` rejects every live transfer |
| Duplicate broadcast after uncertain outcome (idempotency key lost when `previewId` is dropped) | Forward `previewId` through the seam; test retries reuse the same Circle idempotency key and never re-broadcast after `uncertain` |
| Fake success from the immediate fixture receipt in the text confirm path | Route circle-arc confirmations through real Arc receipt verification; test that a reverted receipt surfaces `transfer_reverted`, never `sent` |
| Arc RPC / Circle API availability flapping mid-turn | Provider polling deadlines (20 s broadcast, 120 s finality) degrade to `uncertain`/health-unavailable with explicit user narration; no silent fixture confirmations |
| Native-balance-as-USDC assumption | Arc's native gas asset is USDC (18 decimals) — documented and verified against the on-chain demo; assert `listTokens`/balance consistency in tests |
| Balance shown but history empty confuses users | Honest empty-state copy ("no history available on this network yet"); real history is a tracked follow-up, not fabricated |
| Entity secret exposure | Secret never logged; config reader validates shape only; health/errors carry reasons without credentials |
| Bridge wart: `WDK_*`-prefixed vars configure Circle mode | Explicitly documented as accepted for this increment; renaming is stage-5 work, no behavior hidden behind it |

## Rollback Plan

Set `WDK_TOOLS_SOURCE` back to `fixture` (or `live` for the WDK MCP path) and restart: the WDK code paths are untouched and remain fully selectable, so runtime rollback is configuration-only. The Circle provider code and its tests are inert when not selected and can be reverted independently; no persisted data, SQL migrations, or HTTP contract shapes change, so no data rollback is needed.

## Success Criteria

- [ ] `WDK_TOOLS_SOURCE=circle-arc` with `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_SENDER_WALLET_ID` (and `WDK_NETWORK=arc-testnet`, `WDK_TOKEN=USDC`) boots the worker and API against Circle Arc with no WDK dependency at runtime and no silent fallback.
- [ ] Live-transfer policy is enforced for circle-arc: missing/invalid `WDK_MAX_TRANSFER_AMOUNT` or `WDK_ALLOWED_RECIPIENTS` rejects transfers with `policy_rejected`; over-limit amounts and non-allowlisted/burn/self recipients are refused (unit-tested, fail closed).
- [ ] Preview → explicit confirmation → broadcast → verified finality works over voice and text against Arc Testnet USDC: the confirmed broadcast reuses the preview's idempotency key, the explorer link points to `testnet.arcscan.app`, and a reverted/unverifiable receipt surfaces `transfer_reverted`/`transaction_receipt_invalid` — never a confirmed claim without a real Arc receipt.
- [ ] An uncertain broadcast (Circle accepted, no hash in time; or dispatch outcome unknown) blocks the session with `broadcast_uncertain` and never repeats the transfer.
- [ ] `GET /health` reports `mode: 'live'`, `network: 'arc-testnet'`, and reflects Circle API/Arc RPC reachability with a reason when unhealthy.
- [ ] History on Arc is an honest empty ledger surfaced as "no history available on this network yet"; balances are real Arc RPC values.
- [ ] Baseline preserved: lint, typecheck, and the full Vitest suite (369+ tests, including `tests/unit/circle-arc-provider.test.ts` extensions) are green on `feat/circle-arc-provider`.
- [ ] `.env.example` and docs state the trust model (server-side Circle keys under the developer entity, device never signs) and the testnet-only boundary.

## Proposal Questions for Review (assumptions to confirm)

These assumptions were needed to finalize scope; flag any that should change:

1. **Policy vars reuse**: reuse `WDK_MAX_TRANSFER_AMOUNT`/`WDK_ALLOWED_RECIPIENTS` as-is for circle-arc (instead of introducing `ARC_*` twins) — assumed YES, since the seam pattern reuses `WDK_TOOLS_SOURCE` too.
2. **History**: keep `getHistory` as an honest empty ledger in this increment (real Arc history becomes a follow-up) — assumed YES to keep the bridge small; alternative is to scope Arc explorer-derived history in now.
3. **Health contract**: extend `GET /health` with the provider's `health()` status/reason rather than adding a new endpoint — assumed YES (no `/v1` contract changes).
4. **Explorer URL in `normalizeBroadcastResult`**: switch to `explorerUrlFor` — assumed YES; if the frontend relies on etherscan links somewhere, that is a touch-only fix.
5. **Branch strategy**: continue on `feat/circle-arc-provider` from the rescued WIP commit rather than re-applying to a fresh branch — assumed YES.
