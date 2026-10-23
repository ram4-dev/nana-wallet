# Automatic Supabase embeddings — design revision 3

Status: proposed for human design approval. The user requested automatic generation after learning that SQL inserts need explicitly configured automation. This supersedes the temporary keep-current-generation decision recorded in intake and git history.

## Intended behavior

1. A confirmed contact or memory save commits immediately to the existing Nana Wallet remote Supabase project. A SQL trigger records a durable embedding job in that same transaction. Direct SQL inserts/updates receive the same indexing behavior when they satisfy the existing business/confirmation constraints.
2. A Supabase Edge Function processes queued jobs using OpenAI text-embedding-3-small with dimensions=384. Contact/memory writes never load a local model or call the network while wallet transactions/locks are open.
3. The backend obtains query vectors on demand from a separate authenticated Edge endpoint using the same model, canonical text transformation and application revision. Supabase pgvector stores the document vectors and performs similarity queries. No local inference fallback or mixed-model comparison is permitted.
4. Until indexing completes, a unique exact saved name can resolve through an owner-scoped lexical lookup, including accent folding. Duplicate names require clarification. Semantic recipient selection is unavailable while the owner's relevant active rows are pending, failed or incompatible, so a pending competitor cannot be silently excluded. Facts likewise distinguish unavailable retrieval from an empty successful result.
5. Contact CRUD and policy readiness remain independent of semantic indexing. No new HTTP fields or frontend feature are planned. Existing conversation/tool outcomes must explain temporary search unavailability and ask for an exact saved name. Preview, explicit confirmation, idempotency, recipient version revalidation and per-user isolation remain required.

## Database and processing contract

Add a mirrored migration for recipients/user_memories: allow NULL vectors while pending; record desired/actual embedding revision, readiness state and independent generation. Use a private ordinary SQL outbox so the core migration and tests remain compatible with the existing PG16 compose image. No embedding-only completion changes business version, recipient_versions, wallet policy, grant, proposal or confirmation state.

Triggers invalidate results and advance the indexing generation on content changes, archive/reactivation and target-model changes. Completion must match source owner, kind, ID, current generation, active status, target revision and the claimed unexpired job token. Stale successes and failures cannot overwrite or fail a newer generation. Jobs never resurrect deleted rows. Keep a consistent source-before-job lock order for completion/invalidation; claims do not hold a transaction during HTTP requests.

Default operating limits: scheduled drain once per minute; batch at most four rows, concurrency two; provider timeout 15 seconds; job lease 90 seconds; transient retries with capped exponential backoff, maximum five attempts, then failed/manual retry. Query requests have a three-second deadline and no unbounded retry. These are bounds, not a guarantee that every row is indexed within one minute. Persistent provider outage leaves data saved and search honestly unavailable.

Input must be nonempty, bounded and never silently truncated. Use a 6000 UTF-8 byte canonical-text cap, consistent revisioned normalization and exactly 384 finite nonzero output values. Validate and normalize returned vectors. An oversize row remains saved but reports failed indexing. No arbitrary model/table/URL is accepted from callers.

## Credentials and data handling

OpenAI receives only the text required for matching: contact names/descriptions, confirmed memory facts and search queries. Dedicated addresses, wallet fields, provenance and signing credentials are excluded. Existing text redaction is not a guarantee that free text contains no personal data. This external text processing and per-token API cost are explicit design choices to approve.

Provision secrets through vault-env and Supabase secret mechanisms. The OpenAI key remains in Edge. Backend has only a query-function credential; scheduler has only a drain-function credential. Both endpoints authenticate before processing. Privileged database RPCs revoke public/client execution and validate source ownership/generation even under worker privilege. Queue tables are private and not writable through normal application roles. Log only safe codes/counts/latencies, never raw texts, vectors or credentials.

Use one remote pg_cron/pg_net wake adapter with a narrowly scoped drain token stored in Supabase Vault. Do not place the OpenAI or service-role key in scheduler request payloads. Document the exposure of that drain-only token to privileged database operators. Core local migrations do not require those extensions; local E2E invokes the real Edge handler with a controlled provider. Scheduler setup is a separate tracked deployment step, not an agent automation.

## Model acceptance and rollout

Model identity includes provider/model, dimension, text preprocessing and epoch. Do not relabel old MiniLM vectors or reuse previous semantic thresholds without validation. Build a Spanish recipient/fact corpus covering exact names, accents, relationships, duplicate/ambiguous names and unrelated distractors. Choose thresholds from that evidence; uncalibrated semantic results remain clarification-only. Preserve existing recipient selection and address revalidation safety checks.

Before remote deployment, recheck current rows/model distribution and linked Nana Wallet project. If old vectors or new user data exist, stop for a backfill/cutover decision rather than deleting/relabeling them. Do not migrate legacy local user/test data. Use a brief controlled pause of both HTTP and voice writers during final activation after all components and guards are ready. Nana Landing is excluded.

Stage: dormant schema/queue, fenced processing, authenticated Edge endpoints, compatible application readers/writers, then remote activation and scheduler. Deployment must not activate a partial pipeline. On failure disable new claims/scheduler, retain business data/jobs and exact-name lookup; do not roll back to readers of incompatible vectors. No live transfers are needed for verification.

## Validation and delivery

Existing openspec/config.yaml has strict_tdd=false. After design approval, prepare a complete RPI outline, obtain independent Codex-high review (user-authorized substitution for exhausted Pi/GLM), then human outline approval. Create/validate SDD proposal/spec/design/tasks before implementation. Execute through SDD apply/verify in this isolated Worktrunk checkout.

Tests: portable migrations on fresh isolated databases for both migration chains; SQL-triggered creation for both tables; transaction rollback, duplicate/late jobs, archive/reactivation and lease races; owner/RLS/RPC authorization; remote provider contract and malformed/error cases; Spanish retrieval corpus; real SQL-to-Edge-handler-to-search E2E with controlled provider and fixture wallet. Run backend lint/typecheck/tests/evals/build and Edge-specific checks. Run frontend checks if HTTP types change. Required repository E2E must run or record the exact external blocker. Do not run the integration suite against remote Supabase.

Hosted acceptance: deploy only after local verification and an approved concrete deployment result. Use bounded synthetic generation/search checks in Nana Wallet with explicit cleanup, no payments; verify scheduler and query authentication, actual generation and matching. Provider availability/spend limits are observed, never assumed. Deployment approval, if needed, is the final step after concrete artifacts/checks exist.

Forecast: roughly 1350-2300 authored changed lines including mirrored SQL and tests; this is more than a small provider swap. Recommended delivery choice: auto-chain (stacked-to-main) using focused dependent PRs, each reviewed and validated before integration, final result in main. No size-exception or oversized single PR is assumed. User design approval must include this delivery strategy before apply; exact boundaries come in the reviewed outline.

## Approval record

Gate: remote-supabase-vector-design-r3
Allowed action requested: accept the behavior, OpenAI text processing/model and eventual indexing, bounded operating defaults, short activation pause and auto-chain delivery described above; proceed to outline/review, then implementation only after its required gate.
Decision owner: Ramiro.
Status: proposed; no schema/source changes, external provider calls or deployment performed.
