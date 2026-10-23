# Verification and threat evidence

No checks in this document have run during planning. Each apply work unit records exact commands, exit codes, output hashes, exercised runtime path and rollback evidence in apply-progress; skipped tests are not passes. Parent owns dependency/DB provisioning and git/PR activity. Never use remote DATABASE_URL or live inference for local tests.

## Local commands

Run from worktree root unless a command includes a different cwd. Harnesses fail explicitly when their required local database is absent; they must not silently skip. `EMBEDDINGS_TEST_DATABASE_URL` is injected by the parent and denotes loopback disposable PostgreSQL; never print its value or read .env. The reusable helper creates uniquely named `embedding_*` scratch databases and drops only databases it created. Supabase chain and backend mirror chain run on separate fresh databases, never atop each other. Apply `supabase/roles.sql` plus all Supabase migrations to the former; the backend migration runner creates the latter. Fresh test fixtures enable activation explicitly; normal production migrations stay dormant.

| ID | Exact planned command | Required evidence |
|---|---|---|
| V1 | `npx vitest run tests/integration/automatic-embeddings-foundation.test.ts tests/e2e/automatic-embeddings-foundation.e2e.test.ts` | Fresh-chain parity, NOT NULL retained in U1.1, guarded nullable expansion later, dormant legacy roundtrip and local-only source save/read |
| V2 | `npx vitest run tests/integration/automatic-embeddings-lifecycle.test.ts` | Both-table SQL insert/update/rollback/archive/reactivate/delete, incarnation/generation and metadata protection |
| V3 | `npx vitest run tests/integration/automatic-embeddings-rpc.test.ts tests/integration/automatic-embeddings-races.test.ts` | Actual SQL calls/roles, two-connection token/source/job races, attempt accounting |
| V4 | `deno task --config supabase/functions/deno.json check` | Deno fmt --check, lint and check all entrypoints/shared files; root globs are insufficient |
| V5 | `deno task --config supabase/functions/deno.json test` | Canonical/provider/auth/budget/handler adversarial tests with controlled fetch and clock |
| V6 | `deno task --config supabase/functions/deno.json e2e` | Real PostgreSQL RPCs → real query/drain handlers → controlled HTTP provider; both sources, no external egress |
| V7 | `npx vitest run tests/integration/automatic-embeddings-search.test.ts tests/integration/automatic-embeddings-search-races.test.ts` | Exact complete scan and both-domain final-snapshot races plus ready controls |
| V8 | `npx vitest run tests/e2e/automatic-embeddings.e2e.test.ts tests/integration/livekit-worker-fake.e2e.test.ts tests/integration/livekit-voice-confirmation-fake.e2e.test.ts` | Actual service/repositories + handler + SQL search, fixture preview/confirmation/version/idempotency, voice fake |
| V9 | `npx vitest run tests/unit/embedding-spanish-corpus.test.ts` | Offline corpus acceptance and revision-bound threshold artifact |
| V10 | `npm run lint`; `npm run typecheck`; `npm test`; `npm run eval`; `npm run build`; `node --test scripts/docker-real-wallet.test.mjs scripts/dev-stack.test.mjs` | Full backend and startup checks; integration runs use isolated local DB |
| V11 | `npx vitest run tests/unit/embedding-promotion.test.ts` | Readiness manifest, mixed-fleet refusal and schedule/activation rollback in controlled fixtures |

Deno tasks are new deliverables in slice3. Pin the Deno major/toolchain in CI and use explicit filename lists or discovered whole-tree globs, never only index.ts. E2E requires `--allow-net=localhost,127.0.0.1` (including the actual local fixture host aliases), narrowly named env/read permissions, no --allow-all. Dependency caching/install is separate from execution and may fetch packages, never invoke live providers. Vitest setup must blank inherited provider credentials; handler factories take controlled dependencies. Functions export pure Web handlers; only Deno entrypoints read env and call Deno.serve. Tests never import a server that starts listening as an import side effect.

For V6, use a test-only `npm:pg` SQL RPC adapter implementing the SAME fixed production RPC signatures against a real scratch database with the isolated worker role. Do not stub queue contents, source state or completion. The controlled provider is a Portless-named HTTP server with deterministic vectors/error/delay modes; its HTTP boundary is real. Production RPC HTTP transport also gets a local protocol/auth refusal test; PG17 local Supabase validates PostgREST grants/config before hosted approval. V8 wires the actual backend memory service to these same real handler/RPC components, then exercises SQL-triggered contact and fact creation through readiness and search. No actual wallet provider or transfers are required.

For local Supabase PG17, parent starts an isolated stand-in (`supabase start` / reset via an isolated project configuration), checks both table paths, deployed function configuration and fixed RPC execution privileges. Do not reset another worktree's stack. If unavailable, report its exact blocker separately from successful PG16 evidence; remote promotion remains blocked until this compatibility check passes.

Existing wallet/browser suites remain required where affected: `npm run test:e2e:trusted-recipient-browser` uses the repository fixture harness and stable Portless URLs. If current harness needs an external service, record the exact missing service/credential NAME and command; do not equate an opt-in skip with execution. Live WDK/LiveKit/provider suites are separately gated and must never be invoked with inherited live keys as part of this isolated work. Any frontend/HTTP contract change stops this plan for scope reconciliation, mirrors types and adds frontend lint/typecheck/test/build plus relevant browser E2E.

## Normative threat/test map

The following concrete adversarial cases are regression-test tasks before the corresponding production implementation, without enabling strict TDD globally.

| Case | Input/race | Safe/failure behavior | Checks / work units |
|---|---|---|---|
| T1 | Missing, wrong and opposite endpoint credentials; unauthenticated malformed/large body | 401 before body parse, SQL, provider work | V5; 3.3 |
| T2 | Caller model/table/URL override, redirect, >16KiB body, >6000 canonical bytes, empty input | Reject; no arbitrary execution/truncation | V5; 3.1–3.3 |
| T3 | Wrong model/index/data count/dimension, NaN/Infinity/zero norm, malformed JSON | Reject and never mark ready/select | V5/V6; 3.2, 4.1–4.3 |
| T4 | PUBLIC/anon/authenticated/recipient_app invokes worker RPC; app forges metadata; missing/wrong app.user_id | Deny; no owner leak or metadata changes | V2/V3; 1.4, 2.1–2.4 |
| T5 | Edit/archive/delete/reinsert/reactivate while inference waits; stale success AND failure | Source incarnation/generation/model and live job/run token win | V3/V6; 2.2–2.4, 4.3 |
| T6 | Expired/reclaimed jobs, duplicate delivery, simultaneous claimers, reverse-lock attempts | Unique lease; no deadlock/stale publication; source-before-job | V3; 2.1–2.4 |
| T7 | Poison row, timeout/429/5xx, auth/quota outage, crash, duplicate wake | Healthy progress, bounded retry/leases, global pause, reserved query budget | V3/V5/V6; 2.3–2.4, 3.3, 4.1–4.3 |
| T8 | Other-owner exact/semantic candidate, duplicate outside top5, cursor timeout | Owner isolation, clarification or unavailable; no partial uniqueness | V7/V8; 5.1, 5.4 |
| T9 | Insert/reactivate/edit pending competitor after precheck DURING query HTTP for BOTH domains | Final gate+candidates share snapshot; unavailable, plus complete-domain positive control | V7/V8; 5.2–5.4 |
| T10 | Ready NULL/zero/wrong-model rows or failed fact index | Incompatible domain unavailable, never empty success | V7/V8; 5.2–5.4 |
| T11 | Embedding completion touches wallet version/policy or stale address used after match | No business mutations; version/network/preview/confirmation guard remains | V2/V8; 1.3, 5.3–5.4 |
| T12 | Legacy writers during dormancy; candidate writers before activation; mixed reader fleet at cutover | Preserve old identity; prohibit serving partial app; promotion refuses mixed fleet | V1/V11; 1.1, 6.2 |
| T13 | Errors/logs contain raw text/vector/auth/provider body | Allowlisted diagnostics only; no secret/text exposure | V5/V6/V11; 3.3, 4.1, 6.2 |
| T14 | Changed remote data/project, missing quality evidence, duplicate scheduler, failed activation | Stop promotion; disable schedule/claims, retain rows/jobs/exact lookup | V11 plus hosted checklist; 6.1–6.3 |

Shared design-skill matrix: documentation-like executable classification N/A (no classifier); git -C/relative/absolute repository selection N/A (no VCS feature); staged/commit-a/empty-index state N/A; tracking/first-push/refspec N/A; PR head/env/composition N/A. The parent performs delivery manually within its existing authority; this feature introduces none of these automation boundaries.

## Corpus and acceptance (R4)

Store a versioned Spanish fixture with recipient AND fact cases: Sofía/Sofia and Muñoz/Munoz; composed/decomposed text; exact aliases and duplicate names; qualified name/description/prefix; family relationships with multiple identities; near neighbors, unrelated distractors, empty/pending/failed domains; owner separation; English controls. Every case labels expected unique identity, clarification, no-match or unavailable before tuning.

Offline tests prove corpus/ranking plumbing and uncalibrated clarification-only behavior using deterministic vectors. They do not establish OpenAI quality. A deployment-authorized bounded real-provider calibration produces the actual vector fixture/threshold evidence for the fixed revision; no provider call occurs in this planning executor or default tests. Split labeled cases into tuning and held-out sets, retain scores/margins, tune threshold/floor/margin/lexical bonuses together. Require zero wrong automatic recipient selections and all labeled ambiguity/distractor safety cases to refuse unsafe selection on held-out data; report coverage and correct-match recall rather than claiming broad accuracy. Facts must preserve relationship evidence. If evidence fails or is missing, semantic selection stays clarification-only and hosted acceptance/promotion cannot claim completed quality. Never copy the old 0.78/0.55/0.08 as accepted values.

## Final and hosted evidence

Independent verify compares all 18 requirements and 33 scenarios to artifacts and actual test output. A strict verify report uses authoritative counts and admission validation before persistence; this planner creates no verification report or receipt. Record raw failures attributable to red main CI and unrelated connection-termination crash as separate dependencies. No weakened lint rules, excluded tests, increased timeouts or ignored failures may manufacture a green result. Parent resolves CI before final integration.

Hosted checklist is deferred until local evidence and concrete deployment authority: linked Nana Wallet/project inventory, official CLI dry-run, opaque credential provisioning, capacity, image/function hashes, compatible fleet pause, grants/activation, one minute scheduler using drain-only Vault token, real synthetic BOTH-source SQL generation and authenticated search/refusals, cleanup, HTTPS/database/voice/signer health and rollback drill. No transfers, live-user data movement or Nana Landing changes. Exact external blockers and skipped hosted suites remain explicit.
