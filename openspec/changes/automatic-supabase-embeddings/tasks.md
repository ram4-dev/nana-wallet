# Tasks: Automatic Supabase embeddings

## Review Workload Forecast

Estimated authored code/test changes: 4000–6500 lines including SQL mirrors; 25 bounded units detailed in [work-units.md](work-units.md), the normative task appendix. Each unit defines start/finish, files, exact check references, runtime harness and rollback. Count actual additions+deletions before review; split primitives/proofs again before exceeding400. No size exception.

Delivery strategy: auto-chain
Decision needed before apply: No
Chained PRs recommended: Yes
Chain strategy: stacked-to-main
400-line budget risk: High

Approved design/outline gates are complete. Root strict_tdd=false remains unchanged. Write mapped threat regressions before production behavior; preserve dormant default behavior. Parent owns dependencies, DB, git/PRs and later remote authorization.

## 1. Dormant lifecycle

- [x] 1.1 U1.1 Add mirrored foundation and `automatic-embeddings-foundation.test.ts`.
- [ ] 1.2 U1.2 Add mirrored outbox; extend `automatic-embeddings-lifecycle.test.ts`.
- [ ] 1.3 U1.3 Add guarded lifecycle triggers; prove L1–L3/T5/T11.
- [ ] 1.4 U1.4 Add staged grants/activation; prove T4 before protection.

## 2. Fenced RPCs

- [ ] 2.1 U2.1 Add claim/read RPCs; `automatic-embeddings-rpc.test.ts` T4/T6 first.
- [ ] 2.2 U2.2 Add completion RPC; stale/forged completion tests first.
- [ ] 2.3 U2.3 Add recovery/budget RPCs; T7 tests first.
- [ ] 2.4 U2.4 Prove two-connection fencing in `automatic-embeddings-races.test.ts`.

## 3. Query contract

- [ ] 3.1 U3.1 Add `embedding-text.ts`, Deno checks and Unicode/byte parity.
- [ ] 3.2 U3.2 Add `embedding-provider.ts`; T2/T3 tests first.
- [ ] 3.3 U3.3 Add `embedding-query/handler.ts`; T1/T7/T13 tests first.

## 4. Drain and Edge E2E

- [ ] 4.1 U4.1 Add `embedding-drain/handler.ts`; auth/error/lease tests first.
- [ ] 4.2 U4.2 Add real SQL adapter/controlled-provider E2E infrastructure.
- [ ] 4.3 U4.3 Prove both-domain real-handler success/failure/no-transaction HTTP paths.

## 5. Application compatibility

- [ ] 5.1 U5.1 Add exact cursor in `repository.ts`; T8 first.
- [ ] 5.2 U5.2 Add both-domain snapshot envelopes; T9/T10 first.
- [ ] 5.3 U5.3 Add default-dormant SQL-only writers; T11/T12 first.
- [ ] 5.4 U5.4 Wire `remote-embedding.ts` and internal retrieval outcomes.
- [ ] 5.5 U5.5 Prove both-domain insert/reactivate/edit races during inference.
- [ ] 5.6 U5.6 Gate API/voice warmup and adapt seeds/fixtures.
- [ ] 5.7 U5.7 Prove SQL→Edge→service/search and wallet/voice/browser E2E/evals.

## 6. Acceptance and promotion

- [ ] 6.1 U6.1 Add Spanish corpus and revision-bound acceptance validation.
- [ ] 6.2 U6.2 Add schedule/runbook/readiness package; T12–T14 first.
- [ ] 6.3 U6.3 Complete independent local checks; parent-authorized hosted acceptance later.
- [ ] 6.4 U6.4 Remove legacy inference only after proven promotion.

Final SDD verification follows all units. Local predeployment checks are scoped evidence, not final verify-report admission. Hosted steps remain deferred; no external operation is authorized by this task file. First assignment: U1.1 only, with exact files/commands/rollback in work-units.md. Existing red main CI blocks integration, never planning or isolated first-unit work.
