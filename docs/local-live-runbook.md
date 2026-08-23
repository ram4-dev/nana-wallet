# Nana + WDK local live runbook

This is the canonical way to run the complete Nana experience locally: the
frontend on port 8083, the WDK API on port 3001, local Postgres/RAG, voice,
and a real **Sepolia-only** wallet. It deliberately does not deploy a wallet
or a secret to a remote platform.

## Guardrails

- Use a dedicated, limited-funds Sepolia wallet. Never point this setup at
  mainnet.
- Keep `.env` local and ignored. It contains provider credentials; do not copy
  values into `VITE_*` variables or commit them.
- A transfer can only broadcast after a live preview and an explicit text or
  voice confirmation in the same backend session.
- Both preview and broadcast are blocked unless the exact configured wallet,
  network, and token are used, the amount is within the decimal spending cap,
  and the recipient is a valid, non-burn address on the case-insensitive
  allowlist.
- The address book is local Postgres data. The sample seed is demo-only and
  must not be used as a real recipient list.

## Prerequisites

- Node.js 22.22+ and npm.
- Docker Desktop.
- A configured WDK wallet profile and registered Sepolia token. For this demo:
  `agent-dev` and `usdt-test` point to the funded test wallet/token.
- API credentials for the LLM, NaN transcription, ElevenLabs speech, and WDK
  indexer. Keep them in your local secret vault or `.env`; this document names
  variables but never includes their values.

Check the WDK profile without exposing its seed:

```bash
npx wdk wallet list
npx wdk token list --network sepolia
```

## One-time setup

From the repository root:

```bash
npm ci
cd apps/nana-wallet && npm ci && cd ../..
cp .env.example .env
cp apps/nana-wallet/.env.example apps/nana-wallet/.env.local
docker compose up -d db
```

Configure the backend `.env` with real values for the credential variables
already listed in `.env.example`, then set these non-secret values:

```dotenv
PORT=3001
WDK_TOOLS_SOURCE=live
WDK_WALLET_NAME=agent-dev
WDK_NETWORK=sepolia
WDK_TOKEN=usdt-test
# Required in live mode. Replace the example with approved Sepolia recipients.
WDK_MAX_TRANSFER_AMOUNT=0.05
WDK_ALLOWED_RECIPIENTS=0x1111111111111111111111111111111111111111
AGENT_RUNTIME=llm
CORS_ORIGINS=http://localhost:8083,http://127.0.0.1:8083

RECIPIENT_MEMORY_ENABLED=true
DATABASE_URL=postgresql://recipient_app@127.0.0.1:5432/wdk_agent
DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/wdk_agent
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
RECIPIENT_MEMORY_MODEL_CACHE=.cache/recipient-memory-model
```

Set the frontend file to use the API instead of MSW:

```dotenv
VITE_API_URL=http://localhost:3001
VITE_AGENT_BACKEND=1
```

Initialize the durable local dependencies once. Do not run `db:seed` when the
database already contains real recipients.

```bash
npm run db:migrate
npm run memory:prefetch
```

## Start a live session

Use three terminals from the repository root.

```bash
# Terminal 1: unlock only for the test window; it starts the local WDK daemon.
npx wdk wallet unlock --name agent-dev --ttl 30
```

```bash
# Terminal 2: API + WDK + RAG
npm run dev
```

```bash
# Terminal 3: Nana
cd apps/nana-wallet
npm run dev -- --host 0.0.0.0 --port 8083
```

Open <http://localhost:8083>.

## Required live preflight

Before using Nana, the API must report `"mode":"live"`. Anything else is a
fixture run and must not be treated as transaction evidence.

```bash
curl -fsS http://localhost:3001/health | jq
curl -fsS 'http://localhost:3001/v1/wallet/balance?network=sepolia&token=usdt-test' | jq
```

Expected health fields:

```json
{ "status": "ok", "mode": "live", "mcp": "connected", "wallet": "unlocked", "network": "sepolia" }
```

The balance response must show the expected Sepolia test token and a real
balance. If `mode` is `fixture`, stop, set `WDK_TOOLS_SOURCE=live`, and restart
the API. Do not confirm a preview from that process. If either live transfer
policy variable is missing, empty, malformed, or contains an invalid address,
the API rejects the transfer before calling WDK. The amount comparison is an
exact decimal comparison; exponent notation is not accepted.

## Conversational E2E

1. In Nana, send `Send 0.01 USDT to Lucas.` or `Send 0.01 USDT to my grandson.`
2. Check the displayed Sepolia network, recipient, amount, token, and fee.
3. Confirm by text or voice with an explicit phrase: `I confirm`, `yes, confirm`,
   `confirmo`, or `sí, confirmo`.
4. The API waits for the Sepolia receipt, then returns `Transfer confirmed.`

`yes`/`sí` on their own, a cancellation, or an ambiguous response never
broadcasts. Do not refresh or restart the API between preview and confirmation:
sessions are intentionally in-memory for this local demo.

## Stop and lock

Stop the two development servers with `Ctrl-C`, then lock the test wallet:

```bash
npx wdk wallet lock --name agent-dev
```

The Postgres volume remains so confirmed local recipient memory is preserved.
Use `docker compose down` to stop only the container; do not remove the volume
unless you deliberately want to erase that local memory.
