# LiveKit development runbook

This runbook starts the web MVP as independent development processes. It is a
single-demo-user setup, not an authentication design. `DEMO_USER_ID`,
development LiveKit tokens, and development binding keys must not be used for
multiuser or production wallet access.

## Privacy and retention contract

- The application persists no microphone audio, synthesized audio, or replayable recordings.
- Agent sessions use `record: false`; LiveKit Egress and automatic Egress stay disabled.
- Deepgram uses LiveKit Inference with `mip_opt_out=true` and the documented ZDR path.
- ElevenLabs logging is disabled only when the account's zero-retention capability has been verified. Otherwise provider defaults apply and may retain request history.
- Content-free phase counters and latency aggregates are safe to keep with normal operational telemetry.
- Detailed traces are disabled by default. Development traces require explicit `VOICE_TRACE_ENABLED=true`, are redacted before storage, and expire after no more than seven days.
- Production traces additionally require privacy approval, a retention destination, an audited access role, and a deletion mechanism. Raw audio, provider payloads, keys, addresses, names, tokens, amounts, and balances never belong in traces.

Review the LiveKit Cloud project before a test window. Confirm that Egress,
auto-Egress, room recording, and Agent Observability recording are disabled.
Record any remaining ElevenLabs retention limitation in the deployment notes.

## Prerequisites

- Node.js 22.18 or newer and npm.
- Supabase CLI 2.80.0 and Docker Desktop.
- A LiveKit Cloud development project with an agent registered for the configured name.
- An Ed25519 key pair generated outside the repository.

Generate a development key pair without committing it:

```bash
openssl genpkey -algorithm Ed25519 -out /tmp/nani-live-private.pem
openssl pkey -in /tmp/nani-live-private.pem -pubout -out /tmp/nani-live-public.pem
```

## Configure the processes

From the repository root:

```bash
npm ci
cd apps/nana-wallet && npm ci && cd ../..
cp .env.example .env
cp apps/nana-wallet/.env.example apps/nana-wallet/.env.local
npx supabase start
npx supabase db reset
```

Put provider secrets in the root `.env`, never in a `VITE_*` variable:

```dotenv
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
WDK_TOOLS_SOURCE=fixture
AGENT_RUNTIME=deterministic
LIVE_VOICE_ENABLED=true
LIVE_VOICE_BINDING_PRIVATE_KEY=-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----
LIVE_VOICE_BINDING_PUBLIC_KEY=-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----
LIVEKIT_URL=wss://your-project.livekit.cloud
LIVEKIT_API_KEY=development-key
LIVEKIT_API_SECRET=development-secret
ELEVENLABS_API_KEY=development-provider-key
LIVEKIT_TTS_PROVIDER=elevenlabs
# Development fallback when the ElevenLabs account cannot use API voices:
# LIVEKIT_TTS_PROVIDER=inference
# LIVEKIT_TTS_MODEL=cartesia/sonic-3
# LIVEKIT_TTS_VOICE=5c5ad5e7-1020-476b-8b91-fdcbe9cc313c
LIVEKIT_RECORDING_ENABLED=false
AGENT_OBSERVABILITY_RECORDING=false
VOICE_TRACE_ENABLED=false
VOICE_TRACE_RETENTION_DAYS=7
```

The API needs the private binding key to issue grants. The worker receives the
public key and refuses to start without its LiveKit credentials, database
identity, and ElevenLabs credential. `readApiProcessConfig` and
`readWorkerProcessConfig` reject malformed values before a process starts.

In the wallet `.env.local`, configure only public development values:

```dotenv
VITE_API_URL=http://localhost:3000
VITE_AGENT_BACKEND=1
VITE_LIVEKIT_TOKEN_SERVER_ID=your-development-token-server-id
VITE_LIVEKIT_AGENT_NAME=nani-agent
VITE_LIVEKIT_PARTICIPANT_IDENTITY=11111111-1111-4111-8111-111111111111
```

The browser asks LiveKit Cloud's development token server for a short-lived
room token at session start. The token server ID is public development
configuration; API keys, API secrets, and binding private keys must not be
placed in `VITE_*` values. The returned media credential is scoped to the room
and agent requested by the browser, while the signed Fastify binding remains
the worker's application identity check.

## Start independently

Use three terminals from the repository root:

```bash
# Terminal 1: Fastify HTTP boundary
npm run dev
```

```bash
# Terminal 2: LiveKit worker
npm run livekit:dev
```

```bash
# Terminal 3: wallet web app
cd apps/nana-wallet
npm run dev -- --host 0.0.0.0 --port 8083
```

Open `http://localhost:8083`, tap Nani, and complete a nonfinancial Spanish
or English turn. The browser publishes the microphone before it binds the
conversation so the agent input stream receives the first track. The screen
receives canonical financial revisions from Fastify, not financial payloads
from room data.

## Safe verification commands

Run deterministic checks without Cloud, WDK, model, or provider credentials:

```bash
npm run typecheck
npm run lint
npm test
npm run build
npm run test:simulation
npm run test:retention
npm --prefix apps/nana-wallet run lint
npm --prefix apps/nana-wallet run typecheck
npm --prefix apps/nana-wallet test
npm --prefix apps/nana-wallet run build
npm --prefix apps/nana-wallet run build:mobile
```

The provider-backed smoke is deliberately opt-in and does not call wallet
tools or move funds:

```bash
LIVEKIT_E2E=1 \
LIVEKIT_E2E_AGENT_NAME=nani \
LIVEKIT_E2E_BINDING_TOKEN='short-lived-token' \
LIVEKIT_E2E_BINDING_PUBLIC_KEY='public-key-pem' \
npm run test:e2e:livekit-smoke
```

The command fails closed when any required input is missing. A successful
smoke creates and deletes a temporary room, dispatches the configured agent,
and verifies the binding purpose, audience, issuer, and signature. It never
sets `WDK_ALLOW_BROADCAST` or `WDK_BROADCAST_APPROVED`.

## Shutdown and incident handling

Send SIGTERM or stop the worker with `Ctrl-C`. The worker stops accepting new
jobs, waits up to `LIVEKIT_SHUTDOWN_TIMEOUT_MS` for registered financial tasks,
then closes wallet providers and PostgreSQL. Room interruption or worker
shutdown never cancels a transfer after its database claim. A task that misses
the deadline remains in a durable `broadcasting` or `uncertain` state and must
be reconciled from transaction evidence; do not replay it.

For fixture runs, inspect the canonical state after shutdown and confirm that
an uncertain result blocks another financial action. For live WDK tests, keep
the existing explicit gates: `WDK_LIVE=1`, and additionally
`WDK_ALLOW_BROADCAST=1` plus `WDK_BROADCAST_APPROVED=1` for the separately
approved broadcast harness. Lock the dedicated limited-funds Sepolia wallet
after every live window.

## Production gap

Before multiuser production access, replace `DEMO_USER_ID` with a validated
bearer identity provider, issue LiveKit tokens from Fastify, rotate binding
keys with an overlap procedure, add authorization tests, rate limits, abuse
controls, and a reviewed trace deletion workflow. Development credentials and
this runbook do not provide those guarantees.
