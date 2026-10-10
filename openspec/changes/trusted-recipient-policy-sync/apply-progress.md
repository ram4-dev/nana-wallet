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

---

### Task 1.2 — add the lease functions and the lease API

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/db/migrations/015_recipient_policy_sync.sql` | Appended: the three lease functions plus one SELECT-only system-read policy (see deviations). Header updated to `(tasks 1.1, 1.2)`. |
| `supabase/migrations/20261005000400_recipient_policy_sync.sql` | Same block, `public.`-qualified. `diff <(sed 's/public\.//g' mirror) leaf` shows only the header comment (the 1.1 convention). |
| `src/wallet/policy/lease.ts` | New. `acquirePolicyLease` / `renewPolicyLease` / `releasePolicyLease` + the §1.4 constants. |
| `tests/integration/recipient-policy-lease.test.ts` | New. 10 cases; every database case drives **two real `createDatabaseClient` pools**, so contention is a real row conflict, not a simulated lock. |

#### What the unit delivers

- **SQL (design §1.4/§2.4).** `acquire_recipient_policy_lease(p_wallet_id, p_user_id,
  p_owner_id, p_lease_seconds = 60)` mirrors `acquire_reconciliation_lease`
  (`013_wallet_notifications.sql:106-160`): delete-expired, then `INSERT … ON CONFLICT
  (wallet_id) DO UPDATE … WHERE existing.expires_at <= now()`, table-qualified column
  references inside the `RETURNS TABLE (lease_token)` OUT-variable trap, `md5(random() ||
  clock_timestamp() || p_owner_id)` token, no `SECURITY DEFINER`. It records
  `desired_revision_at_acquire` from `recipient_policy_state` (0 when no state row exists).
  `renew_…` and `release_…` are token-guarded and return a boolean (row count), so a stale
  holder learns it lost the lease. Renewal enforces the 300 s hard hold ceiling inside the
  function that owns the row.
- **TS API (design §1.4).** Bounded wait on the documented `100 ms × 2^n` schedule capped
  at 1 s, `waitBudgetMs` default 3 000, and the sleep is clamped to the remaining budget so
  the budget is never overshot. `busy` on exhaustion, `unavailable` when the database is
  unreachable (never a fabricated acquisition), `false` from renew on any failure (fail
  closed). Published constants: TTL 60 s, renewal cadence 10 s, hard hold 300 s.
- **No new index/constraint.** Both the expiry sweep and the token-guarded renew/release are
  `wallet_id` PK lookups, and §1.4/§2.4 define no other access path, so 1.1's schema already
  covers the lease semantics. The one object 1.1 did not create and §1.4 requires is the
  system-context read of `recipient_policy_state` (deviation 1).

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (module) | Suite written first and run before `lease.ts` existed: **0 tests run**, `Cannot find module '../../src/wallet/policy/lease.js'`. |
| RED (SQL) | `lease.ts` added, database still un-migrated: **6 failed / 4 passed (10)**. Every database case failed with `acquire_… does not exist` (surfacing honestly as `unavailable`/`false`), i.e. absent behaviour, not a tolerated green. The 4 passes were the three stub-driven cases (schedule, zero budget, unreachable database) and the constants contract — none of which touch the database. |
| RED (RLS) | Migration applied **without** the system-read policy: **1 failed / 9 passed**. The one failure was exactly `expected '0' to be '7'` for `desired_revision_at_acquire`, proving the policy is load-bearing rather than decorative; the planned deviation was then justified by observed behaviour, not by argument. |
| GREEN | Policy added to both files and applied: **10 passed / 10**. |
| TRIANGULATE | Two directional pairs added after GREEN: (a) the recorded revision stays `7` after `desired_revision` is bumped to `9`, and a wallet with no state row records `0` — so `7` comes from the row and not from a constant; (b) at `acquired_at = now() - 299 s` the same token still renews while at `- 301 s` it refuses, so the refusal is the documented 300 s boundary rather than “any elapsed time”. The reclaim pair already asserts the false direction (stale renew) **and** the true direction (reclaimer's renew) on the same wallet. |
| REFACTOR | `PolicyLeaseRef` initially carried a redundant `walletId` (caught by `npm run typecheck`, not by the runtime suite). Removed; no behaviour change. Lint and typecheck clean afterwards. |
| False-green guard | Every negative assertion has a preceding positive control: the owner reads `desired_revision = 7` before the lease diagnostic is asserted; the live-token renew is asserted `true` before the stale-token renew is asserted `false`; the real-token release deletes the row before the foreign-token release is asserted to be a no-op. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/integration/recipient-policy-lease.test.ts` (RED, module absent; RED, SQL absent; RED, policy absent; GREEN) | 0 tests (module), then **6 failed / 4 passed**, then **1 failed / 9 passed**, then **10 passed / 10** |
| `docker compose exec -T db psql -U postgres -d wdk_agent -v ON_ERROR_STOP=1 < supabase/migrations/20261005000400_recipient_policy_sync.sql` | applied; re-applied three further times with **0** error lines (only benign `already exists, skipping` notices), so the 1.1 suites' re-apply stays safe |
| `npx vitest run tests/integration/recipient-policy-lease.test.ts` | **1 file passed, 10 tests passed** (2.2 s) |
| `npx vitest run tests/integration/recipient-policy-migration.test.ts tests/integration/recipient-policy-migration-rls.test.ts` | **2 files passed, 24 tests passed** — the 1.1 suites stayed green, including the mirror↔local content-equivalence check |
| `npx vitest run tests/integration/recipient-policy-lease.test.ts tests/integration/recipient-policy-migration.test.ts tests/integration/recipient-policy-migration-rls.test.ts` | **3 files passed, 34 tests passed** |
| `npx vitest run tests/integration/privy-policy-admin-migration.test.ts` | **1 file passed, 4 tests passed** — the real-chain suite rebuilds a fresh database from `src/db/migrations/`, proving the unqualified `015` (functions + policy) applies through the legacy runner |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) |
| `npx vitest run` (whole suite, twice) | Pre-existing noise only. Baseline method: the same 13 affected files were run with 1.2's SQL reverted to `HEAD` and with it restored. **Baseline: 5 failures — 5 failed / 79 passed.** **With 1.2: the same 5 by name, plus one 15 s timing failure** (`notifications-webhook-deep` “returns the same 404 for a foreign conversation as for a missing one”) that **passes in isolation on the changed tree (2 consecutive runs, 14/14)** and is DB-load flakiness, not a regression. No `recipient-policy-*` suite failed in either state. |
| Identifier length audit (`pg_proc` / `pg_policies`) | Longest new name is `recipient_policy_state_system_read` (34); functions 28–30. Well inside the 63-char truncation limit that bit 1.1, so the re-apply guards stay effective. |

#### Deviations from the design

Three, all deliberate and additive:

1. **Added a SELECT-only system-read policy on `recipient_policy_state`**
   (`recipient_policy_state_system_read`). §1.4 requires `acquire` to read
   `desired_revision` “from `recipient_policy_state` inside acquire” while running in
   `withSystemTransaction` (no `app.user_id`), and §2.6 grants the anonymous context a policy
   only on the intent table. With the design's schema as written, that read returns zero rows
   and the new diagnostic column would silently always report `0`. Proved by the RED (RLS)
   run above (`'0'` ≠ `'7'`), not by argument. SELECT only: no write authority is added,
   owner isolation on that table is unchanged, and the design's §5.2 reconciler needs exactly
   this read in slice 2 anyway. Flagged for task 2.9.
2. **`renew_recipient_policy_lease` takes a fourth defaulted parameter**
   (`p_max_hold_seconds INTEGER DEFAULT 300`) so the 300 s hard hold ceiling is enforced by
   the authority that owns the row. §2.4 shows a three-parameter signature; the extra
   parameter is defaulted, so the documented call shape is unchanged. A caller-side-only
   ceiling would be bypassable by any other process and untestable at the database level.
3. **Optional injected `now` / `sleep` (and `leaseSeconds` / `maxHoldSeconds`) on the API.**
   The design's `deps` shape is preserved; the injections exist so the published backoff
   schedule is asserted deterministically (`[100, 200, 400, 800, …]`, capped at 1 000, total
   wait exactly the budget) instead of by wall-clock timing, and so a test can request a 1 s
   TTL and observe a real expiry reclaim instead of back-dating the row.

Two smaller, non-behavioural choices: the lease functions are appended in a labelled
“Task 1.2” section (rather than beside the table 1.1 declared) so every task in this slice
keeps a purely additive diff; and the two file headers now read `(tasks 1.1, 1.2)`.

#### Observations handed to later tasks (not defects in this unit)

- **`recipient_policy_audit` is still owner-only.** This unit appends no audit rows, so it
  needs no change; the `lease_acquired` / `lease_reclaimed` appends of §5.2 step 3 will be
  RLS-denied from a system transaction unless slice 2 adds the matching system-access policy.
  The carried-over note from 1.1 stands unchanged.
- The 300 s ceiling is enforced as `acquired_at > now() - 300 s` on renew. A holder renewing
  at 295 s therefore gets an `expires_at` up to one TTL past the ceiling. That is intentional:
  the ceiling bounds *renewal*, not expiry, and the caller's contract on `false` is
  release-then-re-acquire.

#### Remaining tasks in slice 1

```text
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

One commit, one work unit: the three lease functions plus one policy in both migration file
forms, `src/wallet/policy/lease.ts`, and the integration suite that proves them. It sits inside
the assigned `PR 1` slice (tasks 1.1–1.3, rollback boundary “Migration files +
`src/wallet/policy/{lease,repository}.ts`”). No `size:exception` is requested and no slice-2
work was started. No push, no PR.

#### Commit

`feat(policy): serialize wallet composition with a lease` — see the report envelope for the SHA.
