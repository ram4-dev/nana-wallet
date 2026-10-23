# Proposal: Automatic Supabase embeddings

## Intent

Confirmed contacts and facts must remain saved when inference is unavailable. SQL writes must schedule indexing automatically, while recipient selection must never ignore a pending competitor or compare incompatible vectors.

## Scope

In scope: the six approved slices—dormant source lifecycle/outbox; fenced RPCs; authenticated query/text/provider contract; bounded drain and E2E; compatible readers/writers; Spanish acceptance and controlled remote activation.

Out of scope: frontend/HTTP payload changes, payment-flow changes, local-data migration, Nana Landing, unrelated connection-crash/CI fixes, local inference fallback, and deployment during planning.

## Capabilities

### New Capabilities

Root domain specifications are absent; archive will promote these full specifications.

- `automatic-embedding-lifecycle`: transactional generation, ownership, leases, retries and safe rollout.
- `authenticated-embedding-inference`: bounded, authenticated Edge query/drain with one model/text contract.
- `compatible-memory-retrieval`: exact fallback, complete-snapshot semantic readiness and preserved wallet safeguards.

### Modified Capabilities

None.

## Approach

Use a portable private SQL outbox and mirrored additive migrations. Preserve legacy writers/readers while dormant. After verification, promote the complete pipeline under a brief HTTP/voice write pause. Use OpenAI text-embedding-3-small, 384 dimensions, revisioned canonicalization and L2 normalization. Query inference precedes the final database snapshot. Gate readiness and select candidates in that snapshot. Exact folded-name lookup examines every owner match without inference.

Delivery is approved `auto-chain`, `stacked-to-main`; each code/test PR is at most approximately 400 authored changed lines, including SQL mirrors. Split primitives/proofs; no size exception is authorized.

## Affected Areas

| Area | Change |
|---|---|
| `supabase/migrations/`, `src/db/migrations/` | Lifecycle, private jobs, RPCs, staged grants |
| `supabase/functions/`, `supabase/config.toml` | Provider, query/drain, explicit Deno checks |
| `src/memory/`, `src/config/env.ts` | SQL-only saves, compatible retrieval |
| `src/server.ts`, `src/livekit/worker.ts`, build scripts | Runtime wiring; remove model downloads |
| `tests/`, `evals/`, CI, deployment runbook | Fencing, auth, Spanish quality and complete-path proof |

## Risks

| Risk | Mitigation |
|---|---|
| Stale worker or cross-owner write | Source/job/token/generation fencing and grant tests |
| Incomplete semantic candidates | Same-snapshot conservative gate |
| Mixed deployment or legacy vectors | Dormant expansion; inventory and controlled promotion |
| Provider outage/cost/text exposure | Bounded calls, separate credentials, safe logs, quality/capacity evidence |

## Rollback Plan

Disable claims/scheduler, retain rows/jobs and compatible exact lookup. Never restore legacy readers over new vectors. Destructive schema rollback/model backfill requires separate review.

## Dependencies

Approved design revision 3 and outline revision 2; root strict_tdd=false; parent-owned local dependencies and git/PR delivery. Red main CI remains a separate integration blocker.

## Success Criteria

- [ ] Both source tables generate through SQL → real Edge handler → compatible search locally.
- [ ] Stale, unauthorized and incomplete-index cases fail safely; payment invariants hold.
- [ ] Backend, Edge, migration, E2E and Spanish acceptance evidence passes before remote activation.
