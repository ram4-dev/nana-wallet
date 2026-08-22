# WDK Transaction Agent — Backend Demo Plan

## Document status

- **Purpose:** implementation plan for a backend-only transaction agent for the Aleph Hackathon 2026 WDK Track.
- **Team:** two developers working concurrently.
- **Timebox:** 24 hours.
- **Track:** WDK Track 1 — WDK CLI and bundled MCP server.
- **Product:** an HTTP agent that reads wallet data and sends tokens to people from natural-language instructions.
- **Scope:** hackathon demo only, using a dedicated testnet wallet and testnet funds.

## 1. Demo objective

The user talks to an agent through an HTTP endpoint:

```text
User: Send 10 USDT to 0x1234...abcd
Agent: The transfer will send 10 USDT on Sepolia to 0x1234...abcd.
       Estimated fee: 0.0003 ETH. Confirm?
User: Confirm
Agent: Sent. Transaction: 0xabcd...
```

The agent must be able to:

1. Read the wallet address.
2. Read balances.
3. Read transaction history.
4. Understand a natural-language payment request.
5. Call WDK `send_token` directly with `dryRun: true` to preview it.
6. Ask the user for conversational confirmation.
7. Call the same WDK `send_token` tool with `dryRun: false` after confirmation.
8. Return the transaction hash and explorer link.

This plan intentionally avoids a production security architecture. There is no policy engine, transaction fingerprint, approval API, smart account, multisig, or separate signer service. The goal is to demonstrate a real agent making a real testnet transaction through WDK.

## 2. Scope decisions

The MVP uses:

- Node.js and TypeScript.
- Fastify for the HTTP API.
- AI SDK Core `ToolLoopAgent` for the conversational agent.
- `@ai-sdk/mcp` to load tools from the bundled WDK MCP server.
- `@tetherto/wdk` as the WDK core dependency.
- `@tetherto/wdk-cli` and its `wdk-mcp` executable.
- One dedicated WDK wallet.
- One testnet and one demo asset.
- In-memory sessions for conversation and pending transfer previews.
- Vitest for unit and API tests.

There is no frontend:

- No Next.js.
- No React or React Native UI.
- No `useChat` or `@ai-sdk/react`.
- No Tailwind.
- No browser E2E work.

The API is consumed with `curl`, Postman, or a future wallet client.

## 3. Architecture

```text
curl / Postman / future wallet client
                 |
                 v
+--------------------------------------+
| Fastify HTTP API                     |
| wallet reads + conversational chat   |
+------------------+-------------------+
                   |
                   v
+--------------------------------------+
| AI SDK Core ToolLoopAgent            |
| natural language + tool calling      |
+------------------+-------------------+
                   |
                   v
+--------------------------------------+
| @ai-sdk/mcp                          |
| exposes WDK MCP tools to the model   |
+------------------+-------------------+
                   |
                   v
+--------------------------------------+
| wdk-mcp                              |
| get_balance / history / send_token   |
+------------------+-------------------+
                   |
                   v
+--------------------------------------+
| WDK local daemon + unlocked wallet   |
+------------------+-------------------+
                   |
                   v
              Testnet chain
```

### Direct tool decision

The WDK MCP tools are loaded directly into the `ToolLoopAgent`:

```ts
const mcpClient = await createMCPClient({ transport });
const wdkTools = await mcpClient.tools();

const agent = new ToolLoopAgent({
  model,
  instructions,
  tools: wdkTools,
});
```

The model can see and invoke `send_token`. The application does not wrap it in a separate transaction service.

## 4. WDK tool surface

The agent receives the bundled WDK MCP tools required by the demo:

| WDK MCP tool | Purpose |
| --- | --- |
| `get_networks` | List configured networks. |
| `list_tokens` | List registered tokens. |
| `get_token` | Resolve token configuration. |
| `get_address` | Read the wallet address. |
| `get_balance` | Read native or token balances. |
| `get_history` | Read transfer history when the indexer is configured. |
| `send_token` | Preview or execute a native/token transfer. |

Wallet administration tools remain outside MCP because the bundled server does not expose create, import, export, unlock, lock, delete, or persistent configuration commands. The developer unlocks the demo wallet manually before starting the API.

## 5. Conversational transaction flow

### Step 1 — Payment request

The user sends:

```json
{
  "message": "Send 10 USDT to 0x1234...abcd"
}
```

The LLM extracts:

```json
{
  "network": "sepolia",
  "token": "USDT",
  "to": "0x1234...abcd",
  "amount": "10"
}
```

### Step 2 — Direct WDK preview

The agent calls the model-visible `send_token` tool:

```json
{
  "network": "sepolia",
  "token": "USDT",
  "to": "0x1234...abcd",
  "amount": "10",
  "wallet": "agent-demo",
  "dryRun": true
}
```

The API keeps the resulting preview in the in-memory conversation session and returns:

```json
{
  "status": "confirmation_required",
  "message": "Send 10 USDT to 0x1234...abcd on Sepolia?",
  "preview": {
    "network": "sepolia",
    "token": "USDT",
    "recipient": "0x1234...abcd",
    "amount": "10",
    "estimatedFee": "0.0003 ETH"
  }
}
```

### Step 3 — Conversational confirmation

The user sends a second message in the same session:

```json
{
  "message": "Confirm"
}
```

The system instruction tells the agent to interpret confirmation only when the session contains a pending WDK preview. It then calls `send_token` again with the same parameters and `dryRun: false`.

### Step 4 — Broadcast result

```json
{
  "status": "sent",
  "message": "The transfer was broadcast.",
  "transaction": {
    "network": "sepolia",
    "transactionHash": "0xabcd...",
    "explorerUrl": "https://sepolia.etherscan.io/tx/0xabcd..."
  }
}
```

If the user says `cancel`, the pending preview is removed and no second `send_token` call is made.

## 6. Agent instructions

The system prompt stays short and demo-oriented:

```text
You are a wallet transaction agent powered by WDK.

- Use WDK tools for all wallet facts and actions.
- Never invent a balance, fee, address, token, or transaction hash.
- When the user requests a transfer, call send_token with dryRun=true first.
- Show the network, token, recipient, amount, and estimated fee.
- Ask the user to confirm.
- Only after the user confirms the pending preview, call send_token again with
  the same parameters and dryRun=false.
- If the user cancels, do not send.
- After execution, return the real transaction hash from WDK.
- Do not claim success when WDK returns an error.
```

The conversational confirmation is a demo UX behavior, not a production authorization boundary.

## 7. HTTP API

### Endpoint summary

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/health` | Verify API, MCP process, wallet unlock state, and RPC connectivity. |
| `GET` | `/v1/wallet/address` | Return the wallet address for a network. |
| `GET` | `/v1/wallet/balance` | Return native or token balance. |
| `GET` | `/v1/wallet/history` | Return transaction history. |
| `POST` | `/v1/sessions` | Create an in-memory conversation session. |
| `GET` | `/v1/sessions/:sessionId` | Inspect messages and pending preview. |
| `POST` | `/v1/sessions/:sessionId/messages` | Talk to the LLM and allow WDK tool calls. |

There is no separate transaction proposal, policy, approval, or decision endpoint.

### Health

```http
GET /health
```

```json
{
  "status": "ok",
  "mcp": "connected",
  "wallet": "unlocked",
  "network": "sepolia"
}
```

### Wallet balance

```http
GET /v1/wallet/balance?network=sepolia&token=USDT
```

```json
{
  "network": "sepolia",
  "token": "USDT",
  "address": "0x1234...abcd",
  "balance": "42.5"
}
```

### Create session

```http
POST /v1/sessions
Content-Type: application/json
```

```json
{
  "sessionId": "ses_01",
  "status": "active"
}
```

### Talk to the agent

```http
POST /v1/sessions/ses_01/messages
Content-Type: application/json
```

```json
{
  "message": "How much USDT do I have?"
}
```

The same endpoint handles payment requests, confirmation, cancellation, and the final transaction response.

## 8. Session model

An in-memory store is enough for the demo:

```ts
type DemoSession = {
  id: string;
  messages: ModelMessage[];
  pendingTransfer?: {
    network: string;
    token: string;
    to: string;
    amount: string;
    wallet: string;
    preview: unknown;
  };
  lastTransactionHash?: string;
  createdAt: string;
};
```

Restarting the server clears sessions. This is acceptable for the hackathon demo and must be stated in the README.

## 9. Repository layout

```text
src/
|-- server.ts
|-- api/
|   |-- health.ts
|   |-- wallet.ts
|   `-- sessions.ts
|-- agent/
|   |-- wallet-agent.ts
|   |-- instructions.ts
|   `-- wdk-tools.ts
|-- wdk/
|   |-- mcp-client.ts
|   `-- direct-wallet-reads.ts
|-- sessions/
|   `-- in-memory-store.ts
`-- contracts/
    `-- http.ts
tests/
|-- unit/
|-- integration/
`-- fixtures/
docs/
|-- architecture.md
|-- api.md
|-- development-plan.md
|-- demo-runbook.md
`-- submission-checklist.md
```

## 10. Developer ownership

### Developer A — WDK and blockchain flow

Owns:

```text
src/wdk/
tests/integration/wdk*
docs/architecture.md
```

Responsibilities:

- Install and configure WDK CLI.
- Create and unlock the dedicated testnet wallet.
- Configure network, token, RPC, and optional indexer.
- Start and verify `wdk-mcp`.
- Prove `get_address`, `get_balance`, `get_history`, and `send_token` manually.
- Verify both `dryRun: true` and one real testnet broadcast.
- Provide the exact WDK tool schemas and example results to Developer B.

### Developer B — Agent and HTTP API

Owns:

```text
src/server.ts
src/api/
src/agent/
src/sessions/
src/contracts/
tests/unit/
tests/integration/api*
docs/api.md
docs/demo-runbook.md
```

Responsibilities:

- Bootstrap Fastify.
- Connect AI SDK Core to the MCP client.
- Load WDK MCP tools directly into `ToolLoopAgent`.
- Implement wallet read endpoints.
- Implement sessions and the message endpoint.
- Preserve pending preview context between the request and confirmation.
- Return structured responses for preview, cancellation, success, and WDK errors.
- Build the curl/Postman demo sequence.

### Shared files

- `package.json` and lockfile: Developer B owns them in Wave 0; Developer A requests dependency changes instead of editing concurrently.
- `README.md`: Developer B drafts; Developer A verifies every WDK claim and command.
- `docs/development-plan.md`: both review, Developer B integrates edits.

## 11. Development waves

| Wave | Hours | Developer A | Developer B | Integration gate |
| --- | ---: | --- | --- | --- |
| 0 — Bootstrap | 0–1 | Verify WDK package names, testnet, token, wallet, and RPC. | Create Node/Fastify/AI SDK project and shared response schemas. | Service starts and exact dependency versions are pinned. |
| 1 — Reads | 1–4 | Prove address, balance, and history through `wdk-mcp`. | Implement health, wallet endpoints, sessions, and an MCP fake. | API returns real WDK address and balance. |
| 2 — Direct send tool | 4–8 | Prove `send_token` preview and real testnet execution. | Load raw MCP tools into `ToolLoopAgent` and implement chat. | Agent can create a WDK dry-run from natural language. |
| 3 — Confirmation | 8–12 | Supply real preview/error fixtures and explorer output. | Implement pending preview, confirm, cancel, and second `send_token` call. | Full chat-to-testnet transaction succeeds. |
| 4 — Demo reliability | 12–16 | Stabilize wallet startup, funding, RPC, and WDK errors. | Stabilize session state and structured API responses. | Three consecutive demo runs succeed. |
| 5 — Verification | 16–20 | Run WDK integration smoke and clean setup. | Run unit/API tests and clean-clone setup. | Tests pass and demo works from a clean clone. |
| 6 — Submission | 20–23 | Document WDK versions, commands, token/network, and code permalinks. | Finish README, API docs, Postman/curl demo, and video. | Recorded demo shows a real transaction without mocks. |
| Buffer | 23–24 | Critical fixes only. | Critical fixes only. | Freeze and submit. |

### Wave 0 gate

- Exact Node.js version pinned.
- Exact WDK CLI, WDK Core, AI SDK, and MCP versions pinned.
- One testnet and one asset chosen.
- Sender wallet funded.
- Recipient test wallet/address available.
- Fastify process starts.

### Wave 1 gate

- `GET /health` reports MCP and wallet state.
- Address and balance endpoints return real WDK data.
- History either works with the indexer or is explicitly marked unavailable.

### Wave 2 gate

- The LLM sees `send_token` in its tool list.
- A natural-language request produces a real WDK dry-run.
- The API returns the preview without broadcasting.

### Wave 3 gate

- `Confirm` causes a second tool call with `dryRun: false`.
- `Cancel` clears the pending transfer.
- The final response contains the real transaction hash.
- The transaction appears in the explorer or WDK history.

### Wave 4 gate

The demo handles these expected errors clearly:

- Wallet locked.
- Insufficient balance.
- Invalid recipient address.
- Unsupported network or token.
- RPC unavailable.
- WDK preview failure.
- WDK broadcast failure.
- Confirmation without a pending preview.

## 12. Testing strategy

### Unit tests

- Session creation.
- Pending preview stored after a dry-run.
- `confirm` detected only when a preview exists.
- `cancel` clears the pending preview.
- WDK errors become structured API errors.

### API tests

- Fastify routes through `inject`.
- Wallet read endpoints with mocked WDK results.
- Message endpoint for balance queries.
- Message endpoint for transfer preview.
- Confirmation and cancellation flows.

### Real WDK smoke

- MCP connection.
- `get_address`.
- `get_balance`.
- `send_token` with `dryRun: true`.
- One manual-gated `send_token` with `dryRun: false` on testnet.

There are no production security, concurrency, replay, or persistence tests in this demo scope.

## 13. Demo runbook

The recorded demo is API-only:

1. Unlock the dedicated WDK wallet with a finite TTL.
2. Start the Fastify service.
3. Call `GET /health`.
4. Call the wallet address and balance endpoints.
5. Create a session.
6. Ask the agent for the current balance.
7. Ask the agent to send a small amount to the recipient.
8. Show the WDK dry-run preview.
9. Send `Confirm` in the same session.
10. Show the real transaction hash and explorer page.
11. Ask for wallet history and show the transaction when supported.
12. Demonstrate `Cancel` with a second preview.
13. Lock the wallet after recording.

## 14. Planned cuts

If time is short, cut in this order:

1. Transaction history.
2. Token transfers in favor of native testnet asset.
3. OpenAPI generation.
4. Streaming responses.
5. Contact aliases or address-book support.

Never cut:

- Direct WDK MCP integration.
- `send_token` exposed to the LLM.
- WDK dry-run preview.
- Conversational confirmation.
- One real testnet broadcast.
- Real transaction hash in the demo.

## 15. Out of scope

- Frontend or mobile application.
- Production wallet security.
- Mainnet or real funds.
- Policy engine and spending limits.
- Transaction fingerprints and idempotency.
- Dedicated approval or transaction-decision endpoint.
- Persistent database.
- Multiuser authentication.
- Smart accounts, multisig, or session keys.
- Swaps, bridges, lending, and arbitrary contracts.
- Recurring or autonomous background payments.
- Production deployment.

## 16. Definition of Done

The demo is complete when:

- [ ] WDK Core and the scoped WDK CLI are installed with exact versions documented.
- [ ] `wdk-mcp` is connected to the AI SDK MCP client.
- [ ] `ToolLoopAgent` receives the raw WDK MCP tools, including `send_token`.
- [ ] The API returns the real wallet address and balance.
- [ ] The agent answers wallet questions from WDK tool results.
- [ ] A natural-language payment request calls `send_token` with `dryRun: true`.
- [ ] The agent asks the user to confirm the preview.
- [ ] `Confirm` calls `send_token` again with `dryRun: false`.
- [ ] `Cancel` does not broadcast.
- [ ] A real testnet transaction succeeds.
- [ ] The agent returns the real transaction hash and explorer link.
- [ ] Three consecutive demo runs succeed.
- [ ] Unit and API tests pass.
- [ ] A clean clone can reproduce the setup.
- [ ] The video shows the entire conversation-to-transaction flow without mocks.
- [ ] The submission includes WDK package versions, network/token details, setup commands, code permalinks, and the video.

## 17. Canonical references

- [Aleph Hackathon 2026 — WDK Track](https://hacki.crecimiento.build/h/aleph-hackathon-2026/tracks/wdk-track)
- [WDK CLI — Use the MCP Server](https://docs.wdk.tether.io/cli/guides/use-mcp-server/)
- [WDK CLI — Security Model](https://docs.wdk.tether.io/cli/reference/security-model/)
- [WDK MCP Toolkit](https://docs.wdk.tether.io/ai/mcp-toolkit/)
- [AI SDK Core — Model Context Protocol](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools)
- [AI SDK Core — ToolLoopAgent](https://ai-sdk.dev/docs/reference/ai-sdk-core/tool-loop-agent)
