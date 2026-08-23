# Demo runbook

Mirrors §13 of `docs/wdk-agent-development-plan.md`. Run against fixtures
first (`WDK_TOOLS_SOURCE=fixture`, the default) to rehearse, then switch to
`WDK_TOOLS_SOURCE=live` once Developer A's wallet is unlocked and `wdk-mcp`
is confirmed working, for the real recorded take.

## 0. Setup

```bash
cp .env.example .env       # fill in OPENCODE_GO_API_KEY, and WDK_* once Dev A confirms
npm install
npm run dev                # Fastify on http://localhost:3000
```

For the live take only — done by Developer A before starting the API:

```bash
wdk wallet unlock --name agent-demo --ttl 60
```

## 1. Health check

```bash
curl -s http://localhost:3000/health | jq
```

## 2. Wallet address + balance

```bash
curl -s http://localhost:3000/v1/wallet/address | jq
curl -s "http://localhost:3000/v1/wallet/balance?network=sepolia&token=USDT" | jq
```

## 3. Create a session

```bash
SESSION_ID=$(curl -s -X POST http://localhost:3000/v1/sessions | jq -r .sessionId)
echo "$SESSION_ID"
```

## 4. Ask for the current balance in natural language

```bash
curl -s -X POST "http://localhost:3000/v1/sessions/$SESSION_ID/messages" \
  -H 'Content-Type: application/json' \
  -d '{"message": "How much USDT do I have?"}' | jq
```

## 5. Ask the agent to send a small amount

```bash
curl -s -X POST "http://localhost:3000/v1/sessions/$SESSION_ID/messages" \
  -H 'Content-Type: application/json' \
  -d '{"message": "Send 10 USDT to 0x1234...abcd"}' | jq
```

Expect `status: "confirmation_required"` with a `preview` — no broadcast yet.

## 6. Confirm

```bash
curl -s -X POST "http://localhost:3000/v1/sessions/$SESSION_ID/messages" \
  -H 'Content-Type: application/json' \
  -d '{"message": "Confirm"}' | jq
```

Expect `status: "sent"` with a real `transaction.transactionHash` (live mode)
or a fixture hash (rehearsal mode). Open `transaction.explorerUrl` on the live
take.

## 7. Wallet history

```bash
curl -s "http://localhost:3000/v1/wallet/history?network=sepolia" | jq
```

## 8. Cancel flow (second session)

```bash
SESSION_ID_2=$(curl -s -X POST http://localhost:3000/v1/sessions | jq -r .sessionId)
curl -s -X POST "http://localhost:3000/v1/sessions/$SESSION_ID_2/messages" \
  -H 'Content-Type: application/json' \
  -d '{"message": "Send 5 USDT to 0x1234...abcd"}' | jq
curl -s -X POST "http://localhost:3000/v1/sessions/$SESSION_ID_2/messages" \
  -H 'Content-Type: application/json' \
  -d '{"message": "Cancel"}' | jq
```

Expect `status: "cancelled"` and no second `send_token` broadcast call.

## 9. Wrap up (live take only)

```bash
wdk wallet lock --name agent-demo
```

Restarting the Fastify process clears all sessions (in-memory only) — start
a fresh `POST /v1/sessions` after any restart.
