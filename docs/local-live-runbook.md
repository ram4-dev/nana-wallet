# Nana local live runbook

This is the safe local procedure for the complete fixture or WDK-backed Nana
experience. Supabase owns durable conversations and recipient memory. Fastify
and the LiveKit worker run independently; the worker is required only for web
live voice. Packaged Capacitor builds retain recorded capture and playback.

## Guardrails

- Use a dedicated, limited-funds Sepolia wallet. Never configure mainnet.
- Keep `.env` and `.env.local` ignored. Provider secrets never enter `VITE_*` values.
- Fixture mode is the default and cannot be treated as blockchain evidence.
- Every transfer requires a canonical preview and an explicit allowlisted confirmation.
- Voice, touch, reconnect, and typed fallback share one durable transfer claim.
- A claimed broadcast continues after speech interruption or room closure; an uncertain result blocks rebroadcast.
- No application or LiveKit recording is created. Egress and observability recording remain disabled.

## Prerequisites and setup

- Node.js 22.18 or newer, npm, Docker Desktop, and Supabase CLI 2.80.0.
- For live WDK mode, a configured Sepolia wallet and WDK indexer access.
- For web live voice, a LiveKit Cloud development project and Ed25519 binding pair.

```bash
npm ci
cd apps/nana-wallet && npm ci && cd ../..
cp .env.example .env
cp apps/nana-wallet/.env.example apps/nana-wallet/.env.local
npx supabase start
npx supabase db reset
```

Use the local Supabase connection from `.env.example`:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
```

Do not add `DATABASE_ADMIN_URL` to the application. Administrative migration
work is performed by Supabase CLI; runtime repository access uses the
restricted `recipient_app` role and transaction-local tenant identity.

## Fixture mode

Fixture mode avoids WDK, Cloud, model, and speech credentials:

```dotenv
WDK_TOOLS_SOURCE=fixture
AGENT_RUNTIME=deterministic
LIVE_VOICE_ENABLED=false
VOICE_TRACE_ENABLED=false
```

Run the API and wallet independently:

```bash
# Terminal 1
npm run dev
```

```bash
# Terminal 2
cd apps/nana-wallet && npm run dev -- --host 0.0.0.0 --port 8083
```

For browser live voice, add the development LiveKit and binding values from
`docs/livekit-development-runbook.md`, then start a third terminal:

```bash
npm run livekit:dev
```

Complete a typed balance turn, a voice balance turn, and a fixture transfer
preview. Refresh the page and verify the same conversation state and preview
are returned by `GET /v1/conversations/:id/state`.

## WDK live mode

Configure only Sepolia and explicit policy values:

```dotenv
WDK_TOOLS_SOURCE=live
AGENT_RUNTIME=llm
WDK_WALLET_NAME=agent-dev
WDK_NETWORK=sepolia
WDK_TOKEN=USDT
WDK_MAX_TRANSFER_AMOUNT=0.05
WDK_ALLOWED_RECIPIENTS=0x1111111111111111111111111111111111111111
```

Keep API, WDK, worker, and wallet processes in separate terminals. Unlock only
for the test window and lock afterward:

```bash
npx wdk wallet unlock --name agent-dev --ttl 30
npm run dev
npm run livekit:dev
cd apps/nana-wallet && npm run dev -- --host 0.0.0.0 --port 8083
```

Before any transfer, verify the process is live rather than fixture mode:

```bash
curl -fsS http://localhost:3000/health | jq
curl -fsS 'http://localhost:3000/v1/wallet/balance?network=sepolia&token=USDT' | jq
```

Stop if health reports `mode: fixture`, a wallet is locked, the network is not
`sepolia`, or policy validation is missing. A live transfer may broadcast only
through the separately approved manual harness with `WDK_LIVE=1`; adding
`WDK_ALLOW_BROADCAST=1` and `WDK_BROADCAST_APPROVED=1` is required for the
actual broadcast path. The normal test suite never enables those gates.

## Decision and recovery checks

1. Request a small transfer and inspect network, token, destination, amount, and fee.
2. Confirm with an explicit phrase or the visible Confirm control.
3. Confirm that the progress card moves through broadcasting and verification.
4. Interrupt speech during verification; interruption must not resend or cancel the transaction.
5. End voice with unresolved work only after acknowledging that financial work continues.
6. Reconnect or switch to typed mode and inspect the same durable state.
7. Confirm `yes` or `sí` alone never approves a transfer.

If a worker is terminated, it stops accepting room jobs, drains registered
financial tasks for the configured timeout, closes providers, and closes the
database last. A task that cannot finish remains fail-closed. Inspect history
and receipt evidence before any operator reconciliation; never retry an
ambiguous send automatically.

## Stop and clean up

```bash
npx wdk wallet lock --name agent-dev
npx supabase stop
```

Keep the Supabase volume when local recipient memory is needed. Use
`npx supabase db reset` only when intentionally erasing local data. Remove
temporary LiveKit rooms from the Cloud console and verify Egress remains off.
