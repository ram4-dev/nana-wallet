# Bounded implementation work units

This is the detailed task appendix. All units are sequential, owned by the parent-assigned apply executor, and map to exactly one approved slice. The planner edits no implementation files. Each unit starts from its immediate verified predecessor, delivers only its stated primitive/proof, and ends with focused checks plus its runtime harness and recorded rollback boundary. Code/test estimates include BOTH SQL mirrors and additions+deletions; ceiling approximately400. Split again BEFORE exceeding400; no exception is approved. Documentation and complete candidate identity remain visible even when outside the authored code/test estimate.

Delivery: auto-chain, stacked-to-main. U1.1 PR targets main; later PRs initially target the preceding layer, then retarget/rebase onto main as predecessors merge. Inspect each clean relative diff. Parent owns branches, PR creation/registration/reviews/merge. No Git/PR operation is delegated to this planner. Pre-existing red main CI must be resolved separately before integration; no unit may weaken checks. Application sublayers preserve legacy DEFAULT behavior until explicit controlled promotion; incomplete automatic paths never activate themselves.

Estimated total authored code/tests: 4000–6500 lines, including explicit auth/budget/race/E2E proof and SQL mirrors. This refines the earlier broad research estimate; it is not a size exception. Per-unit estimates below are ceilings to plan around, not permission to inflate changes. Reforecast against each actual diff. Test-first means author the mapped adversarial regression before production behavior; strict_tdd remains false.

Commands V1–V11 mean the exact executable commands in verification.md. Each unit expands those commands verbatim in its apply evidence. V1/V2/V3 exercise actual database transactions/RPCs as runtime harnesses; V5 invokes actual pure handlers/helpers, V6/V8 exercise the full provider/SQL/search path. Run applicable backend lint/typecheck/build and repository-mandated E2E for the touched runtime, not only the focused subset. Do not claim future V6 exists before its unit creates it.

## Slice 1 — Dormant source lifecycle

| Unit / target lines | Tasks and concrete files | Focused checks / runtime harness | Rollback boundary |
|---|---|---|---|
| U1.1 / 340 | Add first mirrored foundation migration; source metadata and disabled private control, retaining old NOT NULL constraints. Add `tests/integration/helpers/embedding-database.ts`, `tests/integration/automatic-embeddings-foundation.test.ts`, `tests/e2e/automatic-embeddings-foundation.e2e.test.ts`. | V1: both fresh chains, dormant old-writer/read roundtrip and no activation. | Leave unused additive schema; activation false; remove only owned scratch databases. No down migration/data rewrite. |
| U1.2 / 240 | Append mirrored `_embedding_outbox.sql`; private job references/indexes/unique identity and revoked grants. Extend foundation tests before schema. | V1 plus outbox SQL insert/rollback/private-role assertions in V2. | Queue unused and claims disabled; preserve existing source vectors. |
| U1.3 / 370 | Append mirrored `_embedding_lifecycle.sql`; install guarded BEFORE/AFTER/DELETE functions plus dormant vector/revision validation. Add both-domain lifecycle tests. Cover L1a–L3a and T5/T11 before functions. | V2: activate in isolated fixtures, mutate source → queue, rollback, archive without version bump, reinsert incarnation, no recursive completion. | Keep production activation false; revert unused functions through later additive correction, no source deletion. |
| U1.4 / 300 | Append mirrored `_embedding_protection.sql`; nullable actual vector/revision only after dormant guards exist; operator-only activation/grant switch preserving business columns and forced RLS. Add T4 tests first in lifecycle suite. | V1/V2: old default grants while dormant, protected-column refusal once active; policy/history invariant controls. | Do not apply activation remotely; fixture disable never grants app access to metadata or drops data. |

## Slice 2 — Fenced SQL worker primitives

| Unit / target lines | Tasks and concrete files | Focused checks / runtime harness | Rollback boundary |
|---|---|---|---|
| U2.1 / 350 | Mirrored `_embedding_claims.sql`: run lease, capped SKIP LOCKED claim/read RPCs, definer ownership/search_path and least privilege. `tests/integration/automatic-embeddings-rpc.test.ts`: T4/T6 first. | V3 RPC subset: duplicate claims, expired tokens/run, owner/text projection and grant refusals. | Claims remain disabled; revoke RPC access without changing sources/jobs. |
| U2.2 / 350 | Mirrored `_embedding_completion.sql`: current-tuple vector validation and source-before-job completion; current/forged/stale result tests first. | V3: real completion, edit/archive/delete/reinsert/duplicate late results, no policy/version writes (T5/T6/T11). | Disable claims; retain valid current vectors/jobs and compatible readers. |
| U2.3 / 370 | Mirrored `_embedding_recovery.sql`: fenced failure/manual retry, attempt admission, durable shared query/drain budgets and global pause. Add T7 capacity/error tests first. | V3: five started attempts, Retry-After/backoff ceiling, poison isolation, global auth pause, query reservation and explicit retry. | Pause claims; preserve counters/failed jobs; no automatic retry reset. |
| U2.4 / 300 | `tests/integration/automatic-embeddings-races.test.ts`: two-connection barriers for T4–T7; extend RPC tests only as needed. | V3: stale success AND failure, reclaimed run/job, source→job lock ordering, no deadlock, current positive control. | Test-only unit; close owned connections and drop owned scratch databases. |

## Slice 3 — Model contract and authenticated query

| Unit / target lines | Tasks and concrete files | Focused checks / runtime harness | Rollback boundary |
|---|---|---|---|
| U3.1 / 300 | `supabase/functions/deno.json`, `_shared/embedding-text.ts`, canonical golden tests; backend text parity test in `tests/unit/embedding-text-parity.test.ts`; explicit Edge CI checks. T2 Unicode/byte cases first. | V4/V5 plus `npx vitest run tests/unit/embedding-text-parity.test.ts`; invoke real pure functions on Spanish goldens. | Unwired pure helpers/check infrastructure; live legacy text behavior unchanged. |
| U3.2 / 320 | `_shared/embedding-provider.ts` and provider tests. Test T2/T3 model/dimensions/index/count/nonfinite/zero/redirect/error cases before helper. | V4/V5: controlled HTTP fetch contract, timeout/abort and L2 output. | Unwired provider helper; no live provider credential/call. |
| U3.3 / 380 | `_shared/{embedding-auth,embedding-budget}.ts`, `embedding-query/{handler,index}.ts`, config.toml explicit auth; query/auth tests T1/T7/T13 first. | V4/V5: real query handler, auth-before-body, fixed revision/body cap, three-second deadline and shared-budget refusals. | Endpoint remains undeployed; no backend mode switch; scoped credentials absent by default. |

## Slice 4 — Bounded drain and complete Edge path

| Unit / target lines | Tasks and concrete files | Focused checks / runtime harness | Rollback boundary |
|---|---|---|---|
| U4.1 / 380 | `embedding-drain/{handler,index}.ts`, `_shared/embedding-rpc.ts`, auth config; handler/transport tests T1/T3/T7/T13 before implementation. Split transport into another layer if actual diff grows. | V4/V5: real bounded drain against deterministic RPC transport, batch4/concurrency2/timeouts/leases and sanitized diagnostics. | Undeployed drain, scheduler absent; claims disabled except isolated fixtures. |
| U4.2 / 300 | `supabase/functions/tests/helpers/{sql-rpc,controlled-provider}.ts`, Deno e2e task; use actual named SQL RPCs and controlled Portless HTTP provider, not queue mocks. | V4/V6: local-only network guard, fresh DB, transport auth and ready happy-path both sources. | Harness only; clean fixture rows/jobs/server and owned scratch DB. |
| U4.3 / 350 | `supabase/functions/tests/automatic-embeddings.e2e.test.ts`: real-handler failure/lease/late-response proof (T3/T5/T7), plus no-open-transaction HTTP wait assertion. | V6: SQL insert → job → actual handler → ready for BOTH types, malformed/fault/crash/healthy-behind-poison controls. | Test-only proof; stop only harness-owned servers/connections; no remote calls. |

## Slice 5 — Compatible application readers and writers

| Unit / target lines | Tasks and concrete files | Focused checks / runtime harness | Rollback boundary |
|---|---|---|---|
| U5.1 / 330 | `src/memory/repository.ts`, `types.ts`, `tests/integration/automatic-embeddings-search.test.ts`: add bounded-memory exact cursor/projection. T8 tests first; default production path not switched yet. | V7 exact subset: accents/duplicates outside top5, full exhaustion, timeout→unavailable, owner scope, no score/address/provider call. | Additive unwired exact branch; dormant legacy retrieval unchanged. |
| U5.2 / 370 | repository.ts adds post-HTTP one-statement envelope for BOTH domains, complete compatibility gate and control acceptance. T9/T10 SQL tests precede query. | V7 complete/incomplete/empty controls: actual gate and candidates share snapshot. | New semantic path remains unwired/default disabled; never fallback to incompatible vectors. |
| U5.3 / 380 | `src/memory/{contacts-repository,contact-policy-adapter,repository,service}.ts`: SQL-only automatic write path retaining transaction client/confirmation/version. Add `MEMORY_EMBEDDING_MODE` default-legacy dispatch in `src/config/env.ts`; T11/T12 tests first. | V2/V8 writer fixture subset; existing contact-policy/proposal rollback tests. Assert no embed/network calls while automatic mutations hold wallet transactions; dormant old writes unchanged. | Default legacy while SQL dormant; activated mode mismatch fails closed. Reverting cannot re-enable old readers on new vectors. |
| U5.4 / 370 | New `src/memory/remote-embedding.ts`; `service.ts`, `runtime.ts`, `tools.ts`, agent result adapters: select query/exact/gated paths only in automatic mode; preserve outcome unions. | V7/V8: query error→unavailable, lexical first, uncalibrated clarification-only, selected-version/network guard and existing HTTP shapes. | Dormant default stays legacy. After activation, only compatible exact/unavailable rollback. |
| U5.5 / 320 | `tests/integration/automatic-embeddings-search-races.test.ts`: T9 insert/reactivate/edit competitors DURING query wait for BOTH domains, barriers after optimistic precheck; complete positive controls. | V7: actual two-connection races and no retained transaction during HTTP, no empty-fact lie. | Proof-only unit; rollback closes barriers/connections and restores isolated fixtures. |
| U5.6 / 360 | `src/server.ts`, `src/livekit/worker.ts`, memory seed/prefetch, Dockerfile/compose/scripts and explicit fixtures: automatic mode skips inference warmup/downloads; legacy dormant behavior retained until cleanup. Audit all embed callers first. | V10 startup scripts plus V8 fixture startup; automatic API/voice starts without model cache/local inference; default dormant path unchanged. | Keep preactivation legacy image viable; do not remove dependency still used by other callers. |
| U5.7 / 370 | `tests/e2e/automatic-embeddings.e2e.test.ts`, tool/agent focused tests and `evals/` fixtures: SQL→real Edge→actual service/search and fake payment preview/confirmation proof. | V6/V8 plus relevant trusted-recipient browser E2E and `npm run eval`; T8–T11 across text/voice. | Proof-only changes; fixture wallet performs no transfer; owned server/DB cleanup. |

## Slice 6 — Acceptance, promotion and cleanup

| Unit / target lines | Tasks and concrete files | Focused checks / runtime harness | Rollback boundary |
|---|---|---|---|
| U6.1 / 300 | `tests/fixtures/embedding-spanish-corpus.json`, `tests/unit/embedding-spanish-corpus.test.ts`, revision-bound quality evidence. Add uncalibrated refusal tests, held-out acceptance and threshold artifact validator. | V9 plus V8: offline fixtures prove plumbing; actual OpenAI calibration is separately authorized hosted work, never default tests. | Semantics clarification-only until accepted evidence; exact branch remains usable. |
| U6.2 / 350 | `scripts/configure-embedding-schedule.sql`, `docs/automatic-embeddings.md`, `tests/unit/embedding-promotion.test.ts`: remote-only wake, deployment manifest, T12–T14 refusal/rollback tests first. | V11 plus controlled promotion fixture: one schedule, inactive defaults, inventory/quality/credential/capacity gates and rollback retaining rows/jobs. | No schedule applied by tests; documented disable claims/schedule/semantics, preserve exact/data. |
| U6.3 / 180 | Complete independent local verification, PG17 compatibility and concrete deployment package; update only owned evidence artifacts/runbook. Parent handles remote approval and hosted operations. | V1–V11, required browser E2E, backend full checks, then separately approved BOTH-source hosted scheduled generation/search/auth/cleanup. | Stop on changed remote inventory/CI/quality failure; no remote apply without final concrete approval. |
| U6.4 / 350 | After successful promotion, remove dormant legacy memory generator/selector/warmup/prefetch and unneeded build/dependency references; preserve unrelated transformer users. Separate primitive and proof layers if needed. | V4/V6/V8/V10 plus caller audit: automatic-only API/voice startup and rollback-compatible exact retrieval without model artifacts. | Revert cleanup only to the prior compatible automatic image; never restore legacy readers. |

## Exact first apply assignment

Select ONLY U1.1 (tasks1.1). Allowed implementation files for its next executor:

- `supabase/migrations/20261023000000_embedding_foundation.sql`
- `src/db/migrations/018_embedding_foundation.sql`
- `tests/integration/helpers/embedding-database.ts`
- `tests/integration/automatic-embeddings-foundation.test.ts`
- `tests/e2e/automatic-embeddings-foundation.e2e.test.ts`
- This change's task/progress artifacts for evidence and checkbox completion.

Recheck/reserve migration names before writing; if either is taken, choose next free ordered pair and record it. Parent supplies isolated loopback DB dependencies. First write assertions for metadata-only expansion with existing NOT NULL retained, disabled control, preserved actual vectors/revisions, old-role insert/update/read and separate fresh chains; then implement only additive foundation. Do NOT drop NOT NULL or add triggers/claims/auth/provider/runtime changes in U1.1.

Exact focused/runtime command: `npx vitest run tests/integration/automatic-embeddings-foundation.test.ts tests/e2e/automatic-embeddings-foundation.e2e.test.ts`. Required static/build checks: `npm run lint`, `npm run typecheck`, `npm run build`. Run required backend tests/evals with local database and report pre-existing baseline failures separately. Confirm nonzero integration/E2E case counts, no skip due to missing DB, no schema drift across chains and authored code/test diff ≤400. Rollback boundary is the dormant additive foundation: activation=false, no source values rewritten, no jobs/HTTP; retain columns in any already-applied database and remove only harness-owned scratch resources. No remote migration, provider, secret access or git/PR action is included in the executor assignment.
