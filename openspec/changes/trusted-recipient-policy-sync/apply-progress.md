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
