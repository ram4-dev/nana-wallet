# Apply Progress: Recipient Address Memory

**Mode:** Standard (strict TDD disabled)

**Completed tasks:** 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 3.1, 3.2, 3.3, 3.4, 3.5

## Completed Foundation

- 1.1 UUID-validated feature configuration, disabled-by-default behavior, environment template, and scripts.
- 1.2 PostgreSQL 16/pgvector compose topology, restricted application role, database client, migration runner, tables, indexes, and RLS policies.
- 1.3 Pinned multilingual 384-dimensional embedding service, cache path, address stripping before embedding, and vector validation.
- 1.4 User-scoped repository, hybrid lexical/cosine SQL, versioned lookup, atomic inserts, redacted candidate type, and confirmed-only seed input.

## Work Unit Evidence

| Evidence | Result |
|---|---|
| Focused tests | `npm run typecheck && npm test -- --run tests/unit/recipient-memory-config.test.ts tests/unit/recipient-memory-embedding.test.ts tests/unit/recipient-memory-repository.test.ts tests/integration/recipient-memory-db.test.ts` — exit 0; 8 passed. |
| Feature-off regression | `RECIPIENT_MEMORY_ENABLED=false npm test` — exit 0; 52 passed, 3 skipped. `npm run build` — exit 0. |
| Database runtime harness | `docker compose up -d db` — healthy. `DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/wdk_agent npm run db:migrate` — applied `001_recipient_memory.sql`. Live SQL verified `vector` + `pgcrypto`, FORCE RLS for both tables, `recipient_app.rolbypassrls=false`, tenant A visible=1, foreign tenant visible=0. |
| Repository runtime harness | Live repository script returned `{candidatesA:1,candidatesB:1,candidateHasAddress:false,foreignVisible:false}`. |
| Embedding runtime harness | `npm run memory:prefetch` — passed. A real model invocation returned `{dimensions:384,finite:true}`. |
| Rollback boundary | The phase only adds configuration, local database/memory modules, compose support, dependencies, and tests; existing agent and WDK paths are untouched. |

## Completed Retrieval and Tools

- 2.1 Added RED-first unit coverage for tenant propagation, candidate redaction, exact-name ambiguity, semantic threshold/margin, stale selection, and model/database failure containment.
- 2.2 Added deterministic ranking over the repository's existing lexical-plus-cosine candidates. A sole exact normalized name resolves; duplicate exact names or an insufficient semantic score/margin require clarification; unavailable dependencies return no candidates.
- 2.3 Added session-bound `search_recipients`, `search_user_memory`, and `get_recipient_address` contracts. Search persists only a resolved ID/version; address lookup rejects absent/mismatched selections and clears stale state.
- 2.4 Added a session-bound, five-minute-by-default write staging flow. `write_user_memory` accepts only an expiring one-time confirmation ID, so a recipient's exact staged address cannot be substituted at persistence time.

## Work Unit 2 Evidence

| Evidence | Result |
|---|---|
| RED tests before production code | `npm test -- --run tests/unit/recipient-memory-service.test.ts tests/unit/recipient-memory-tools.test.ts` — exit 1 as expected because `src/memory/service.ts` and `src/memory/tools.ts` did not yet exist; both suites failed to import their missing modules. |
| Focused test command and exact result | `npm run typecheck && npm test -- --run tests/unit/recipient-memory-service.test.ts tests/unit/recipient-memory-tools.test.ts tests/unit/session-store.test.ts tests/unit/recipient-memory-repository.test.ts` — exit 0; 4 files, 13 tests passed. |
| Runtime harness command/scenario and exact result | PostgreSQL service was healthy. `node --input-type=module -e "…service.searchRecipients(DEMO_USER_ID, 'Lucas')…"` against the live pgvector database and cached model returned `{status:"no_match",candidateCount:0,candidateContainsAddress:false}`; it performed no write and exposed no address. |
| Regression and build | `npm test` — exit 0; 14 files / 59 tests passed, 1 file / 3 tests skipped. `npm run build` — exit 0. |
| Rollback boundary | Revert `src/memory/service.ts`, `src/memory/tools.ts`, the recipient-memory session fields/helpers in `src/sessions/in-memory-store.ts`, and the two new focused test files. No API route, agent loop, transfer preview, WDK client, or HTTP contract changed. |

## Next Pending Work

- None. Phase 4 is complete; the change is ready for final review/archival.

## Completed Conversation and WDK Handoff

- 3.1 began RED-first with transfer-intent tests covering named recipients, `my grandson`, contextual pronouns, unrelated prompts, ambiguity, and unavailable memory.
- 3.2 persists only selection ID/version and safe clarification metadata in session inspection. Staged write inspection exposes expiry only; neither drafts nor addresses leave the session endpoint.
- 3.3 resolves relationship facts into a stable recipient candidate before address retrieval. The agent receives session-bound memory tools and instructions that prohibit guessing an address or previewing on unsafe results.
- 3.4 replaces the agent's live PATH-based MCP client with the existing bundled `WdkMcpClient` boundary. Fixture mode remains unchanged; the live adapter opens the bundled WDK CLI through Node and decodes its MCP text envelope.
- 3.5 binds a revalidated recipient ID/version to a pending preview and verifies it again before `dryRun:false`; a changed/inactive/mismatched record clears both selection and approval. Explicit user-supplied addresses clear old recipient selection and retain the existing WDK path.

## Work Unit 3 Evidence

| Evidence | Result |
|---|---|
| RED tests before production | `npm test -- --run tests/unit/recipient-intent.test.ts tests/unit/recipient-resolution.test.ts` — expected exit 1 because the production modules did not yet exist. |
| Focused verification | `npm run typecheck && npm test -- --run tests/unit/recipient-intent.test.ts tests/unit/recipient-resolution.test.ts tests/unit/wallet-agent-guard.test.ts tests/unit/wallet-agent-deterministic.test.ts tests/integration/api-sessions.test.ts tests/integration/wdk-mcp.test.ts` — exit 0; 40 tests passed. |
| Full regression/build | `npm test && npm run build` — exit 0; 70 passed, 3 skipped; build passed. |
| MCP smoke | `npm run test:e2e:wdk-mcp` — exit 0; discovery and read-only Sepolia/USD₮ metadata succeeded, without broadcast. |
| Rollback boundary | Revert Phase 3 agent, WDK adapter, session/contract/API additions and focused tests; recipient memory can remain disabled via `RECIPIENT_MEMORY_ENABLED=false`. |

## Completed Evidence and Release

- 4.1 adds `tests/e2e/recipient-memory-release.e2e.test.ts`. It composes the
  session-bound tools, intent resolver, guarded WDK boundary, and fixture
  transport to cover a unique Lucas, qualified `Lucas el electricista`, `my
  grandson`, ambiguity, cross-tenant tool identity, unavailable memory,
  confirmed writes, stale selection, and exact `to` for both preview and
  broadcast. Search output is asserted not to contain the address.
- 4.2 updates the README, API contract, architecture, environment template,
  executable runbook, and confirmed-only demo seed. They document the clean
  clone path, pgvector schema and RLS, fixed demo identity, pinned model,
  retrieval/write tools, feature flag, score policy, approval gate, fixture
  versus live WDK boundary, and failure behaviour.

| Evidence | Result |
|---|---|
| Focused release E2E | `npm run typecheck && npm test -- --run tests/e2e/recipient-memory-release.e2e.test.ts` — exit 0; 3 scenarios passed. |
| Live pgvector migration/idempotency | `docker compose up -d db` — healthy. Two successive `DATABASE_ADMIN_URL=… npm run db:migrate` invocations both reported `Database schema is already current.` |
| Real embedding | `RECIPIENT_MEMORY_ENABLED=true … npm run memory:prefetch` — cached model verified. A real embedding invocation returned `{dimensions:384,finite:true}`. |
| Full release gate | `npm run typecheck && npm test && npm run build && npm run test:e2e:wdk-mcp` — exit 0; 17 files / 73 tests passed, 1 file / 3 tests skipped; build passed; bundled MCP smoke passed 1/1. |
| Redaction / no-broadcast scan | Source scan found no logging of address, draft, or confirmation ID. The MCP smoke source has no `send_token` call. Candidate and session-inspection redaction paths were located and covered by tests. |
| Rollback boundary | Revert only release E2E, `examples/recipient-memory.seed.json`, README/docs/.env, and OpenSpec completion evidence. Runtime rollback remains `RECIPIENT_MEMORY_ENABLED=false`; explicit-address transfers are unchanged. |
