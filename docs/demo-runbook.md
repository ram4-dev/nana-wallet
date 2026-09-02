# Recipient-memory demo runbook

This runbook records the safe RAG path from a natural-language recipient to a
WDK transfer preview. Start in fixture mode. The final live-wallet take is
optional and never needs to broadcast to prove recipient retrieval.

## Quick rehearsal

```bash
cp .env.example .env
npm ci
npx supabase start
npx supabase db reset
```

Set these values in `.env`:

```dotenv
RECIPIENT_MEMORY_ENABLED=true
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
RECIPIENT_MEMORY_SEED_FILE=examples/recipient-memory.seed.json
WDK_TOOLS_SOURCE=fixture
```

Then prepare the database, local model, and API:

```bash
npx supabase db reset
npm run memory:prefetch
npm run db:seed
npm run dev
```

For a frontend textual E2E (LLM + WDK fixtures, no live broadcast), configure
and start the Nana wallet in another terminal. If `:3000` is taken, use
`PORT=3001` for the API and `VITE_API_URL=http://localhost:3001` below.

```bash
cp apps/nana-wallet/.env.example apps/nana-wallet/.env.local
# keep WDK_TOOLS_SOURCE=fixture and AGENT_RUNTIME=llm in the backend .env
# set VITE_AGENT_BACKEND=1 so the chat bypasses MSW and hits this API
cd apps/nana-wallet
npm install
npm run dev -- --host 0.0.0.0 --port 8083
```

Type a natural-language transfer request, then Confirm. With fixtures, expect
a fixture `transactionHash`, never a live broadcast. For a parser-only
rehearsal without a model provider, set `AGENT_RUNTIME=deterministic`.

The seed contains confirmed demo data only: one Lucas described as `mi nieto`
and the fact `Lucas is my grandson`. It is not a real address book.

## Session setup

```bash
CONVERSATION_ID=$(curl -s -X POST http://localhost:3000/v1/conversations | jq -r .conversationId)
echo "$CONVERSATION_ID"
```

Inspecting a session is safe for the screen recording: it can show selected ID,
version, descriptions, and write expiry, but must never show a staged address
or confirmation ID.

```bash
curl -s "http://localhost:3000/v1/conversations/$CONVERSATION_ID/state" | jq
```

## Demo sequence

### 1. Named and relationship retrieval

Send either prompt:

```bash
curl -s -X POST "http://localhost:3000/v1/conversations/$CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Mandale plata a Lucas"}' | jq
```

```bash
curl -s -X POST "http://localhost:3000/v1/conversations/$CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Send money to my grandson"}' | jq
```

The agent first detects transfer intent. It searches current-user recipient data
or confirmed relationship facts, obtains exactly one ID/version, retrieves the
address internally, revalidates it, and returns a `confirmation_required`
preview. Retrieval itself never returns an address.

### 2. Approval boundary

Verify that the preview names the network, USD₮, amount, recipient, and fee.
Only then send the separate confirmation:

```bash
curl -s -X POST "http://localhost:3000/v1/conversations/$CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' \
  -d '{"message":"confirm"}' | jq
```

Fixture mode returns a fixture transaction hash. For a live take, use only a
dedicated limited-funds Sepolia wallet, let a human unlock it with a finite TTL,
and capture the post-transfer explorer evidence. Do not use a mainnet wallet.

### 3. Ambiguity and description qualification

For an ambiguity recording, seed two confirmed current-user records named
`Lucas`, with descriptions such as `mi nieto` and `el electricista`, then ask:

```text
Mandale plata a Lucas
```

Expected: `clarification_required`, candidates with descriptions, no selected
address, and no preview. Follow with a qualifier such as:

```text
Mandale plata a Lucas el electricista
```

The hybrid lexical + cosine ranking can resolve only when its score threshold
and margin are safe; otherwise it continues to ask for clarification.

### 4. Confirmed memory write

Ask the agent to remember a recipient or relationship in ordinary language.
It must call `stage_user_memory`, display the exact draft (including an address
only when one was supplied), and wait for an explicit confirmation. A bare
`confirm` persists only the active session's one-time, five-minute draft.
Rejected, expired, reused, or missing confirmations do not change the database.

## Release checks

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:wdk-mcp
```

Run `npx supabase db reset` once more after the test pass when a clean replay is
needed. The WDK MCP test is read-only: it discovers tools
and reads Sepolia/USD₮ metadata but never sends tokens.

## Failure expectations

Database/model unavailability, no match, conflicting facts, stale versions,
or an inactive recipient stop before preview. If a recipient changes after the
preview, its ID/version revalidation clears both the selection and approval;
the user must resolve it again. Explicit user-supplied addresses retain the
existing transfer path and are not stored or embedded by recipient memory.
