# Automatic embeddings implementation outline revision 2

Controlling design: 03-design-discussion.md revision 3, approved by Ramiro on 2026-10-23 ("apruebo eso"). Source workspace: /Users/ramiro/Desktop/projects/colloseum.feat-remote-supabase-vector; branch feat/remote-supabase-vector; source main cd306e9. Research: 04-automatic-embedding-research.md. This outline introduces no additional product defaults.

## Prerequisite before any implementation

Create and validate complete OpenSpec proposal/spec/design/tasks for automatic-supabase-embeddings, preserving this design and slice dependencies. Read current openspec/config.yaml; strict_tdd=false. Record authoritative applyState=ready and allowed roots for each executor before editing code. Use SDD apply for assigned tasks and independent verify after tasks finish. Planning approval does not activate incomplete runtime components.

Delivery: auto-chain, stacked-to-main. Create focused dependent PRs targeting the preceding layer, first targeting main; register each PR with T3. Keep each authored code/test diff near or below 400 lines by splitting a slice into sublayers when its actual diff requires it. Do not silently select size:exception. Dormant layers may merge only if their incomplete state is explicit and cannot affect live behavior. Final writer/model activation waits for the complete verified chain. User approval covers eventual indexing, model/API text processing, a short write pause at activation, and this delivery mode.

## Slice 1: dormant source lifecycle and transactional queue

Add mirrored new SQL migrations (reserve next names at apply time), private outbox, nullable actual vectors/model revision, indexing state, desired model and independent generation for both recipients and user_memories. Stage activation disabled so old app writers/readers remain compatible until cutover. Trigger functions invalidate/enqueue on content/active/model changes; enable them only at activation. They do no network work or policy mutations. Prevent normal app roles from writing protected indexing metadata after activation; preserve allowed business columns and forced owner RLS.
Outcome: direct SQL writes have a defined indexing lifecycle once enabled; rollback cannot leave orphan work; old rows retain their true model identity during dormant rollout.
Files: new supabase/migrations and src/db/migrations mirrors, focused database tests/fixtures.
Checks: each migration chain on a separate fresh PG16 DB; activation off/on; both table inserts/updates; rollback removes job; archive without business-version bump fences prior work; reactivation enqueues; no recursive completion; physical deletion; no business version/history/policy/grant changes from embedding-only writes; unauthorized metadata/queue access denied. Test old-vector expansion without relabeling.
Stop: schema parity, RLS or any wallet invariant regresses.

## Slice 2: fenced claim/completion/failure RPCs

Add narrowly privileged fixed-search_path RPCs and grants. Claims commit before remote I/O; completion checks owner/kind/ID/current generation/active status/model plus unexpired token. Source-before-job locking for completion/invalidation, job-only claiming. Retry backoff, expiry and five-attempt failure handling follow approved design. Stale success/failure never changes the newer row. Give queue jobs references rather than copies of raw text/addresses.
Outcome: concurrent workers, crashes and late results cannot replace current content or cross owners.
Checks: real two-connection races, SKIP LOCKED, duplicate delivery, edit/archive/delete/reactivate during inference, expired/reclaimed token, stale failure, source/job lock ordering, privileged role versus PUBLIC/anon/authenticated/recipient_app grants. Runtime harness invokes actual SQL claim/complete/fail against fresh isolated DB. No provider calls.
Stop: any stale/unauthorized update or deadlock in mapped scenarios.

## Slice 3: shared provider/text contract and authenticated query endpoint

Add pure revisioned text/provider helpers in supabase/functions/_shared and embedding-query endpoint. OpenAI text-embedding-3-small with required dimensions384, finite positive-norm output validation and normalization; model identity includes text revision and epoch. Preserve canonical preprocessing; send no dedicated addresses/provenance/wallet fields. Enforce 6000-byte text cap with no silent truncation. Auth before parsing/work; fixed model/provider, three-second query deadline. Keep OpenAI secret only in Edge and use a distinct backend query credential.
Outcome: on-demand query vectors are compatible with the future worker output, without local model loading.
Files: supabase/functions shared/query code, explicit function auth config, Edge test runner configuration.
Checks: missing/wrong auth and mode token; no provider work before auth; canonical Unicode/Spanish parity; request model/dimensions; invalid JSON/model/index/count/dimension/nonfinite/zero vectors; errors/timeouts/oversize. Explicit Edge lint/typecheck/tests, since default root globs do not cover Deno. Controlled provider endpoint; no live text/cost during local tests.
Stop: incompatible vectors, credential exposure or untested Edge tree.

## Slice 4: bounded drain worker and portable complete-path E2E

Add embedding-drain handler with drain-only credential, bounded batch4/concurrency2, job lease90s, provider15s timeout and bounded invocation. Reuse exact provider/text contract from Slice3; retain RPC fencing and capped retry policy. Deployment/runbook must identify failure/manual retry ownership and global auth/rate failure behavior without raw-text logs.
Outcome: committed SQL jobs become ready vectors with the real handler against controlled inference.
Checks: missing/wrong/query credential cannot claim; malformed output and provider errors; healthy work progresses behind failed work; crash/lease reclaim and late result; SQL insert for recipient AND fact -> job -> actual Edge handler -> vector ready, all on isolated PostgreSQL. Prove no transaction open during remote provider wait. Fixtures never reach live OpenAI/Supabase. Use Portless if starting test HTTP servers.
Stop: end-to-end lifecycle unproven or duplicate mutation.

## Slice 5: compatible search, exact fallback and application write cutover

Remove synchronous write inference from contact-policy adapter, contact/memory repositories/services and seeds, preserving their transaction clients, confirmations and idempotency. Add authenticated remote query client for backend/voice. Semantic SQL guards owner+active+ready+nonnull+actual/desired/requested revision for both tables. After obtaining the remote query vector, evaluate the incomplete-index gate and semantic candidate selection from the SAME database snapshot for each domain (one SQL statement or an explicit repeatable-read transaction containing both checks). Never keep a transaction open during provider HTTP. Any earlier precheck is an optimization only; it cannot authorize the final search. Apply the same snapshot rule to lexical/ambiguity checks when they are used to justify a selection. Exact saved-name branch works before provider invocation and examines all owner matches for ambiguity; no synthetic cosine scores. Implement the approved conservative incomplete-index gate. Choose a bounded lexical implementation during SDD design without introducing a new contact-count product limit; if unavoidable, return for that specific decision. No HTTP payload additions are approved.
Remove production model warmup/prefetch dependencies from API/worker and Docker only after auditing all callers. Adapt fixtures explicitly for lifecycle tests; do not hide pending state with automatic production inference mocks.
Outcome: business saves succeed independently of inference, exact names work during pending/outage, and semantics never selects from an incomplete/incompatible candidate set. Query/provider failure remains honest unavailable, not empty evidence or a wrong payee.
Checks: exact accent-folding/duplicate matches beyond top5; pending competitor; failed/incompatible states; both source tables; query outage; same-user/cross-user; address-free candidates and selected-recipient version revalidation. Add real two-connection races for BOTH recipients and user_memories: after an optimistic precheck and while query inference is in flight, insert, reactivate or edit a competing row so it is pending before the final search snapshot. The final search must return unavailable rather than selecting a ready competitor or returning empty fact evidence. Include a control with a complete compatible snapshot that can return results, and verify no transaction was held over the HTTP wait. Results are defined at the final selection snapshot; existing version revalidation continues to guard later recipient use. Existing HTTP/voice contact mutations and policy rollback tests; preview/confirmation fake E2E; real SQL/Edge/search E2E. Backend lint/typecheck/full tests/evals/build and startup scripts. Frontend lint/typecheck/tests/build if contract changes unexpectedly become necessary, after coordinated design review.
Stop: any payment/confirmation/owner regression, unapproved UI/contract change, unsafe partial rollout or unresolved stale baseline failures.

## Slice 6: Spanish quality acceptance, hosted deployment and activation

Build/evaluate the agreed Spanish corpus for names, accents, relationships, ambiguity and distractors. Select retrieval thresholds from evidence; keep uncalibrated semantic choices clarification-only. No inherited MiniLM threshold is declared valid for OpenAI without measurements. Verify query and document vectors use the same revision.
Prepare concrete deployment artifacts and local verification results before any deployment approval request. Re-inventory remote data/model distribution, linked Nana Wallet and readiness. If rows appeared, obtain a scoped backfill/cutover decision. Exclude Nana Landing and all legacy local data. Provision OpenAI/query/drain credentials opaquely; enable one pg_cron/pg_net schedule using only drain token via Supabase Vault. Keep secrets out of files committed to git and logs. No generic agent scheduler is created.
After approval of the concrete rollout, pause HTTP and voice writers briefly, deploy compatible components, activate automatic triggers/model epoch and scheduler, then restore writers. Hosted checks use bounded approved synthetic data with cleanup, no transfers. Demonstrate direct SQL write without vector -> scheduled generation -> compatible backend lookup for both source types; verify auth/refusals, app/worker remote database, HTTPS API and signer/voice infrastructure. The hosted provider check is separate from isolated test suites.
Rollback: stop scheduler/claims and preserve rows/jobs; retain exact lookup and explicit semantic unavailability. Never restore old readers onto new-model vectors. Model rollback/backfill is a separate reviewed operation.
Stop: remote state differs from approved inventory, secrets/capacity unavailable, Spanish quality fails, or rollback/cutover cannot preserve data.

## Required evidence and unresolved gates

Every slice records exact focused commands/results, runtime path and rollback boundary in SDD apply-progress, then independent verification. Required test scopes include fresh migration parity, unit/integration/Edge checks, complete backend checks, relevant E2E and provider-specific hosted acceptance. Name external blockers and actual skips; no pass from skipped suites. Local test dependencies are provisioned by executor; never run the suite against remote DATABASE_URL.

The research flagged the prior backend connection-termination crash. Its reliability fix is separate; this outline does not hide it as embedding failure or widen into unrelated service repair. CI cleanup remains preserved in its own worktree; current red main baseline must be documented and addressed before final integration per repository rules.

Human design approval: recorded. Independent Codex-high review: pending (user-approved substitution for exhausted Pi/GLM). Human outline approval: pending. Implementation has not started.
