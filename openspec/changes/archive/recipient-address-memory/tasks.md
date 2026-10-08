# Tasks: Recipient Address Memory

## Review Workload Forecast

Estimated: 900–1,400 lines; `size:exception`; `DEMO_USER_ID`.

Decision needed before apply: No
Chained PRs recommended: No
Chain strategy: size-exception
400-line budget risk: High

### Suggested Work Units

| Unit | Bounded outcome | Focused test | Runtime harness | Rollback boundary |
|---|---|---|---|---|
| 1 | Config, identity, pgvector schema | `npm test -- memory` | `docker compose up db; npm run db:migrate` | env/schema |
| 2 | Embeddings, repository, tools | `npm test -- recipient` | `search_recipients('Lucas')` | memory flag |
| 3 | Agent/session/WDK handoff | `npm test -- transfer` | fixture preview + MCP smoke | adapter/session |
| 4 | E2E, docs, release gates | `npm test && npm run build` | Lucas/grandson demo | E2E/docs |

## Phase 1: Foundation

- [x] 1.1 Add UUID-validated config/env/scripts in package, `.env.example`, config; verify flag-off startup/build.
- [x] 1.2 Add PostgreSQL16/pgvector compose service, volume, `src/db/*`; verify health/config. Depends 1.1.
- [x] 1.3 Add pinned multilingual 384D embedding/cache; normalize name+description/fact without addresses; test embedding. Depends 1.1.
- [x] 1.4 Add repository/types/seed: hybrid search, facts, versioned lookup, writes, RLS, redaction, atomicity; run DB tests. Depends 1.2–1.3.

## Phase 2: Retrieval and Tools

- [x] 2.1 Add RED memory tests for isolation, redaction, ambiguity, stale and DB/model failure; require no address/preview. Depends 1.4.
- [x] 2.2 Lexical+cosine ranking, threshold/margin, clarification. **Files:** service/ranking. **Deps:** 1.4,2.1. **Accept:** deterministic; no guessing. **Verify:** ranking tests. **Rollback:** flag.
- [x] 2.3 Session-bound `search_recipients`, `search_user_memory`, `get_recipient_address`. **Files:** tools/agent. **Deps:** 2.2. **Accept:** search omits address; lookup needs owned ID/version. **Verify:** tool tests. **Rollback:** unregister tools.
- [x] 2.4 Staged expiring single-use writes; exact address confirmation. **Files:** tools/service/session/contracts. **Deps:** 1.4,2.3. **Accept:** rejection preserves data. **Verify:** write tests. **Rollback:** off.

## Phase 3: Conversation and WDK

- [x] 3.1 Add RED intent/API tests for pronouns, `my grandson`, ambiguity/no-preview and unrelated prompts. Depends 2.3.
- [x] 3.2 Session/HTTP state for ID/version, clarification, writes. **Files:** sessions/contracts/API. **Deps:** 2.3–2.4,3.1. **Accept:** inspection hides address. **Verify:** typecheck/API tests. **Rollback:** fields.
- [x] 3.3 Wire intent, clarification, relational lookup; model cannot choose address. **Files:** wallet-agent/instructions. **Deps:** 3.2. **Accept:** candidate precedes lookup. **Verify:** agent tests. **Rollback:** flag.
- [x] 3.4 Route live tools through `WdkMcpClient`; preserve fixtures/evidence. **Files:** agent tools/WDK/tests. **Deps:** 3.3. **Accept:** no second daemon. **Verify:** WDK tests+MCP E2E. **Rollback:** adapter.
- [x] 3.5 Bind ID/version; revalidate preview/broadcast; exact address unchanged to WDK. **Files:** agent/session/WDK/tests. **Deps:** 3.2,3.4. **Accept:** changes invalidate approval; explicit address remains. **Verify:** revalidation/guard tests. **Rollback:** names off.

## Phase 4: Evidence and Release

- [x] 4.1 E2E: Lucas, grandson, writes, isolation, stale/failure, WDK `to`. **Files:** E2E/tests/fixtures. **Deps:** 3.5. **Accept:** scenarios pass; retrieval redacts. **Verify:** compose+test+build. **Rollback:** E2E tests.
- [x] 4.2 Document schema, identity, pgvector/model, tools, examples, flags, approval/WDK. **Files:** README/docs/.env. **Deps:** 1.1,3.2,3.5,4.1. **Accept:** clean-clone run. **Verify:** docs commands+build. **Rollback:** docs.
- [x] 4.3 Typecheck/tests/build, migration rerun, redaction scan, MCP smoke; no auto-broadcast/secrets. **Files:** lockfile/reports. **Deps:** 4.1–4.2. **Accept:** gates pass. **Verify:** `npm run typecheck && npm test && npm run build && npm run test:e2e:wdk-mcp`. **Rollback:** flag off.

Threat N/A: no new routing, shell, subprocess, VCS, or lifecycle behavior.

## Apply Progress — 2026-08-23

### Work Unit 1: Foundation

| Evidence | Result |
|---|---|
| Focused test command and exact result | `npm run typecheck && npm test -- --run tests/unit/recipient-memory-config.test.ts tests/unit/recipient-memory-embedding.test.ts tests/unit/recipient-memory-repository.test.ts tests/integration/recipient-memory-db.test.ts` — exit 0; 4 files, 8 tests passed. |
| Runtime harness command/scenario and exact result | `docker compose up -d db` — healthy. `DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/wdk_agent npm run db:migrate` — applied `001_recipient_memory.sql`. Live SQL confirmed `vector` + `pgcrypto`, FORCE RLS on both tables, `recipient_app.rolbypassrls=false`, tenant A visible=1, foreign tenant visible=0. Live repository result: `{candidatesA:1,candidatesB:1,candidateHasAddress:false,foreignVisible:false}`. `npm run memory:prefetch` passed; a real embedding returned `{dimensions:384,finite:true}`. |
| Rollback boundary | Revert `.env.example`, `package*.json`, `compose.yaml`, `docker/init/`, `src/config/`, `src/db/`, `src/memory/`, and recipient-memory tests; no existing WDK or transfer path was modified. |

All Phase 1 runtime evidence is complete.

## Apply Progress — 2026-08-23, Phase 3

| Evidence | Result |
|---|---|
| RED tests before production code | `npm test -- --run tests/unit/recipient-intent.test.ts tests/unit/recipient-resolution.test.ts` — exit 1 as expected: both new modules were absent. |
| Focused conversation/guard tests | `npm run typecheck && npm test -- --run tests/unit/recipient-intent.test.ts tests/unit/recipient-resolution.test.ts tests/unit/wallet-agent-guard.test.ts tests/unit/wallet-agent-deterministic.test.ts tests/integration/api-sessions.test.ts tests/integration/wdk-mcp.test.ts` — exit 0; 6 files, 40 tests passed. |
| Full regression and build | `npm test && npm run build` — exit 0; 16 files / 70 tests passed, 1 file / 3 tests skipped; TypeScript build passed. |
| Bundled MCP smoke, no broadcast | `npm run test:e2e:wdk-mcp` — exit 0; bundled `@tetherto/wdk-cli` MCP opened, required tools discovered, Sepolia and USD₮ metadata read. No `send_token` call was made. |
| Rollback boundary | Revert the Phase 3 intent/resolution/runtime modules, agent/WDK adapter, session and HTTP extensions, and focused tests. Feature-off and explicit-address paths remain available. |
