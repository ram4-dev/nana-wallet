#!/usr/bin/env bash
# Nani E2E launcher — starts the full voice-agent stack for end-to-end testing.
#
# What it does (idempotent):
#   1. Verifies prerequisites (docker DB, node_modules, portless, vault-env).
#   2. Materializes secrets from the Secret Vault via vault-env (values never
#      pass through the terminal output or agent context) when .env is missing.
#   3. Creates the frontend public env and generates development binding keys
#      when missing (Ed25519 pair, machine-local, gitignored).
#   4. Seeds demo contacts into the local Postgres when the table is empty.
#   5. Starts API + LiveKit worker + wallet frontend (portless routes).
#   6. Waits for every health check and prints the E2E test script. The worker
#      and frontend are relaunched (bounded) if transient LiveKit DNS blips or
#      an interrupted parent shell kill them mid-boot.
#
# Usage:
#   scripts/nani-e2e.sh          # start everything
#   scripts/nani-e2e.sh stop     # stop everything
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

log()  { printf '\033[1;34m[nani-e2e]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[nani-e2e] FATAL:\033[0m %s\n' "$*" >&2; exit 1; }

# Strip stray quoting characters that may have been materialized into .env values
# (e.g. literal '' placeholders), so the presence check tests the real content.
strip_quotes() { printf %s "$1" | sed "s/[\"']//g"; }

DB_CONTAINER="${NANI_DB_CONTAINER:-supabase_db_nana-wallet-local}"

stop_all() {
  log "stopping nani processes..."
  pkill -f "$ROOT.*src/livekit/worker.ts" 2>/dev/null || true
  pkill -f "job_proc_lazy_main" 2>/dev/null || true
  pkill -f "$ROOT.*tsx watch src/server.ts" 2>/dev/null || true
  pkill -f "$ROOT/apps/nana-wallet.*vite" 2>/dev/null || true
  sleep 1
  log "stopped."
}

if [[ "${1:-}" == "stop" ]]; then stop_all; exit 0; fi

# --- 1. prerequisites -------------------------------------------------------
docker ps --format '{{.Names}}' | grep -qx "$DB_CONTAINER" || \
  fail "container $DB_CONTAINER is not running. Start the local Supabase stack first (npx supabase start)."
[[ -d node_modules ]] || fail "no node_modules — run npm install at the repo root first."
[[ -d apps/nana-wallet/node_modules ]] || fail "no frontend node_modules — run npm install in apps/nana-wallet."
command -v portless >/dev/null || fail "portless is not installed (npm i -g portless)."
command -v vault-env >/dev/null || log "vault-env not found — secrets must already be in .env."

# --- 2. env materialization -------------------------------------------------
if [[ ! -f .env ]]; then
  log "no .env found — materializing secrets from the Secret Vault (vault-env)..."
  cp .env.example .env
  if command -v vault-env >/dev/null; then
    vault-env to .env --append --names OPEN_AI_API_KEY,LIVEKIT_URL,LIVEKIT_API_KEY,LIVEKIT_API_SECRET,WDK_INDEXER_API_KEY
    sed -i '' 's/^OPEN_AI_API_KEY=/OPENAI_API_KEY=/' .env
  fi
fi

# Frontend public config (gitignored). Only public dev values live here.
if [[ ! -f apps/nana-wallet/.env.local ]]; then
  log "creating apps/nana-wallet/.env.local from template..."
  sed -e 's|VITE_API_URL=http://localhost:3000|VITE_API_URL=https://nani-api.localhost|' \
      -e "s|VITE_LIVEKIT_TOKEN_SERVER_ID=$|VITE_LIVEKIT_TOKEN_SERVER_ID=${NANI_LIVEKIT_TOKEN_SERVER_ID:-testnanna-bwstps}|" \
      apps/nana-wallet/.env.example > apps/nana-wallet/.env.local
fi

# --- 3. required env vars (fail closed with the missing name) ---------------
required_env=(
  OPENAI_API_KEY LIVEKIT_URL LIVEKIT_API_KEY LIVEKIT_API_SECRET
  LIVE_VOICE_BINDING_PRIVATE_KEY LIVE_VOICE_BINDING_PUBLIC_KEY
  DATABASE_URL DEMO_USER_ID LIVEKIT_AGENT_NAME
)
missing=()
for v in "${required_env[@]}"; do
  # Last occurrence wins: the template may hold an empty placeholder before the
  # vault-materialized value appended later in the file.
  val="$(strip_quotes "$(grep -E "^${v}=" .env | cut -d= -f2- | tail -1)")"
  [[ -n "$val" ]] || missing+=("$v")
done
if ((${#missing[@]} > 0)) && [[ " ${missing[*]} " == *" LIVE_VOICE_BINDING_PRIVATE_KEY "* ]]; then
  # Development Ed25519 binding keys are machine-local (gitignored .env); generate
  # them on first run instead of failing. macOS system openssl may lack Ed25519,
  # so generate through Node crypto (available in the toolchain).
  log "generating development Ed25519 binding key pair (via node crypto)..."
  node -e 'const { generateKeyPairSync } = require("node:crypto");
const oneline = (pem) => pem.trim().replace(/\n/g, "\\\\n");
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log(JSON.stringify({
  priv: oneline(privateKey.export({ type: "pkcs8", format: "pem" })),
  pub: oneline(publicKey.export({ type: "spki", format: "pem" })),
}));' > /tmp/nani-e2e-binding.json
  if [[ -s /tmp/nani-e2e-binding.json ]]; then
    priv_pem="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/nani-e2e-binding.json","utf8")).priv)')"
    pub_pem="$(node -e 'console.log(JSON.parse(require("fs").readFileSync("/tmp/nani-e2e-binding.json","utf8")).pub)')"
    # Replace placeholder lines (they may hold empty '' from a prior materialization).
    sed -i '' "s|^LIVE_VOICE_BINDING_PRIVATE_KEY=.*|LIVE_VOICE_BINDING_PRIVATE_KEY=${priv_pem}|" .env
    sed -i '' "s|^LIVE_VOICE_BINDING_PUBLIC_KEY=.*|LIVE_VOICE_BINDING_PUBLIC_KEY=${pub_pem}|" .env
    rm -f /tmp/nani-e2e-binding.json
    missing=()
    for v in "${required_env[@]}"; do
      val="$(strip_quotes "$(grep -E "^${v}=" .env | cut -d= -f2- | tail -1)")"
      [[ -n "$val" ]] || missing+=("$v")
    done
  fi
fi
((${#missing[@]} == 0)) || fail "missing required env vars: ${missing[*]} (secrets: vault-env to .env --append --names ...; binding keys: auto-generated or see docs/livekit-development-runbook.md)"

# Live-voice + recipient memory must be enabled for the E2E flow.
grep -q '^LIVE_VOICE_ENABLED=true' .env || printf '\nLIVE_VOICE_ENABLED=true\n' >> .env
grep -q '^RECIPIENT_MEMORY_ENABLED=true' .env || printf '\nRECIPIENT_MEMORY_ENABLED=true\nRECIPIENT_MEMORY_MODEL_CACHE=.cache/recipient-memory-model\nRECIPIENT_MEMORY_SCORE_THRESHOLD=0.78\nRECIPIENT_MEMORY_SCORE_MARGIN=0.08\n' >> .env
grep -q '^CORS_ORIGINS=' .env || printf '\nCORS_ORIGINS=https://nana-wallet.localhost\n' >> .env
grep -q '^LIVEKIT_AGENT_NAME=' .env || printf '\nLIVEKIT_AGENT_NAME=nani-agent\n' >> .env

# --- 3b. WDK wallet mode validation -----------------------------------------
wdk_source="$(strip_quotes "$(grep -E '^WDK_TOOLS_SOURCE=' .env | cut -d= -f2- | tail -1)")"
if [[ "$wdk_source" == "live" ]]; then
  # Live policy fails closed at transfer time; catch missing machine config here
  # instead of letting every preview return policy_rejected at runtime.
  wdk_missing=()
  for v in WDK_MAX_TRANSFER_AMOUNT WDK_ALLOWED_RECIPIENTS; do
    val="$(strip_quotes "$(grep -E "^${v}=" .env | cut -d= -f2- | tail -1)")"
    [[ -n "$val" ]] || wdk_missing+=("$v")
  done
  wallet_name="$(strip_quotes "$(grep -E '^WDK_WALLET_NAME=' .env | cut -d= -f2- | tail -1)")"
  if [[ "$wallet_name" == "agent-demo" ]]; then
    wdk_missing+=("WDK_WALLET_NAME (template default 'agent-demo' — set the wallet created on this machine)")
  fi
  ((${#wdk_missing[@]} == 0)) || fail "WDK_TOOLS_SOURCE=live requires machine-local config missing from the template-based .env: ${wdk_missing[*]} (add them to .env and re-run)."
  log "WDK live mode: wallet '${wallet_name}', policy cap and allowlist configured."
else
  log "WDK fixture mode (safe default) — set WDK_TOOLS_SOURCE=live in .env for a real Sepolia wallet."
fi

# --- 4. seed demo contacts when empty --------------------------------------
seeded=$(docker exec "$DB_CONTAINER" psql -U postgres -d postgres -tAc \
  "SELECT count(*) FROM public.recipients" 2>/dev/null || echo 0)
if [[ "$seeded" == "0" ]]; then
  log "seeding demo contacts (two Lucas + Ana)..."
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -c "
  INSERT INTO public.recipients (user_id, name, normalized_name, description, address, version, status, embedding, embedding_model_revision, address_confirmed_at)
  VALUES
   ('11111111-1111-4111-8111-111111111111','Lucas Gutiérrez','lucas gutierrez','Amigo del gimnasio','0x1111111111111111111111111111111111111111',1,'active',(SELECT ('[' || array_to_string(array_fill(0.05, ARRAY[384]), ',') || ']')::vector),'manual',now()),
   ('11111111-1111-4111-8111-111111111111','Lucas Herrera','lucas herrera','Primo, vive en Rosario','0x2222222222222222222222222222222222222222',1,'active',(SELECT ('[' || array_to_string(array_fill(0.05, ARRAY[384]), ',') || ']')::vector),'manual',now()),
   ('11111111-1111-4111-8111-111111111111','Ana Fernández','ana fernandez','Coworking, diseñadora','0x3333333333333333333333333333333333333333',1,'active',(SELECT ('[' || array_to_string(array_fill(0.05, ARRAY[384]), ',') || ']')::vector),'manual',now())
  ON CONFLICT DO NOTHING;" >/dev/null
  log "note: contact addresses are non-allowlisted placeholders; in WDK_TOOLS_SOURCE=live, update one contact to a WDK_ALLOWED_RECIPIENTS address for a real transfer."
fi

# --- 5. start processes (skip if already healthy) ---------------------------
start_if_down() { # $1 name, $2 pgrep pattern, $3... command
  local name="$1" pattern="$2"; shift 2
  if pgrep -f "$ROOT.*$pattern" >/dev/null 2>&1; then
    log "$name already running."
  else
    log "starting $name..."
    ( "$@" > "/tmp/nani-${name}.log" 2>&1 & )
  fi
}

start_if_down "api"    "tsx watch src/server.ts"   portless nani-api --force npm run dev
start_if_down "worker" "src/livekit/worker.ts dev" portless nani-worker --force npm run livekit:dev
if ! pgrep -f "$ROOT/apps/nana-wallet.*vite" >/dev/null 2>&1; then
  log "starting frontend..."
  ( cd apps/nana-wallet && npm run dev > /tmp/nana-wallet-vite.log 2>&1 & )
fi
portless alias --remove nana-wallet >/dev/null 2>&1 || true
portless alias nana-wallet 8080 >/dev/null

# --- 6. health checks -------------------------------------------------------
log "waiting for health checks..."
worker_restarts=0
frontend_restarts=0
for i in $(seq 1 30); do
  # Transient DNS blips can FATAL the worker at boot; the frontend can die if the
  # parent shell is interrupted. Relaunch either (bounded) instead of failing.
  if ! pgrep -f "$ROOT.*src/livekit/worker.ts dev" >/dev/null 2>&1 && (( worker_restarts < 3 )); then
    worker_restarts=$((worker_restarts + 1))
    log "worker died (DNS blip?) — restarting (attempt $worker_restarts/3)..."
    ( portless nani-worker --force npm run livekit:dev > /tmp/nani-worker.log 2>&1 & )
    sleep 10
  fi
  if ! pgrep -f "$ROOT/apps/nana-wallet.*vite" >/dev/null 2>&1 && (( frontend_restarts < 3 )); then
    frontend_restarts=$((frontend_restarts + 1))
    log "frontend died — restarting (attempt $frontend_restarts/3)..."
    ( cd apps/nana-wallet && npm run dev > /tmp/nana-wallet-vite.log 2>&1 & )
    sleep 5
  fi
  worker_up=$(grep -c 'registered worker' /tmp/nani-worker.log 2>/dev/null || true)
  api_up=$(curl -sS -o /dev/null -w '%{http_code}' -X POST "https://nani-api.localhost/v1/live-bindings" \
    -H 'Content-Type: application/json' -H 'Origin: https://nana-wallet.localhost' -d '{}' --max-time 3 2>/dev/null || echo 000)
  web_up=$(curl -sS -o /dev/null -w '%{http_code}' "https://nana-wallet.localhost" --max-time 3 2>/dev/null || echo 000)
  if [[ "$worker_up" -ge 1 && "$api_up" == "200" && "$web_up" == "200" ]]; then
    worker_name="$(grep -A3 'registered worker' /tmp/nani-worker.log | grep -o 'agentName: "[^"]*"' | tail -1 || true)"
    worker_name="${worker_name:-agentName unresolved (check /tmp/nani-worker.log)}"
    log "ALL GREEN: worker registered (${worker_name}), api binding OK, frontend OK."
    cat <<EOF

──────────────────────────────────────────────────────────────
 E2E URLs
   Frontend : https://nana-wallet.localhost
   API      : https://nani-api.localhost
   Logs     : /tmp/nani-worker.log | /tmp/nani-api.log | /tmp/nana-wallet-vite.log

 Voice test script
   1. "¿Cuánto tengo?"                       → get_balance
   2. "¿Le puedo mandar plata a Lucas?"      → search_contacts (ambiguous → asks)
   3. "Para <contacto>, <monto> USDT"        → send_token preview + UI card
   4. "Confirmá"                             → confirm_transfer (broadcast)
   5. Confirm from the UI card instead       → same DB claim, one broadcast
   6. Interrupt Nani mid-speech              → barge-in
   7. In live mode (WDK_TOOLS_SOURCE=live): amounts above WDK_MAX_TRANSFER_AMOUNT
      or non-allowlisted recipients must be narrated as policy_rejected.
 Stop everything: scripts/nani-e2e.sh stop
──────────────────────────────────────────────────────────────
EOF
    exit 0
  fi
  sleep 2
done
fail "health checks did not pass in time. Check /tmp/nani-worker.log, /tmp/nani-api.log, /tmp/nana-wallet-vite.log."
