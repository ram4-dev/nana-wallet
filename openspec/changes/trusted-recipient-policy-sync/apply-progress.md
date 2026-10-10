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

### Task 1.3 — add the `recipient_policy_sync` repository

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/repository.ts` | New. The typed, bind-parameterized access layer for `recipient_policy_state`, `recipient_policy_sync_intent`, `recipient_policy_audit`, `contact_action_proposals`, the composer's contact read, and the `signer_grants` projection refresh — plus the typed domain conflicts each index raises. |
| `tests/integration/recipient-policy-repository.test.ts` | New. 19 cases over two real connection pools: the §1.5 CAS, the W0 lock, the three intent indexes, exactly-once consumption under a real race, cross-user isolation on every read and write, and the authority boundary. |

#### What the unit delivers

- **`recipient_policy_state` (design §2.1, §1.5).** `readPolicyState` (owner-scoped, `null` when
  absent), `lockPolicyState` (the `W0(U)` slot: create-if-absent `ON CONFLICT DO NOTHING` then
  `SELECT … FOR UPDATE`, requiring an explicit client because a lock released by the repository's own
  commit would be useless), `bumpDesiredRevision`, `commitAppliedRevision` (the exact §1.5 CAS,
  `false` ⇔ zero rows ⇔ the desired revision moved) and `setPolicyStatus` for the non-`applied`
  transitions with their bounded evidence and relative attempt bookkeeping.
- **`recipient_policy_sync_intent` (design §2.2, §5.2).** `insertIntent` (owner-scoped, one intent
  per `(wallet, desired_revision)`), `listDueIntents` + `claimIntent` (the ONLY anonymous
  system-context paths: the reconciler must enumerate due intents across wallets and resolve each
  owner from the row it reads), and `supersedeIntent` (owner-scoped, inside the caller's
  transaction so the supersede and its replacement commit together). All three unique/partial
  indexes are translated into typed errors instead of leaking a driver error.
- **Composer contact read (design §3.1).** `listComposerContacts`: active + `network='solana-devnet'`
  + the caller's own rows, with the version a mutation must echo back. `recipients.address_confirmed_at`
  is `NOT NULL` by schema, so the chain scope *is* the confirmation axis; legacy NULL-network EVM rows
  are never composed.
- **`recipient_policy_audit` (design §2.5).** `appendPolicyAudit` returns the row id, owner-scoped,
  append-only (asserted through the trigger).
- **`contact_action_proposals` (design §2.3, §4.5).** `insertProposal` (immutable versioned identity
  columns, one-open-per-conversation enforced with a typed conflict), `readProposal`, and
  `consumeProposal` — the whole predicate in one conditional `UPDATE`: id **and** version **and**
  owner **and** `status='open'` **and** `consumed_at IS NULL` **and** `expires_at > now()`.
- **`signer_grants` projection (design §5.4).** `refreshSignerGrantProjection` writes
  `allowlisted_recipients` + `policy_hash` on the wallet's newest `state='active'` row and returns
  `null` when the wallet has none (nothing to refresh is honest, not a fabricated row). The hash
  VALUE stays the caller's decision (see deviations).
- **Authority contract, stated per path.** Owner paths run through `withUserTransaction`; the only
  system paths are the due scan and the in-flight claim. No migration change was needed: the `015`
  `recipient_policy_sync_intent_system_access` policy already grants exactly that, and the suite
  asserts a system-context audit append is still REFUSED, so this unit adds no authority it cannot
  demonstrate.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (module) | Suite written first, run against the absent module: **0 tests run**, `Cannot find module '../../src/wallet/policy/repository.js'`. |
| RED (mutation: the CAS guard) | Removed `AND desired_revision = $3` from `commitAppliedRevision`: the stale-revision case failed (`RECIPIENT_POLICY_STATE_APPLIED_COMPLETE_CK` also fires without the guard, because the stale writer would have left `applied_revision < desired_revision` under an `applied` status). Proves the predicate — not the surrounding test — is what makes a stale write impossible. |
| RED (mutation: conditional consume) | Removed `status='open' AND consumed_at IS NULL AND expires_at > now()` from `consumeProposal`: the two-connection race test failed with **two** winners (`expected [ … ] to have a length of 1`). Proves the concurrent proof is a proof, not a serialized coincidence. |
| RED (mutation: the status transition) | Removed `status = 'pending'` from `bumpDesiredRevision`: 2 state cases failed (`expected 'saved_not_configured' to be 'pending'`, and the revision-order/applied-complete CHECK rejecting the bump). Proves the additive constraint from task 1.1 forces the transition and that the test observes it. |
| RED (discovery: the ownership hole) | With the module otherwise green, the new isolation case failed honestly: `promise resolved "'69481c43-…'" instead of rejecting` — `insertIntent` accepted a **foreign** `wallet_id`. RLS's `user_id = app.user_id` check cannot detect that, because the caller trivially satisfies it by naming itself. Fixed with the minimum guard (see deviations 3); the case then passed. |
| GREEN | **19 passed / 19**, stable across 4 consecutive runs. |
| TRIANGULATE | Added after GREEN: the W0 lock is proven exclusive by contending with `SET LOCAL lock_timeout = '200ms'` and then succeeding after the holder commits; the CAS re-applies the CURRENT revision (idempotent) while refusing a stale one, so the guard is proven to be the revision rather than "apply once"; `supersedeIntent` is not re-runnable (a terminal row stays terminal); the `(wallet, desired_revision)` index is proven per-wallet by inserting revision 1 for a second wallet; the backoff pair (excluded while `next_attempt_at` is in the future, included again once cleared); "newest active" `signer_grants` is disambiguated with two active rows at explicit ages, so the untouched-row assertions cannot pass by accident. |
| REFACTOR | Three test defects removed after review: a positive control that asserted the wrong relation (the intent's state, not the absent state row), a `WITH CHECK` claim that was actually a `USING` outcome (replaced with a real identity-claiming INSERT), and a truncated doc sentence. No production-code refactor was needed; `npm run lint` and `npm run typecheck` are clean. |
| False-green guard | Every negative assertion is preceded by a positive control: the owner reads its own state/intent/audit/proposal before the foreign blank is asserted; the owner's W0 lock is released and re-acquired successfully after the timed-out contention; the correct proposal version consumes before the stale one is refused; the owner CAN record intent/audit/proposal for its own wallet before the foreign refusal is asserted; the owner's `signer_grants` refresh writes before the foreign refresh is asserted `null`; `PolicyStateMissingError` is proven reachable on an owned wallet with no state row, so the two error classes are not interchangeable. |
| RLS false-green class | Two test-side instances of the task-1.2 trap were caught and fixed: reading `signer_grants` from a system context returned **zero rows with no error** (owner-isolated table, no system policy), and the fixture now reads it in owner scope with that lesson documented in the helper. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/integration/recipient-policy-repository.test.ts` (RED, module absent) | 0 tests, `Cannot find module` |
| `npx vitest run … -t "compare-and-set"` (CAS mutation) | **1 failed** — the stale-revision case |
| `npx vitest run … -t "concurrent"` (consume mutation) | **1 failed** — two consumers both won |
| `npx vitest run … -t "recipient_policy_state"` (bump mutation) | **2 failed** — `'saved_not_configured' ≠ 'pending'` |
| `npx vitest run … -t "refuses to record an intent"` (pre-guard) | **1 failed** — a foreign wallet id was accepted |
| `npx vitest run tests/integration/recipient-policy-repository.test.ts` | **1 file passed, 19 tests passed** (0.3 s) |
| `npx vitest run tests/integration/recipient-policy-migration.test.ts tests/integration/recipient-policy-migration-rls.test.ts tests/integration/recipient-policy-lease.test.ts` | **3 files passed, 34 tests passed** — the 1.1/1.2 suites stayed green |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/integration/privy-policy-admin-migration.test.ts` | **5 files passed, 57 tests passed** (includes the real-chain suite that rebuilds a fresh database from `src/db/migrations/`) |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) |
| `npm test` (whole suite, twice) | Pre-existing noise only. **Baseline method:** the same 8 affected files were run with this unit's two new files removed — **5 failures** (`conversation-preview-claim-race:106`, `wallets-sync:198`, `realtime-agent-session:311`, `realtime-tool-binding:183`, `realtime-tools:360`). **With 1.3:** the same 5 by name, plus `notifications-webhook:202`, `api-auth-logout:107`, `api-voice-auth:117`/`:151`, which **pass in isolation on the changed tree (12/12, 5.9 s)** and which differed in count between two consecutive full runs of the same tree (6 then 9) — load/timing flakiness, not a regression. No `recipient-policy-*` suite failed in any state. |
| Identifier/authority audit | No new SQL object, so no identifier-length risk (the 63-char truncation that bit 1.1 only applies to migration identifiers). Authority: the only system-context paths are the intent due scan and claim, both covered by the existing `recipient_policy_sync_intent_system_access`; `recipient_policy_state`, `recipient_policy_audit`, `contact_action_proposals`, `recipients` and `signer_grants` are reached only in owner scope. |

#### Deviations from the design

Four, all deliberate; the first two were forced by the database, the third by a proven hole and the
fourth by an ambiguity the repository must not resolve on its own:

1. **The CAS also writes `applied_recipients`.** §1.5's statement lists the revision guard's columns;
   §2.1 and §5.4 require the verified address union to be persisted so `signer_grants` can be
   refreshed from one authoritative place. The CAS is where verified evidence is committed, so the
   column is written there; §1.5's predicate is unchanged and is still the only guard.
2. **`bumpDesiredRevision` moves the status to `pending` in the same statement.** Forced by task
   1.1's additive `recipient_policy_state_applied_complete_ck`: a bump that left the status at
   `applied` would be a lie the database now refuses. Proven by the third mutation RED, not argued.
   The applied evidence is deliberately NOT cleared here — only a proven divergence destroys it (§4.3).
3. **A wallet-ownership guard (`PolicyWalletNotOwnedError`) on the three writes that name a
   `wallet_id`** (`insertIntent`, `appendPolicyAudit`, `insertProposal` when a wallet is named) plus
   the W0 lock. Row isolation validates `user_id = app.user_id`, which a caller satisfies by naming
   itself, so without this guard a foreign `wallet_id` can be planted inside the caller's own scope.
   Found by the isolation case failing against an otherwise green module; the guard is one indexed
   `SELECT` inside the caller's transaction, so the check and the write cannot be split. No column,
   policy or grant was added — the fix is a predicate, not new authority.
4. **`refreshSignerGrantProjection` takes the hash as a parameter.** §5.4 says `policy_hash` is
   refreshed from the applied rule hash; §0 C6 says `policy_hash` is the consent-envelope hash and
   stays a compatibility field. Both are in the design, so the repository persists the value it is
   given and the choice belongs to the applying transaction (slice 2). The repository deliberately
   does not decide which hash is authoritative.

Two smaller, non-behavioural choices: "newest active" `signer_grants` row is tie-broken
`created_at DESC, id DESC` so the selection is deterministic when two active enrollments share a
timestamp; and `listDueIntents` orders by `next_attempt_at ASC, desired_revision ASC` (matching the
partial due index) with an optional `walletId` filter, which subsumes §5.2's per-wallet
`ORDER BY desired_revision LIMIT 1`.

#### Observations handed to later tasks (not defects in this unit)

- **`recipient_policy_audit` is still owner-only, and the suite asserts it.** A system-context append
  is refused (with the owner-context append as its positive control). Slice 2's `lease_reclaimed`
  append (design §5.2 step 3) must therefore either re-scope to the resolved owner inside its system
  transaction — the established pattern at `src/notifications/reconciliation-worker.ts:199-215` — or
  add an explicit policy AND update that assertion deliberately. It is written as a guard so the
  choice is visible instead of accidental.
- **`claimIntent` is system-scoped and re-claimable by design.** The claim is not the serializer: the
  lease (`W1`) is. Re-claiming a row already in `applying` is idempotent so restart recovery can
  resume a wallet whose holder died.
- **§5.2 step 3 refers to "the intent row's `lease_token`", but §2.2's table has no such column.**
  The in-flight marker is `state`, and the holder is the `recipient_policy_leases` row. Task 2.9 must
  resolve that (read the lease row, not a nonexistent column) — recorded here rather than invented.
- **A new desired revision does not reset `state.next_attempt_at`.** The due scan reads the INTENT's
  `next_attempt_at` (NULL on a fresh insert ⇒ due now), so a stale state-level deadline cannot delay
  a new intent. Task 2.9 decides whether resetting it is wanted.
- **`signer_grants` (and `recipient_policy_state`, `contact_action_proposals`, `recipients`) are
  silently blind to a system context.** The reconciler must resolve the owner from the intent row
  (which it can, thanks to the system-access policy) and then work in owner scope; an anonymous read
  of those tables returns zero rows with no error.
- **Typed conflicts are available for the HTTP contract.** `PolicyIntentIdempotencyConflictError`
  lets task 3.2 implement the `Idempotency-Key` replay without re-querying, and
  `ContactActionProposalConflictError` names the one-window rule for task 4.5.
- **`PolicyWalletNotOwnedError` is a backstop, not the design.** Task 1.6 must keep deriving the
  wallet server-side (§3.5); if the guard ever fires in production, the caller chose the wallet.

#### Remaining tasks in slice 1

```text
- [ ] **1.4 Build the pure composer and prove the composition invariants in unit tests.**
- [ ] **1.5 Implement the readback comparator as a pure function with its failure classes.**
- [ ] **1.6 Add `RecipientPolicyService` with server-owned identity, wallet, and network, plus the strict service-seam types.**
- [ ] **1.7 Implement the atomic removal transaction with whole-grant revocation.**
- [ ] **1.8 Delete the legacy full-rule writer entry points and route their callers through the composer.**
- [ ] **1.9 Document and install the single lock order, prepending `W0` to the claim path.**
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` (lines 172–173: the bounded native review and the
post-apply verify/archive) were left byte-for-byte untouched, and no review, receipt or delivery
gate was started by this phase.

#### Workload / PR boundary

One commit, one work unit: `src/wallet/policy/repository.ts` (1 165 lines) plus its integration suite
(1 132 lines) — **~2 300 changed lines**, above the 400-line review budget and reported, not hidden.
It cannot be split further without breaking the unit: the module is one access layer over five tables
whose guarantees (§1.5 CAS, the three intent indexes, exactly-once consume, the authority contract)
are only provable together, and the `gentle-ai-work-unit-commits` rule forbids shrinking the diff by
dropping tests, comments or documentation. It sits inside the parent-assigned `PR 1` slice (tasks
1.1–1.3, rollback boundary "Migration files + `src/wallet/policy/{lease,repository}.ts`"), needs no
migration change, and no `size:exception` is requested. No push, no PR, and no slice-2 work started.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit, the
authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any edit — `tasks.md` (task 1.3, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §1.5/§2.1–§2.5 (and §3.1/§3.5/§4.5/§5.2–§5.4 where they constrain persistence), `spec.md`
and the 1.1/1.2 apply-progress. `actionContext`: all writes stayed inside the assigned worktree root;
the main checkout and the untracked `compose.privy-local.ports.yaml` were not touched.

#### Commit

`feat(policy): persist recipient policy intent behind a revision CAS` — see the report envelope for
the SHA.

### Task 1.4 — build the pure composer and prove the composition invariants in unit tests

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/errors.ts` | New. The composition domain's typed, fail-closed refusals: `PolicyCompositionRefusalError` (carrying `failureClass` + `reason`) and the four refusals `PolicyEmptyCompositionUnprovenError`, `PolicyRuleCompositionUnprovenError`, `PolicyOrdinaryCapUnsupportedError`, `PolicyComposerRequiredError`. |
| `src/wallet/policy/composer.ts` | New. The pure `ComposeInput → ComposedPolicy` function, `composedRulesHash`, and the re-export of the existing `composeGrantRules`. |
| `tests/unit/policy-composer.test.ts` | New. 24 cases: the ordinary rule, the consent boundary, delegated limits, determinism/locale independence, empty composition, the two rule families, metadata edits, the module boundary and the refusal contract. |
| `tests/unit/policy-composer-hash.test.ts` | New. 7 cases: the pinned canonical digest, key-order independence, value/order/extra-key sensitivity, and the composed-vs-consent hash distinction. |
| `src/wallet/embedded.ts` | Two `export` keywords only (`SOLANA_MAX_PER_TRANSFER_LAMPORTS`, `deterministicPolicyHash`) so the composer reuses the single lamport ceiling and the unit suite compares against the real consent-envelope hash. No behaviour change. |

#### What the unit delivers

- **The ordinary rule (design §3.2 guarantee 1).** Built by the existing
  `buildSolanaEnrollmentRules` with the ceiling taken from the single constant
  `SOLANA_MAX_PER_TRANSFER_LAMPORTS`, so the composed rule is byte-identical to
  the legacy enrollment rule. A caller-supplied `ordinaryCapLamports` that is not
  that constant — wider *or* narrower — is refused instead of composed, so the
  ceiling cannot be re-authored by a call site.
- **No consent expansion (guarantee 2).** The ordinary allowlist is
  `sorted-unique(baseline ∪ active contacts)`. Grant recipients appear exclusively
  in their own conditioned rules and are never folded into the 0.01 SOL allowlist.
- **Delegated limits untouched (guarantee 3).** Grant rules come from the existing
  `composeGrantRules` (re-exported from `composer.ts`, restated nowhere), one rule
  per active grant, each carrying the ledger's own `max_per_transfer` and the
  stored `expires_at`.
- **Determinism (guarantee 4).** Grants ascending by `grantId` byte order, every
  address array sorted by code-unit comparison and deduplicated (`localeCompare`
  is never used: it would make the hash locale-dependent), so shuffling the input
  arrays cannot change the composition or the hash.
- **`applied_rules_hash` (guarantee 5).** `sha256` over an explicitly key-ordered
  canonical form — declared keys first in declared order, any other key appended
  in code-unit order, so a key set is never silently dropped and the encoding does
  not depend on `Object.keys` order. The digest is `sha256:<64 hex>`, distinct
  from the `pol_…` consent-envelope `deterministicPolicyHash` (design §0 C6).
- **Fail-closed defaults (§3.2 guarantee 8, §11 U1/U4).** An empty composition
  refuses with `empty_composition_unproven` unless `empty_composition='proven_deny'`;
  ordinary+grant coexistence refuses with `rule_composition_semantics_unproven`
  until the U1 probe records `union`, while a single-family composition (ordinary
  only, or grants only) composes without the probe. Every refusal is a typed
  `blocked_configuration` carrying the reason it must be persisted with, and it is
  thrown **before** any rule set exists, so no PATCH body can be derived from a
  refusal.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (module) | Both suites written first, run against the absent module: **2 files failed, 0 tests**, `Cannot find module '../../src/wallet/policy/composer.js'`. |
| RED (mutation: the three refusal paths) | Removing the multi-family refusal, the ordinary-cap validation, and the empty-composition guard produced **3 failed / 25 passed**, exactly and only: `refuses an ordinary cap that does not come from the single lamport constant`, `refuses an empty composition unless empty_composition is proven_deny`, `refuses ordinary + grant coexistence until the probe records union`. |
| RED (mutation: ordering) | Replacing the code-unit comparator with `localeCompare` and dropping the grant sort/allowlist sort produced **2 failed / 26 passed**: `orders addresses by code-unit order, never by a locale comparator`, `composes identically and hashes identically across runs and input orders`. |
| RED (mutation: consent and canonical form) | Folding grant recipients into the ordinary allowlist and canonicalizing with `Object.keys` order produced **3 failed / 25 passed**: `is independent of the key insertion order of a rule and of a condition`, `never folds a grant recipient into the ordinary allowlist`, `composes both families once the probe records union (positive control)`. |
| RED (mutation: dedupe) | Dropping `Set` dedupe from the sorted-union produced **1 failed / 30 passed**: `deduplicates an address that is both the baseline and a contact`. |
| GREEN | **31 passed / 31** (`policy-composer` + `policy-composer-hash`), `npm run lint` and `npm run typecheck` clean. |
| TRIANGULATE | Added after GREEN: an address that is both baseline and contact is deduplicated to one allowlist entry and tagged `contact`; an address that is both a contact and a grant recipient is composed in **both** rules while tagged `grant`; and `Object.keys(provenance)` equals exactly `ordinaryRecipients ∪ grantRecipients`, which is the address union design §5.1(d) will compare the readback against. |
| REFACTOR | One export removed before commit: an initially exported `sameRuleSet` wrapper was dropped, because unit 1.5 needs the *existing* comparator (`isDeepStrictEqual`, as used by `solana-policy-provisioner.ts:97-99`) and a second indirection for the same call would be a new abstraction around an existing one. No other refactor; lint and typecheck clean. |
| False-green guard | Every assertion is a positive one on the composed value, not a negative that could pass on an absent module: the module-absent RED is stated separately, the byte-identity assertion compares against the real `buildSolanaEnrollmentRules` output, the pinned digest was computed **before** implementation from an independent reproduction of the canonical form in `/tmp/gentle-canonical.mjs` (not from this module's output), and the locale test asserts that the two comparators disagree for its fixture before asserting which one the composer used. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/unit/policy-composer.test.ts tests/unit/policy-composer-hash.test.ts` (RED, module absent) | **2 files failed, 0 tests**, `Cannot find module '../../src/wallet/policy/composer.js'` |
| … (mutation passes: refusals / ordering / consent+canonical / dedupe) | **3 failed / 25 passed**, **2 failed / 26 passed**, **3 failed / 25 passed**, **1 failed / 30 passed** — each mutation caught by exactly the intended cases |
| `npx vitest run tests/unit/policy-composer.test.ts tests/unit/policy-composer-hash.test.ts` | **2 files passed, 31 tests passed** (0.3 s) |
| `npx vitest run tests/integration/recipient-policy-*.test.ts` | **4 files passed, 53 tests passed** (see the environment note below for the one pre-existing fragility this run exposed) |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) |

#### Environment note (not a defect in this unit, not a code change)

The first cumulative run reported **1 failed / 53 passed**:
`recipient-policy-repository.test.ts` → “claims a due intent from the system context and
leaves a foreign user unable to see it” (`expected undefined to be defined`). The cause is
accumulated database residue from repeated suite runs, proven directly: the table held
**144** `recipient_policy_sync_intent` rows, **60** of them due-now, while the case asserts
that a freshly inserted intent appears inside `listDueIntents({ limit: 50 })`. Postgres
orders `next_attempt_at ASC` with NULLs last, so the limit window is filled by older rows
and the fresh row is only *sometimes* inside it — the suite has no teardown, so its own
past runs create the flakiness. No SQL, schema or DB object was touched by this unit.
Deleting the 144 residue rows (all of them created by these suites; the table is
introduced by this change and is written by nothing else) restored **4 files passed /
53 tests passed**. Handed forward: whoever owns task 1.3's suite should scope the query to
its own fixture or clean up after itself, otherwise the slice-1/5 gates will stay
run-count sensitive.

#### Deviations from the design

Three, all deliberate and additive:

1. **A third refusal class, and a fourth, for two refusals the named pair cannot carry.**
   Task/design name `PolicyEmptyCompositionUnprovenError` and `PolicyComposerRequiredError`.
   §11 U1's blocking stop (`blocked_configuration` / `rule_composition_semantics_unproven`)
   and §3.2 guarantee 1's ceiling refusal need their own types, otherwise U1's refusal would
   have to be reported through an error whose meaning is “this path cannot route through the
   composer”. All four extend one base that carries `failureClass` and `reason`, which is what
   lets the service map a refusal onto `recipient_policy_state.status`/`status_reason` without
   matching message text.
2. **`ComposeInput.ruleComposition` is an added input field.** §3.1's literal shape has no
   signal for the U1 probe outcome, but §11 U1 requires the composer to refuse multi-family
   composition until the probe records `union`, and task 1.4 requires that refusal in the unit
   suite. The field mirrors `status_detail.rules_union`, defaults to `unproven`, and its
   default is the refusal.
3. **Two `export` keywords in `src/wallet/embedded.ts`.** The composer imports the raw
   `SOLANA_MAX_PER_TRANSFER_LAMPORTS` value instead of restating `"10000000"`, because a
   second literal would be a second authority over the same consent. `deterministicPolicyHash`
   is exported for one reason: the unit suite must compare the composed hash against the
   *real* consent-envelope function, and a test-local copy would have proven nothing.

Two smaller, documented choices: rule/condition canonicalization is an array of `[key, value]`
pairs with declared keys first and any unknown key appended in code-unit order (a rule set is
never lossily canonicalized); and `walletId`/`userId` are accepted as identity context and
deliberately excluded from the hash, so `applied_rules_hash` is a pure function of the rule set
and the composer can never derive the identity it composes for.

#### Observations handed to later tasks (not defects in this unit)

- **`BaselineProvenance` is carried, not interpreted.** §3.1 passes the frozen consent record
  into the composer and §2.1 defines its content as the `signer_grants` snapshot
  (`consent_baseline` = `allowlisted_recipients`, `consent_provenance` =
  `signer_enrollment_snapshot`), so the composer takes `Record<string, unknown>` — exactly the
  type task 1.3's `PolicyStateRecord` already exposes — and derives the address union from
  `baseline.addresses`. Task 1.6 must assemble both from the wallet's newest `state='active'`
  `signer_grants` row; the composer deliberately does not police a shape the design does not
  fix, so it cannot block slice 2 on a mapping choice.
- **The `union` flag is the only thing standing between the shipped behaviour and
  multi-family composition.** Until task 2.1 records `union`, every mutation on a wallet that
  has both trusted contacts and an active grant will stop as `blocked_configuration` with
  `rule_composition_semantics_unproven` and no PATCH. That is the intended slice-1 end state
  (§11 U1), but it means the grant paths stay non-executable until the probe lands — task 2.1
  and task 2.8 must therefore wire the flag before the slice-2 gate.
- **`PolicyComposerRequiredError` has no producer in this unit.** It is shipped for the
  callers that must fail visibly (the legacy entry points deleted in task 1.8 and the
  grant/expiry paths routed in tasks 1.8/2.13); its contract is pinned by a unit case now so
  those tasks map it instead of inventing a second error.

#### Remaining tasks in slice 1

```text
- [ ] **1.5 Implement the readback comparator as a pure function with its failure classes.**
- [ ] **1.6 Add `RecipientPolicyService` with server-owned identity, wallet, and network, plus the strict service-seam types.**
- [ ] **1.7 Implement the atomic removal transaction with whole-grant revocation.**
- [ ] **1.8 Delete the legacy full-rule writer entry points and route their callers through the composer.**
- [ ] **1.9 Document and install the single lock order, prepending `W0` to the claim path.**
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` (the bounded native review and the post-apply
verify/archive rows) were left byte-for-byte untouched, and no review, receipt or delivery gate
was started by this phase.

#### Workload / PR boundary

One commit, one work unit: two new modules (~470 lines), two new suites (~700 lines) and two
`export` keywords — **~1 180 changed lines**, above the 400-line review budget and reported,
not hidden. It cannot be split further without breaking the unit: the composer and its
invariants are one artifact, and the `gentle-ai-work-unit-commits` rule forbids shrinking the
diff by dropping tests, comments or documentation. It sits inside the parent-assigned `PR 2`
slice (tasks 1.4–1.6, rollback boundary
`src/wallet/policy/{composer,readback,service,errors}.ts`), needs no migration change, and no
`size:exception` is requested. No push, no PR, and no slice-2 work started.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work
unit, the authoritative artifact paths and the delivery path directly. Readiness was resolved
against the artifacts before any edit — `tasks.md` (task 1.4, terminal
`<!-- sdd-owner: implementation -->`), `design.md` §0 C1/C5/C6, §3.1–§3.3, §3.5, §5.1, §11 U1/U4,
§12.1, `spec.md` (single composer, invariants preserved, consent provenance, empty composition)
and the 1.1–1.3 apply-progress. `actionContext`: all writes stayed inside the assigned worktree
root; the main checkout and the untracked `compose.privy-local.ports.yaml` were not touched.

#### Commit

`feat(policy): compose one rule set per wallet from consent and grants` — see the report
envelope for the SHA.

### Task 1.5 — implement the readback comparator as a pure function with its failure classes

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

This unit was finished from an interrupted run: `src/wallet/policy/readback.ts` and
`tests/unit/policy-readback.test.ts` already existed as untracked work in progress, and a green
53-test suite from that run was **not** treated as evidence. Both files were re-judged against
design §5.1 requirement by requirement first, then repaired under RED → GREEN → mutation, and the
gaps below are what that review actually found.

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/readback.ts` | New (407 lines). The pure §5.1 comparator: `compareComposedRules` (checks (a)–(d)), `assertOwnerVerifiedBinding` (checks (e)–(g)) and `comparePolicyReadback` (the single decision the reconciler consumes). |
| `tests/unit/policy-readback.test.ts` | New (774 lines, 33 cases): the policy-id check, the rule-set comparison, the unknown-rule and unenumerable-allowlist checks, the address-provenance A/B for the `Test1` drift, the canonical-signer and sibling-signer checks, the ownership checks, the frozen-input purity check and the failure-class table. |

No other file was touched. `src/wallet/embedded.ts` inside `e9b11d3` was spot-checked, not extended
(see the spot-check verdict below).

#### What the unit delivers

- **The comparator is pure and I/O-free (design §12.1).** `readback.ts` imports only
  `node:util`, two `type` imports and the `composedRulesHash`-free composer types: no database, no
  provider, no clock. Every comparison is unit-provable before any apply code exists, which is why
  slice 1 can ship the whole §5.1 contract without a live readback.
- **Checks (a)–(d) classify `blocked_conflict` in the design's order** — policy id, then a
  documented hoist of (c)/(d) before (b), so a pristine drift carrying an unexplained rule or an
  unconsumed address is refused instead of being "repaired" by overwriting it; (b) is the
  `isDeepStrictEqual` comparator `solana-policy-provisioner.ts:97-99` already uses, so it is
  key-order independent rather than a new deep-equal.
- **It never returns a rule set derived from the readback.** The comparison result union has no
  `rules` member at all, and the frozen-input case proves the comparator reads its inputs instead of
  rewriting them: an implementation that normalised, sorted or repaired `readback.rules` in place
  throws on the frozen fixtures. This is what makes "unknown remote rules MUST block instead of
  being deleted or copied into desired state" mechanical rather than aspirational.
- **Checks (e)–(g) fail closed by default (design §5.1, §11 U2/U3).** The owner-verified signer and
  wallet listings are explicit inputs with a first-class `not_acquired` variant, so "we did not
  look" is distinguishable from "we looked and it was fine", and an absent listing is itself the
  `blocked_configuration`. No caller can reach `proven` by omitting evidence, and the decision
  function can therefore never return `verified` or `patch_required` in slice 1: the unit suite
  asserts exactly that (the `rules equal + binding unproven` row returns
  `signer_attachment_unproven`, never `verified`).
- **The binding checks are ordered (e) → (f) → (g)** with a distinct reason each
  (`signer_attachment_unproven`, `sibling_signer_lost`, `ownership_unproven`, `ownership_drift`), so
  the status reason a later task persists identifies which invariant actually broke instead of a
  single catch-all.

#### Gaps found in the interrupted work, and how each was repaired

1. **A `Transfer.to` allowlist that cannot be enumerated was silently treated as "no addresses".**
   `transferToEntries` returned `unreadable: undefined` for a missing `conditions` array *and* for a
   `Transfer.to` condition with no `value`, and the caller's `unreadable !== undefined` guard
   therefore never fired. The comparison then fell through to a `converge` in the pristine phase —
   a PATCH derived from `composed.rules` that would have **deleted** a remote allowlist nobody could
   enumerate. This is the one failure mode the comparator exists to prevent, so it was repaired with
   a tagged scan result (`enumerated` | `unreadable`) plus a distinct reason,
   `rule_conditions_unreadable`, rather than by reusing `recipient_address_without_provenance`: the
   failure is "this rule's allowlist is unreadable", not "this address lacks provenance", and the two
   need different evidence in `status_detail`.
2. **The duplicated-canonical-signer case passed for the wrong reason.** The suite covered only
   `[canonical(POLICY_ID), canonical(POLICY_ID), sibling]`, which the *policy-id count* clause
   catches; the "exactly once" clause was never exercised. Mutation confirmed it: relaxing
   `occurrences.length !== 1` to `< 1` left **32/32 passing**. A second occurrence whose
   `override_policy_ids` is empty hides the duplicate from the count clause entirely, so that case
   (units 2.2/2.3 read the listing that way) is now covered directly and through the decision
   table.
3. **Two required "no PATCH decision" cases were missing at the decision level.** Owner drift and
   the duplicated canonical signer were asserted only against `assertOwnerVerifiedBinding`, so the
   aggregator could have returned `patch_required` for them unnoticed. Both are now rows in the
   failure-class table, and the table helper *throws* naming the resolved outcome instead of relying
   on redundant negations.
4. **A weakened assertion.** The "never returns a rule set" case asserted
   `Object.keys(comparison)).not.toContain("rules")` on a return type that has no `rules` member —
   vacuous by construction. It now pins the whole classification (`ruleIndex`, `ruleName`) and is
   paired with the frozen-input purity case.
5. **A weakened table.** `Array<[PolicyReadbackDecision, string, string]>` with a cast at the call
   site meant a typo in an outcome or a reason still compiled. The table is now typed with the real
   unions and additionally asserts that the eleven rows produce nine distinct reasons, i.e. that no
   two rows collapse.
6. **A real `npm run typecheck` failure the interrupted run never reached:** `scanTransferTo(rule)`
   was called with `rule: unknown`, because the `isRecord` guard was consumed inside the `name`
   ternary and TypeScript does not narrow from that. Replaced with an explicit early-return guard,
   which narrows `rule` to `Record<string, unknown>` for check (d) with no cast. (The killed run had
   therefore never established the slice's typecheck gate; this unit does.)

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (the repaired guards) | The new cases ran against the *unmodified* interrupted implementation: **6 failed / 26 passed** — exactly the 5 unenumerable-allowlist cases (`expected 'converge' to be 'blocked_conflict'` for the missing-`conditions` and missing-`value` fixtures, `expected 'recipient_address_without_provenance' to be 'rule_conditions_unreadable'` for the three non-enumerable fixtures) and the decision-table row for the unenumerable allowlist (`expected 'blocked_configuration' to be 'blocked_conflict'` — i.e. the flow had resolved to the fail-closed binding instead of the conflict). |
| REFACTOR (narrowing) | The typecheck failure from gap 6 was fixed by replacing the ternary guard with an early return; lint and typecheck clean, **33/33** unchanged. |
| GREEN | **33 passed / 33** (`tests/unit/policy-readback.test.ts`), and **64 passed / 64** across the three slice-1 unit suites. `npm run lint` and `npm run typecheck` clean. |
| MUTATION A (the repaired sentinel) | Reverting `scanTransferTo` to "unreadable looks like no addresses" produced **6 failed / 27 passed**, exactly the 5 unenumerable cases plus the decision-table row — and the same 6 failures again after the narrowing refactor. |
| MUTATION B ("exactly once") | `occurrences.length !== 1` → `< 1`: **32 passed / 32 with the original suite** — not falsified, which is how gap 2 was found. After adding the empty-`override_policy_ids` duplicate: **3 failed / 30 passed** (`classifies a duplicated with only one entry carrying our policy id …`, `reports the occurrence count so the anomalies are distinguishable`, the decision-table row). Re-confirmed post-refactor. |
| MUTATION C (lost sibling) | Disabling the `missingSignerIds` branch (`> 0` → `> 100`): **2 failed / 30 passed** (`classifies a lost sibling signer as blocked_configuration`, the decision-table row). |
| MUTATION C2 (policy-id count clause) | Dropping `observedPolicyIds.length !== 1`: **2 failed / 31 passed** (`classifies a carrying our policy id and another canonical signer …`, the occurrence-count case). |
| MUTATION D (policy-id value clause) | Neutralising `occurrences[0].overridePolicyIds[0] !== expectedPolicyId`: **2 failed / 31 passed** (`classifies a carrying another policy id canonical signer …`, the occurrence-count case). |
| MUTATION E (verification phase) | Treating a verification mismatch as repairable (`phase === "verification"` → `false`): **2 failed / 31 passed** (the (b) pristine/verification case and the `rules_mismatch` row). |
| MUTATION F (ownership fail-closed default) | Returning `proven` when the owner-verified wallet listing was not acquired: **4 failed / 29 passed** — the (f) positive control, both (g) cases and the decision-table row, i.e. removing the fail-closed default turns a `blocked_configuration` into `patch_required`. |
| False-green guard | Every mutation was applied to one anchor, observed, and reverted (`cp` from a pristine copy); the suite was re-run green after each revert and the unmodified module reproduces **33/33**. The green from the interrupted run was deliberately not adopted as evidence: two of the six gaps above were only reachable by falsifying guards the old suite claimed to cover. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/unit/policy-readback.test.ts` (RED, before the repair) | **6 failed / 26 passed** (the five unenumerable cases + the decision-table row) |
| … (mutations A / B / C / C2 / D / E / F, each reverted) | **6 / 3 / 2 / 2 / 2 / 2 / 4** failures respectively, each attributed to the named cases above |
| `npx vitest run tests/unit/policy-composer.test.ts tests/unit/policy-composer-hash.test.ts tests/unit/policy-readback.test.ts` | **3 files passed, 64 tests passed** (0.2 s) |
| `npx vitest run tests/integration/recipient-policy-*.test.ts` | **4 files passed, 53 tests passed** (units 1.1–1.3 stay green; no residue flakiness this run) |
| `npm run lint` (twice, convergence check) | clean both runs (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) — this is the first time the slice's typecheck gate actually ran over these two files |

#### Deviations from the design

Three, all fail-closed and all additive:

1. **`converge` in the pristine phase vs. the §5.1 table's flat `blocked_conflict` for (b).** The
   table lists (b)'s failure class as `blocked_conflict`, but §5.1 also says the pristine readback
   "decides whether any PATCH is needed at all", so a structural difference with no unexplained rule
   and no unconsumed address is a repairable drift (`converge` → `patch_required`), not a stop. The
   verification phase classifies the same difference as `blocked_conflict`/`rules_mismatch`, and the
   unit suite pins both halves plus the two failure classes side by side.
2. **A fifth `blocked_conflict` reason, `rule_conditions_unreadable`.** §5.1 names four checks and
   two classes, not reason codes. Folded into `recipient_address_without_provenance` it would have
   reported "an address without provenance" for a rule that has no readable addresses at all, which
   is different evidence for 2.8/2.9 to persist. The reason is what let the repaired guard be
   mutation-provable.
3. **A documented hoist: (c)/(d) run before (b).** The design's table order is (a)…(g). Running (b)
   first would make the pristine phase answer `converge` for a drifted readback that also carries an
   unexplained rule, and the caller would then PATCH over an unknown remote rule — the exact
   behaviour the spec forbids. There is a unit case that pins the hoist. In the verification phase
   the relative order cannot change the outcome (all four are `blocked_conflict`).

One deliberate non-deviation: checks (e)–(g) are implemented and reachable, but no slice-1 case
asserts a *resolved* signer or ownership semantic (`proven`, `verified`, `patch_required`). That
proof is the owner-verified read in slice 2 (design §11 U2/U3); slice 1 asserts only that every
shape reaching the comparator without that evidence stops as `blocked_configuration`.

#### Observations handed to later tasks (not defects in this unit)

- **Task 1.6 must supply the listings, and the type makes "not looked" explicit.** Both
  `ownerVerifiedSigners` and `ownerVerifiedWallets` are optional precisely so a caller that has not
  performed the owner-verified read (design §0 C5, §11 U2/U3) produces the fail-closed stop instead
  of an accidental `proven`. The service must pass `not_acquired` with a reason while the read does
  not exist, and must not default to an empty `acquired` listing: `walletIds: []` is
  `ownership_drift` (a disproved binding), which is a different status from `ownership_unproven`.
- **Task 2.8/2.9 own the phase mapping.** `compareComposedRules(phase: "pristine")` → `converge`
  is "PATCH required"; `compareComposedRules(phase: "verification")` → `equal` is
  "promote to applied". Nothing else in this module decides which phase it is in, so the reconciler
  and the apply path must each pass their own phase explicitly.
- **`rule_conditions_unreadable` is a hard stop in both phases, by construction.** A provider that
  ever returns a `Transfer.to` condition with a non-array `value` (or a rule with no `conditions`)
  will now block every mutation for that wallet with no PATCH. That is the intended fail-closed
  direction, but 2.2's owner-verified probe and 2.9's GET-outcome table should record the reason so
  a malformed remote policy is diagnosable from `status_detail` rather than looking like an outage.
- **Check (a) is the only id-level check.** A readback whose `id` matches but whose rules belong to
  another wallet entirely is indistinguishable here; that separation is the wallet-binding step of
  §3.5, not this comparator.

#### Remaining tasks in slice 1

```text
- [ ] **1.6 Add `RecipientPolicyService` with server-owned identity, wallet, and network, plus the strict service-seam types.**
- [ ] **1.7 Implement the atomic removal transaction with whole-grant revocation.**
- [ ] **1.8 Delete the legacy full-rule writer entry points and route their callers through the composer.**
- [ ] **1.9 Document and install the single lock order, prepending `W0` to the claim path.**
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` (the bounded native review and the post-apply
verify/archive rows) were left byte-for-byte untouched, and no review, receipt or delivery gate was
started by this phase.

#### Spot-check: `src/wallet/embedded.ts` inside `e9b11d3` (15 lines)

**Verdict: the benign seam unit 1.4 needed — nothing broader.** The diff is exactly two `export`
keywords plus the two doc comments that justify them: `SOLANA_MAX_PER_TRANSFER_LAMPORTS` is exported
so the composer imports the single lamport ceiling instead of restating `"10000000"`, and
`deterministicPolicyHash` is exported so the composer's unit suite compares `applied_rules_hash`
against the *real* consent-envelope hash. No statement, expression, value, call site or control flow
was changed; `-3 / +15` is entirely comments, the `export` keywords, and one line reflowed by the
added doc block. It is the same seam this unit's apply-progress records for task 1.4, so no stop was
required. One cosmetic observation for whoever next touches the file: the new `export const` block
was inserted *between* two import statements (imports keep working because ESM hoists them, and lint
is clean), but it would read better above the import block.

#### Workload / PR boundary

One commit, one work unit: one new module (407 lines) and its suite (774 lines) — **~1 181 new
lines**, above the 400-line review budget and reported, not hidden. It cannot be split without
breaking the unit: the comparator and the seven checks it must satisfy are one artifact, and
`gentle-ai-work-unit-commits` forbids shrinking a diff by dropping tests, comments or
documentation. It sits inside the parent-assigned `PR 2` slice (tasks 1.4–1.6, rollback boundary
`src/wallet/policy/{composer,readback,service,errors}.ts`), needs no migration change, and no
`size:exception` is requested. No push, no PR, and no slice-2 work started.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit,
the authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any edit — `tasks.md` (task 1.5, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §0 C5/C6, §3.2, §5.1, §11 U2/U3, §12.1, `spec.md` ("Unknown remote rule blocks
mutation", "Owner or attachment drift blocks mutation", "Known drift is repaired by the reconciler")
and the 1.1–1.4 apply-progress. `actionContext`: all writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout and the
untracked `compose.privy-local.ports.yaml` were not touched.

#### Commit

`feat(policy): compare a policy readback against the composed revision` — see the report envelope
for the SHA.

### Task 1.6 — add `RecipientPolicyService` with server-owned identity, wallet, and network, plus the strict service-seam types

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

This unit was resumed after a hard-timeout kill that wrote the implementation and both suites but
never verified, persisted or committed them. The interrupted work was **verified, not adopted**: its
diff was read line by line, every guard was proved load-bearing by mutation, and no assertion was
weakened. No code repair turned out to be necessary — the two probes below are the only edits I made
to the working tree, and both were restored (verified by a leftover-mutation scan and by the
`errors.ts` / `repository.ts` diffstat returning to its pre-probe `140/-1` and `185/+185` shape).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/service.ts` | New (1043 lines). The service, the strict seam schemas, the injected ports, the read projection. |
| `src/wallet/policy/errors.ts` | Modified (additive: `+140/-1`). The seam's typed failure vocabulary + `apply_capability_unwired`. |
| `src/wallet/policy/repository.ts` | Modified (additive: `+185`, 0 deletions). The four service-seam queries. |
| `tests/unit/policy-service-contract.test.ts` | New (550 lines). Seam shape, refusals, projection, the non-driven apply port. |
| `tests/integration/recipient-policy-service.test.ts` | New (1302 lines). Real tables, real RLS, real transaction. |

#### What the unit delivers

- **`RecipientPolicyService`** with `create`, `edit`, `composeRevision(userId, walletId, { client? })`
  and `readContactPermission(userId, walletId)`.
- **Server-owned identity, wallet and network.** `recipientCreateInputSchema` /
  `recipientEditInputSchema` are `.strict()` and the address is validated as a canonical
  `solana-devnet` recipient; `network` is a `z.literal("solana-devnet")` echo, so a body may only
  agree with the derived scope. The wallet comes from `user_wallets` (`readReadySolanaWallet`,
  `chain_family = 'solana' AND state = 'ready'`), never from the body.
- **`ComposeInput` assembly** from the RLS-scoped `listComposerContacts`, the ledger-shaped
  `listActiveGrants(walletId, userId, "solana")` and `recipient_policy_state`; `emptyComposition` and
  the U1 `ruleComposition` are read from the wallet's recorded evidence and default to the
  fail-closed values, and the ordinary ceiling comes from `SOLANA_MAX_PER_TRANSFER_LAMPORTS`.
- **One-time consent capture.** `consent_baseline` / `consent_provenance` are read from the newest
  `state='active'` `signer_grants` row and written once, guarded twice: the service's read-aversion
  (`needsConsentRead`) and, independently, the repository statement's own
  `desired_revision = 0 AND applied_revision = 0` predicate. Each is proved on its own below.
- **The `composeRevision` seam** and the durable intent: the exact composed rules and hash are
  recorded per revision, so a later apply re-applies THAT revision instead of recomputing from
  mutable tables.
- **The apply port is a seam slice 1 cannot drive.** `PolicyApplyPort` is
  `unavailable | signed`; the service constructor refuses the `signed` arm
  (`PolicyApplyCapabilityUnwiredError`), so "slice 1 performs no live PATCH" is a property of the
  wiring rather than a promise about behaviour. The signed request/outcome shape is fixed for slice 2
  to fill.
- **Metadata-only edits never merge.** An edit whose post-mutation recomposition disagrees with the
  recorded rule reference throws `RecipientPolicyConflictError` (`blocked_conflict`,
  `metadata_edit_changes_rules`) from inside the transaction, so the contact write rolls back with
  everything else and only the recorded stop survives.
- **`readContactPermission`** fails closed: `applied` is only reported behind a verified readback at
  the current desired revision, and the projected key set is closed (`state`, `desiredRevision`,
  `appliedRevision`, `retryable`, optional `reason`) — no policy id, signer, signature or token.

#### Diff verdict on the two modified files (the additive-seam check)

- **`errors.ts` — the seam this unit needs and nothing broader.** `+140/-1`: the single changed
  existing line is the `PolicyCompositionRefusalReason` union gaining `"apply_capability_unwired"`.
  Everything else is appended: `PolicyApplyCapabilityUnwiredError`, the
  `RecipientPolicySeamErrorCode` vocabulary, `RecipientPolicyValidationIssue`, and the four typed
  seam errors (`RecipientPolicyValidationError`, `RecipientPolicyConflictError`,
  `RecipientPolicyRevisionConflictError`, and the contact-version/missing pair the injected contact
  port needs so the service can translate its failures without importing the contacts repository).
  No existing class, message or classifier was altered.
- **`repository.ts` — additive, zero deletions.** The diff is `+185` lines and no `-` line at all:
  two new exported types (`ReadyPolicyWallet`, `EnrollmentConsent`), one new error
  (`PolicyConsentRecordUnreadableError`), and four new methods
  (`readReadySolanaWallet`, `readActiveEnrollmentConsent`, `captureConsentBaselineOnce`,
  `readInFlightIntent`) placed under a `Service seam — task 1.6` marker. No existing statement,
  predicate, column list or mapping was touched, so units 1.1–1.5 keep their proof unaltered (172
  slice-1 tests still green).

#### TDD Cycle Evidence

Honest disclosure first: the killed run left no test transcript, so I cannot attest an original
RED-first ordering for its 55 tests, and I do not claim one. What I can attest is the substantive
RED evidence: for this resume I re-established a failing (RED) run for each required guard by
**mutation**, observed the attributed failure, and restored the clause — and every negative assertion
is preceded by a positive control on the same fixture.

| # | Mutation applied | Observed RED (unmocked run, exact failing tests) | Verdict |
|---|---|---|---|
| M1 | `recipientCreateInputSchema`: removed `.strict()` | 5 `rejects a create body carrying {policyId,signerId,a cap,a lamport cap,a wallet id}` — `expected a typed rejection, but nothing was thrown` | strictness is load-bearing |
| M2 | `derivedNetworkSchema`: `z.literal(...)` → `z.string()` | 4 `rejects a {create,edit} body carrying an {unknown network,a mainnet network}` | the derived-scope literal is load-bearing (a known key is not caught by `.strict()`) |
| M3 | `needsConsentRead` → always true | `does not re-capture the baseline after a stop that recorded no revision`, `refuses to compose from an enrollment consent record it cannot read` | the service-side read-aversion is load-bearing and independently attributed |
| M4 | `captureConsentBaselineOnce`: dropped `desired_revision = 0 AND applied_revision = 0` | `refuses to capture the baseline again once a revision is recorded` | the DB predicate is load-bearing on its own, as the code claims |
| M5 | metadata conflict guard `reference.hash !== composed.hash` → `!== reference.hash` (disabled) | `blocks a metadata edit whose recomposition would change the recorded rule set`, `compares a settled wallet's metadata edit against its APPLIED rule set` | the conflict guard is load-bearing; the "not a silent merge" requirement is genuinely asserted |
| M6 | `PolicyApplyPort` construction refusal disabled (`if (false)`) | `refuses a signed capability instead of driving a live policy write`, `classifies the refusal as a blocking configuration stop` | the no-live-PATCH property is load-bearing |
| M7 | `validationIssues` unknown-key path attribution flattened to the object path | 10 `rejects a {create,edit} body carrying {policyId,…}` — the path no longer names the key | the assertion is the clause that catches the case (unit 1.5's lesson: the intended clause is what fails) |

Post-restore controls: leftover-mutation scan for all seven mutated strings returns no hits, the
`repository.ts`/`errors.ts` diffstat is back to `185`/`140-1`, and both suites are green again
(55/55, then 172/172 for the whole slice).

#### Commands run and results

```text
npx vitest run tests/unit/policy-service-contract.test.ts
  Test Files 1 passed (1) | Tests 33 passed (33) | 330ms

npx vitest run tests/integration/recipient-policy-service.test.ts
  Test Files 1 passed (1) | Tests 22 passed (22) | 985ms

npx vitest run tests/unit/policy-service-contract.test.ts tests/integration/recipient-policy-service.test.ts
  Test Files 2 passed (2) | Tests 55 passed (55) | 968ms

npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
  Test Files 9 passed (9) | Tests 172 passed (172) | 2.35s      ← units 1.1–1.5 stayed green

npm run lint        → eslint src tests --max-warnings=0 : clean, no output
npm run typecheck   → tsc -p tsconfig.test.json --noEmit : clean, no output
```

The integration suite runs against the **Supabase** chain in container
`colloseumfeat-solana-operational-db-1` (host port 55470) using the worktree `.env`; it self-cleans
the state/intent/proposal/grant/recipient rows it provisions so it does not consume the windowed
due-intent scan that task 1.3's suite depends on, and it leaves audit rows alone because the table is
append-only by trigger.

#### Deviations from the design

1. **`readContactPermission(userId, walletId)`, not the design's shorthand `readContactPermission(walletId)`.**
   The owner scope is an explicit argument so a caller can never read a wallet it does not own: the
   repository read is RLS/owner-scoped and the design's shorthand would have had to re-derive the
   user from ambient state. Same guarantee, one more argument.
2. **The construction refusal of the signed apply arm.** Design §12.1 says slice 1 performs no live
   PATCH; this unit makes that structural instead of behavioural, at the cost of slice 2 having to
   remove the guard when it wires the signed port. Recorded as a deliberate stop-gap, not an
   interface the signed port is expected to keep.
3. **The contact-mutation port is injected, not `ContactsRepository`.** `recipients.embedding` needs
   the embedding provider, which belongs to the HTTP vertical (slice 3), and design §3.3 keeps
   `src/wallet/policy/**` free of `ContactsRepository` imports. The integration suite therefore
   supplies a real-SQL adapter with the documented contract (create / version-CAS update / read)
   rather than the production one.
4. **A metadata conflict is recorded in a second transaction.** The edit itself must not be applied,
   so the conflict is thrown from inside the mutation transaction and only the stop is written
   afterwards; the alternative (committing the metadata write and recording the stop) is exactly the
   silent merge the spec forbids.

#### Observations handed to later tasks (not defects in this unit)

- **Task 1.5's `not_acquired` requirement lands in slice 2, and this service does not violate it.**
  The service never calls `compareComposedRules`, so it cannot pass an `acquired` listing it has not
  read. The signed apply port (`PolicyApplyRequest` carries `appliedPolicyId` plus the recorded
  rules) is where `ownerVerifiedSigners` / `ownerVerifiedWallets` must arrive as `not_acquired` with
  a reason until task 2.2/2.3 perform the owner-verified read.
- **`listActiveGrants` opens its own user transaction**, so the grants are read outside an enclosing
  mutation transaction's snapshot. Nothing in this unit mutates grants (documented in the code under
  a `KNOWN BOUNDARY` note); the apply/removal paths that do own moving that read onto the caller's
  client.
- **`apply_capability_unwired` must be removed, not relaxed, by the slice-2 wiring.** While it stands,
  a deployment that accidentally wires a real capability fails closed at construction — which also
  means slice 2's capability tests must construct the service with the signed arm and therefore have
  to update this unit's unit-test expectations deliberately.
- **`recordApplyPending` is a second transaction after the mutation commit.** A failure there leaves
  the intent durable with the `pending` status `bumpDesiredRevision` already wrote, so the reconciler
  still sees the work; a caller that wants one-transaction atomicity must move the status write into
  the mutation before slice 2 relies on it.
- **`empty_composition` and `rules_union` are read from `recipient_policy_state`**, so no composition
  can relax a fail-closed stop without a recorded probe result (design §11 U1/U4). The reconciler
  (2.7/2.9) is what will write them.

#### Remaining tasks in slice 1

```text
- [ ] **1.7 Implement the atomic removal transaction with whole-grant revocation.**
- [ ] **1.8 Delete the legacy full-rule writer entry points and route their callers through the composer.**
- [ ] **1.9 Document and install the single lock order, prepending `W0` to the claim path.**
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` (the bounded native review and the post-apply
verify/archive rows) were left byte-for-byte untouched, and no review, receipt or delivery gate was
started by this phase.

#### Workload / PR boundary

One commit, one work unit: one new module (1043 lines), two suite files (1852 lines) and the additive
repository/error seams — **~3 235 new lines**, above the 400-line review budget and reported, not
hidden. It cannot be split without breaking the unit: the service, the strict schemas it is the
boundary for and the integration proof that a rejection persists nothing are one artifact, and
`gentle-ai-work-unit-commits` forbids shrinking a diff by dropping tests, comments or documentation.
It sits inside the parent-assigned `PR 2` slice (tasks 1.4–1.6, rollback boundary
`src/wallet/policy/{composer,readback,service,errors}.ts` plus the additive `repository.ts` seam
block), needs no migration change, and no `size:exception` is requested. No push, no PR, and no
slice-2 work started.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit,
the authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any edit — `tasks.md` (task 1.6, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §0 C6, §2.1–§2.5, §3.1, §3.5, §9.1, §11 U1, §12.1 and the 1.1–1.5 apply-progress.
`actionContext`: all writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout and the
untracked `compose.privy-local.ports.yaml` were not touched.

#### Commit

`feat(policy): add the recipient policy service with server-owned identity and a strict seam` — see
the report envelope for the SHA.

### Task 1.7 — implement the atomic removal transaction with whole-grant revocation

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/service.ts` | Modified (additive, `+537/-7`). `remove(...)`, the `W1 → tx{ W0(U) → L1(asc) → L2 → L3 → L5 }` chain, the abort-and-restart guard, the whole-grant revoke loop, `projectRevocationDisclosure`, the `RecipientRemovalResult` / `RecipientRevocationDisclosure` types, the removal schema, and ONE line in `composeRevision` (`options.grants ?? this.listActiveGrants(...)`). |
| `src/wallet/policy/repository.ts` | Modified (additive, `+266`). Six new removal reads/statements under a `Removal transaction — task 1.7` marker: `listActiveAliases`, `lockActiveAliases` (L3), `listAffectedActiveGrants`, `lockAffectedGrants` (L2), `lockGrantAdvisoryKeys` (L1), `revokeGrantWhole`, `listActiveLedgerGrants` (the client-scoped composition read), plus the two row types and their mapper. No existing statement, predicate or column list was touched. |
| `src/wallet/policy/errors.ts` | Modified (additive, `+48`). `RecipientPolicyRemovalConflictError` (`blocked_conflict` / `revocation_set_widened`) and `RecipientPolicyNotSerializedError` (`blocked_conflict` / `policy_lease_busy` \| `policy_lease_unavailable`). |
| `tests/integration/recipient-policy-removal.test.ts` | New (17 cases). The removal semantics against real tables, real RLS, real transactions and a real second lease holder, plus the disclosure projection's decision table. |
| `tests/integration/recipient-policy-service.test.ts` | Modified (additive, `+13`): the injected contact port gains the `archive` member this unit's seam requires, so task 1.6's suite keeps compiling and its 22 cases keep their proof. |

#### What the unit delivers

- **The chain, exactly as §1.3 specifies for removal.** `W1` is acquired OUTSIDE the
  transaction (bounded wait, released in `finally`); Phase B is one `withUserTransaction`
  taking `W0(U)` (`lockPolicyState`), then `L1` (one `pg_advisory_xact_lock(hashtext('dgc-grant-<id>'))`
  per affected grant, ascending — the SAME key the claim path takes, so claim and removal
  serialize on one lock), then `L2` (`FOR UPDATE`, ascending, deliberately NOT filtered by
  `state`), then `L3` (the aliases `FOR UPDATE`, ascending), then `L5` (appends). Provider I/O
  never runs inside the transaction: the port's capability is `unavailable` and the apply step
  is a separate, post-commit status write.
- **Phase A / Phase B split with the abort-and-restart guard.** Phase A reads the target
  contact, the alias set, the affected active grants and freezes the immutable proposal payload
  (`action: 'remove'`, contact id + version, address, `affected_grant_ids` only when last
  alias). Phase B re-derives the alias set under `L3` and the affected set under the locks, and
  aborts (rollback → re-plan) when either the alias set differs from Phase A's or an affected
  grant was not locked. Three attempts, then `blocked_conflict` with
  `revocation_set_widened`. Widening is the direction that matters: a grant Phase A never named
  would otherwise be revoked without ever being disclosed.
- **Whole-grant revocation, or none.** Only when the alias set under lock is exactly one
  alias: each affected grant is revoked whole by the existing revoke statement
  (`state='revoked', revoked_at=now()`) and gets its `revoked` `grant_audit_log` row through
  `appendGrantAudit(..., client)` IN THE SAME transaction. The statement has no `recipients`
  write at all, so a multi-address grant cannot be narrowed, rewritten or migrated to a
  replacement address — proven by comparing the raw rows byte-for-byte.
- **Everything else in the same transaction.** The version-CAS contact archive
  (`WHERE user_id=$1 AND id=$2 AND version=$3 AND status='active'`; the port raises the seam's
  `409 VERSION_OBSOLETA` on zero rows), `desired_revision + 1`, the intent row for that revision
  carrying the composed rules/hash and the `idempotency_key`, and the `intent_recorded` +
  `revocation_disclosed` audits.
- **The recorded revision composes the POST-mutation projection.** The grants are read on the
  caller's client (`listActiveLedgerGrants`) and handed to `composeRevision` through a new
  optional `grants` field, so the recorded rules cannot contain a rule for a scope this
  transaction just revoked (proven directly: the intent's `composed_rules` does not contain
  `solana-grant-<revoked id>`).
- **No premature success.** `revocation.state` is produced by one exported projection that
  defers entirely to the already-fail-closed `projectContactPermission`, so a state row claiming
  `applied` without `verified_at` (or with an applied revision behind the desired one) yields
  `pending`, never `applied`.
- **A composition refusal is a STOP, not a rollback.** If the post-mutation composition refuses
  (`blocked_configuration`), the removal and its revocations COMMIT with the stop recorded and
  no new revision or intent — revoking authority is the safe direction, and retaining it because
  a composition could not be proven would be the unsafe one. Proven by a case where one grant is
  revoked while a second stays active and U1 is unproven.

#### TDD Cycle Evidence

Honest disclosure first: the RED I can attest is **module-level**, not behavioural. The suite was
written and run against the pre-unit tree (`service.ts`/`repository.ts`/`errors.ts` reverted to
`HEAD`, restored by `cp` from a backup, no stash involved): **16 failed / 16**, every case failing
`TypeError: … remove is not a function` / `projectRevocationDisclosure is not a function`. That
proves the suite cannot pass without the unit, but it does not prove any individual guard. Every
guard is therefore proven separately, by mutation, and each was restored from a pristine copy
with the suite re-run green afterwards (`17/17`).

| # | Mutation applied | Observed RED (exact failing tests) | Verdict |
|---|---|---|---|
| A | `if (aliasesUnderLock.length === 1)` → `if (true)` | `does not revoke the grant and appends no revoke audit while a second alias is active` | the last-alias authority is load-bearing |
| B | revocation `reason: "last_active_alias_removed"` → `"neutralised"` | `revokes the affected whole grant with its audit in the same transaction as the contact` | the `revoked` audit append and its evidence are load-bearing |
| C | `projectRevocationDisclosure`: `if (permission.state === "applied")` → `if (true)` | 5 cases — the removal's `state !== "applied"`, plus 4 decision-table rows | "never reports the revocation as applied before a readback" is genuinely asserted |
| D | the `W1` gate (`if (lease.status !== "acquired")` → `if (false)`) | `mutates nothing while another writer holds the wallet lease, then succeeds once it is released` | the lease is the writer gate, not a retry hint |
| E | `composeRevision(userId, walletId, { client, grants })` → `{ client }` (the runtime's own-transaction read) | `revokes the affected whole grant …` **and** `mutates nothing while another writer holds the wallet lease …` | the post-mutation composition read is load-bearing |
| F | the abort guard's alias clause (`!sameIdSet(...) \|\|` → `false \|\|`) | `restarts on a stale plan instead of disclosing a revocation it did not perform` | the restart guard is load-bearing |

Mutation F is why the suite has a 17th case: the first mutation run produced **16 passed / 16**
under F — not falsified — which is exactly unit 1.5's lesson. The guard was unreachable because
grant creation must hold `W1` (which the removal holds), so nothing in the suite could move the
plan. The honest fix was a test, not a comment: a repository proxy whose Phase A alias read is
followed by an injected second alias (the alias half needs no new grant), which now fails by name
under F and passes otherwise.

Every negative assertion is preceded by a positive control on the same fixture: the affected grant
is asserted `active` before it is asserted `revoked`; `recordRuleUnion` asserts `rowCount === 1`
so a composition case cannot silently measure the fail-closed default; the rollback case asserts the
injected failure really ran AFTER the contact write; the version-CAS case asserts the SAME call
succeeds with the version the caller read; the lease case releases the lease and re-runs the very
same removal to success; the unrelated-grant case asserts the affected grant's audit IS visible
through the same helper that reports the unrelated grant's absence.

#### Commands run and results

```text
# pre-change control (BEFORE any edit), 6 grant suites
npx vitest run tests/unit/grants-policy-provisioner.test.ts tests/unit/grants-policy-runtime.test.ts \
  tests/unit/privy-policy-sync.test.ts tests/integration/grant-claim-release.test.ts \
  tests/integration/delegated-grants-consumption.test.ts tests/integration/delegated-grant-execution.test.ts
  → Test Files 6 passed (6) | Tests 62 passed (62)

# honest module-level RED (implementation reverted to HEAD, then restored)
npx vitest run tests/integration/recipient-policy-removal.test.ts
  → Tests 16 failed (16) — every case `remove is not a function` / `projectRevocationDisclosure is not a function`

# mutations A-F, each restored and re-run green
  → 1 / 1 / 5 / 1 / 2 / 1 failures respectively, each by name (table above)

npx vitest run tests/integration/recipient-policy-removal.test.ts
  → Test Files 1 passed (1) | Tests 17 passed (17)   (stable across 3 runs)

npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
  → Test Files 10 passed (10) | Tests 189 passed (189)      ← units 1.1-1.6 stayed green (172 → 189)

# post-change grant regression set, SAME six suites, compared by test name
  → Test Files 6 passed (6) | Tests 62 passed (62)          ← identical to the pre-change control; no new failure

npm run lint        → eslint src tests --max-warnings=0 : clean, exit 0
npm run typecheck   → tsc -p tsconfig.test.json --noEmit : clean, exit 0
```

Grant regression comparison **by test name**: pre-change control 62 passed / 0 failed; post-change
62 passed / 0 failed, the same names, so this unit introduces no regression in the grant
claim/consumption/revocation area. The six known backend failures named in
`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md` are outside this set and
were not touched by this unit's diff.

#### Deviations from the design

Five, all deliberate and additive:

1. **`Remove`'s contact archive goes through the injected port, not `ContactsRepository`.** The port
   gains an `archive(userId, contactId, expectedVersion, client)` member carrying the design's exact
   version predicate (`WHERE user_id=$1 AND id=$2 AND version=$3 AND status='active'`). The existing
   `ContactsRepository.archive` (`src/memory/contacts-repository.ts:226-240`) is an UNVERSIONED soft
   delete, so it cannot be the seam's CAS and must not be imported here (design §3.3 keeps
   `src/wallet/policy/**` free of that module). The zero-row case is reported as
   `RecipientContactVersionConflictError` — the seam's `409 VERSION_OBSOLETA`, exactly what
   `update` already reports — rather than by importing the concrete `ContactsConflictError`; the
   translation belongs to the HTTP vertical's adapter.
2. **Two new seam errors.** `revocation_set_widened` (the exhausted restart budget) and
   `policy_lease_busy` / `policy_lease_unavailable` (`W1` could not be acquired) have no member in
   the design's vocabulary, and neither may be reported as a generic failure: the first is a
   `blocked_conflict` that must be recorded, and the second is the reason a removal mutated
   NOTHING. Both carry `failureClass` + `reason` so `recordStop` cannot pattern-match message text.
3. **`composeRevision` gained an optional `grants` input.** §1.6 step 7 requires the composition to
   read the post-mutation projection; `listActiveGrants` opens its own transaction and would
   therefore compose from a snapshot that still contains the just-revoked grant. The carried note
   from task 1.6 named removal as the owner of moving that read onto the caller's client; the new
   `listActiveLedgerGrants` does exactly that and `composeRevision` accepts the result. One line
   changed: `const grants = options.grants ?? (await this.listActiveGrants(...))`.
4. **The lease's bounded wait is injectable** (`deps.policyLease?: { waitBudgetMs?, ownerId? }`,
   default 3 000 ms / `"backend"`). §1.6 step 1 bounds the wait; without an injection point the
   contended-lease case would either sleep the production budget or simulate contention instead of
   creating it. The case holds the lease from a SECOND connection, so contention is real.
5. **A composition refusal during a removal commits the removal and its revocations.** The design
   says a failed mutation persists nothing (spec: the rollback scenario) but does not say what a
   `blocked_configuration` STOP does on the removal path, and slice 1 ships only fail-closed
   defaults, so this path is reachable today. Rolling back would RETAIN authority the user
   explicitly removed; committing keeps the safe direction and still records the stop, with no
   revision, no intent and no PATCH (§11 U1's saved-not-enabled end state, applied to removal).

One smaller, non-behavioural choice: the removal's `revocation_disclosed` audit detail is the frozen
Phase A payload plus the `revokedGrantIds` the transaction actually performed, so the two are
comparable in one row; the test that proves the abort guard reads exactly that pair.

#### Observations handed to later tasks (not defects in this unit)

- **`setPolicyStatus` REPLACES `status_detail`.** `recordApplyPending` writes
  `{ code: "provider_unavailable" }`, so a U1 probe result recorded as
  `status_detail.rules_union` is destroyed by the next mutation's post-commit status write. Task 2.1
  records the probe result and task 2.9 owns the status transitions, so one of them must merge
  rather than replace (or record the probe outcome where it survives). Found while building this
  unit's fixture, which has to record the union LAST for that reason; not this unit's to fix.
- **`grant_audit_log`'s append-only trigger plus its FK to `delegated_grants` makes a revoked grant
  undeletable.** Any test teardown that revokes a grant must leave the grant row behind (this
  suite's `afterAll` does, and says why). A future suite that tries to clean up its grants after
  exercising revocation will fail on the FK, not on its assertions.
- **`ContactsRepository.archive` is unversioned today.** The HTTP vertical's adapter must add the
  `version = $3` predicate the design's §1.6 step 7 statement carries; the port's contract already
  requires it, so the adapter cannot satisfy the seam without it.
- **The remote rules for a removal are not withdrawn until the reconciler applies them.** When the
  composition refuses, the previously attached policy keeps the revoked grant's rule; the ledger
  revocation plus the slice-2 claim gate are what stop execution. This is the design's architecture
  (`Ledger state, whole-grant revocation, and revoke audits are authoritative`), recorded here so
  slice 2's apply path is not read as optional for safety.
- **`L1`/`L2` are locked but not yet contended by this suite.** `claim ‖ removal` under two real
  connections with `statement_timeout` is design §12.2's concurrency case and task 1.9's explicit
  deliverable (it also prepends `W0` to the claim path); this unit proves the locks are taken in the
  documented order, not that the order prevents `40P01`.

#### Remaining tasks in slice 1

```text
- [ ] **1.8 Delete the legacy full-rule writer entry points and route their callers through the composer.**
- [ ] **1.9 Document and install the single lock order, prepending `W0` to the claim path.**
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` (lines 172-173: the bounded native review and the
post-apply verify/archive) were left byte-for-byte untouched — both still carry
`<!-- sdd-owner: parent -->` and remain unchecked — and no review, receipt or delivery gate was
started by this phase.

#### Workload / PR boundary

One commit, one work unit: `service.ts` (`+537/-7`), `repository.ts` (`+266`), `errors.ts` (`+48`),
the new 17-case suite and the 13-line additive `archive` member in task 1.6's suite —
**~1 750 changed lines**, above the 400-line review budget and reported, not hidden. It cannot be
split without breaking the unit: the chain, the abort guard, the revocation and the disclosure are
one transaction whose guarantees are only provable together, and `gentle-ai-work-unit-commits`
forbids shrinking a diff by dropping tests, comments or documentation. It sits at the head of the
parent-assigned `PR 3` slice (tasks 1.7–1.11, rollback boundary
`embedded.ts`, grants provisioner/runtime, `consumption.ts`, docs), needs no migration change, and
no `size:exception` is requested. No push, no PR, and no work started on tasks 1.8-1.11.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit,
the authoritative artifact paths and the delivery path directly (slice-1 chained PR, this work unit
alone). Readiness was resolved against the artifacts before any edit — `tasks.md` (task 1.7,
terminal `<!-- sdd-owner: implementation -->`), `design.md` §1.2/§1.3/§1.6/§1.7, §2.1-§2.5, §9.2,
§11 U1, §12.2, `spec.md` ("Atomic recipient mutation with desired revision and granted-scope
revocation", "Atomic revocation of affected grants on last-alias removal", "Effective status
vocabulary and no premature success") and the 1.1-1.6 apply-progress. `actionContext`: all writes
stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout and the
untracked `compose.privy-local.ports.yaml` were not touched. The database was left on the Supabase
chain this worktree provisions from, and `npm run db:migrate` was not used.

### Task 1.8 — delete the legacy full-rule writer entry points and route their callers through the composer (PARTIAL)

Status: **partial — deliberately NOT checked off.** `tasks.md` still shows `- [ ]` for task 1.8,
and this entry says exactly which of the four deliverables landed and which did not. The persisted
checkbox was left untouched because the run hit its hard 20-minute cap (three earlier runs on this
unit died at the same wall); claiming completion would be a lie the checkbox would then carry.

#### What landed in this commit (green, coherent, strictly safer than `HEAD`)

| File | Role |
|---|---|
| `src/wallet/grants/solana-policy-provisioner.ts` | The two direct writer entry points are DELETED (`createSolanaGrantPolicyProvisioner`, `provisionPolicy`, `revokePolicyRules`) together with their dead helpers (`mergeGrants`, `ProvisionerOptions`, `ProvisionPolicyResult`, `RevokePolicyRulesResult`, `sameRules`, the `node:util` import). What remains is the PURE rule builder (`composeGrantRules`) and the provider port types. The module no longer reaches a provider at all. |
| `src/wallet/grants/privy-policy-runtime.ts` | `createRuntimeGrantPolicyProvisioner` keeps the `GrantPolicyProvisioner` port that `PrivyPolicySyncService` depends on, and both methods delegate to the composer service entry point `RecipientPolicyService.composeRevision`. Because slice 1 deliberately ships no signed apply capability (task 1.6 `apply_capability_unwired`), the delegation ends in ONE typed `blocked_configuration` refusal — never a fabricated `policyId`, never a silent success, never a direct provider fallback. |
| `tests/unit/policy-provisioner-delegation.test.ts` | New (5 cases). Replaces the deleted `tests/unit/grants-policy-provisioner.test.ts`. |
| `tests/unit/grants-policy-runtime.test.ts` | 5 cases CHANGED (see below). |

#### The fail-visible assertion (the safety framing's requirement)

`tests/unit/policy-provisioner-delegation.test.ts` → *"routes provisionPolicy through the composer
and never issues an independent full-rule write"*. Its structure:

1. **Positive control first** — the composer's own reads are asserted to have run
   (`FROM user_wallets`, `FROM recipients`, `FROM recipient_policy_state`), so the refusal is
   provably the composer's successor and not an early bail that never consulted it. Without this the
   case could pass on a module that does nothing.
2. **Fail-visible** — the call REJECTS, and the rejection is a `PolicyCompositionRefusalError` with
   `failureClass === "blocked_configuration"` and `reason === "apply_capability_unwired"`. This is
   the assertion that fails the instant a future edit makes the path silently succeed: the mutation
   recorded below turns exactly these two cases red.
3. **No second full-rule writer** — `server.createPolicy`, `server.patchPolicy` and
   `admin.attachPolicyToSigner` are instrumented `vi.fn()`s that WOULD record if called (this is not
   a negative over an unreachable module: the deleted writer called all three), and they are
   asserted uncalled.

The invariant it protects is the spec's "never detach to unrestricted authority": a path that used
to create or attach a policy and now cannot obtain one through the composer stops visibly instead of
reporting permission as ready with nothing attached.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (module) | `tests/unit/policy-provisioner-delegation.test.ts` was written against the un-edited tree first: `npm run typecheck` → `error TS2305: Module '"../../src/wallet/grants/solana-policy-provisioner.js"' has no exported member 'createSolanaGrantPolicyProvisioner'` — the suite cannot even load without the unit. |
| GREEN | `npx vitest run tests/unit/policy-provisioner-delegation.test.ts` → **1 file passed, 5 tests passed** (386 ms). |
| MUTATION (the fail-visible guard) | `throw new PolicyApplyCapabilityUnwiredError("grant_policy_sync")` → `return { policyId: "policy-1" } as never` (a silent success with no policy attached). Result: **2 failed / 3 passed (5)**, exactly `routes provisionPolicy through the composer and never issues an independent full-rule write` and `routes revokePolicy through the composer too, with the same visible refusal`. The guard is load-bearing and attributed by name. Restored from a pristine copy; re-run green; `grep` for the mutation string returns nothing. |
| GREEN (after the existing-suite update) | `npx vitest run tests/unit/grants-policy-runtime.test.ts tests/unit/policy-provisioner-delegation.test.ts` → **2 files passed, 20 tests passed**. |

#### Existing tests changed, and why (none deleted without replacing its intent)

1. `tests/unit/grants-policy-provisioner.test.ts` — **DELETED** (14 tests). Every case drove
   `createSolanaGrantPolicyProvisioner(...).provisionPolicy`/`.revokePolicyRules`, i.e. exactly the
   direct-call behaviour task 1.8 removes; the suite could not exist without the deleted writer. Its
   intent is not dropped, it moved: the flat-rule shape, deterministic per-grant name, no fabricated
   cumulative rule and the static-expiry encoding are asserted by
   `tests/unit/policy-composer.test.ts` (byte-identity + composition invariants, unit 1.4) and by
   the surviving builder case in the new delegation suite; the readback/fail-closed intent is
   asserted by `tests/unit/policy-readback.test.ts` (1.5) and by the new typed-refusal cases.
2. `tests/unit/grants-policy-runtime.test.ts` — 5 cases CHANGED, all in the
   `createRuntimeGrantPolicyProvisioner` / wiring describes:
   - *"accepts the stored Solana ledger chain and emits the flat Solana rule shape (no chain field)"*
     → now *"accepts the stored Solana ledger chain, then refuses visibly instead of writing a
     policy"*. The chain-acceptance half is preserved verbatim; the PATCH-body half has no subject
     left (the composer owns rule composition) and is replaced by the typed refusal + zero provider
     writes.
   - *"provisions through the composed provisioner with verbatim lamports strings"* → now
     *"delegates provision to the composer, which emits no provider write in this slice"*. The
     lamports-never-reformatted intent is asserted by `tests/unit/policy-composer.test.ts`; here the
     assertion is that no provider write exists to carry them.
   - *"throws on provision failure so the sync service keeps its fail-closed audit path"* → kept by
     name, **strengthened**: the original body asserted only `rejects.toThrow(/provider timeout/)`;
     it now asserts the refusal is a typed `PolicyCompositionRefusalError` with reason
     `apply_capability_unwired`. Same rejection (so the sync service's fail-closed catch path still
     runs), stronger evidence.
   - *"revoke succeeds through the composed revoke and throws on an uncertain outcome"* → now
     *"refuses revoke visibly instead of reporting a revocation nobody performed"*: both halves
     assert the same contract, because resolving `revokePolicy` requires a verified remote rule set
     and slice 1 has no writer that could produce one.
   - the wiring case *"returns the runtime service when Privy + canonical signer config are
     available"* keeps its `kind: "runtime"` assertion and its END-TO-END `syncGrant` call, but the
     end state changed from `policyId: "policy-new"` to `policyId: null` + a recorded refusal +
     `createPolicy` never called. This is the whole-unit expression of the fail-closed end state.
   No assertion was deleted without its intent being re-homed, and no suite was weakened.

#### Commands run and results

```text
# PRE-CHANGE CONTROL (before any edit) — the mandated named set
npx vitest run tests/unit/grants-policy-provisioner.test.ts tests/unit/grants-policy-runtime.test.ts \
  tests/unit/privy-policy-sync.test.ts tests/unit/privy-policy-admin.test.ts \
  tests/integration/privy-policy-sync.test.ts tests/integration/wallets-enrollment.test.ts \
  tests/integration/privy-policy-admin-migration.test.ts tests/integration/privy-wallet-runtime-fail-closed.test.ts
  → Test Files 8 passed (8) | Tests 88 passed (88)      ← BASELINE

# the unit's own suite
npx vitest run tests/unit/policy-provisioner-delegation.test.ts         → 5 passed (5)
npx vitest run tests/unit/grants-policy-runtime.test.ts tests/unit/policy-provisioner-delegation.test.ts
  → 2 files passed (2) | Tests 20 passed (20)

# slice-1 regression (units 1.1-1.7 stayed green)
npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
  → Test Files 11 passed (11) | Tests 194 passed (194)

# POST-CHANGE, SAME CONTROL SET, compared BY TEST NAME
npx vitest run <the 8 pre-change paths>
  → Test Files 7 passed (7) | Tests 74 passed (74)
    88 → 74 tests, 8 → 7 files: the ONLY difference is the deletion of the
    writer suite (14 tests, 1 file), replaced by 5 cases at
    tests/unit/policy-provisioner-delegation.test.ts. NO OTHER test name
    changed state: every one of the remaining 74 passes, and the 6 known
    backend failures named in .agent-workflow/.../91-test-baseline.md are
    outside this set and were not touched.

npm run lint      → eslint src tests --max-warnings=0 : clean, exit 0
npm run typecheck → tsc -p tsconfig.test.json --noEmit : clean, exit 0
```

#### What did NOT land, and why

1. **Deliverable 2 — `preparePermission` (`task 1.8` part 2).** NOT DONE. `privyServer.createPolicy(...)`
   and the stale pending-policy reuse are still in place. `tests/integration/enrollment-composed.test.ts`
   does not exist. Rationale for stopping rather than starting it: it changes enrollment from "returns a
   policyId" to "records a `recipient_policy_sync_intent` with `origin='enrollment'` and then fails
   visibly", which invalidates `tests/integration/wallets-enrollment.test.ts` and requires its own
   integration suite. Starting it without the time to update that suite and write the new one would have
   left the tree red or, worse, shipped an enrollment that completes with no policy attached — the exact
   failure mode the parent's safety framing forbids. The tree as committed is strictlier safe than `HEAD`:
   enrollment still creates its policy directly (unchanged authority), while the grant side can no longer
   write at all.
2. **Deliverable 3 — `completePermission` verifying against `recipient_policy_state.applied_policy_id`
   plus `applied_rules_hash`.** NOT DONE (`src/wallet/embedded.ts:1238-1269` still validates the pending
   row's stored id). This is the guard that makes "a pending row whose stored id no longer matches the
   applied revision cannot activate permission" true, and it is the highest-value remainder of this unit.
3. **The enrollment-composition integration test.** NOT DONE (blocked by 1).

#### Handover to the next run on task 1.8

- Deliverables 2 and 3 are untouched and independent of what landed; start from
  `src/wallet/embedded.ts` (`preparePermission` ~`:906-975`, `completeSolanaPermission` ~`:1238-1369`).
- `PolicyApplyCapabilityUnwiredError("grant_policy_sync")` is the typed refusal the grant path now
  emits; per task 1.6's carried note it must be DELETED (not relaxed) when slice 2 wires the signed
  port, and `tests/unit/policy-provisioner-delegation.test.ts` plus the five changed cases in
  `tests/unit/grants-policy-runtime.test.ts` are the assertions that will have to change with it.
- The delegation calls `composer.composeRevision(userId, walletId)` BEFORE refusing, deliberately: a
  composition refusal (empty composition, unproven rule union, unsupported ceiling) is reported as
  its own typed stop rather than being masked by `apply_capability_unwired`.
- `tests/unit/policy-provisioner-delegation.test.ts` answers the composer's reads with a database
  double that returns one active contact and no state row, so composition SUCCEEDS and the only
  observable is the refusal. A future edit that gives the composer a real policy id will be caught
  by the provider-surface `not.toHaveBeenCalled()` assertions.

#### Workload / PR boundary

One commit, one PARTIAL work unit: `solana-policy-provisioner.ts` (net deletion of the two writer
entry points and their helpers), `privy-policy-runtime.ts` (delegation + typed refusal), the new
5-case suite and the 5 changed existing cases. It sits inside the parent-assigned `PR 3` slice (tasks
1.7–1.11). No push, no PR, and no work started on tasks 1.9–1.11.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit,
the authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any edit — `tasks.md` (task 1.8, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §0 C1/C6, §3.3, §3.4, §3.5, §12.1 and the 1.1–1.7 apply-progress. `actionContext`: all
writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout
(`/Users/ramiro/Desktop/projects/colloseum`) and the untracked `compose.privy-local.ports.yaml` were
not touched. No review, receipt or delivery gate was started.

---

## Task 1.8 — deliverables 2 and 3 (enrollment composed; completion verified on the applied revision)

Continuation of the same work unit. Deliverable 1 (the grant provisioner delegation) landed in
`f0308cc`; this run completes the dangerous half — removing `preparePermission`'s direct
`createPolicy` — and closes the unit. One commit.

### What landed in this commit

| File | Role |
|---|---|
| `src/wallet/embedded.ts` | `preparePermission` no longer creates or reuses a policy: it persists the pending `signer_grants` row (snapshot preserved, `provider_policy_id` NULL), records the enrollment intent through the composer, then REFUSES VISIBLY. `completeSolanaPermission` now verifies against `recipient_policy_state.applied_policy_id` + a rule readback equal to `applied_rules_hash` instead of the pending row's stored id. New `EnrollmentPolicyComposer` seam + `appliedPolicyRevision` / `appliedRulesReadbackMatches` helpers. |
| `src/wallet/policy/service.ts` | New `recordEnrollmentIntent(userId, walletId)` (design §3.4 step 1): compose the desired revision and record it as a durable `origin='enrollment'` intent, superseding the previous in-flight intent in the same transaction. Creates no policy and returns no policy id. |
| `src/api/wallets.ts` | `PolicyCompositionRefusalError` maps to `409 CONFLICTO_POLITICA` so the fail-visible stop is a typed conflict, not a generic 500. |
| `tests/integration/enrollment-composed.test.ts` | New (3 cases). |
| `tests/integration/wallets-enrollment.test.ts` | 6 cases CHANGED (see below). |

### The safety framing, resolved

The forbidden failure mode was *enrollment completing while no policy is attached at all*. Removal of
the direct `createPolicy` makes the composer the only policy creator; because slice 1 ships the
`apply_capability_unwired` capability (task 1.6), the composer cannot hand back a policy. The contract
is therefore: **a caller that used to obtain a policy and now cannot fails visibly.**

* `preparePermission` records the durable enrollment intent (positive control: the intent row exists,
  carrying the composed rules) and then throws a typed `PolicyCompositionRefusalError`
  (`failureClass: blocked_configuration`). When no composer is wired at all it throws
  `PolicyComposerRequiredError` (same class) instead of falling back to a provider call.
* `completePermission` activates ONLY when `recipient_policy_state` records an applied revision whose
  `applied_policy_id` the signer carries AND whose policy reads back rules hashing to
  `applied_rules_hash`. With no verified apply on record it fails closed — a pending row can never
  activate on the strength of its own stored id.
* `signer_enrollment_snapshot` is untouched (the retention path at `signer_enrollment_snapshot`
  is byte-identical; only the `provider_policy_id` column of the same INSERT became NULL).

### The fail-visible test (the structural guard)

`tests/integration/enrollment-composed.test.ts` → *"fails visibly instead of reporting an enrollment
with no policy attached"* asserts `preparePermission` REJECTS with a
`PolicyCompositionRefusalError`, that `createPolicy`/`addPolicyToSigner` were reachable and uncalled,
and that no `provider_policy_id` exists for the wallet. It fails the instant an edit lets enrollment
resolve while no policy is attached (see mutation A below).

### TDD cycle evidence (RED → GREEN → MUTATION)

| Phase | Evidence |
|---|---|
| RED | The new suite was authored against the new contract. Honest RED was produced by MUTATION rather than by the pre-edit tree (deliverable 1 had already edited the tree in `f0308cc`): each guard was removed and the attributed failure observed by name — see below. |
| GREEN | `npx vitest run tests/integration/enrollment-composed.test.ts` → **1 file passed, 3 tests passed** (363 ms). |
| MUTATION A (fail-visible guard, deliverable 2) | `throw new PolicyApplyCapabilityUnwiredError("enrollment")` → a fabricated `return { policyId: "pol_fabricated", … } as never`. Result: **2 failed / 1 passed (3)**: exactly *"records the enrollment intent through the service and creates no independent policy"* and *"fails visibly instead of reporting an enrollment with no policy attached"*. Restored from a pristine copy; re-run green. |
| MUTATION B (applied-revision guard, deliverable 3) | The whole `appliedPolicyRevision` gate → `const policyId = grant.provider_policy_id;` (the deleted behaviour). Result: **1 failed / 2 passed (3)**: exactly *"cannot activate a permission from a pending row whose id is not the applied revision"*. Restored; re-run green (`grep -c` confirms the throw and both `applied.applied_policy_id` reads are back). |

Positive control for the negative (mutation B) case: the same applied-revision gate is exercised in the
POSITIVE direction by the two rewritten `wallets-enrollment` cases *"complete binds exactly-one new
signer vs snapshot…"* and *"complete reuses the canonical stored signer id…"* (both seed
`recipient_policy_state` and assert `verified === true`), so the stale-id refusal is not passing
because a relation or row set is missing.

### Existing tests changed, and why (none deleted)

In `tests/integration/wallets-enrollment.test.ts`:

1. *"prepare creates the per-transfer provider policy and a pending grant (user-authorized scope)"* →
   *"prepare records no policy and fails visibly instead of reporting a permission nobody attached"*.
   The old case asserted exactly the removed behaviour (`createPolicy` called once, `prep.policyId`).
   The new case asserts the design's replacement: zero provider policy writes, a pending row with no
   policy id, and a typed `blocked_configuration` refusal. The `aggregationReady:false` /
   `aggregateBlockReason` intent has no subject left (there is no preparation payload), so it moved to
   the honest-reporting case *"reports a legacy active row honestly with the pending hourly limit"*,
   which still asserts `aggregationReady:false` + `aggregateOvershootCaveat:true`.
2. *"authenticated prepare endpoint activates enrollment with the pending hourly limit surfaced"* →
   *"authenticated prepare endpoint fails visibly instead of reporting an enabled enrollment"*: the
   route now returns `409 CONFLICTO_POLITICA` instead of `200 { policyId }`. Same route, same token,
   same no-secret assertion; the honest end state replaced the optimistic one.
3. *"prepare persists a durable signer snapshot on the pending grant"*: prepare now rejects, so the
   call is wrapped in `.rejects.toMatchObject({ failureClass: "blocked_configuration" })`; the snapshot
   assertion (the case's real intent) is unchanged, plus a new `provider_policy_id IS NULL` assertion.
   The `prep.perTransferSol` assertion has no subject left and is covered by the honest-reporting case.
4. *"prepare retry preserves the original snapshot and pending grant (restart-safe)"*: same wrapping on
   both prepare calls; the restart-safety assertion is unchanged.
5. *"complete binds exactly-one new signer vs snapshot and stores the canonical id"* and
6. *"complete reuses the canonical stored signer id when present after remote readback"*: these drove
   the OLD completion contract (activate on the pending row's id). They now seed the APPLIED revision
   (`insertAppliedPolicyState`) and configure the policy readback (`policyRules`), because that is what
   completion is verified against. The activation and "reuse never re-select" assertions are unchanged.
   The shared `mockServerClient` gained a `getPolicy` (previously the throwing `unused` stub) for the
   applied-rules readback.

All other completion cases (stale policy, ownership loss, provider failure, race, zero/multiple new
signers, missing policy readback) already asserted `verified:false` and stay green unchanged: with no
applied revision on record they now fail closed even earlier.

### Commands run and results

```text
# the unit's own suite
npx vitest run tests/integration/enrollment-composed.test.ts        → 3 passed (3)

# slice-1 regression (units 1.1-1.7 + 1.8a stay green)
npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
  → Test Files 11 passed (11) | Tests 194 passed (194)

# PRE-CHANGE CONTROL (recorded before any edit) and POST-CHANGE, SAME SET, by test name
npx vitest run tests/integration/wallets-enrollment.test.ts tests/integration/privy-policy-admin-migration.test.ts \
  tests/integration/wallets-sync.test.ts tests/unit/grants-policy-runtime.test.ts tests/unit/policy-provisioner-delegation.test.ts
  PRE  → Test Files 1 failed | 4 passed (5) | Tests 1 failed | 62 passed (63)
  POST → Test Files 1 failed | 4 passed (5) | Tests 1 failed | 62 passed (63)
  IDENTICAL BY TEST NAME. The ONLY failure in both runs is the pre-existing baseline failure
  `wallets-sync.test.ts > PEW-013: explicit activation with read-back; empty allowlist rejected (422)`
  (named in .agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md). No new failure.

# suites that reference the changed contract
npx vitest run tests/unit/wallet-chain-http.test.ts tests/unit/policy-composer.test.ts → 2 files, 34 passed

npm run lint      → eslint src tests --max-warnings=0 : clean, exit 0
npm run typecheck → tsc -p tsconfig.test.json --noEmit : clean, exit 0
```

### Workload / PR boundary

One commit, closing the task-1.8 work unit (deliverables 1–3): `solana-policy-provisioner.ts` +
`privy-policy-runtime.ts` + the new delegation suite (from `f0308cc`), plus `embedded.ts`,
`policy/service.ts`, `api/wallets.ts`, the new `enrollment-composed` suite and the 6 changed
`wallets-enrollment` cases. It sits inside the parent-assigned `PR 3` slice (tasks 1.7–1.11). No push,
no PR, and no work started on tasks 1.9–1.11.

### Deviations from design

1. **`errorReply` mapping added.** The design does not name an HTTP code for the legacy
   `/permission/prepare` route; a typed `blocked_configuration` stop would otherwise surface as a
   generic 500. It now maps to `409 CONFLICTO_POLITICA`.
2. **`EnrollmentPreparation` is now unreachable on the success path.** `preparePermission` always
   throws in this slice (no signed apply), so the response schema and `policyId` field remain declared
   but are never produced. Slice 2/3 replaces the enrollment surface with the mirrored recipient
   contract; the removed `perTransferSol`/`aggregationReady` preparation payload was re-homed to the
   honest-reporting case rather than dropped silently.
3. **The composer is injected, not built in place.** `EmbeddedWalletService` takes an optional
   `EnrollmentPolicyComposer`; `server.ts` does not wire one yet, so production `prepare` stops at
   `PolicyComposerRequiredError` (same `blocked_configuration` class). Wiring the real service is
   slice 2/3's job — the service is not constructed anywhere in production yet.

### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit, the
authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any edit — `tasks.md` (task 1.8, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §0 C1/C6, §3.3, §3.4, §3.5, and the prior 1.1–1.8 apply-progress. `actionContext`: all
writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout
(`/Users/ramiro/Desktop/projects/colloseum`) and the untracked `compose.privy-local.ports.yaml` were
not touched. No review, receipt or delivery gate was started.

### Task 1.9 — document and install the single lock order, prepending `W0` to the claim path

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `docs/architecture.md` | New §"Wallet policy lock order" (`+158`): the canonical vector, the two rules, the `W0`-before-`L1` cycle reasoning, the `LX` rule, the per-writer chains, claim-vs-removal, and where the `lease_reclaimed` audit belongs. |
| `src/wallet/grants/consumption.ts` | Modified (`+37/-1`). `claimConsumption` opens with a `recipient_policy_state … FOR SHARE` read in the `W0` slot, BEFORE its `dgc-grant` advisory lock (`L1`). Existing comments for that advisory now name the `L1` slot. No other statement, predicate or ordering changed. |
| `tests/unit/lock-order-vector.test.ts` | New (18 cases). Declarative order vector + source-position scan. |
| `tests/integration/lock-order-concurrency.test.ts` | New (4 cases). Real contention under two connections with per-transaction `statement_timeout`, plus its own falsification. |

#### The claim-path change, and what it deliberately is not

One added statement, prepended. It resolves the wallet through the caller's own
grant (`JOIN delegated_grants … WHERE grant_row.id = $1 AND grant_row.user_id = $2`),
so no new input, no widened signature and no new authority: RLS still scopes the
grant, and `FOR SHARE OF state` locks only the state row. The claim cannot be
pointed at another wallet.

**A missing `recipient_policy_state` row locks nothing and stays claimable.**
`SELECT … FOR SHARE` locks no row that does not exist, so a wallet with no policy
state behaves exactly as it did before this commit. That is intentional and is
pinned by a test: the read is a **lock, not yet a gate**. Deciding that an absent
or unverified row refuses the claim is task 2.11, and turning it into a refusal
here would have been a behaviour regression this task is forbidden to introduce.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (unit) | `tests/unit/lock-order-vector.test.ts` written first, run against the pre-change claim path (`git stash push src/wallet/grants/consumption.ts`): **3 failed / 15 passed**, all three failures `expected -1 to be greater than or equal to 0` — the `W0` read does not exist in the body. Honest RED: the failures are the missing position, not a missing fixture. |
| RED (concurrency) | `tests/integration/lock-order-concurrency.test.ts` run against the pre-change claim path (pre-fix file restored from `HEAD~1`): **2 failed / 2 passed**. The two failures are `the claim never blocked on recipient_policy_state … expected 0 to be greater than 0` for `claim ‖ apply` and `claim ‖ removal`; the pre-fix claim takes `L1`/`L2` (which do not conflict with a held `W0`) and returns while the other transaction holds `W0`, so the wait is never observed. The falsification case and the missing-row case pass on both trees, as they must. |
| GREEN | Post-change: 18/18 vector cases, 4/4 concurrency cases, `delegated-grants-consumption` + 6 sibling grant suites unchanged at 58/58. |
| TRIANGULATE | The harness is falsified **three** ways, not asserted once: (1) the pre-fix order is re-run inside the suite and must produce a real `40P01 deadlock detected` — if that case stops deadlocking, every "no 40P01" case above it is vacuous; (2) both claim cases require the claim to be *blocked on `recipient_policy_state`* while the other side holds ONLY `W0`, so a claim path without the prepend fails them (proven by the RED above); (3) the unit guard is falsified by mutation — moving the `W0` statement *below* the `L1` advisory lock (not deleting it) fails exactly two cases: the monotonicity check (`[L1, L2, W0]` is not sorted) and `opens the claim path with W0, before its advisory L1` (`expected 2031 to be less than 1887`). Each guard therefore has a demonstrated failing state. |
| REFACTOR | None needed. One added statement; no existing lock's order relative to another existing lock changed; `npm run lint` and `npm run typecheck` clean. |

#### How the concurrency test was proven able to detect a deadlock

`proves a pre-fix lock order really deadlocks (the harness detects 40P01)` writes
the PRE-FIX claim chain on purpose — `L1` advisory → `L2` grant row → *then* `W0`
— inverts it against the apply chain (`W0(U)` → `L2`) behind a two-party barrier,
and requires **exactly one** side to fail with `code === "40P01"` and
`"deadlock detected"`, while the survivor really commits. The chain is written in
the test on purpose rather than reached through the production path, because the
production path no longer contains the inverted order (that is the point of the
change) and a guard whose failing state cannot be produced is not a guard.
`statement_timeout` is 5 s and `deadlock_timeout` is the 1 s default, so the
deadlock is reported as `40P01` rather than as a timeout.

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/integration/delegated-grants-consumption.test.ts tests/integration/delegated-grant-execution.test.ts tests/integration/grant-claim-release.test.ts tests/integration/delegated-grant-candidates.test.ts tests/integration/nani-grant-creation.test.ts tests/integration/delegated-grants-schema.test.ts tests/unit/grants-engine.test.ts` (BEFORE the change) | **7 files passed, 58 tests passed** |
| same command (AFTER the change) | **7 files passed, 58 tests passed** — identical by file and by test name, no new failure, no changed failure |
| `npx vitest run tests/unit/lock-order-vector.test.ts` (RED, pre-change) | 3 failed / 15 passed |
| `npx vitest run tests/unit/lock-order-vector.test.ts` (moved `W0` below `L1`) | 2 failed / 16 passed |
| `npx vitest run tests/integration/lock-order-concurrency.test.ts` (RED, pre-change) | 2 failed / 2 passed |
| `npx vitest run tests/unit/lock-order-vector.test.ts tests/integration/lock-order-concurrency.test.ts` | **2 files passed, 22 tests passed** |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` | **11 files passed, 194 tests passed** (1.1–1.8 unchanged) |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`) |

**Existing tests changed by this unit: NONE.** No existing suite, case, assertion
or fixture was edited; the new suites were added beside them. The pre-existing
backend failures named by the parent (`api-voice-auth`,
`conversation-preview-claim-race`, `wallets-sync`, `realtime-agent-session`,
`realtime-tool-binding`, `realtime-tools`) were not touched and are outside this
suite set, which is green on both sides of the change.

#### Deviations from the design and from the task text

1. **The `lease_reclaimed` audit is NOT added here, and must not be.** Design §5.2
   step 3 places it in the reconciler's restart-recovery branch (the intent row
   whose lease holder expired), not in the claim path — the claim path holds no
   lease and no intent. Task 1.9's wording ("audit `lease_reclaimed` where §5.2
   step 3 requires it") is therefore satisfied by recording the requirement where
   the design requires it: `docs/architecture.md` §"Where the `lease_reclaimed`
   audit belongs" states the site, and states the prerequisite slice 2 owes — the
   table `recipient_policy_audit` is owner-only, so an append from the reconciler's
   anonymous system transaction is RLS-denied until a matching system-access
   policy is added deliberately. That carried-over note (1.1, 1.2, 1.3) stands
   unchanged; adding the authority pre-emptively would be design drift, and
   implementing reconciler code inside a lock-ordering task would violate the
   unit's own "changes lock ordering ONLY" constraint.
2. **`tests/integration/grant-consumption.test.ts` (named in the task's verify
   line) does not exist.** The claim suite is
   `tests/integration/delegated-grants-consumption.test.ts`; it was run as the
   control, together with every other grant/consumption/concurrency suite found
   by `find tests/integration tests/unit -iname '*grant*' -o -iname '*consumption*'`.
3. **The `apply` side of `claim ‖ apply` is the §1.3 apply chain, not the apply
   service.** Slice 1 ships no apply orchestration (task 2.8 supplies it), so the
   case drives `W0(U) → L2` through `RecipientPolicyRepository` — the same
   statements the apply transaction will take, in the same order. Recorded rather
   than hidden: when 2.8 lands, this case should be re-pointed at the real
   orchestrator.
4. **The vector test records three measured chains that differ from design §1.3**
   and says so in the source: `settleGrantReservation` takes only `L1` (its CAS
   locks `conversation_transfer_attempts`, not `delegated_grants`);
   `getGrant` takes **no** lock at all, contradicting §1.1's row for it; and
   `create`/`edit` do not take `W1` today (§1.3 lists it as pending, and the
   removal's abort-and-retry guard exists for exactly that reason). The declared
   chains assert what the code does, and the design's intent is listed as
   `pending` so it cannot be silently dropped.
5. **`W0` is resolved through the grant, in one statement.** The alternative — a
   new `walletId` parameter on `claimConsumption` — would have changed a
   money-path signature and every call site for a lock. The join keeps the diff at
   one statement and keeps the wallet binding server-side.

#### Process incident recorded (not a code defect)

While producing the RED evidence I ran `git stash push -- src/wallet/grants/consumption.ts`
on a tree that had **no** local change for that file, so the push was a no-op and
the following `git stash pop` popped an **unrelated** stash that belongs to another
worktree's history (`On slice2-provider-solana-devnet: slice2-recovery-protect-five`),
leaving four unrelated files with conflict markers in the index. It was fully
reverted with `git reset` (index only) plus `git checkout HEAD --` on the four
files; `git status --porcelain` is now empty apart from the two pre-existing
untracked files, and all three unrelated stash entries are **still present and
unmodified**. The RED evidence above was re-taken correctly afterwards by writing
the pre-fix file from `HEAD~1` and restoring it from `HEAD`. No commit, no
published state and no stash entry was lost.

#### Remaining tasks in slice 1

```text
- [ ] **1.10 Extend the structural guard suite to make a second full-rule writer unreachable by construction.**
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` (lines 172-173) were left byte-for-byte
untouched — both still carry `<!-- sdd-owner: parent -->` and remain unchecked —
and no bounded review, receipt, refutation, correction or delivery gate was started
by this phase.

#### Workload / PR boundary

One commit, one work unit: `docs/architecture.md` (`+158`),
`src/wallet/grants/consumption.ts` (`+37/-1`), plus the two new suites (18 + 4
cases, ~700 lines of authored test/doc text). The doc is the deliverable's first
half — it is what stops the next writer from reintroducing the cycle — and
`gentle-ai-work-unit-commits` forbids shrinking it. It sits inside the
parent-assigned `PR 3` slice (tasks 1.7–1.11, rollback boundary `embedded.ts`,
grants provisioner/runtime, `consumption.ts`, docs), needs no migration change, and
no `size:exception` is requested.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the
resolved work unit, the authoritative artifact paths (including
`apply-progress.md`) and the delivery path directly. Readiness was resolved against
the artifacts before any edit — `tasks.md` (task 1.9, terminal
`<!-- sdd-owner: implementation -->`), `design.md` §1.1/§1.2/§1.3/§1.7, §5.2, §12.1,
the 1.1–1.8 apply-progress entries, and the source of every writer named in §1.1.
`actionContext`: all writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main
checkout and the untracked `compose.privy-local.ports.yaml` were not touched. Task
1.10 was not started, and no push and no PR happened.
