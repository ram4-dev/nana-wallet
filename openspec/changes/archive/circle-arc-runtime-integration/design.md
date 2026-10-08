# Design: Circle Arc Runtime Integration

## Technical Approach

Enable `WDK_TOOLS_SOURCE=circle-arc` as a fully safe live runtime on top of the rescued `CircleArcProvider` (branch `arc-migration`, worktree `.arc-migration`). The rescued WIP already implements the whole `WalletProvider` interface; this change is **wiring plus hardening**: two type/seam widenings (previewId transport, receipt-waiter selection), policy-gate parity, network-aware explorer URLs, an additive health field, and a fail-closed config guard. The WDK/MCP path stays byte-identical and selectable (CAR-015).

Guiding rule for every decision below: **one provider seam, no alternate paths**. Voice tools, text confirmation, and the typed conversation service all resolve the same `dependencies.wallet`; every live transfer passes the same policy gate; every confirmation ends in a real `waitForFinality` sourced from that provider.

## Architecture Decisions

| Decision | Choice and rationale | Alternatives considered |
| --- | --- | --- |
| **D1 — Config validation timing (CAR-002)** | **Eager, at `createWalletProvider`** (current rescued behavior, kept): `readCircleArcProviderConfig` throws `CircleArcConfigError` during dependency construction, so `WDK_TOOLS_SOURCE=circle-arc` with missing/invalid `CIRCLE_API_KEY`/`CIRCLE_ENTITY_SECRET`/`CIRCLE_SENDER_WALLET_ID` **fails process boot** (worker and API both build dependencies through the same seam). Rationale: the Circle SDK client is constructed with the entity secret inside the provider constructor — a lazily validated provider would have to exist without credentials, meaning health could never truthfully report a circle-arc mode it cannot build. Eager boot failure is the loudest fail-closed mode and matches the existing convention (`readWorkerProcessConfig` throws at boot). Import-time safety is already satisfied: the config read is only invoked from `createWalletProvider`, never at module scope. **Failure mode spelled out:** operator sets `circle-arc` without credentials → process exits at startup with `CircleArcConfigError: Circle Arc provider requires CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, and CIRCLE_SENDER_WALLET_ID.`; no fixture or WDK provider ever serves a request (CAR-003). Rollback is config-only (`fixture`/`live`). | Lazy per-request validation (the `voice_token_unavailable` pattern from `local-livekit-selfhost`): rejected — unlike the LiveKit token issuer, the wallet provider is a process-wide dependency required by every financial path, and a half-built provider would force a fake fallback object, contradicting CAR-003's "no silent fallback". |
| **D2 — `previewId` transport for CAR-006** | **No type change is needed; the gap is construction sites.** `TransferRequest = Omit<PendingTransfer, 'preview'>` already carries optional `previewId` (and `recipientId`/`recipientVersion`). Pin three construction fixes: (1) `toTransferRequest` in `src/conversations/service.ts` copies `previewId` from the claimed pending transfer (this is the typed-flow broadcast path); (2) `sendTokenInputSchema`/`SendTokenInput` stays **unchanged** (the model never sees or supplies `previewId` — no idempotency-key injection surface); instead `buildGuardedTools` in `src/agent/wallet-agent.ts` injects `previewId: session.pendingTransfer.previewId` into the broadcast call input **only** when `dryRun:false` and `pendingMatches(session, input)`; (3) `sendToken` in `src/agent/definition.ts` accepts an internal widened type `SendTokenBroadcastInput = SendTokenInput & { previewId?: string }` (cast at the tool call boundary) and copies a present `previewId` into the outgoing `TransferRequest`. The single injection point is the guarded wrapper: the confirm path (`executeConfirmedTransfer`) already routes through `tools.send_token`, so one injection covers both text and tool flows. `randomUUID()` remains the last-resort fallback inside `CircleArcProvider.broadcastTransfer` for direct calls without a preview, and unit tests assert a confirmed preview never takes that branch. | Widening `sendTokenInputSchema` with an optional `previewId`: rejected — it exposes the idempotency key to model input, and a hallucinated key would silently defeat duplicate-broadcast protection. |
| **D3 — Arc receipt verification source (CAR-008/009)** | **The provider's `waitForFinality` is the single Arc verification source.** `defaultTransactionReceiptWaiter` keeps its exact current behavior for the WDK path (`live` → Sepolia waiter, otherwise immediate fixture). The **waiter is selected at the call site**: `executeConfirmedTransfer` uses `options.walletProvider.waitForFinality` when `options.walletProvider` is present, else `defaultTransactionReceiptWaiter`. This is provider-agnostic and needs no Arc branch in `src/wdk/transaction-receipt.ts` (duplicating Arc polling there would create a second verification source that can drift from the provider's deadlines/taxonomy). The service path already calls `dependencies.wallet.waitForFinality`. **Hardening inside `CircleArcProvider.waitForFinality`** (uncertain, never silent success): (a) before polling, one `eth_chainId` call MUST return `5042002` (`0x4ce0d2`), else throw immediately (wrong chain can never confirm); (b) each `eth_getTransactionReceipt` result MUST echo the requested hash, else throw `receipt for a different transaction`; (c) `0x1` → `confirmed`, `0x0` → `reverted`; (d) missing receipt or transient RPC error → keep polling until the 120 s deadline, then throw — the throw maps at the call sites to `transaction_receipt_invalid` with the reason (text path `markTransactionReceiptInvalid`, service path `receipt_invalid` finalize). No path returns a fixture-style unconditional `confirmed`. | Standalone `waitForArcTransactionReceipt` in `transaction-receipt.ts` selected by an `arc-testnet` branch inside `defaultTransactionReceiptWaiter`: rejected as primary (second polling implementation, duplicated chain-id/hash validation, drift risk); also rejected to branch `defaultTransactionReceiptWaiter` on `WDK_TOOLS_SOURCE=circle-arc` — that re-couples the WDK module to the Circle mode and would still leave `executeConfirmedTransfer`'s fixture fallback reachable for provider-routed flows. Fixture parity is preserved instead because `FixtureWalletProvider.waitForFinality` already delegates to `immediateTransactionReceiptWaiter`. |
| **D4 — Policy-gate parity (CAR-004/005)** | A single shared source predicate makes both gates provider-agnostic: export `isLiveTransferSource(environment = process.env)` from `src/agent/definition.ts`, returning `true` for `WDK_TOOLS_SOURCE` of `live` **or** `circle-arc`. `validateWalletTransferPolicy` (definition.ts) and `validateLiveTransferPolicy` (wallet-agent.ts) replace their `!== 'live'` checks with `!isLiveTransferSource()`. Policy env vars (`WDK_MAX_TRANSFER_AMOUNT`, `WDK_ALLOWED_RECIPIENTS`) are reused as-is — no `ARC_*` twins. Both gates keep their existing invariants (positive decimal max, wallet/network/token exact match against the configured runtime, positive decimal amount ≤ max, valid non-burn EVM recipient in the allowlist); circle-arc without both policy vars rejects every live transfer with `policy_rejected` (fail closed). The two near-identical gate functions are knowingly kept (their messages and call sites differ and CAR-005 only demands taxonomy parity); a dedicated fail-closed test asserts **both** gates reject circle-arc without policy config so drift cannot reintroduce a bypass. | A `mode` parameter threaded into the gates: rejected — the gates already read the process env, and a parameter invites divergence between call sites. |
| **D5 — Health contract (CAR-012/016)** | **Additive optional field** on `healthResponseSchema`: `provider: z.object({ status: z.enum(['healthy','degraded','unavailable']), reason: z.string().optional() }).optional()`. The route always calls `dependencies.wallet.health({ wallet, network })` (provider-agnostic — works for fixture, WDK, circle-arc) and includes the result; the existing `status`/`mode`/`mcp`/`wallet`/`network` semantics are untouched (`MODE()` already maps `circle-arc` → `'live'`; `NETWORK()` reads `WDK_NETWORK=arc-testnet`). No new endpoint, no `/v1` shape change. **Frontend tolerance:** `apps/nana-wallet/src/lib/api-types.ts` has no health response type today (only `/v1` types), so nothing to mirror; the additive-optional shape means any consumer that later adds a type must mark `provider?` optional, and unknown JSON fields are ignored by existing consumers. Reason strings must never contain credentials — see Secret hygiene below; a unit test asserts an unhealthy reason carries no config values. | Surfacing health only via `mcp`/`wallet` enums: rejected — they cannot carry a reachability reason, which CAR-012 requires for an unhealthy Circle API/Arc RPC. |
| **D6 — Explorer URL (CAR-010)** | `normalizeBroadcastResult` (definition.ts) replaces the hardcoded `https://sepolia.etherscan.io/tx/${hash}` with `explorerUrlFor(network, hash)` from `src/wallet/provider.ts` (arc-testnet entry `https://testnet.arcscan.app/tx/` already exists in the rescued `EXPLORER_URLS`). Sepolia behavior unchanged. `WdkWalletProvider.broadcastTransfer`'s internal explorer URL is left untouched (WDK stays byte-identical, CAR-015). | Also fixing the WDK provider's URL: rejected for this increment — it is a WDK-path edit with zero circle-arc benefit. |
| **D7 — Single seam for voice + text (CAR-013)** | The one concrete break found: **the text confirm branch of `handleMessage` calls `await getWdkTools()` unconditionally** — under circle-arc a confirmed transfer would broadcast through the WDK MCP client against Sepolia/USDT, the exact fixture-style fake success the spec forbids. Fix: the confirm branch builds tools from `createWalletAgentDefinition()` via `toAiSdkTools` with `options.walletProvider` when present (same construction the non-confirm branch already uses), and falls back to `getWdkTools()` only when no provider is supplied (legacy WDK callers). `executeConfirmedTransfer` additionally receives the provider (for the D3 waiter selection) and its hardcoded "Sepolia" receipt messages become network-parameterized ("on {network}"). With this, voice (`createRealtimeTools` → `createWalletConversationService` → `dependencies.wallet`) and text (`handleMessage` with `options.walletProvider`) resolve the same `CircleArcProvider`, and `buildGuardedTools`' confirmation guard + D4 policy gate wrap every broadcast. **What breaks and must be fixed:** (a) confirm-branch `getWdkTools()`; (b) Sepolia literals in `executeConfirmedTransfer` messages; (c) missing `previewId` in the confirm-path broadcast (D2). The service path (`runFinancialTransfer`) already uses `dependencies.wallet` end-to-end and needs only the `toTransferRequest` previewId copy (D2). | Routing the confirm path through `getWdkTools()` for circle-arc "since WDK tools are still loaded": rejected — it is precisely the alternate broadcast path CAR-013 forbids. |
| **D8 — Testnet-only boundary (CAR-014)** | Three layers: (1) `assertNetwork` in the provider (already rescued) throws for any network other than `arc-testnet` — this is the request-level mainnet rejection; (2) **new config-shape guard** in `createWalletProvider`: when `WDK_TOOLS_SOURCE=circle-arc`, a set-but-mismatched `WDK_NETWORK` (must be `arc-testnet`) or `WDK_TOKEN` (must be `USDC`) throws `CircleArcConfigError` at boot — the health route derives `network` from `WDK_NETWORK`, so without this guard a misconfigured operator could see `network: 'sepolia'` in `/health` while the provider only serves Arc; (3) structural invariants already pinned in the provider: `listNetworks` → only `arc-testnet`/`testnet`, `listTokens` → only `USDC`/18 decimals, chainId 5042002 checked in `waitForFinality` (D3). No env var can point the Circle path at mainnet: `ARC_TESTNET_NETWORK`, `ARC_TESTNET_RPC_URL`, `CIRCLE_BLOCKCHAIN`, and the USDC token address are module constants; `rpcUrl` is only overridable via injected test options. | Trusting `WDK_NETWORK` at runtime without a boot check: rejected — it leaves an observable contract mismatch (health vs provider) reachable by config error. |

## Components and Planned Files

| Path | Action and responsibility |
| --- | --- |
| `src/wallet/circle-arc-provider.ts` | Finalize rescued provider: harden `waitForFinality` (chainId 5042002 pre-check, receipt-hash echo validation); keep idempotency (`previewId ?? randomUUID()`), 20 s broadcast / 120 s finality deadlines, `uncertain`-on-timeout, empty ledger, assertNetwork, recipient/burn/self guards. No public-shape changes. |
| `src/wallet/provider.ts` | Already carries `arc-testnet` in `EXPLORER_URLS` (rescued WIP); `explorerUrlFor` unchanged. `TransferRequest` unchanged (already optional `previewId` via `Omit<PendingTransfer,'preview'>`). |
| `src/runtime/dependencies.ts` | `createWalletProvider` keeps the circle-arc branch (CAR-001) **plus** the D8 boot guard on `WDK_NETWORK`/`WDK_TOKEN`; `createCoreDependencies` keeps routing `circle-arc` to the shared `walletReads` (CAR-003). |
| `src/agent/definition.ts` | Export `isLiveTransferSource`; use it in `validateWalletTransferPolicy`; `normalizeBroadcastResult` uses `explorerUrlFor`; `sendToken` accepts the internal `previewId`-bearing input (D2) and copies it into `TransferRequest`. |
| `src/agent/wallet-agent.ts` | `validateLiveTransferPolicy` uses `isLiveTransferSource`; confirm branch of `handleMessage` builds definition tools from `options.walletProvider` instead of unconditional `getWdkTools()` (D7); `buildGuardedTools` injects `pending.previewId` into broadcast input (D2); `executeConfirmedTransfer` takes the provider, selects `provider.waitForFinality ?? defaultTransactionReceiptWaiter`, network-parameterized receipt messages (D3). |
| `src/conversations/service.ts` | `toTransferRequest` forwards `previewId` (D2). Everything else (`claim`, receipt waiter mapping, `normalizeBroadcastResult` usage via `explorerUrlFor` fallback in `resultFromFinancialState`) already network-aware. |
| `src/contracts/http.ts` | `healthResponseSchema` gains optional `provider: { status, reason? }` (D5). No other schema changes; `/v1` shapes untouched (CAR-016). |
| `src/api/health.ts` | Calls `dependencies.wallet.health({ wallet: WALLET(), network: NETWORK() })` and returns the additive `provider` field; existing fields and lazy env reads unchanged (D5). |
| `tests/unit/circle-arc-provider.test.ts` | Extend (see Testing Strategy): policy parity, idempotency, receipt semantics, explorer, config fail-closed, testnet-only, health. |
| `tests/unit/*.test.ts` (targeted extensions) | Policy-gate tests for both gates under `circle-arc`; `normalizeBroadcastResult` arcscan test; health-route additive-field test; confirm-path seam test (provider-routed tools, no `getWdkTools`). |
| `.env.example` | Finalize the rescued circle-arc section: credentials, `WDK_NETWORK=arc-testnet`, `WDK_TOKEN=USDC`, mandatory policy vars for live mode, and the trust-model comment (CAR-017). |
| `docs/api.md` | Document the additive `/health` `provider` field. |
| `docs/local-live-runbook.md` (or a new arc runbook section) | Manual E2E steps for Arc testnet with real `CIRCLE_*` creds, explicit consent, real testnet USDC. |
| `compose.yaml` | **No change**: it pins no wallet vars (verified — no `WDK_*`/`SEPOLIA`/`CIRCLE` keys); `.env` interpolation already drives `WDK_TOOLS_SOURCE=circle-arc` without any compose-level sepolia pinning. |
| `apps/nana-wallet` | Touch-only: no health type exists to mirror (D5); honest empty-state handling for Arc history is already data-driven (`network`/`explorerUrl` come from the backend). Fixture/test updates only if something hardcodes Sepolia/USDT labels. |

## Interfaces

### PreviewId transport (D2)

```ts
// src/agent/definition.ts — internal, model-invisible
export type SendTokenBroadcastInput = SendTokenInput & { previewId?: string };
// sendToken copies request.previewId into TransferRequest when present

// src/agent/wallet-agent.ts — single injection point
// guardedSendToken, dryRun === false && pendingMatches(session, input):
//   call input = { ...normalizedInput, previewId: session.pendingTransfer.previewId }

// src/conversations/service.ts
function toTransferRequest(transfer: PendingTransfer): TransferRequest {
  return {
    network: transfer.network, token: transfer.token, to: transfer.to,
    amount: transfer.amount, wallet: transfer.wallet,
    ...(transfer.previewId ? { previewId: transfer.previewId } : {}),
  };
}
```

### Waiter selection (D3)

```ts
// src/agent/wallet-agent.ts
const verify = options.walletProvider
  ? (tx, opts) => options.walletProvider!.waitForFinality({ transaction: tx, ...opts })
  : defaultTransactionReceiptWaiter;
```

`CircleArcProvider.waitForFinality` hardening: `eth_chainId !== 5042002n` → immediate throw; `receipt.transactionHash` mismatch → throw; deadline throw message names the hash and "do not re-broadcast" is preserved at the broadcast layer. Text-path mapping: throw → `transaction_receipt_invalid` + reason; `0x0` → `transfer_reverted`; service-path mapping unchanged.

### Health schema (D5)

```ts
export const healthResponseSchema = z.object({
  status: z.literal('ok'),
  mode: z.enum(['fixture', 'live']),
  mcp: z.enum(['connected', 'disconnected', 'unknown']),
  wallet: z.enum(['unlocked', 'locked', 'unknown']),
  network: z.string(),
  provider: z.object({
    status: z.enum(['healthy', 'degraded', 'unavailable']),
    reason: z.string().optional(),
  }).optional(),
});
```

### Policy predicate (D4)

```ts
// src/agent/definition.ts
export function isLiveTransferSource(environment: NodeJS.ProcessEnv = process.env): boolean {
  return environment.WDK_TOOLS_SOURCE === 'live' || environment.WDK_TOOLS_SOURCE === 'circle-arc';
}
```

## Testing Strategy

**Unit (extend `tests/unit/circle-arc-provider.test.ts` + targeted suites; no network — inject `client`/`rpc`/`sleep`/`now` options):**

- Config fail-closed: missing each credential, non-64-hex secret → `CircleArcConfigError`; import of the module without env never throws; complete config resolves.
- Selection + no fallback: `circle-arc` → `id === 'circle-arc'`, `mode === 'live'`; `fixture`/`live` unchanged; `WDK_NETWORK=sepolia` under circle-arc → boot throw (D8).
- Policy parity: both `validateWalletTransferPolicy` and `validateLiveTransferPolicy` reject circle-arc without policy vars, over-limit amounts, non-allowlisted/burn/self recipients, and wallet/network/token mismatch; matching transfers pass. `WDK_TOOLS_SOURCE=live` behavior byte-preserved.
- Idempotency: confirmed preview (`previewId=P`) → `createTransaction` receives `idempotencyKey=P`; direct call without previewId → generated key (last resort); no fresh key for previewed broadcasts.
- Receipt semantics: `0x1` → `confirmed`; `0x0` → `reverted`; receipt hash mismatch → throw → `receipt_invalid` with reason; RPC unavailable / deadline → throw (never a fabricated `confirmed`); wrong chainId → immediate throw.
- Explorer: `normalizeBroadcastResult` on arc-testnet → `https://testnet.arcscan.app/tx/{hash}`; Sepolia unchanged.
- Testnet-only: any non-`arc-testnet` read/transfer rejects naming `arc-testnet`; `listNetworks`/`listTokens` invariants.
- Health: unhealthy provider → `provider.status === 'unavailable'` with a reason containing **no** API key, entity secret, or wallet id (CAR-017).
- Text seam: confirm path with `options.walletProvider` builds definition tools (never `getWdkTools`); duplicate confirm → `broadcast_in_progress`; missing preview → `stale_preview` (CAR-007 — repository claim semantics already cover this; asserted at the text path too).

**Integration (fake Circle transport, in-memory repository):** drive the typed conversation service with a real `CircleArcProvider` constructed over injected fake `client` + `rpc`: preview → confirm → broadcast → finality happy path; Circle API failure mid-broadcast → `broadcast_uncertain` and session blocked; uncertain outcome then retry → `broadcast_uncertain` with no second `createTransaction`; reverted receipt → `transfer_reverted`; previewId reuse verified through `runFinancialTransfer` (via `toTransferRequest`).

**Manual E2E (Arc testnet, real funds — explicit consent required):**

1. Set `WDK_TOOLS_SOURCE=circle-arc`, `WDK_NETWORK=arc-testnet`, `WDK_TOKEN=USDC`, `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET` (64 hex), `CIRCLE_SENDER_WALLET_ID`, plus policy vars; `docker compose up` (or local processes).
2. `curl /health` → `mode: live`, `network: arc-testnet`, `provider.status: healthy`.
3. Voice: ask balance (real Arc RPC USDC value), then a preview→confirm transfer below `WDK_MAX_TRANSFER_AMOUNT` to an allowlisted recipient; confirm spoken narration never claims "sent" before the on-chain receipt.
4. Text: same preview→confirm through the typed API; verify the Confirm/Cancel card links to `testnet.arcscan.app/tx/{hash}`.
5. Negative: attempt an over-limit transfer → `policy_rejected` narration; attempt a non-allowlisted recipient → `policy_rejected`.
6. Fund check: confirm the Arcscan transaction shows a real USDC transfer; the demo stays testnet-only.

## Traceability: CAR-001..CAR-017 → decisions and files

| Req | Decision | Files |
| --- | --- | --- |
| CAR-001 selection | existing rescued branch kept, no fallback | `src/runtime/dependencies.ts` |
| CAR-002 config fail-closed | D1 eager at boot | `src/wallet/circle-arc-provider.ts`, `src/runtime/dependencies.ts` |
| CAR-003 no silent fallback | D1 + existing `walletReads` routing | `src/runtime/dependencies.ts` |
| CAR-004 policy parity | D4 shared predicate | `src/agent/definition.ts`, `src/agent/wallet-agent.ts` |
| CAR-005 taxonomy parity | D4 (same `policy_rejected` code/message shape) | same as CAR-004 |
| CAR-006 previewId transport | D2 three construction sites | `src/conversations/service.ts`, `src/agent/wallet-agent.ts`, `src/agent/definition.ts` |
| CAR-007 duplicate/retry fail closed | D2 + existing claim semantics (+ tests) | `src/agent/wallet-agent.ts`, `src/conversations/service.ts` |
| CAR-008 real Arc receipt | D3 provider `waitForFinality` as single source | `src/agent/wallet-agent.ts`, `src/wallet/circle-arc-provider.ts` |
| CAR-009 explicit uncertain | D3 failure semantics (throw → `receipt_invalid`/`broadcast_uncertain`) | same as CAR-008 |
| CAR-010 explorer URL | D6 `explorerUrlFor` | `src/agent/definition.ts` |
| CAR-011 honest empty history | rescued provider behavior kept + tests | `src/wallet/circle-arc-provider.ts` |
| CAR-012 health exposure | D5 additive `provider` field | `src/contracts/http.ts`, `src/api/health.ts` |
| CAR-013 single seam | D7 confirm branch fix | `src/agent/wallet-agent.ts` |
| CAR-014 testnet-only | D8 three layers | `src/wallet/circle-arc-provider.ts`, `src/runtime/dependencies.ts` |
| CAR-015 WDK intact | no WDK-path edits (D2/D3/D6 explicitly leave it) | — |
| CAR-016 HTTP contract unchanged | D5 additive-optional only | `src/contracts/http.ts`, `apps/nana-wallet/src/lib/api-types.ts` (no-op today) |
| CAR-017 secret hygiene | D1/D5 + reason scrub test | `src/wallet/circle-arc-provider.ts`, `src/api/health.ts`, `.env.example`, docs |

## Edge Cases

- **Circle API failure mid-broadcast**: `createTransaction` non-{400,code 2} errors and dispatch-timeout both return `uncertain` (never `not_dispatched`); the service marks the pending transfer uncertain, blocks the session (`broadcast_uncertain`), and a retry cannot re-broadcast because `markPendingTransferUncertain` gates the claim and the idempotency key is stable.
- **Duplicate confirm**: repository claim (`claimPendingTransfer`) serializes concurrent confirms; a second confirm while `broadcasting` → `broadcast_in_progress`; after `uncertain` → `broadcast_uncertain`.
- **Expired/superseded preview**: claim status `missing`/`stale` → `stale_preview`, no broadcast.
- **Entity secret hygiene**: validated for shape only (64 hex regex); never logged, never in health reasons (test asserts absence of the literal secret value, API key, and wallet id), never sent to the frontend; error messages from the Circle SDK are surfaced as reasons only after the config values are excluded from any message construction.
- **`previewId` absent on the confirm path**: impossible after D2 when a pending transfer exists (guarded tool injects it); a direct provider call without preview is the documented last resort and is asserted to be unreachable for confirmed previews.
- **Arc RPC flapping during finality**: transient errors keep polling to the 120 s deadline, then throw → `transaction_receipt_invalid` with reason; the transfer is never cleared as confirmed on a fabricated success.

## Out of Scope

- Device passkey signing (roadmap stage 3) — the wallet stays developer-controlled server-side.
- WDK removal (roadmap stage 5) — `@tetherto/*`, `WdkWalletProvider`, legacy tools, Sepolia/USDT stay untouched and selectable; `WDK_*` variable renaming is deferred there.
- Real Arc transfer history (empty ledger only), mainnet, gas sponsorship, token swaps, non-USDC assets, family recovery/ENS/Ledger/bridges/multisig.
- Any `/v1` endpoint or request/response shape change; frontend rewrites.
