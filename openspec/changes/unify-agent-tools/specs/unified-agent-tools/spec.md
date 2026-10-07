# Spec Delta: unified-agent-tools

## ADDED Requirements

### Requirement: Single shared tool definition for text and voice agents

The system SHALL define agent tools once in `src/agent/definition.ts`
(`createWalletAgentDefinition()`) and both the text agent (AI SDK) and the voice
agent (LiveKit realtime) SHALL consume that definition through their respective
adapters. `src/agent/definition.ts` MUST NOT import from `@livekit/*`; only the
LiveKit side imports the definition.

#### Scenario: Both agents expose the same shared tools

- **Given** the canonical tool definition with a text context and a voice context
- **When** the tool name lists of both agents are compared
- **Then** they are identical except for `confirm_transfer` and `cancel_transfer`,
  which are declared in `VOICE_ONLY_TOOLS` as the only permitted divergence

#### Scenario: No duplicated hand-written tool bodies for shared tools

- **Given** the voice realtime tools module
- **When** the module is inspected for tool definitions
- **Then** shared tools (`get_balance`, `get_networks`, `list_tokens`, `get_address`,
  `get_history`, `send_token`, `search_recipients`, memory tools) are produced from
  the shared definition, not re-declared with independent schemas

### Requirement: Shared preview-only send_token contract

The model-facing `send_token` schema (text and voice) SHALL be
`{ amount, recipientId, recipientVersion, memo? }` with strict validation. The
schema MUST NOT accept `to`, `network`, `token`, `wallet`, or `dryRun` from the
model. Address/network/token resolution SHALL be performed server-side from the
versioned recipient; the existing runtime guards (pending preview match,
`previewId` idempotency injection, recipient revalidation) SHALL remain active.

#### Scenario: The model cannot invent a recipient address

- **Given** either agent (text or voice)
- **When** the model emits a `send_token` call containing a `to` address or a
  `dryRun` flag
- **Then** the strict schema rejects the call and the model receives a typed error
  without any broadcast occurring

#### Scenario: Direct address request from a text user still works

- **Given** a text user providing a raw wallet address
- **When** the agent resolves the recipient (persisted and versioned) and calls
  `send_token` with the resolved recipient id/version
- **Then** the preview is created for that address through the server-side
  resolution, preserving the preview → explicit confirmation flow

### Requirement: Multi-network balance and address reads in both agents

The read tools (`get_balance`, `get_address`, `get_history`) SHALL accept an
optional `network` (default `arc-testnet`) and the wallet SHALL be resolved per
call according to the requested network via the chain-family resolver. An
unsupported network SHALL fail closed with the typed `wallet_config_error`, and
the voice session MUST NOT bind a single network for the whole session.

#### Scenario: Voice balance read for Solana

- **Given** an authenticated Privy user with a ready Solana wallet binding
- **When** the voice agent calls `get_balance` with `network: 'solana-devnet'`
- **Then** the balance is read from the user's Solana wallet through the devnet
  provider (not from the Arc wallet)

#### Scenario: Default network stays Arc when unspecified

- **Given** a balance request without a `network` argument
- **When** `get_balance` executes
- **Then** the balance is read from the Arc wallet (USDC) as today

#### Scenario: Unsupported network fails closed

- **Given** a `get_balance` call with an unsupported network string
- **When** the tool executes
- **Then** a typed `wallet_config_error` is returned and no fallback network is used

### Requirement: Voice-only spoken-decision tools remain gated

`confirm_transfer` and `cancel_transfer` SHALL remain voice-only tools wrapped by
the spoken-decision gate (`voiceDecisionGate`); they MUST NOT be exposed to the
text agent. The parity test SHALL treat them as the declared exception list.

#### Scenario: Text agent never exposes confirm_transfer

- **Given** the text agent tool list produced from the shared definition
- **When** the tool names are inspected
- **Then** `confirm_transfer` and `cancel_transfer` are absent

### Requirement: Deterministic CI eval coverage for the unified surface

The offline eval suite (`npm run eval`, no network) SHALL include scenarios that
cover: every text tool previously uncovered (`get_networks`, `list_tokens`,
`get_address`, `get_history`, `search_user_memory`, `stage_user_memory`,
`write_user_memory`); multi-network balance reads (Solana, default Arc, invalid
network); the preview-only `send_token` selection path on text; and a tools-parity
assertion. Eval fixtures MUST NOT use networks or tokens outside the product
surface (`arc-testnet`/USDC, `solana-devnet`/SOL) except in tests explicitly
targeting the demo legacy mode.

#### Scenario: Multi-network balance eval

- **Given** the deterministic mock-model eval harness
- **When** the scenario "balance on Solana" runs
- **Then** `get_balance` is called with `network: 'solana-devnet'` and the response
  narrates the provider value without inventing amounts

#### Scenario: Parity eval guards against surface drift

- **Given** the shared tool definition and both adapters
- **When** the parity eval executes
- **Then** any name, description, or schema-shape divergence between text and voice
  surfaces (outside `VOICE_ONLY_TOOLS`) fails the eval
