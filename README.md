# WDK Transaction Agent

A backend-only Sepolia USD₮ agent that can turn a reference such as “Mandale
plata a Lucas” or “Send money to my grandson” into a safe, versioned recipient
selection. Recipient search is durable RAG data, not hidden model memory: the
model sees names, descriptions, and minimal evidence, while the exact address
is released only after one recipient is grounded and is revalidated before the
WDK preview and broadcast.

The wallet boundary is the bundled `wdk-mcp` process from
`@tetherto/wdk-cli`; the application also declares `@tetherto/wdk` directly.
This is a Track 1 testnet demo, not a mainnet wallet service.

## Quick path

Requires Node.js `>=22.18.0`, Docker Compose, and a dedicated limited-funds
Sepolia test wallet only for live WDK work.

```bash
git clone <repository-url>
cd aleph-hackathon
cp .env.example .env
npm ci
docker compose up -d db
```

For the RAG demo, set the following values in `.env` (the supplied UUID and
seed are demo data and contain no credential):

```dotenv
RECIPIENT_MEMORY_ENABLED=true
DATABASE_URL=postgresql://recipient_app@127.0.0.1:5432/wdk_agent
DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/wdk_agent
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
RECIPIENT_MEMORY_SEED_FILE=examples/recipient-memory.seed.json
```

```bash
npm run db:migrate
npm run memory:prefetch
npm run db:seed
npm run dev
```

The first prefetch downloads the pinned embedding model into
`.cache/recipient-memory-model`; later starts reuse it. With the default
`WDK_TOOLS_SOURCE=fixture`, no wallet, unlock, or broadcast is required.

## What happens to a recipient reference

| User request | Safe result |
| --- | --- |
| `Mandale plata a Lucas` | Searches this demo user's recipient name and description. One exact Lucas may be selected. |
| `Mandale plata a Lucas el electricista` | Uses hybrid lexical + vector retrieval over the current user's names and descriptions; the response contains candidates, never addresses. |
| `Send money to my grandson` | Reads confirmed relationship facts, then still resolves one recipient record before address lookup. |
| Two plausible Lucas records | Asks a description-based question such as “Lucas (mi nieto) or Lucas (el electricista)?” No preview is created. |
| No match, stale record, DB/model failure | Stops before address lookup and before any WDK preview. |

Once there is one stable `recipientId` and `version`, `get_recipient_address`
may obtain the current address internally. That exact string is passed unchanged
as `send_token.to`. The record is checked once before `dryRun: true` and again
before the matching approved `dryRun: false`; a changed, deleted, inactive, or
foreign record clears the selection and approval.

## RAG memory model

PostgreSQL 16 + pgvector holds the durable data. The local multilingual model
is `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` through
`@huggingface/transformers@4.2.0`, with 384-dimensional normalized embeddings.
No embedding API key is needed.

| Table | Purpose | Retrieval / privacy boundary |
| --- | --- | --- |
| `recipients` | `id`, `user_id`, name, normalized name, description, exact address, version, status, provenance, confirmation time, and a 384D embedding | Embeds only normalized name + description. Search returns id, version, name, description, evidence, and score — never address. |
| `user_memories` | User-relative facts such as `Lucas is my grandson`, kind, version, status, provenance, confirmation time, and a 384D embedding | Embeds the fact, returns minimal evidence, and is only a lead for recipient search. It is not identity proof. |

Both tables have tenant filters in each query plus PostgreSQL row-level security
under the restricted `recipient_app` role. This demo injects one UUID from
`DEMO_USER_ID`; there is deliberately no login surface yet. A production
deployment must replace that fixed demo identity with the authenticated
principal before enabling the feature.

### Memory tools

| Tool | Input | Result and boundary |
| --- | --- | --- |
| `search_recipients` | `{ query }` | Finds current-user candidates and may bind one ID/version to the session. Addresses are omitted. |
| `search_user_memory` | `{ query }` | Returns current-user relationship evidence only. |
| `get_recipient_address` | `{ recipientId, expectedVersion }` | Returns an address only for the session-bound, still-current selection. |
| `stage_user_memory` | Recipient draft or relationship fact | Stages exact user-provided content for five minutes; no data is yet written. |
| `write_user_memory` | `{ confirmationId }` | Consumes a single-use, unexpired confirmation and writes atomically. |

The session inspection endpoint never exposes a staged address or confirmation
ID. The tool may show an exact staged address to the user for confirmation, but
search output, embeddings, session inspection, and release evidence must not
contain it.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `RECIPIENT_MEMORY_ENABLED` | `false` | Feature flag. When false, no DB/model/memory tools are initialized and explicit-address transfers remain available. |
| `DATABASE_URL` | — | Application connection as `recipient_app`; required when memory is enabled. |
| `DATABASE_ADMIN_URL` | — | Migration-only admin connection. Do not use it for the application runtime. |
| `DEMO_USER_ID` | — | UUID tenant injected server-side for this demo; required when memory is enabled. |
| `RECIPIENT_MEMORY_MODEL_CACHE` | `.cache/recipient-memory-model` | Reusable local Transformers.js cache. |
| `RECIPIENT_MEMORY_SCORE_THRESHOLD` | `0.78` | Minimum semantic score for a non-exact candidate. |
| `RECIPIENT_MEMORY_SCORE_MARGIN` | `0.08` | Required lead over the runner-up; otherwise clarification is required. |
| `RECIPIENT_MEMORY_SEED_FILE` | — | Confirmed-only JSON seed consumed by `npm run db:seed`. |

`compose.yaml` starts only PostgreSQL/pgvector and persists its data in the
named `recipient_memory_postgres` volume. A hosted pgvector-compatible
PostgreSQL changes only the URLs above.

## Approval and WDK

Recipient-memory enablement does not authorize a transfer. Every transfer
still follows:

1. Resolve one recipient safely, or ask for clarification.
2. Revalidate it and call WDK `send_token` with `dryRun: true`.
3. Return the network, token, recipient, amount, and estimated fee.
4. Require a separate `confirm` / `confirmar` in the same session.
5. Revalidate again and make one matching `dryRun: false` call.

`WDK_TOOLS_SOURCE=fixture` is the safe default. `live` starts the bundled MCP
server through `WdkMcpClient`; use only a human-unlocked, dedicated, limited-
funds test wallet. The read-only MCP smoke below never broadcasts.

## Verification and scripts

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:wdk-mcp
```

`npm run test:e2e:wdk-mcp` starts the bundled MCP server, discovers the Track 1
tools, and reads Sepolia/USD₮ metadata only. It does not call `send_token`.
For the full recipient-memory rehearsal, follow
[the demo runbook](docs/demo-runbook.md); HTTP details are in
[the API reference](docs/api.md) and the architecture rationale is in
[the architecture document](docs/architecture.md).

Other useful commands:

- `npm run db:migrate` — applies each migration exactly once.
- `npm run db:seed` — embeds and inserts only explicitly confirmed seed data.
- `npm run memory:prefetch` — downloads/validates the local embedding model.
- `npm run test:wdk-manual` — opt-in manual live read/preview harness; broadcast
  remains separately gated and is not a CI command.
