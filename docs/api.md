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

## `POST /v1/conversations`

No body. Creates a durable conversation for the server-resolved demo identity.
The identity is never accepted from the request body.

```json
{ "conversationId": "b1f0...", "mode": "typed" }
```

## `GET /v1/conversations/:conversationId/state`

Returns the small canonical projection used by typed mode, LiveKit revision
notifications, reconnect, and financial cards. It does not return raw audio or
the full model context.

```json
{
  "revision": 18,
  "mode": "live",
  "activity": "awaiting_confirmation",
  "progress": { "phase": "awaiting_confirmation", "label": "Transfer preview ready for confirmation" },
  "pendingTransfer": { "previewId": "c0de...", "network": "sepolia", "token": "USDT", "recipient": "0x...", "amount": "10", "estimatedFee": "0.001 ETH" }
}
```

Responses include `ETag: "conversation-18"` and
`Cache-Control: private, no-store`. A matching `If-None-Match` returns `304`.

## `POST /v1/conversations/:conversationId/turns`

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

## `POST /v1/conversations/:conversationId/decisions`

Touch confirmation and cancellation use the same compare-and-set claim as a
spoken decision in the LiveKit worker.

```json
{ "previewId": "c0de...", "decision": "confirm" }
```

The response is `{ "accepted", "revision", "state" }`. A stale preview,
repeated decision, or uncertain broadcast returns `accepted: false` and never
starts another broadcast.

## `POST /v1/conversations/:conversationId/end-live`

Commits `live` to `typed` before the browser disconnects. `expectedRevision` is
required. If a preview, broadcast, receipt check, or uncertain result exists,
the request also requires `acknowledgeUnresolvedFinancialWork: true`; ending
voice does not cancel financial work.

## `POST /v1/live-bindings`

Issues a short-lived EdDSA binding for the server-resolved demo user. The
development LiveKit token is a separate media credential. The binding token is
opaque and is never returned by state inspection, room data, traces, or logs.

```json
{ "conversationId": "b1f0..." }
```

```json
{ "conversationId": "b1f0...", "bindingToken": "eyJ..." }
```

`503 voice_unavailable` means the API private binding key is not configured.
Production must replace the demo identity and issue authenticated LiveKit
tokens from Fastify.

## Recipient-memory behaviour

When `RECIPIENT_MEMORY_ENABLED=true`, a named or relationship recipient goes
through the server-configured `DEMO_USER_ID`; the client cannot send a tenant
ID. Search output can include a stable recipient ID, version, name,
description, evidence, and score, but never an address. The exact address is
an internal, session-bound tool result only after safe resolution.

The state projection may contain this safe inspection data:

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

## Legacy routes and privacy

`/v1/sessions` and the process-local session store are removed; clients use
conversation routes exclusively. The recorded-turn transcription and speech
routes remain only for the packaged Capacitor path.

The API persists no microphone or synthesized audio. LiveKit Egress and
observability recording are disabled. Detailed voice traces are disabled by
default, and development traces are redacted and limited to seven days. Public
responses never contain provider payloads, keys, addresses, amounts, or stack
traces.
