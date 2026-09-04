# Nani E2E runbook

End-to-end run of the voice agent: OpenAI Realtime speech-to-speech + real wallet
tools, against the local Supabase Postgres and LiveKit Cloud. One command:

```bash
scripts/nani-e2e.sh          # start everything + health checks
scripts/nani-e2e.sh stop     # stop everything
```

The script is idempotent: re-running it with services already up is a no-op that
only re-checks health.

## Prerequisites

- Node.js 22.18+, npm; `portless` (`npm i -g portless`) and `vault-env` for secrets.
- Local Supabase stack running (`npx supabase start`) — container
  `supabase_db_nana-wallet-local` on `127.0.0.1:54322`.
- `node_modules` at the root and in `apps/nana-wallet`.
- A LiveKit Cloud project + an Ed25519 binding key pair generated outside the repo.

## Secrets and environment

Provider secrets never live in the repo. The script materializes them from the
Secret Vault with `vault-env` (values go vault → `.env` directly; they never pass
through terminal output):

```bash
vault-env to .env --append --names OPEN_AI_API_KEY,LIVEKIT_URL,LIVEKIT_API_KEY,LIVEKIT_API_SECRET,WDK_INDEXER_API_KEY
```

Required in `.env` for the E2E flow (the script appends the non-secret ones if
missing and fails closed listing anything still missing):

```dotenv
OPENAI_API_KEY=...                    # worker refuses to start without it
LIVEKIT_URL=LIVEKIT_API_KEY=LIVEKIT_API_SECRET=
LIVE_VOICE_ENABLED=true
LIVE_VOICE_BINDING_PRIVATE_KEY=...    # Ed25519 PEM, \n-escaped single line
LIVE_VOICE_BINDING_PUBLIC_KEY=...
LIVEKIT_AGENT_NAME=nani-agent         # must match the frontend VITE_LIVEKIT_AGENT_NAME
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
RECIPIENT_MEMORY_ENABLED=true         # real contacts search; without it
                                      # search_contacts fails closed (unavailable)
```

Frontend (`apps/nana-wallet/.env.local`, public values only):

```dotenv
VITE_API_URL=https://nani-api.localhost
VITE_AGENT_BACKEND=1
VITE_LIVEKIT_TOKEN_SERVER_ID=<livekit-cloud-sandbox-token-server-id>
VITE_LIVEKIT_AGENT_NAME=nani-agent
VITE_LIVEKIT_PARTICIPANT_IDENTITY=11111111-1111-4111-8111-111111111111
```

## Wallet mode

- `WDK_TOOLS_SOURCE=fixture` (default): balance and broadcast are simulated.
  Zero risk; recommended for the first E2E pass.
- `WDK_TOOLS_SOURCE=live`: real Sepolia wallet via WDK. Requires the WDK wallet
  created/unlocked by a human (`./node_modules/.bin/wdk wallet unlock --name
  agent-dev --ttl 5`), `WDK_MAX_TRANSFER_AMOUNT` and `WDK_ALLOWED_RECIPIENTS`
  set, and the wallet funded with Sepolia gas. Transfers are gated by policy:
  over-cap amounts and non-allowlisted recipients are narrated as
  `policy_rejected` — that is the guard working, not a bug.

## The voice test script

Open `https://nana-wallet.localhost` (hard-reload after env changes: vite caches
env at startup) and speak to Nani:

1. **"¿Cuánto tengo?"** → `get_balance` (provider balance).
2. **"¿Le puedo mandar plata a Lucas?"** → `search_contacts` → two Lucases → the
   agent must ask which one (ambiguity from the DB classification).
3. **"Para Lucas Herrera, 1 USDT"** → `send_token` preview → spoken preview +
   Confirm/Cancel card in the UI (same persisted `pendingTransfer`).
4. **"Confirmá"** → `confirm_transfer` → broadcast → receipt narrated. The UI
   card and the voice confirm arbitrate on the same DB claim: only one wins.
5. **Cancel by voice** ("cancelá") or the card's Cancel → no broadcast.
6. **Barge-in**: interrupt Nani mid-speech; the realtime turn is cancelled
   cleanly (`turn_detected`).

Latency per turn (first audio + tool breakdown) is logged to
`/tmp/nani-worker.log` as `realtime_turn_latency`.

## Troubleshooting (everything that bit us, so you don't re-learn it)

| Symptom | Cause | Fix |
| --- | --- | --- |
| Worker FATAL `getaddrinfo ENOTFOUND <project>.livekit.cloud` | Transient DNS/network blip | Re-run `scripts/nani-e2e.sh`; verify with `nslookup` |
| Job dispatched but binding fails (`ok:false`) | Another worker with the same (empty) name registered on the LiveKit project stole the job and validates a different binding key | Name your worker (`LIVEKIT_AGENT_NAME`) and match it in `VITE_LIVEKIT_AGENT_NAME` |
| `search_contacts` returns `status:"unavailable"`, count 0 | `RECIPIENT_MEMORY_ENABLED` not `true` → memory service absent, tool fails closed | Enable it in `.env` and restart the worker |
| First `search_contacts` very slow (40s+) | 470 MB fp32 ONNX model never finished downloading; interrupted downloads leave `.onnx.tmp.*` and every call re-downloads | `rm .cache/recipient-memory-model/**/onnx/*.tmp.*`; download `model.onnx` once from HF (resume with `curl -C -`); after that: load ~1.5 s, inference ~9 ms |
| CORS error on `/v1/conversations/:id/state` (`if-none-match`) | ETag conditional reads not in the CORS allowlist | Already fixed in `src/server.ts` (`If-None-Match`, `If-Modified-Since`) |
| Voice button says "La voz no está disponible" | Missing `apps/nana-wallet/.env.local` VITE vars | Copy from `.env.example` and set `VITE_LIVEKIT_TOKEN_SERVER_ID` + participant identity |
| Confirm/Cancel card never appears | Tool wrote in-memory only, or revision not published | The preview path must persist via the repository and publish via `financialTasks`; covered by tests (V8.4) |
| Live mode: EVERY `send_token` returns `policy_rejected` | Recreated `.env` (from template) lacks `WDK_MAX_TRANSFER_AMOUNT` / `WDK_ALLOWED_RECIPIENTS` — live policy fails closed when absent. Same class: wallet name/token defaults (`agent-demo`/`USDT`) don't match a machine's created wallet | Add the policy vars + the real `WDK_WALLET_NAME`/`WDK_TOKEN` to `.env`, restart the stack (`scripts/nani-e2e.sh`) |

## Architecture invariants (do not break)

- The model never sees recipient addresses: `search_contacts` returns stripped
  candidates; the payee address travels only inside the service machinery.
- Broadcast happens exclusively through `confirm_transfer`/`resolveDecision`;
  the voice `send_token` schema is preview-only (`zod .strict()`, no `dryRun`,
  no free-form `to`).
- One active transfer per conversation is enforced by the partial unique index +
  atomic `claimPendingTransfer` — voice confirm and UI confirm arbitrate on it.
- Revisions to the frontend flow through `financialTasks.publish(state-revision)`;
  never publish from livekit code directly.