# HTTP API

Base URL: `http://localhost:3000` (or `PORT` from `.env`).

All responses are JSON. Request/response shapes are defined as zod schemas in
`src/contracts/http.ts` — that file is the source of truth; the examples
below are illustrative.

## `GET /health`

```json
{
  "status": "ok",
  "mode": "fixture",
  "mcp": "connected",
  "wallet": "unlocked",
  "network": "sepolia"
}
```

`mcp` and `wallet` are probed live on each call (`get_networks` / `get_address`
against the configured `WDK_NETWORK` + `WDK_WALLET_NAME`). In fixture mode
(`WDK_TOOLS_SOURCE=fixture`, the default) both always report healthy.

## `GET /v1/wallet/address`

```json
{ "network": "sepolia", "address": "0x1234...abcd" }
```

## `GET /v1/wallet/balance?network=sepolia&token=USDT`

`token` is optional (native balance when omitted).

```json
{ "network": "sepolia", "token": "USDT", "address": "0x1234...abcd", "balance": "42.5" }
```

## `GET /v1/wallet/history?network=sepolia&token=USDT`

```json
{
  "network": "sepolia",
  "transactions": [
    {
      "hash": "0x...",
      "direction": "in",
      "counterparty": "0x...",
      "amount": "5",
      "token": "USDT",
      "timestamp": "2026-08-21T18:00:00.000Z"
    }
  ]
}
```

## `POST /v1/sessions`

No body. Creates an in-memory conversation session.

```json
{ "sessionId": "b1f0...", "status": "active" }
```

## `GET /v1/sessions/:sessionId`

```json
{
  "id": "b1f0...",
  "messages": [
    { "role": "user", "content": "How much USDT do I have?" },
    { "role": "assistant", "content": "You have 42.5 USDT." }
  ],
  "pendingTransfer": null,
  "lastTransactionHash": null,
  "createdAt": "2026-08-22T20:00:00.000Z"
}
```

`404` with `{ "status": "error", "message": "Session not found.", "code": "session_not_found" }`
for an unknown id.

## `POST /v1/sessions/:sessionId/messages`

Body: `{ "message": "Send 10 USDT to 0x1234...abcd" }`

The response `status` is one of:

| `status` | When | Shape |
| --- | --- | --- |
| `answer` | A wallet question was answered from tool results. | `{ status, message }` |
| `clarification_required` | Recipient retrieval found more than one safe candidate. | `{ status, message, candidates: [{ id, name, description, version, evidence?, score? }] }` |
| `confirmation_required` | A transfer dry-run preview was produced. | `{ status, message, preview: { network, token, recipient, amount, estimatedFee } }` |
| `sent` | A confirmed transfer was broadcast. | `{ status, message, transaction: { network, transactionHash, explorerUrl } }` |
| `cancelled` | The user cancelled a pending transfer. | `{ status, message }` |
| `error` | Session missing, no pending preview to confirm, agent failure, or a WDK error. | `{ status, message, code }` |

`error.code` values currently in use: `session_not_found`, `no_pending_preview`,
`confirmation_required` (model attempted to broadcast without a matching
preview — the guarded `send_token` wrapper rejected it), `agent_error`.

HTTP status codes: `200` for `answer` / `confirmation_required` / `sent` /
`cancelled`, `422` for `error`, `404` for an unknown session, `400` for an
invalid request body.

## Recipient-memory behaviour

When `RECIPIENT_MEMORY_ENABLED=true`, a named or relationship recipient goes
through the server-configured `DEMO_USER_ID`; the client cannot send a tenant
ID. Search output can include a stable recipient ID, version, name,
description, evidence, and score, but never an address. The exact address is
an internal, session-bound tool result only after safe resolution.

`GET /v1/sessions/:sessionId` may contain this safe inspection data:

```json
{
  "recipientMemory": {
    "selectedRecipient": {
      "recipientId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      "version": 1
    },
    "clarification": [
      {
        "recipientId": "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        "version": 1,
        "name": "Lucas",
        "description": "el electricista"
      }
    ],
    "pendingWrite": { "expiresAt": "2026-08-23T20:00:00.000Z" }
  }
}
```

The endpoint never returns a staged draft, exact address, or memory-write
confirmation ID. A changed, inactive, or missing recipient invalidates the
pending preview before WDK can receive `dryRun: false`.
