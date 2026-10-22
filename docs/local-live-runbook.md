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
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-csearch_path%3Dpublic,extensions
```

> **Remote primary vs. local stand-in.** The Nana Wallet primary is the
> isolated Supabase project `nana_app` (ref `jnhemqouecznsziytzhm`, region
> us-east-1, PostgreSQL 17.11). The repository is linked to it; all migrations
> and the `recipient_app` role bootstrap are applied. For future pushes, use
> the official `supabase` CLI v2.113.0 or newer and inspect
> `supabase db push --dry-run` first. The npm wrapper pinned in this repo is
> v2.80.0 and fails parsing `per_transfer_atomic6`. Nana Landing is the
> separate waitlist project. Keep this local URL, local `.env` files, and test
> suites local; provision deployed `DATABASE_URL` through the platform/Vault.
> Never migrate the waitlist data into Nana Wallet.

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

## Arc Testnet (Circle developer-controlled wallet)

`WDK_TOOLS_SOURCE=circle-arc` selects the Circle developer-controlled wallet
provider on Arc Testnet as an alternative to the WDK path. The provider is
built eagerly at process boot: missing or malformed credentials, or a
`WDK_NETWORK`/`WDK_TOKEN` that does not match the testnet-only shape, fail
the boot with `CircleArcConfigError`. There is no fixture fallback.

Required environment (credentials come from the Circle Console, Developer
Control section):

```dotenv
WDK_TOOLS_SOURCE=circle-arc
WDK_NETWORK=arc-testnet
WDK_TOKEN=USDC
CIRCLE_API_KEY=TEST_API_KEY:id:secret
CIRCLE_ENTITY_SECRET=64-hex-entity-secret
CIRCLE_SENDER_WALLET_ID=circle-wallet-uuid
# Live transfer policy — mandatory for circle-arc; transfers fail closed
# with policy_rejected when either value is absent or invalid.
WDK_MAX_TRANSFER_AMOUNT=0.05
WDK_ALLOWED_RECIPIENTS=0x1111111111111111111111111111111111111111
```

Trust model: Circle holds the wallet keys server-side under the developer
entity. The backend holds the entity secret as a production-grade secret
(never logged, never sent to any client); the user's device never signs.
Arc TESTNET only: chain id 5042002, USDC (18 decimals) exclusively, and no
mainnet configuration exists. The RPC chain id is verified before every
finality check, and a receipt that does not echo the requested hash can
never confirm a transfer.

`compose.yaml` pins no wallet variables; `.env` interpolation alone drives
`WDK_TOOLS_SOURCE=circle-arc` (verified with `docker compose config`). No
compose change is required.

`/health` gains an additive optional `provider` field under this mode:
`provider.status` is `healthy` when the Circle wallet responds, or
`unavailable` with a reason that never contains credential values. The
legacy `mode` (`live`), `network` (`arc-testnet`), `mcp`, and `wallet`
fields keep their meaning. `docs/api.md` is intentionally left untouched:
`/health` is not a `/v1` route and no `/v1` request/response shape changed.

### Manual E2E (real Circle credentials, real testnet USDC)

Explicit user consent is required before running any step: this exercise
moves real testnet USDC funded from a faucet and depends on live Circle and
Arc testnet services. Keep `WDK_MAX_TRANSFER_AMOUNT` small.

1. Set the environment above with real credentials and policy values, then
   boot the API (`npm run dev`) or `docker compose up`.
2. `curl -fsS http://localhost:3000/health | jq` — expect `mode: live`,
   `network: arc-testnet`, and `provider.status: healthy`.
3. Voice: ask for the balance (a real Arc RPC USDC value), then request a
   preview→confirm transfer below `WDK_MAX_TRANSFER_AMOUNT` to an
   allowlisted recipient. Confirm the narration never claims the transfer
   was sent before the on-chain receipt is verified.
4. Text: run the same preview→confirm through the typed API and verify the
   Confirm/Cancel card links to `testnet.arcscan.app/tx/{hash}`.
5. Negative: attempt an over-limit transfer and a non-allowlisted
   recipient; both must narrate `policy_rejected` without broadcasting.
6. Fund check: confirm the Arcscan transaction shows a real USDC transfer.
   The demo stays testnet-only.

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
