# Design: Automatic Supabase embeddings

## Technical approach

Implement the six approved slices; specifications L1–L6, I1–I6 and R1–R6 are normative. Detailed SQL, model, search and promotion contracts are in [contracts.md](contracts.md); evidence and threats are in [verification.md](verification.md). These supporting documents are part of this design.

## Architecture decisions

| Choice | Alternative/tradeoff | Reason |
|---|---|---|
| Private ordinary SQL outbox; disabled expansion | pgmq or HTTP triggers | PG16 portability; wallet transactions contain SQL only |
| Independent generation/incarnation plus leased token | Business version alone | Archive and ID reuse must fence late results |
| Exact cursor; post-HTTP semantic snapshot | Top-five fallback or separate precheck | Detect every duplicate/pending competitor without a contact-count limit |
| Shared pure Edge contract; backend parity copy | Import Node inference into Deno | Explicit runtime separation and no model downloads |
| Default-dormant application selector; complete automatic image at promotion | Mixed old/new readers | Partial merges preserve live behavior; no legacy fallback after activation |
| Durable shared budgets/circuit state | Per-isolate counters | Concurrent functions cannot multiply provider spend |

## Data flow

```mermaid
sequenceDiagram
 participant W as Confirmed HTTP/voice writer
 participant D as PostgreSQL
 participant E as Authenticated Edge drain
 participant P as OpenAI
 W->>D: business mutation + trigger/outbox
 D-->>W: commit saved data
 E->>D: claim refs and read current text
 D-->>E: commit claim/token
 E->>P: bounded canonical inference
 E->>D: fenced completion (source before job)
 Note over D: indexing metadata only; no policy/version changes
```

```mermaid
sequenceDiagram
 participant B as Text/voice memory service
 participant D as Owner-scoped PostgreSQL
 participant Q as Authenticated query Edge
 B->>D: repeatable-read exact-name cursor
 D-->>B: unique / ambiguous / miss; transaction closed
 B->>Q: infer only after exact miss
 Q-->>B: validated revision + vector
 B->>D: one statement: active scope, gate, candidates
 D-->>B: unavailable or complete-snapshot result
 Note over B,D: selected ID/version revalidated before preview/confirmation
```

## Interfaces and file changes

| Files | Contract |
|---|---|
| New numbered SQL mirror pairs | Source metadata, private control/jobs, lifecycle triggers, worker RPCs; never edit historical SQL |
| `supabase/functions/_shared/{embedding-text,embedding-provider,embedding-auth,embedding-budget}.ts` | Pure canonicalization, response validation, scoped auth, shared admission |
| `supabase/functions/embedding-{query,drain}/{index,handler}.ts`, `supabase/functions/deno.json`, `supabase/config.toml` | Thin Deno entrypoints, injectable Web handlers, explicit checks and auth config |
| `src/memory/{repository,contacts-repository,contact-policy-adapter,service,types,runtime,seed,embedding}.ts`, new `remote-embedding.ts` | SQL-only writes; nullable actual revision; lexical/semantic discriminated candidates; readiness envelope |
| `src/config/env.ts`, `src/server.ts`, `src/livekit/worker.ts` | Revision-bound query runtime; no inference during mutations |
| `src/memory/prefetch.ts`, `Dockerfile`, `compose.yaml`, `package*.json`, scripts | Gate startup hooks in automatic mode; remove legacy code after promotion; audit other callers |
| `tests/`, `evals/`, `.github/workflows/ci.yml`, scheduler script/runbook | Explicit Deno and complete-path checks, corpus, remote-only wake and promotion evidence |

No frontend imports or HTTP field changes. Internal unions carry lexical evidence without synthetic scores and semantic unavailable separately from empty results.

## Testing strategy

Use real isolated PG16 for both fresh chains, SQL roles and two-connection races; PG17 Supabase stand-in for deployment compatibility. Invoke real Edge handlers with controlled HTTP inference and real SQL RPC adapters. Races cover both source domains after precheck and during HTTP. Require complete compatible controls, wallet confirmation/version/policy E2E, corpus evaluation, full backend checks and explicit Deno checks. See verification matrix and work-unit commands.

## Threat matrix

Documentation-like execution paths, Git selectors, commit/push state and PR command composition are N/A: this feature adds no executable classification or VCS automation. Endpoint authentication/routing, malicious payloads, worker privilege, queue races and deployment integration are applicable and mapped in verification.md. Strict TDD stays false; adversarial regression tasks precede their implementations without changing root policy.

## Migration / rollout

Dormant additive layers preserve old actual vectors and grants. Final promotion revokes protected-column writes, activates lifecycle triggers, deploys compatible HTTP/voice processes and enables claims/scheduler only after local verification and concrete deployment approval. Pause/drain both writer types; never serve a mixed reader fleet. Re-inventory Nana Wallet before promotion; unexpected rows require a scoped backfill decision. Rollback disables claims and semantics, keeps exact lookup and all rows/jobs; legacy reader rollback is prohibited.

## Open questions

None. Red main CI and the unrelated connection crash remain separate integration dependencies, never reasons to weaken checks.
