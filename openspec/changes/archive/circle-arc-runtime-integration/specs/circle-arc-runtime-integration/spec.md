# Circle Arc Runtime Integration Specification

## Purpose

Run Nana's financial runtime (voice, text, and frontend) on Circle developer-controlled wallets over Arc Testnet with USDC, through the existing `WalletProvider` seam, as the first runtime increment of the arc-migration roadmap. After this change, selecting `WDK_TOOLS_SOURCE=circle-arc` makes every financial path — balance reads, preview → explicit confirmation → broadcast → on-chain verification, health, and progress narration — operate against Circle's API and the Arc testnet RPC, with the same safety taxonomy the WDK path has today (policy limits, allowlist, idempotency, uncertain-state handling). The WDK/MCP path stays intact and selectable; WDK removal is a separate later work unit.

This increment is a **wiring-plus-hardening** bridge of roadmap stages 1 + 2 + 4: provider integration behind the provider seam, no per-device passkey signing, and no WDK deletion. Device passkey signing (stage 3) and WDK removal (stage 5) are explicit follow-ups.

## Requirements

### Requirement: CAR-001 Provider selection by `WDK_TOOLS_SOURCE`

The system MUST select `CircleArcProvider` in `createWalletProvider` when `WDK_TOOLS_SOURCE=circle-arc`, with the resulting provider's `id` equal to `'circle-arc'` and `mode` equal to `'live'`. The `fixture` and `live` (WDK MCP) values MUST keep their current behavior (FixtureWalletProvider and WdkWalletProvider respectively). The circle-arc selection MUST resolve through the same `createWalletProvider` seam used by the worker, the API, and the conversation service, so a single source of truth selects the runtime provider.

#### Scenario: Selecting circle-arc builds the Circle provider

- GIVEN `WDK_TOOLS_SOURCE=circle-arc` and valid Circle credentials
- WHEN `createWalletProvider(environment)` is called
- THEN the returned provider's `id` is `'circle-arc'`
- AND the provider's `mode` is `'live'`

#### Scenario: Fixture and live selection is unchanged

- GIVEN `WDK_TOOLS_SOURCE=fixture`
- WHEN `createWalletProvider(environment)` is called
- THEN a FixtureWalletProvider is returned

- GIVEN `WDK_TOOLS_SOURCE=live`
- WHEN `createWalletProvider(environment)` is called
- THEN a WdkWalletProvider is returned

### Requirement: CAR-002 Circle Arc config validation fails closed

The system MUST require `CIRCLE_API_KEY`, `CIRCLE_ENTITY_SECRET`, and `CIRCLE_SENDER_WALLET_ID` for the circle-arc provider via `readCircleArcProviderConfig`. `CIRCLE_ENTITY_SECRET` MUST be exactly 64 hexadecimal characters. When a required credential is missing or the entity secret is not 64 hex, the config read MUST throw a `CircleArcConfigError` (fail closed). Validation MUST occur before the provider is used and MUST NOT be deferred indefinitely such that an invalid configuration silently serves a fixture or WDK provider; it MUST NOT run at module import time (so importing the provider module without config does not throw).

#### Scenario: Missing credential fails closed

- GIVEN circle-arc mode with no `CIRCLE_ENTITY_SECRET`
- WHEN the provider config is read
- THEN a `CircleArcConfigError` is thrown
- AND no provider is instantiated

#### Scenario: Non-64-hex entity secret is rejected

- GIVEN `CIRCLE_ENTITY_SECRET=nothex`
- WHEN the provider config is read
- THEN a `CircleArcConfigError` is thrown indicating the secret must be 64 hexadecimal characters

#### Scenario: Complete configuration is accepted

- GIVEN valid `CIRCLE_API_KEY`, a 64-hex `CIRCLE_ENTITY_SECRET`, and `CIRCLE_SENDER_WALLET_ID`
- WHEN the provider config is read
- THEN a resolved config object is returned with all three values

#### Scenario: Importing the module never throws

- GIVEN the `circle-arc-provider` module is imported without any environment config
- THEN no error is thrown at import time

### Requirement: CAR-003 No silent fallback under circle-arc

With `WDK_TOOLS_SOURCE=circle-arc`, missing Circle config or a down Circle API MUST produce explicit failures (a `CircleArcConfigError`, a `wallet_unavailable` transfer error, or an unhealthy health report) and MUST NEVER silently switch to the WDK or the fixture provider. `createCoreDependencies` routes both `live` and `circle-arc` to the same `walletReads` provider; circle-arc MUST NOT fall back to a legacy WDK tool source.

#### Scenario: Missing config never falls back

- GIVEN `WDK_TOOLS_SOURCE=circle-arc` with missing `CIRCLE_API_KEY`
- WHEN the provider is used
- THEN a `CircleArcConfigError` is thrown
- AND no WDK or fixture provider serves the request

#### Scenario: Down Circle API is surfaced, not silently served

- GIVEN `WDK_TOOLS_SOURCE=circle-arc` with a Circle API that rejects requests
- WHEN a transfer broadcast returns `uncertain` or the health check runs
- THEN the failure is surfaced as an explicit `wallet_unavailable`/`broadcast_uncertain` state or an unhealthy health report
- AND no fixture confirmation is returned

### Requirement: CAR-004 Policy parity for circle-arc live transfers

The live-transfer policy gate (`validateWalletTransferPolicy` in `src/agent/definition.ts` and the equivalent `validateLiveTransferPolicy` in `src/agent/wallet-agent.ts`) MUST apply to `WDK_TOOLS_SOURCE=circle-arc` exactly as it applies to `live`. A circle-arc configuration without both `WDK_MAX_TRANSFER_AMOUNT` and `WDK_ALLOWED_RECIPIENTS` MUST reject every live transfer with `policy_rejected` (fail closed). Enforced invariants MUST be: `WDK_MAX_TRANSFER_AMOUNT` is a positive plain decimal; the requested `wallet`, `network`, and `token` exactly match the configured runtime; the amount is a positive plain decimal not exceeding the maximum; and the recipient is a valid non-burn EVM address present in `WDK_ALLOWED_RECIPIENTS`.

#### Scenario: Circle-arc without policy configuration rejects transfers

- GIVEN `WDK_TOOLS_SOURCE=circle-arc` with no `WDK_MAX_TRANSFER_AMOUNT` or `WDK_ALLOWED_RECIPIENTS`
- WHEN a live transfer is validated
- THEN the gate returns `policy_rejected`
- AND the transfer is not broadcast

#### Scenario: Over-limit amount is rejected

- GIVEN circle-arc with `WDK_MAX_TRANSFER_AMOUNT=0.01`
- WHEN a transfer of `0.02` is validated
- THEN the gate returns `policy_rejected`
- AND the transfer is not broadcast

#### Scenario: Non-allowlisted recipient is rejected

- GIVEN circle-arc with `WDK_ALLOWED_RECIPIENTS=0xValidRecipient`
- WHEN a transfer to a different EVM address is validated
- THEN the gate returns `policy_rejected`
- AND the transfer is not broadcast

#### Scenario: Wallet/network/token mismatch is rejected

- GIVEN circle-arc configured for wallet `W`, network `arc-testnet`, token `USDC`
- WHEN a transfer requests a different network or token
- THEN the gate returns `policy_rejected`

#### Scenario: Matching over-limit policy is rejected before broadcast

- GIVEN circle-arc with a valid amount, allowlisted recipient, and matching wallet/network/token
- WHEN the transfer is validated
- THEN the gate does not return `policy_rejected`
- AND the transfer proceeds to broadcast

### Requirement: CAR-005 `policy_rejected` taxonomy parity

A live transfer rejected by the policy gate in circle-arc mode MUST surface the same conversation error code used by `live`: `policy_rejected`. The rejection MUST be indistinguishable (by error code and message taxonomy) from the WDK live path, so the frontend and conversation layer need no mode-specific handling.

#### Scenario: Over-limit transfer surfaces policy_rejected

- GIVEN `WDK_TOOLS_SOURCE=circle-arc` with an over-limit transfer
- WHEN the transfer is rejected by the gate
- THEN the conversation result carries error code `policy_rejected`

### Requirement: CAR-006 Broadcast idempotency key derived from persisted previewId

`TransferRequest` MUST carry the confirmed preview's `previewId` through the seam — including `toTransferRequest` in `src/conversations/service.ts` and the voice preview path — so `CircleArcProvider.broadcastTransfer` can derive its Circle idempotency key from the persisted `previewId`. `randomUUID()` MUST remain only the last-resort fallback for direct calls made without a confirmed preview. A broadcast that originates from a confirmed preview MUST reuse that preview's idempotency key, never a freshly generated key.

#### Scenario: Confirmed preview reuses its previewId as the idempotency key

- GIVEN a pending transfer persisted with `previewId=P`
- WHEN the confirmed transfer is converted to a `TransferRequest` and broadcast
- THEN the Circle idempotency key equals `P`
- AND no fresh `randomUUID()` is generated

#### Scenario: Direct call without a preview uses a last-resort key

- GIVEN a direct `broadcastTransfer` call with no `previewId` in the request
- WHEN the transfer is broadcast
- THEN a last-resort idempotency key is used
- AND this path is never taken for a confirmed preview

### Requirement: CAR-007 Duplicate confirm and retry fail closed

Once a pending preview is claimed for broadcast, a duplicate confirm or a retry MUST fail closed to `stale_preview` or `broadcast_in_progress` semantics and MUST NEVER re-broadcast. An `uncertain` broadcast outcome MUST mark the pending transfer `uncertain`, block further transfers in the session, and surface `broadcast_uncertain` until resolved. The idempotency guarantee MUST prevent duplicate spending on retries, double clicks, or restarts.

#### Scenario: Duplicate confirm while broadcasting fails closed

- GIVEN a confirmed preview already claimed into `broadcasting`
- WHEN the user confirms again
- THEN the result is `broadcast_in_progress`
- AND no second broadcast is dispatched

#### Scenario: Retry after an uncertain outcome is blocked

- GIVEN a broadcast that returned `uncertain`
- WHEN a subsequent transfer attempt is made in the same session
- THEN the result is `broadcast_uncertain`
- AND the transfer is not repeated

#### Scenario: Confirm on a missing/superseded preview fails closed

- GIVEN a preview that no longer exists
- WHEN the user confirms it
- THEN the result is `stale_preview`
- AND no broadcast is dispatched

### Requirement: CAR-008 Receipt verification uses a real Arc receipt

A circle-arc confirmation MUST NOT return a fixture or immediate-confirmation receipt. The text confirmation path (`defaultTransactionReceiptWaiter` / `executeConfirmedTransfer` in `src/agent/wallet-agent.ts`) and the service path MUST route `arc-testnet` transactions through real Arc finality verification — the provider's `waitForFinality` polling Arc's RPC `eth_getTransactionReceipt`, chain-validated — instead of the immediate fixture confirmation. A successful `0x1` receipt MAY confirm; a `0x0` receipt MUST surface `transfer_reverted`.

#### Scenario: Confirmed circle-arc transfer verifies on-chain

- GIVEN a circle-arc broadcast returning a transaction hash
- WHEN finality is awaited via Arc RPC and the receipt returns `0x1`
- THEN the transfer is `confirmed`
- AND the confirmed state is derived from a real Arc receipt

#### Scenario: Reverted receipt surfaces transfer_reverted

- GIVEN a circle-arc broadcast returning a transaction hash
- WHEN the Arc RPC receipt returns `0x0`
- THEN the result is `error` with code `transfer_reverted`
- AND the transfer is never reported as `sent`

### Requirement: CAR-009 Explicit uncertain state on verification failure

For circle-arc, a provider or verification failure MUST produce an explicit `uncertain`/`receipt_invalid` state — never a silent success. If the Arc RPC or Circle API becomes unavailable during finality, or the receipt cannot be validated against the expected hash, the result MUST surface `transaction_receipt_invalid` (or `broadcast_uncertain` when dispatch outcome is unknown) with a reason, and the pending transfer MUST NOT be cleared as confirmed.

#### Scenario: Arc RPC unavailable during finality

- GIVEN a circle-arc broadcast with the Arc RPC unreachable
- WHEN finality is awaited
- THEN the result is `transaction_receipt_invalid` (or `broadcast_uncertain`) with a reason
- AND the transfer is not reported as confirmed

#### Scenario: Mismatched receipt is rejected

- GIVEN a circle-arc transaction hash `H`
- WHEN Arc RPC returns a receipt for a different hash or an invalid status
- THEN the result is `transaction_receipt_invalid`
- AND no confirmed state is produced

### Requirement: CAR-010 Network-aware explorer URL

`normalizeBroadcastResult` MUST derive the transaction explorer URL from `explorerUrlFor(network, hash)` instead of a hardcoded Sepolia etherscan URL. For `arc-testnet`, the URL MUST point to `https://testnet.arcscan.app/tx/{hash}`; for Sepolia the existing explorer URL behavior MUST remain. The Confirm/Cancel card and transaction results MUST link to the network-appropriate explorer for circle-arc.

#### Scenario: Circle-arc broadcast links to Arcscan

- GIVEN a circle-arc broadcast with hash `H` and network `arc-testnet`
- WHEN the broadcast result is normalized
- THEN the transaction `explorerUrl` is `https://testnet.arcscan.app/tx/{H}`

#### Scenario: Sepolia broadcast keeps its explorer

- GIVEN a Sepolia broadcast with hash `H`
- WHEN the broadcast result is normalized
- THEN the transaction `explorerUrl` is the Sepolia etherscan URL

### Requirement: CAR-011 Honest empty transfer history

`CircleArcProvider.getHistory` MUST return an explicit empty ledger (an empty `transactions` array) rather than fabricating entries. The frontend and narration MUST treat an empty Arc history as "no history available on this network yet", and MUST NOT present it as bank data or as evidence of zero past spending. Real Arc transfer history is a documented follow-up and MUST NOT be invented in this increment.

#### Scenario: History returns an empty ledger

- GIVEN a circle-arc history query for `arc-testnet`
- WHEN `getHistory` is called
- THEN the returned `transactions` array is empty

#### Scenario: Empty history is narrated as no-history-yet

- GIVEN an empty Arc history returned to the frontend/narration
- WHEN the history is presented
- THEN it is shown as "no history available on this network yet"
- AND no zero-spend claim or fabricated entry is produced

### Requirement: CAR-012 Health contract exposes provider status

`GET /health` MUST expose the selected provider's `health()` status and reason for circle-arc mode, reflecting Circle API and Arc RPC reachability, while keeping the existing `status`/`mode`/`mcp`/`wallet`/`network` contract semantics. For circle-arc, `mode` MUST be `'live'` and `network` MUST be the configured `arc-testnet`. This extension MUST NOT add a new `/v1` endpoint.

#### Scenario: Healthy circle-arc reports live/arc-testnet

- GIVEN a healthy circle-arc provider
- WHEN `GET /health` is called
- THEN the response includes `mode: 'live'` and `network: 'arc-testnet'`
- AND the provider health status is `healthy` with no reason

#### Scenario: Unhealthy circle-arc reports the failing reason

- GIVEN circle-arc with the Circle API or Arc RPC unreachable
- WHEN `GET /health` is called
- THEN the provider health status is `unavailable` with a reason
- AND no credentials or secrets are present in the reason

### Requirement: CAR-013 Voice and text share one provider seam

The realtime voice tools (`createWalletAgentTools` / `createWalletConversationService` in `src/livekit/worker.ts`) and the typed conversation flow (`src/conversations/service.ts`) MUST resolve the same provider through the same `createWalletProvider` seam. There MUST be no alternate broadcast path that bypasses the selected provider, the policy gate, or the confirmation cycle.

#### Scenario: Voice and text resolve the same provider

- GIVEN `WDK_TOOLS_SOURCE=circle-arc` in a worker
- WHEN a voice `send_token` preview and a typed conversation preview are both prepared
- THEN both resolve `dependencies.wallet` to the same `CircleArcProvider`
- AND no alternate broadcast path is used

### Requirement: CAR-014 Testnet-only boundary

The Circle Arc provider MUST only operate on `arc-testnet` (chainId `5042002`). Any requested network other than `arc-testnet` MUST be rejected (`assertNetwork` throws). `listNetworks` MUST report only `arc-testnet` with `kind: 'testnet'` and `listTokens` MUST report only `USDC` (18 decimals). No configuration in this change MAY point the Circle path at mainnet; the demo boundary MUST stay testnet-only. The provider (`mode: 'live'`) MUST be presented as a testnet runtime, and real-funds / mainnet behavior MUST remain out of scope.

#### Scenario: Unsupported network is rejected

- GIVEN a circle-arc request for network `sepolia` (or any non-`arc-testnet`)
- WHEN a provider read or transfer is attempted
- THEN the call rejects with an error naming `arc-testnet` as the only supported network

#### Scenario: Only Arc Testnet and USDC are advertised

- GIVEN a circle-arc provider in healthy state
- WHEN `listNetworks` and `listTokens` are called
- THEN `listNetworks` returns only `[{ network: 'arc-testnet', kind: 'testnet' }]`
- AND `listTokens` returns only `[{ network: 'arc-testnet', token: 'USDC', decimals: 18 }]`

### Requirement: CAR-015 WDK stays intact and selectable

The WDK/MCP path (`WdkWalletProvider`, `@tetherto/*` dependencies, legacy tools, Sepolia/USDT references) MUST remain untouched and selectable. `WDK_TOOLS_SOURCE=live` and `fixture` MUST continue to work as today. Circle Arc is an additive selection, not a replacement: selecting `WDK_TOOLS_SOURCE=circle-arc` MUST NOT remove, disable, or rename any WDK path, and rollback MUST be configuration-only.

#### Scenario: WDK and fixture remain selectable after Circle Arc wiring

- GIVEN a worker with the Circle Arc provider wired in
- WHEN `WDK_TOOLS_SOURCE=live` or `WDK_TOOLS_SOURCE=fixture` is selected
- THEN the WdkWalletProvider or FixtureWalletProvider is still returned
- AND no WDK code path is removed or renamed

### Requirement: CAR-016 Front/back HTTP contract unchanged

The frontend/backend HTTP contract MUST remain unchanged except for the health payload extension in CAR-012 — no new `/v1` endpoints and no change to `/v1` request/response shapes. The documented (typed `api-types`) `/v1` contract and the actual `/v1` responses MUST continue to agree; only `GET /health` gains the provider health status/reason field. The `network`/`token`/`explorerUrl` data driving the frontend MUST continue to come from the backend without shape changes.

#### Scenario: /v1 contract shape is preserved

- GIVEN the circle-arc runtime
- WHEN the `/v1` endpoints and `apps/nana-wallet` typed client are inspected
- THEN no `/v1` request or response shape has changed
- AND `api-types` mirror still matches the actual `/v1` responses

#### Scenario: Only the health payload is extended

- GIVEN the circle-arc runtime
- WHEN `GET /health` is called
- THEN the existing `status`/`mode`/`mcp`/`wallet`/`network` fields are present alongside the new provider health status/reason field
- AND no new endpoint is introduced

### Requirement: CAR-017 Circle credentials are never exposed

`CIRCLE_ENTITY_SECRET` MUST be treated as a production-grade secret: it MUST be validated for shape only by `readCircleArcProviderConfig`, MUST NEVER be logged, MUST NEVER be echoed in health reports or error messages, and MUST NEVER be sent to the frontend. Health and error surfaces MUST carry reasons without credentials. `.env.example` and repo docs MUST state the trust model (Circle holds wallet keys server-side under the developer entity; the backend holds the entity secret; the device never signs).

#### Scenario: Health output carries no credentials

- GIVEN an unhealthy circle-arc provider
- WHEN `GET /health` returns a reason
- THEN the reason contains no API key, entity secret, or wallet id
- AND no credential is echoed

#### Scenario: Config reader validates shape only

- GIVEN a valid 64-hex `CIRCLE_ENTITY_SECRET`
- WHEN `readCircleArcProviderConfig` reads it
- THEN only its shape is validated
- AND the secret value is not logged or emitted

#### Scenario: Trust model is documented

- GIVEN the `.env.example` circle-arc section and repo docs
- WHEN they are inspected
- THEN they state the server-side Circle key trust model, the testnet-only boundary, and that the user's device never signs
