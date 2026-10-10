# 91 — Pre-Change Test Baseline

Read-only measurement. No source file was edited, no test was fixed, nothing was committed.

Working root: `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`
Branch: `feat/solana-operational`
Commit: `a121b2c68f668cf595b907cff719a2aef361a3c3`

> **CORRECTION NOTICE (read this first).**
> The measurement below under **"attempt 1"** was taken against a **local database built from the legacy `src/db/migrations` path** and is therefore **INVALIDATED**. Its 11-test `error: schema "extensions" does not exist` cluster was an artifact of the wrong database setup, not of the code under test.
> The **authoritative pre-change baseline is "attempt 2"**, taken after the local database was rebuilt to match `.github/workflows/ci.yml`. Later comparisons MUST use attempt 2.

## Measurement history

| Attempt | Database | Validity | Failing tests |
|---|---|---|---|
| 1 | legacy `src/db/migrations` (no `extensions` schema) | **INVALIDATED** | 17 failed / 1017 passed / 10 skipped |
| 2 | CI-shaped (`extensions` + `supabase/roles.sql` + `supabase/migrations/*.sql` + demo user) | **CURRENT BASELINE** | 6 failed / 1028 passed / 10 skipped |

---

# attempt 2 — CURRENT PRE-CHANGE BASELINE (corrected database)

Read-only measurement. No source file was edited, no test was fixed, nothing was committed. Only this baseline document was written.

## Exact commit

```
$ git rev-parse HEAD
a121b2c68f668cf595b907cff719a2aef361a3c3
```

## `git status --porcelain -uall`

```
?? .agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md
?? compose.privy-local.ports.yaml
?? openspec/changes/trusted-recipient-policy-sync/design.md
?? openspec/changes/trusted-recipient-policy-sync/proposal.md
?? openspec/changes/trusted-recipient-policy-sync/spec.md
?? openspec/changes/trusted-recipient-policy-sync/tasks.md
```

6 untracked entries, **no tracked file modified**. Identical before the measurement runs and after them (verified). The 7 `90-*`/`0*-*` task documents under this directory are tracked and untouched.

## Command result — backend (`npx vitest run`, worktree root)

Exact command:

```
npx vitest run
```

Exit status: **1 (test failures)**.

```
 Test Files  6 failed | 148 passed | 4 skipped (158)
      Tests  6 failed | 1028 passed | 10 skipped (1044)
   Start at  02:58:57
   Duration  40.21s (transform 4.18s, setup 1.99s, import 51.05s, tests 271.67s, environment 13ms)
```

## Remaining backend failures — complete list, copy-paste exact

6 failures across 6 files. Format: `file > describe > test`, then the first failure message verbatim.

1. `tests/integration/api-voice-auth.test.ts` > /v1/voice/room-token authorization (PMU-020, privy mode) > returns the same 404 for a foreign conversation as for a missing one
   `Error: Test timed out in 15000ms.`

2. `tests/integration/conversation-preview-claim-race.test.ts` > previewTransfer real claim semantics > two simultaneous confirms broadcast exactly once (V8.5)
   `AssertionError: expected "broadcastTransfer" to be called once, but got 0 times`

3. `tests/integration/wallets-sync.test.ts` > /v1/wallets sync + embedded wallet service (PEW-002/003/005) > PEW-013: explicit activation with read-back; empty allowlist rejected (422)
   `AssertionError: expected 422 to be 200 // Object.is equality`

4. `tests/unit/realtime-agent-session.test.ts` > OpenAI realtime agent session composition > allows one re-read when a confirmation is refused for an incomplete read-back
   `AssertionError: expected 'You are Nani, the voice assistant of …' to match /except when a confirmation is refus…/iu`

5. `tests/unit/realtime-tool-binding.test.ts` > realtime tool binding — production execution against the fixture stack > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy
   `AssertionError: expected [] to have a length of 1 but got +0`

6. `tests/unit/realtime-tools.test.ts` > createRealtimeTools > send_token delegates the preview to the service and strips the recipient address
   `AssertionError: expected "vi.fn()" to be called with arguments: [ StringContaining{…} ]`

### Classification of the 6 remaining failures (observed, not diagnosed)

- **Real assertion failures (5):** #2, #3, #4, #5, #6. Each is an explicit `AssertionError` about runtime behaviour (a broadcast that did not happen, an HTTP 422 where 200 was expected, a persona prompt that does not contain the required clause, a spy that was never called). No database/schema message appears in any of them.
- **Environment-shaped / undetermined (1):** #1 is a bare `Test timed out in 15000ms` in an HTTP authorization suite. Its first message carries no assertion and no schema error, so it is classified **environment-shaped or timing-shaped, root cause NOT diagnosed** (diagnosing it would require running database/voice-provider commands outside the authorized set).

## Delta versus attempt 1 (17 failures) — what disappeared, what remains

**Disappeared (11).** All were inside the invalidated `schema "extensions" does not exist` cluster or consistent with it:

- #1 attempt 1 `tests/integration/api-conversation-resolution.test.ts` > claims one preview atomically across independent repository clients
- #2 attempt 1 `tests/integration/api-conversation-service.test.ts` > completes preview, atomic confirmation, and fixture finality through HTTP
- #5 attempt 1 `tests/integration/grant-claim-release.test.ts` > 8.4b RED: real PostgresConversationRepository.claimPendingTransfer returns the persisted claim_id
- #6 and #7 attempt 1 `tests/integration/notifications-outbox-dispatcher.test.ts` (rolls back with outbox completion / dedupe loser)
- #8, #9, #10, #11, #12 attempt 1 `tests/integration/notifications-outbox.test.ts` (5 tests)
- #13 attempt 1 `tests/integration/voice-touch-decision-race.test.ts` > claims once and reaches one terminal state

Ten of those eleven carried the literal message `error: schema "extensions" does not exist`. The eleventh (attempt-1 #2, `api-conversation-service`, `expected 500 to be 200`) disappeared with the same database correction; its 500 is consistent with the missing-schema path, but that link was **not** independently proven.

**Remain (6):** attempt-1 #3, #4, #14, #15, #16, #17 — the same six files/tests that fail now. Five kept their exact first message. One changed shape:

- attempt-1 #4 `conversation-preview-claim-race` moved from the environment message `error: schema "extensions" does not exist` to the real assertion `expected "broadcastTransfer" to be called once, but got 0 times`. The test still fails, but now as a genuine assertion rather than a setup artifact.

## Skipped tests — identified by name

Attempt 1 could not name them (default reporter prints no names). This measurement ran the authorized second invocation:

```
npx vitest run --reporter=verbose 2>&1 | grep -inE 'skip|todo|↓'
```

The verbose reporter marks each skipped test with `↓`. **10 skipped tests across 6 files:**

1. `tests/integration/wdk-transfer.manual.test.ts` > manual Sepolia USD₮ evidence > captures a dry-run preview and proves it has no broadcast
2. `tests/integration/wdk-transfer.manual.test.ts` > manual Sepolia USD₮ evidence > broadcasts exactly one human-approved candidate after a matching preview
3. `tests/unit/recipient-memory-service.test.ts` > recipient-memory ranking > integrates a real embedding for Lucas el electricista while preserving the global threshold
4. `tests/e2e/livekit-smoke.e2e.test.ts` > opt-in LiveKit Cloud smoke > fails closed when provider credentials or binding verification inputs are absent
5. `tests/e2e/livekit-smoke.e2e.test.ts` > opt-in LiveKit Cloud smoke > requires the native worker runtime for rollout smoke
6. `tests/e2e/livekit-smoke.e2e.test.ts` > opt-in LiveKit Cloud smoke > creates a room and dispatches the configured agent without wallet calls
7. `tests/e2e/livekit-smoke.e2e.test.ts` > opt-in LiveKit Cloud smoke > verifies the application binding independently of room identity
8. `tests/e2e/wdk-mcp-connection.e2e.test.ts > real bundled wdk-mcp connection > initializes stdio, discovers tools, and reads built-in Sepolia USD₮ metadata
9. `tests/e2e/recipient-memory-llm.e2e.test.ts` > live LLM recipient retrieval > lets OpenCode choose the exact pgvector tool while preserving ambiguity and address privacy
10. `tests/e2e/wallet-agent-live-preview.e2e.test.ts` > real wallet agent preview > uses the configured production model and bundled WDK MCP to create a preview only

Reconciling with the summary `4 skipped` test **files** (verified by static test counts, read-only):

- **Fully skipped files (4 files, 7 tests):** `livekit-smoke.e2e.test.ts` (4/4 tests), `wdk-mcp-connection.e2e.test.ts` (1/1), `recipient-memory-llm.e2e.test.ts` (1/1), `wallet-agent-live-preview.e2e.test.ts` (1/1). These are the 4 files counted as skipped.
- **Partially skipped files (2 files, 3 tests):** `wdk-transfer.manual.test.ts` (2 of 5 tests skipped) and `recipient-memory-service.test.ts` (1 of 9 tests skipped); each still runs passing tests, so the file counts as passed.
- 7 + 3 = 10 skipped tests, matching `10 skipped (1044)`.

**Why this matters:** every one of the 10 skipped tests is an opt-in integration/E2E behaviour that is *not verified* by this baseline. In particular the LiveKit Cloud rollout smoke (4 tests), the real WDK MCP stdio connection, the live-LLM pgvector retrieval, the real-embedding ranking check, the manual Sepolia transfer path (2 tests), and the live wallet-agent preview are all silently unexercised in CI-shaped local runs.

## Database setup observed and verified

Verified by **read-only** queries (`docker exec ... psql` catalog/SELECT only — no DDL, DML, or state mutation):

- **Container:** `colloseumfeat-solana-operational-db-1`, image `pgvector/pgvector:0.8.1-pg16`, published `127.0.0.1:55470->5432/tcp`. The `127.0.0.1:55470` listener is colima's port-forwarder (its `ssh: .../_lima/colima/ssh.sock [mux]` process), not a stray tunnel. This is the worktree's own container.
- **`extensions` schema present:** yes. `pg_namespace` returns `extensions` and `public`.
- **Extensions installed:** `vector`, `pgcrypto`, `plpgsql`.
- **Supabase migrations applied:** the `public` schema holds 21 tables, consistent with `supabase/roles.sql` + the 15 files matching `supabase/migrations/*.sql` on disk. There is **no** `supabase_migrations` tracking schema (0 tables) — consistent with CI applying the raw `psql` files directly, exactly as `.github/workflows/ci.yml` lines 35–46 do.
- **Demo user row present:** `users.id = 00000000-0000-4000-8000-000000000001` with `privy_did = did:privy:demo`. This is what makes the fixture-identity suites' `recipients_user_id_users_fk` hold.
- **CI shape confirmed on disk:** `.github/workflows/ci.yml` applies `CREATE SCHEMA IF NOT EXISTS extensions;` then `for f in supabase/roles.sql supabase/migrations/*.sql`, with `DATABASE_URL` carrying `options=-csearch_path%3Dpublic,extensions`. The worktree database matches this shape; the attempt-1 database did not.

I did **not** re-derive the setup only from its description: the bullets above are the direct read-back of the live container.

## Environment notes

- `DATABASE_URL` is present in the worktree's git-ignored `.env` (1 occurrence of the `DATABASE_URL=` key; host `127.0.0.1:55470`, database `wdk_agent`, `options=-csearch_path%3Dpublic,extensions`). **Value not printed.**
- Node `v26.8.1` (package `engines` requires `>=22.18.0`; satisfied). Vitest `4.1.11 darwin-arm64`.
- `tests/setup/isolate-provider-env.ts` loads `dotenv/config` and deliberately does **not** clear `DATABASE_URL`, so the DB-gated integration suites ran rather than silently skipping. It deletes the provider/identity/voice credential keys (`PRIVY_*`, `LIVE_VOICE_*`, `LIVEKIT_*`, `OPENAI_API_KEY`, `OPENCODE_GO_*`) so the suite runs in its CI fixture shape. No environment variable was modified by this measurement.
- **`node_modules` in this worktree is a symlink to the main checkout**: `node_modules -> /Users/ramiro/Desktop/projects/colloseum/node_modules` (pre-existing, created before this run). Consequence: stack traces resolve through `../colloseum/node_modules/...`. Dependencies are shared with the off-limits main checkout. Nothing was installed; `npm install` was not run.
- **Commands beyond the authorized test list.** The parent asked me to state what I verified about the database setup, so I ran read-only inspection only: `docker ps`, `lsof`, `docker exec <container> psql -tAc "<catalog/SELECT>"`, `git rev-parse`, `git status`, `git ls-files`, and repo file reads. No DDL/DML, no `docker` mutation, no install, no repository-state change. The only authorized test command was `npx vitest run` (plus the permitted verbose reporter invocation); `npm run lint` / `npm run typecheck` / the frontend suite / `npm run eval` were **not** re-run.
- The main checkout `/Users/ramiro/Desktop/projects/colloseum` was never entered or modified.
- No files were mutated by this task other than this baseline document.

---

# attempt 1 — INVALIDATED RECORD (invalid database setup)

> **DO NOT USE AS A BASELINE.** The database behind this run was built from the legacy `src/db/migrations` path, so the `extensions` schema was absent. The 11-test `error: schema "extensions" does not exist` cluster below is an artifact of that wrong setup. Kept verbatim only as the historical record.

# 91 — Pre-Change Test Baseline

Read-only measurement. No source file was edited, no test was fixed, nothing was committed.

Working root: `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`
Branch: `feat/solana-operational`

## Exact commit

```
$ git rev-parse HEAD
a121b2c68f668cf595b907cff719a2aef361a3c3
```

## `git status --porcelain`

```
?? compose.privy-local.ports.yaml
?? openspec/changes/trusted-recipient-policy-sync/
```

Identical before and after all runs (verified). No tracked file was modified by this measurement.

## Command results — backend (worktree root)

### 1. `npm run lint`

Exit status: **0 (pass)**. `eslint src tests --max-warnings=0`. No output beyond the npm banner.

### 2. `npm run typecheck`

Exit status: **0 (pass)**. `tsc -p tsconfig.test.json --noEmit`. No diagnostics.

### 3. `npx vitest run`

Exit status: **1 (test failures)**.

```
 Test Files  12 failed | 142 passed | 4 skipped (158)
      Tests  17 failed | 1017 passed | 10 skipped (1044)
   Start at  02:55:03
   Duration  37.59s (transform 4.55s, setup 2.00s, import 54.94s, tests 257.06s, environment 32ms)
```

## Backend failures — complete list by full name, with first assertion message

17 failures across 12 files. Format: `file > describe > test`, then the first failure message verbatim.

1. `tests/integration/api-conversation-resolution.test.ts` > conversation transfer resolution > claims one preview atomically across independent repository clients
   `error: schema "extensions" does not exist`

2. `tests/integration/api-conversation-service.test.ts` > typed conversation service with fixture wallet > completes preview, atomic confirmation, and fixture finality through HTTP
   `AssertionError: expected 500 to be 200 // Object.is equality`

3. `tests/integration/api-voice-auth.test.ts` > /v1/voice/room-token authorization (PMU-020, privy mode) > returns the same 404 for a foreign conversation as for a missing one
   `Error: Test timed out in 15000ms.`

4. `tests/integration/conversation-preview-claim-race.test.ts` > previewTransfer real claim semantics > two simultaneous confirms broadcast exactly once (V8.5)
   `error: schema "extensions" does not exist`

5. `tests/integration/grant-claim-release.test.ts` > phase 8: reservation release on definitive no-dispatch (RED) > 8.4b RED: real PostgresConversationRepository.claimPendingTransfer returns the persisted claim_id
   `error: schema "extensions" does not exist`

6. `tests/integration/notifications-outbox-dispatcher.test.ts` > assistant outbox dispatcher PostgreSQL atomicity > rolls notification insert back with outbox completion, retries once, then publishes after commit
   `error: schema "extensions" does not exist`

7. `tests/integration/notifications-outbox-dispatcher.test.ts` > assistant outbox dispatcher PostgreSQL atomicity > completes a dedupe loser without publishing another invalidation
   `error: schema "extensions" does not exist`

8. `tests/integration/notifications-outbox.test.ts` > assistant lifecycle outbox (repository transitions) > writes outbox rows atomically for submitted then finalized terminal states
   `error: schema "extensions" does not exist`

9. `tests/integration/notifications-outbox.test.ts` > assistant lifecycle outbox (repository transitions) > emits uncertain on the uncertain path
   `error: schema "extensions" does not exist`

10. `tests/integration/notifications-outbox.test.ts` > assistant lifecycle outbox (repository transitions) > emits nothing for previewed/cancelled/retry and zero-row stale updates
    `error: schema "extensions" does not exist`

11. `tests/integration/notifications-outbox.test.ts` > assistant lifecycle outbox (repository transitions) > emits reverted and receipt_invalid terminal outbox rows
    `error: schema "extensions" does not exist`

12. `tests/integration/notifications-outbox.test.ts` > assistant lifecycle outbox (repository transitions) > rolls back the attempt transition when the outbox insert fails
    `error: schema "extensions" does not exist`

13. `tests/integration/voice-touch-decision-race.test.ts` > live voice and touch decision race > claims once and reaches one terminal state
    `error: schema "extensions" does not exist`

14. `tests/integration/wallets-sync.test.ts` > /v1/wallets sync + embedded wallet service (PEW-002/003/005) > PEW-013: explicit activation with read-back; empty allowlist rejected (422)
    `AssertionError: expected 422 to be 200 // Object.is equality`

15. `tests/unit/realtime-agent-session.test.ts` > OpenAI realtime agent session composition > allows one re-read when a confirmation is refused for an incomplete read-back
    `AssertionError: expected 'You are Nani, the voice assistant of …' to match /except when a confirmation is refus…/iu`

16. `tests/unit/realtime-tool-binding.test.ts` > realtime tool binding — production execution against the fixture stack > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy
    `AssertionError: expected [] to have a length of 1 but got +0`

17. `tests/unit/realtime-tools.test.ts` > createRealtimeTools > send_token delegates the preview to the service and strips the recipient address
    `AssertionError: expected "vi.fn()" to be called with arguments: [ StringContaining{…} ]`

### Failure-message clustering (observed, not diagnosed)

- 11 of 17 failures (#1, #4, #5, #6, #7, #8, #9, #10, #11, #12, #13) share the identical first message `error: schema "extensions" does not exist`, all raised from `src/conversations/postgres-repository.ts:371` inside `DatabaseClient.withUserTransaction` (`src/db/client.ts:89`).
- 6 of 17 are distinct assertions: #2 (500 vs 200), #3 (15s timeout), #14 (422 vs 200), #15 (persona prompt regex), #16 (no broadcast call), #17 (speakPreview not called).

## Command results — frontend (`cd apps/nana-wallet`)

Command run as authorized, chained: `npm run lint && npm run typecheck && npx vitest run`

Exit status: **0 (pass, whole chain)**.

- `npm run lint` (`eslint .`): pass, no output.
- `npm run typecheck` (`tsc --noEmit`): pass, no diagnostics.
- `npx vitest run`:

```
 Test Files  21 passed (21)
      Tests  112 passed (112)
   Start at  02:56:21
   Duration  2.71s (transform 595ms, setup 1.50s, import 1.39s, tests 4.47s, environment 9.18s)
```

Frontend failures: **none**. Frontend skipped: **none** (0 files, 0 tests). Frontend test files on disk: 21, matching the 21 reported.

## Lint / typecheck summary

| Command | Result |
|---|---|
| backend `npm run lint` | pass, exit 0 |
| backend `npm run typecheck` | pass, exit 0 |
| frontend `npm run lint` | pass, exit 0 |
| frontend `npm run typecheck` | pass, exit 0 |

No errors to report.

## Skipped tests (flagged — skipped is NOT passing)

Backend:

```
 Test Files  12 failed | 142 passed | 4 skipped (158)
      Tests  17 failed | 1017 passed | 10 skipped (1044)
```

- **4 backend test files and 10 backend tests were skipped**, not passed. They appear in neither the passed nor the failed sets above.
- The default vitest reporter used by the authorized command does **not** print the names of skipped tests or skipped files, so the exact identities of those 4 files and 10 tests were **not observable from the authorized run output** and are recorded here as unverified.
- Static inventory of skip gates found in `tests/` (read-only inspection, NOT confirmation of what actually skipped at runtime):
  - `describe.skipIf` / `it.skipIf` on `!DATABASE_URL` (many integration files) — these gates are **satisfied**, since `DATABASE_URL` is present, so they should have run.
  - Opt-in gates that are **not** satisfied in this environment and are the plausible skip sources: `tests/e2e/livekit-smoke.e2e.test.ts` (`LIVEKIT_E2E`, `describe.skipIf` + 3 `it.skipIf`), `tests/e2e/wdk-mcp-connection.e2e.test.ts` (`WDK_E2E`), `tests/e2e/wallet-agent-live-preview.e2e.test.ts`, `tests/integration/wdk-transfer.manual.test.ts` (2 `it.skipIf`), `tests/unit/recipient-memory-service.test.ts:158` (`it.runIf(RECIPIENT_MEMORY_REAL_EMBEDDING === '1')`).
  - This mapping was not confirmed against runtime output and must not be treated as the baseline.

Frontend: **0 skipped**, verified both by the reporter summary (`21 passed (21)`, `112 passed (112)`, no skipped count) and by the absence of any `skip`/`todo`/`skipIf`/`runIf` marker under `apps/nana-wallet/src` and `apps/nana-wallet/tests`.

## Environment notes

- `DATABASE_URL` is present in the worktree's git-ignored `.env` (host `127.0.0.1:55470`, database `wdk_agent`, `options=-csearch_path%3Dpublic,extensions`). Value not printed. `tests/setup/isolate-provider-env.ts` loads `dotenv/config` and deliberately does **not** clear `DATABASE_URL`, so the DB-gated integration suites did run rather than silently skipping.
- `tests/setup/isolate-provider-env.ts` deletes the provider/identity/voice credential keys (`PRIVY_*`, `LIVE_VOICE_*`, `LIVEKIT_*`, `OPENAI_API_KEY`, `OPENCODE_GO_*`) so the suite runs in its CI fixture shape. No environment variable was modified by this measurement.
- **`node_modules` in this worktree is a symlink to the main checkout**: `node_modules -> /Users/ramiro/Desktop/projects/colloseum/node_modules` (pre-existing, dated 9 Oct; created before this run). Consequences observed: failure stack traces resolve through `../colloseum/node_modules/pg/lib/client.js`. Dependencies are therefore shared with the off-limits main checkout. Nothing was installed or changed; `npm install` was not run.
- Node version: `v26.8.1` (package `engines` requires `>=22.18.0`; satisfied).
- `npm run db:migrate` was **not** run — the brief stated the schema was already applied and it was not needed for these commands.
- The 11 `schema "extensions" does not exist` failures are consistent with the `extensions` schema named in the `search_path` not existing in the worktree's database. Root cause was **not** investigated, because doing so would have required database commands outside the authorized set. These are recorded as an environment-shaped failure cluster, not as code regressions.
- The brief described the tree as "clean apart from an untracked `compose.privy-local.ports.yaml`". Actual `git status --porcelain` shows **two** untracked entries: additionally `openspec/changes/trusted-recipient-policy-sync/`.
- `npm run eval` was not run, as instructed.
- No files were mutated. The only file written by this task is this baseline document.

## Reproduction

All commands were run sequentially from the worktree root (`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`) at commit `a121b2c68f668cf595b907cff719a2aef361a3c3`, with the worktree's `.env` in place and its Postgres container on host port 55470.
