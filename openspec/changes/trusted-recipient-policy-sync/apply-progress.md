# Apply Progress: trusted-recipient-policy-sync

Cumulative. Each entry is a completed work unit with its verification evidence. Later
slices append; earlier entries are never rewritten.

## Delivery context

- Worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch
  `feat/solana-operational`.
- Review Workload Forecast: `Decision needed before apply: Yes`, `Chained PRs
  recommended: Yes`, `400-line budget risk: High` (whole-change estimate ~12,000–16,000
  lines, re-measured at apply).
- Resolved delivery path for this work unit: parent-assigned **single work unit inside
  the chained slice 1** (`PR 1` = tasks 1.1–1.3, bounded outcome "Schema, lease,
  repository", rollback boundary "Migration files + `src/wallet/policy/{lease,repository}.ts`").
  No `size:exception` is requested; this unit is only task 1.1 and does not attempt the
  rest of slice 1.
- `actionContext` / edit roots: all writes stayed inside the assigned worktree root. The
  main checkout and the untracked `compose.privy-local.ports.yaml` were not touched.
- Structured status consumed: native SDD status is non-authoritative for this phase
  because the parent prompt supplied the resolved work unit, the artifact paths, and the
  delivery path directly. Readiness was resolved against the OpenSpec artifacts
  (`tasks.md` slice-1 preamble, `design.md` §2.1–§2.7, `spec.md`), all present and
  approved before any edit.

---

## Slice 1

### Task 1.1 — add the `015` recipient-policy-sync migration with its integration proof

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/db/migrations/015_recipient_policy_sync.sql` | New. Legacy local migration path (unqualified names; the runner sets `search_path = public, extensions`). |
| `supabase/migrations/20261005000400_recipient_policy_sync.sql` | New. Supabase-chain mirror with the `public.` qualification (next free timestamp after `20261005000300_session_floor.sql`). |
| `tests/integration/recipient-policy-migration.test.ts` | New. Static + database proof: object presence, DB-enforced invariants, re-run idempotency. |
| `tests/integration/recipient-policy-migration-rls.test.ts` | New. Cross-user RLS denial on all five tables, with the system-context positive control for `recipient_policy_leases`. |

#### What the unit delivers

Five additive tables per design §2.1–§2.5, plus §2.6 RLS/grants/FKs and the
`grant_audit_log`-style append-only guard:

- `recipient_policy_state` — desired vs. applied revision, `applied_rules_hash` as a
  distinct authoritative rule hash (design §0 C6), consent baseline/provenance, verifiable
  status, `recipient_policy_state_revision_order_ck` (`applied_revision <= desired_revision`)
  and `recipient_policy_state_applied_complete_ck` (an `applied` status must carry the
  whole evidence set), plus `user_idx` and the partial `retry_idx`.
- `recipient_policy_sync_intent` — durable desired intent with `composed_rules`/`composed_hash`,
  unique `(wallet_id, desired_revision)`, the one-in-flight partial unique index, the
  idempotency partial unique index, and the due-scan partial index.
- `contact_action_proposals` — immutable versioned proposals with `revoked_grant_ids`,
  one-open-per-conversation partial unique index, immutable `(user_id, id, version)`
  unique index and the open-scan index.
- `recipient_policy_leases` — one holder per wallet (`wallet_id` PK),
  `desired_revision_at_acquire` recorded, system-only RLS. The three lease functions are
  deliberately **not** in this unit; task 1.2 appends them.
- `recipient_policy_audit` — append-only evidence with the full 16-event vocabulary and a
  `BEFORE UPDATE OR DELETE` guard trigger.

Also: `ENABLE` + `FORCE ROW LEVEL SECURITY` on all five tables; owner-isolation policies on
state/intent/audit/proposals; `recipient_policy_sync_intent_system_access` for the
reconciler scan; `recipient_policy_leases_system_only`; `REVOKE ALL … FROM PUBLIC` plus
`SELECT, INSERT, UPDATE` (state/intent/proposals), `SELECT, INSERT` (audit) and
`SELECT, INSERT, UPDATE, DELETE` (leases) to `recipient_app`; thirteen
`IF NOT EXISTS (SELECT 1 FROM pg_constraint …)` + `NOT VALID` foreign keys.

Additive only: no `DROP TABLE`/`DROP COLUMN`/`DROP CONSTRAINT`/`DROP INDEX`, no
`ALTER COLUMN … TYPE`. Only `DROP POLICY IF EXISTS` and `DROP TRIGGER IF EXISTS` appear,
which is the re-appliability pattern of `008_delegated_grants.sql`.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED | Both suites written first and run against the un-migrated database: **22 failed / 2 passed (24)**. Failures were `relation "…" does not exist` for every schema object and the invariant tests. The two "passes" were `expect(...).rejects.toThrow()` assertions satisfied by the *missing relation*, i.e. false greens. |
| RED cleanup | Both false greens were replaced with an explicit positive control executed **before** the negative assertion. Re-run confirmed the honest RED state (the positive control cannot pass against a missing table). |
| GREEN | Supabase mirror applied to this worktree's database (`docker compose exec -T db psql … < supabase/migrations/20261005000400_recipient_policy_sync.sql`), then **24 passed / 24**. |
| TRIANGULATE | Added after GREEN: the one-open-proposal rule is proven scoped, not global — a second conversation's proposal is accepted while the first is open, and consuming the open one frees the slot for a new version. Both falsifiable directions of `applied_complete_ck`, the revision-order CHECK, the in-flight index, the idempotency index and the append-only trigger already carry accept + reject pairs. |
| REFACTOR | None needed. `npm run lint` and `npm run typecheck` clean; no production code touched, so no refactor surface exists. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/integration/recipient-policy-migration.test.ts tests/integration/recipient-policy-migration-rls.test.ts` (RED, pre-migration) | 22 failed / 2 passed (24) — expected RED |
| `docker compose exec -T db psql -U postgres -d wdk_agent -v ON_ERROR_STOP=1 < supabase/migrations/20261005000400_recipient_policy_sync.sql` | applied; only benign `already exists, skipping` notices on the second and third runs |
| `npx vitest run tests/integration/recipient-policy-migration.test.ts tests/integration/recipient-policy-migration-rls.test.ts` | **2 files passed, 24 tests passed** |
| `npx vitest run tests/integration/session-floor-migration.test.ts tests/integration/delegated-grants-schema.test.ts tests/integration/notifications-schema.test.ts tests/integration/privy-policy-admin-migration.test.ts` | **4 files passed, 23 tests passed** — includes the real-chain `runMigrations` suite, which rebuilds a fresh database from `src/db/migrations/` and therefore proves the unqualified `015` file applies through the legacy runner |
| `npx vitest run tests/integration/*migration*.test.ts tests/integration/*schema*.test.ts` | **6 files passed, 47 tests passed** |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`) |

#### Deviations from the design

Two, both deliberate and additive:

1. **The self-referencing FK name is shorter than the table name would imply.**
   `contact_action_proposals_supersedes_id_contact_action_proposals_fk` is 69 characters,
   and Postgres silently truncates identifiers to 63. That truncation is not cosmetic: the
   `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)` guard compares the
   *untruncated* name, so a re-apply would not find the stored constraint and would fail
   with a duplicate-constraint error. The constraint is therefore named
   `contact_action_proposals_supersedes_id_proposals_fk` (51 chars), matching the existing
   `…_grant_id_grants_fk` nickname style. Every identifier in the migration is now ≤53
   characters (checked directly against `pg_constraint`/`pg_class`/`pg_policies`/`pg_trigger`).
2. **Inline CHECK constraints carry explicit `_ck` names** (e.g.
   `recipient_policy_state_status_ck`) instead of the Postgres-generated
   `<table>_<column>_check`. Design §2 shows them unnamed; naming them follows
   `008_delegated_grants.sql` (`grant_claim_ledger_amount_positive_ck`) and makes each CHECK
   assertable by name. No CHECK from design §2 was dropped or weakened.

#### Observations handed to later tasks (not defects in this unit)

- Design §2.6 grants the reconciler's anonymous system context a policy only on
  `recipient_policy_sync_intent`. If slice 2 ever appends `recipient_policy_audit` rows
  from a system transaction (e.g. the `lease_reclaimed` audit of §5.2 step 3) outside a
  user transaction, that write will be denied by RLS and slice 2 must add the matching
  system-access policy. Recorded here rather than pre-emptively added, because the design
  is authoritative for this schema and adding authority the design does not describe would
  itself be drift.
- The local database was built the CI way, so `src/db/migrations` is not what it reflects.
  The Supabase mirror is what was applied; `npm run db:migrate` does not read `.env` in
  this worktree and was not used.

#### Remaining tasks in slice 1

```text
- [ ] **1.2 Add the lease functions and the lease API.**
- [ ] **1.3 Add the `recipient_policy_sync` repository.**
- [ ] **1.4 Build the pure composer and prove the composition invariants in unit tests.**
- [ ] **1.5 Implement the readback comparator as a pure function with its failure classes.**
- [ ] **1.6 Add `RecipientPolicyService` with server-owned identity, wallet, and network, plus the strict service-seam types.**
- [ ] **1.7 Implement the atomic removal transaction with whole-grant revocation.**
- [ ] **1.8 Delete the legacy full-rule writer entry points and route their callers through the composer.**
- [ ] **1.9 Document and install the single lock order, prepending `W0` to the claim path.**
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

#### Workload / PR boundary

One commit, one work unit: the `015` migration in both file forms plus the two integration
suites that prove it. It is an honest single PR-1 slice boundary per the forecast table
(`PR 1` rollback boundary begins at the migration files). No push, no PR.

#### Commit

`feat(policy): add the recipient policy sync schema` — see the report envelope for the SHA.
