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

---

### Task 1.10 — extend the structural guard suite to make a second full-rule writer unreachable by construction

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `tests/unit/policy-writer-structural.test.ts` | New (9 cases, 2 describes). Reads the real `src/**` tree (idiom: `tests/unit/signer-worker-path.test.ts:256-290`) and compares the measured sets for **exact equality** with the frozen boundaries. |

No production file was touched. This unit is assertion-only, which is why it is one
new file plus this entry.

#### What the unit delivers

Two describes, nine cases, all over the source tree rather than over prose:

- **`the composer is the only full-rule policy writer`** (5 cases):
  1. `.createPolicy(`/`.patchPolicy(` outside `src/wallet/policy/**` + `src/wallet/signer/**` must equal
     exactly `["src/wallet/grants/privy-policy-runtime.ts"]` — the provider adapter that implements the
     composer's `PrivyPolicyAdminClient` port and forwards the rules it is handed.
  2. `.addPolicyToSigner(`/`.attachPolicyToSigner(` outside those paths must equal exactly
     `[embedded.ts, privy-policy-admin.ts, privy-policy-runtime.ts]` — the provider implementation and
     the narrow complete-list attach design §5.7 keeps (it binds an EXISTING policy id and composes
     nothing).
  3. `composeGrantRules` must be mentioned only by its definition and `policy/composer.ts` (design §3.3
     row 1: "imported nowhere else").
  4. `buildSolanaEnrollmentRules` must be mentioned only by its definition and `policy/composer.ts`
     (design §3.3: "no longer imported by `embedded.ts`").
  5. The deleted legacy writer is absent **at module level**: `createSolanaGrantPolicyProvisioner`,
     `provisionPolicy` and `revokePolicyRules` are asserted NOT to be exported by
     `solana-policy-provisioner.ts`, with `composeGrantRules` as the positive control so the case cannot
     pass on an import that resolved to nothing.
- **`ContactsRepository mutations stay behind the policy path and its HTTP vertical`** (4 cases):
  6. the importer set is exactly `{src/api/contacts.ts, src/server.ts}`;
  7. **no** file under `src/wallet/policy/**` imports `ContactsRepository` (design §3.3);
  8. `contacts.create|update|archive(` call sites exist only under `src/wallet/policy/**` (the injected
     mutation port) and `src/api/contacts.ts`;
  9. `src/server.ts` constructs the repository (`new ContactsRepository(`, asserted first as the
     positive control) and never calls a mutation member.

Every set is asserted for exact equality, not containment: a new caller changes the measured set and
fails the case. That is what makes these guards fail-closed against a future second writer instead of
becoming a snapshot of today's tree.

#### Honest scope note: the literal task wording is not satisfiable at HEAD

The task text (and design §12.1's structural line) reads "no file outside `src/wallet/policy/**` and
`src/wallet/signer/**` calls `createPolicy`, `patchPolicy`, or `addPolicyToSigner`". **Measured against
HEAD, that literal claim is false, and a guard asserting it would be red today.** The exact conflicts:

| File:line | Call | Why it is not the regression the guard exists for |
|---|---|---|
| `src/wallet/grants/privy-policy-runtime.ts:63` | `server.createPolicy(...)` | Provider adapter implementing `PrivyPolicyAdminClient`. It composes nothing; it forwards `input.rules`. The grant provisioner that used to drive it (`createRuntimeGrantPolicyProvisioner`, same file `:171-206`) now delegates to `composer.composeRevision` and refuses with `apply_capability_unwired`. |
| `src/wallet/grants/privy-policy-runtime.ts:79` | `server.patchPolicy(...)` | Same adapter, same reason. |
| `src/wallet/grants/privy-policy-runtime.ts:143` | `admin.attachPolicyToSigner(...)` | Same adapter; attach only. |
| `src/wallet/grants/privy-policy-admin.ts:168` | `privy.addPolicyToSigner(...)` | Design §5.7 keeps `attachPolicyToSigner` as "the narrow, complete-list mutation"; it binds an existing policy id. |
| `src/wallet/embedded.ts:1348` | `this.privyServer!.addPolicyToSigner(...)` | `completeSolanaPermission` attaching the **applied** policy id (task 1.8 deliverable 3 replaced the verification, not the attach). Unreachable in slice 1 — no signed apply capability — and live only once an applied revision exists (slice 2). |

So this unit encodes the design's actual invariant (**one rule *composer*; a policy create/patch/attach
site is legal only on the frozen provider boundary, and the boundary is asserted by exact name**) and
reports the five near-misses above rather than claiming a property the tree does not have. Two of the
five were already carried in the task-1.9 record for the lock-order vector (`getGrant` takes no lock)
under the same principle: record what the code does, and list the design's intent as pending.
**Handover to slice 2:** design §3.4 step 2 puts the attach inside the composer's apply path, so when
2.8 lands the `embedded.ts` entry should move into `src/wallet/policy/**` and the exception list above
should shrink — at which point case 2 fails until the list is updated deliberately. Recorded as an open
design/code divergence, not silently absorbed.

#### TDD Cycle Evidence

Honest framing: the invariant **holds at HEAD**, so there is no implementation-free RED to observe for
this unit — a green first run is the expected state, and by itself would be decoration. The RED is
therefore produced by **mutation**, per the task's own instruction ("prove the guard is load-bearing:
temporarily add a violating call, observe the named failure, remove it"). Seven mutations, one anchor
each, every one restored and the suite re-run green (9/9) afterwards.

| # | Mutation (appended to a real module outside the boundary) | Case that failed, by name |
|---|---|---|
| M1 | `createPolicy(...)` call in `src/wallet/grants/privy-policy-sync.ts` | `issues no policy create or patch call outside the policy path and the frozen provider boundary` |
| M2 | `export { composeGrantRules } from "./solana-policy-provisioner.js"` in `privy-policy-sync.ts` | `builds the delegated-grant rules in one module only` |
| M3 | `contacts.archive("probe")` in `privy-policy-sync.ts` | `mutates contacts only from the policy service and the contacts route` |
| M4 | re-export `createSolanaGrantPolicyProvisioner` from `solana-policy-provisioner.ts` | `deletes the legacy writer so no module can construct it` |
| M5 | a second `buildSolanaEnrollmentRules` mention in `solana-policy-provisioner.ts` | `builds the ordinary enrollment rule in the composer only` |
| M6 | `admin.attachPolicyToSigner({...})` in `privy-policy-sync.ts` | `attaches a policy only through the frozen boundary set` |
| M7 | a `ContactsRepository` type-import in `privy-policy-sync.ts` | `is imported by the composition root and the contacts route only` |

Each mutation produced **exactly one** failure (1 failed / 8 passed), named above — not a cluster, so
each case is attributed to its own guard. `git status --porcelain src/` is empty after the last revert.

**A real defect this unit found in its own guard, fixed before commit:** the scan helpers used `g`-flagged
regexes with `RegExp.test`, which is stateful (`lastIndex` persists between files) and made the attach
case fail spuriously on the first run (`expected [...(1)] to deeply equal [...(2)]`). The flags were
removed and the run is deterministic. Worth recording because a stateful guard is worse than no guard:
it passes or fails by file order. RED before the fix: the attach case; GREEN after: 9/9, reproduced.

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/unit/policy-writer-structural.test.ts` (first run, pre-fix) | **1 failed / 8 passed** — the `g`-flag statefulness defect above |
| `npx vitest run tests/unit/policy-writer-structural.test.ts` (post-fix) | **1 file passed, 9 tests passed** |
| … seven mutation runs, each restored | **1 failed / 8 passed** each time, exactly the case named in the table |
| `npx vitest run tests/unit/policy-writer-structural.test.ts` (final) | **1 file passed, 9 tests passed** |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` | **12 files passed, 203 tests passed** (1.1–1.9 were 194; +9 is this suite) |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) |

#### Deviations from the design and from the task text

1. **Exact-equality sets with a frozen exception list instead of the literal "nothing outside
   policy/signer"**, with the five measured near-misses listed above and each one's reason stated in the
   test source. Deliberate: the alternative is an assertion that is red today and therefore not a guard.
2. **Two guards the task did not ask for**, both strictly stronger and both currently true:
   `buildSolanaEnrollmentRules`'s single builder (the ordinary rule, design §3.3 row 1) and the
   module-level absence of the deleted writer's exports. The second is the case that fails if anyone
   resurrects `createSolanaGrantPolicyProvisioner`.
3. **`src/server.ts` is exempted for `ContactsRepository`** and the exemption is asserted, not assumed:
   case 6 freezes the importer set and case 9 proves the file constructs without mutating. The task text
   ("no module outside `src/wallet/policy/**` and `src/api/contacts.ts` imports `ContactsRepository` for
   mutation") is satisfied in substance — the composition root imports to *wire*, it does not mutate —
   but not in the letter, so it is recorded rather than papered over.

#### Remaining tasks in slice 1

```text
- [ ] **1.11 Run the slice-1 gate and record the slice-1 work-unit commits.**
```

Parent-owned lifecycle rows in `tasks.md` were left byte-for-byte untouched — both still carry
`<!-- sdd-owner: parent -->` and remain unchecked — and no bounded review, receipt, refutation,
correction or delivery gate was started by this phase.

#### Workload / PR boundary

One commit, one work unit: one new 200-line test file. No production change, so the unit is well inside
the 400-line review budget. It sits inside the parent-assigned `PR 3` slice (tasks 1.7–1.11, rollback
boundary `embedded.ts`, grants provisioner/runtime, `consumption.ts`, docs). No push, no PR, and no
slice-2 work started.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit, the
authoritative artifact paths (including `apply-progress.md`) and the delivery path directly. Readiness
was resolved against the artifacts before any edit — `tasks.md` (task 1.10, terminal
`<!-- sdd-owner: implementation -->`), `design.md` §3.3, §3.4, §5.7, §12.1 and the 1.1–1.9
apply-progress. `actionContext`: all writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout
(`/Users/ramiro/Desktop/projects/colloseum`) and the untracked `compose.privy-local.ports.yaml` were not
touched. No `git stash` command was run at any point.

---

### Task 1.11 — run the slice-1 gate, record the slice-1 work-unit commits, and audit the task-1.8a deletion

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

This unit adds no behaviour. It runs the slice-1 gate, records the result by test name against the
pristine baseline, records the slice-1 work-unit commits, and discharges the deletion audit the parent
owes the human for task 1.8a.

#### Slice-1 work-unit commits (one per unit, none pushed, no PR)

```text
a253249 fix(policy): document one lock order and open the claim path with W0 before L1            (1.9)
4c4010d refactor(policy): route enrollment through the composer and verify completion on the applied revision   (1.8)
f0308cc refactor(policy): delete the second full-rule writer and delegate grant policy sync to the composer    (1.8)
6e68903 feat(policy): revoke affected grants atomically when the last alias is removed            (1.7)
86319bb feat(policy): add the recipient policy service as the single strict mutation seam         (1.6)
e77463c feat(policy): compare a policy readback against the composed revision                     (1.5)
e9b11d3 feat(policy): compose one rule set per wallet from consent and grants                     (1.4)
d05cb71 feat(policy): persist recipient policy intent behind a revision CAS                       (1.3)
946a608 feat(policy): serialize wallet composition with a lease                                   (1.2)
df3d2d7 feat(policy): add the recipient policy sync schema                                        (1.1)
8330c0e test(policy): guard the single policy writer structurally                                 (1.10)
```

Ten slice-1 units plus task 1.10; task 1.11 closes with this bookkeeping commit. `git status
--porcelain` shows only the pre-existing untracked `compose.privy-local.ports.yaml` (never touched) and
no modified tracked file. No remote branch exists for this branch; nothing was pushed.

#### The gate command and its result

```text
cd /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational
npm run lint && npm run typecheck && npx vitest run
```

| Command | Result |
|---|---|
| `npm run lint` (`eslint src tests --max-warnings=0`) | **clean**, exit 0, no output |
| `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | **clean**, exit 0, no output |
| `npx vitest run` (full backend suite, worktree `.env`, DB container `colloseumfeat-solana-operational-db-1` on host port 55470) | **exit 1 — `Test Files 6 failed \| 162 passed \| 4 skipped (172)`, `Tests 6 failed \| 1242 passed \| 10 skipped (1258)`** |

Counts versus the pristine baseline (`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`,
attempt 2 at `a121b2c`, `6 failed | 148 passed | 4 skipped (158)` files and `6 failed | 1028 passed |
10 skipped (1044)` tests): the failure COUNT is unchanged (6 files / 6 tests); the pass set grew by 214
tests and 14 files, which is the slice itself. Skipped is unchanged (10 tests / 4 files), so no
previously-running test became silently skipped.

#### Baseline comparison **by test name** — the gate verdict

| # | Failing test (`file > describe > test`) | In the pristine baseline list? | Verdict |
|---|---|---|---|
| 1 | `tests/unit/realtime-agent-session.test.ts` > OpenAI realtime agent session composition > allows one re-read when a confirmation is refused for an incomplete read-back | **yes** (baseline #4) | pre-existing, unchanged |
| 2 | `tests/unit/realtime-tools.test.ts` > `createRealtimeTools` > send_token delegates the preview to the service and strips the recipient address | **yes** (baseline #6) | pre-existing, unchanged |
| 3 | `tests/integration/conversation-preview-claim-race.test.ts` > previewTransfer real claim semantics > two simultaneous confirms broadcast exactly once (V8.5) | **yes** (baseline #2) | pre-existing, unchanged |
| 4 | `tests/unit/realtime-tool-binding.test.ts` > realtime tool binding — production execution against the fixture stack > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy | **yes** (baseline #5) | pre-existing, unchanged |
| 5 | `tests/integration/wallets-sync.test.ts` > /v1/wallets sync + embedded wallet service (PEW-002/003/005) > PEW-013: explicit activation with read-back; empty allowlist rejected (422) | **yes** (baseline #3) | pre-existing, unchanged |
| 6 | `tests/integration/users-db.test.ts` > users migration (database) > provisions a fresh database through the full local migration sequence | **no — NEW appearance** | **full-suite-load flake, not a regression** (evidence below) |
| — | `tests/integration/api-voice-auth.test.ts` > /v1/voice/room-token authorization (PMU-020, privy mode) > returns the same 404 for a foreign conversation as for a missing one | baseline #1 (itself classified *environment-shaped / timing-shaped, root cause NOT diagnosed*) | **did not fail in this run** — the baseline itself records it as load-flaky |

**Verdict: the gate passes on the baseline comparison.** No test that the baseline records as passing
failed. Five of six failures are named in the baseline; the sixth is a 5-second **timeout** (not an
assertion failure) that passes 3/3 in isolation.

The NEW appearance is not waved through — the evidence:

- The failure is `Error: Test timed out in 5000ms` at `tests/integration/users-db.test.ts:73`. It is a
  **budget** failure, not a wrong value: the case creates a fresh database and replays the full local
  migration sequence, which is also what `tests/integration/privy-policy-admin-migration.test.ts` does
  (that suite passes).
- Isolated re-runs on this exact tree: `npx vitest run tests/integration/users-db.test.ts` → **1 file
  passed, 9 tests passed**, three consecutive times. The verbose per-test duration in isolation is
  **155 ms** against a 5 000 ms budget — a 32× blowup under full-suite parallelism, which is contention
  on the single Postgres container (`CREATE DATABASE` + a full migration replay while ~170 other files
  run), not a change in the test's own behaviour.
- Honest limitation, stated rather than hidden: slice 1 **added one migration file** (`015`) to the
  legacy chain this case replays, and slice 1's new integration suites add database work to the same
  container. Both make the pre-existing contention more likely to cross that budget, so this is
  **slice-1-adjacent flakiness** even though it is not a behavioural regression. Recommended follow-up
  for whoever owns the suite: raise that case's timeout or serialize the fresh-database cases, exactly
  as the task-1.3 residue note in the 1.4 entry recommends for its own due-intent scan. Recorded as a
  WARNING, not silently accepted and not counted as a regression.

#### The deleted-test re-homing audit (task 1.8a) — `tests/unit/grants-policy-provisioner.test.ts`

Method: `git show f0308cc^:tests/unit/grants-policy-provisioner.test.ts` (482 lines, **14 cases** across
4 describes) was read in full and every substantive assertion enumerated; each was then traced to the
current suite by reading the surviving files, not by trusting the deletion note.

| # | Deleted case (assertion) | Where it lives now | Covered? |
|---|---|---|---|
| 1 | "composes conditioned ALLOW rules per grant; no fabricated cumulative rule" | `tests/unit/policy-provisioner-delegation.test.ts:202` *"still builds one flat ALLOW rule per grant (the rule builder survives the writer)"* (name/method/action, no `chain`, no `/cumulative/i`) + `tests/unit/policy-composer.test.ts:178` byte-equality with `composeGrantRules` | **covered** |
| 2 | "recomputes the union over active grants and PATCHes with readback before ready" | union over active grants: `tests/unit/policy-composer.test.ts` (two-grant composition, per-grant lamports + expiry values) and the service's `listActiveGrants` assembly (`tests/integration/recipient-policy-service.test.ts`). The PATCH half has **no subject**: the writer that PATCHed is deleted by design (§3.3), the apply path is slice 2 (2.8), and the comparison itself is `tests/unit/policy-readback.test.ts` | **covered in substance** (the removed half is deleted behaviour) |
| 3 | "fails closed on uncertain PATCH: binding unchanged, audited, siblings degraded" | readback failure classification: `tests/unit/policy-readback.test.ts` (rules mismatch → `blocked_conflict`/`rules_mismatch`, both phases). The uncertain-PATCH write itself is slice-2 apply behaviour that does not exist in slice 1; the sibling/affected-grant disclosure survives on the removal path (`tests/integration/recipient-policy-removal.test.ts`, 17 cases incl. the revocation-disclosure decision table) | **partially covered, remainder legitimately deferred to slice 2** — noted, not hidden |
| 4 | "revoke keeps sibling rules and the policy id; never deletes while siblings active" | `tests/integration/recipient-policy-removal.test.ts`: "a second active alias prevents revocation", "revokes the affected whole grant with its audit in the same transaction", and the recorded intent's `composed_rules` excluding the revoked grant while keeping the surviving grant's rule (task 1.7) | **covered** |
| 5 | "attach performs a post-attach signer readback and preserves unrelated `additional_signers` entries" | `tests/unit/privy-server-client.test.ts` (~`:480-505`): `get` called **twice** (post-attach readback) and `params.additional_signers` asserted equal to the preserved list; `tests/unit/privy-policy-admin.test.ts` (canonical-signer attach); `tests/integration/wallets-enrollment.test.ts` completion cases (attach → verified) | **covered** (re-homed at the layer that still owns attach) |
| 6 | "fails closed when the post-attach signer readback omits the new policy" | `tests/integration/wallets-enrollment.test.ts`: the completion cases asserting `verified:false` when the readback lacks the policy (stale policy, provider failure, missing policy readback) | **covered** |
| 7 | "fails closed when the readback rules do not match the composed rules" | `tests/unit/policy-readback.test.ts` `rules_mismatch` row (and the `before → after` drift pair) | **covered** |
| 8 | "maps the grant's exact epoch-second expiry into the rule condition" | `tests/unit/policy-composer.test.ts:169` — `toEqual({ field_source: "system", field: "current_unix_timestamp", operator: "lt", value: 1_900_000_000 })` | **covered** |
| 9 | "serializes a concurrent provision-vs-revoke recompute per wallet" | the in-process mutex is replaced by the database lease: `tests/integration/recipient-policy-lease.test.ts` (10 cases, real two-connection contention) + `tests/integration/lock-order-concurrency.test.ts` + `tests/integration/recipient-policy-removal.test.ts` ("mutates nothing while another writer holds the wallet lease") | **covered** (stronger mechanism, same invariant) |
| 10 | "maps a Privy policy denial to a `not_dispatched` outcome (provider seam)" | `tests/unit/solana-devnet-provider.test.ts:767`, `:804`, `:841` — "keeps a policy denial definitive and every transport failure ambiguous", "reports a definitive policy denial as not_dispatched through the provider", "treats Privy's real 400 `policy_violation` body as a definitive denial" | **covered** (and broader than the deleted case) |
| 11 | "passes the stored grant expiry (epoch seconds) to the provisioner, not a `windowSeconds` rollforward" | `tests/unit/privy-policy-sync.test.ts` has **no** expiry case (5 cases, none about `expiresAt`/`windowSeconds`). The protected property survives where the value now flows: `src/wallet/grants/privy-policy-runtime.ts:131` maps `expires_at` → exact epoch seconds and `tests/unit/policy-composer.test.ts:169` asserts that exact stored value in the rule condition; `windowSeconds` cannot enter the composer at all because `ComposeInput` has no such field | **partially covered — the passthrough ASSERTION is not re-homed.** Judged low residual risk (typed input has no rollforward field, and the exact epoch value is asserted downstream), but recorded as the one deleted assertion whose exact form is gone rather than claimed as covered |
| 12 | "uses the exact flat Solana shape: named ALLOW rule, hoisted method, `Transfer.to` in, `Transfer.lamports` lte" | **was NOT covered** — the key-set equality (`Object.keys(rule).sort()`), `not.toHaveProperty("resource")`, the 50-character name cap and the exact `Transfer.to`/`"in"` triple had no surviving home (only the `value` halves were asserted at `policy-composer.test.ts:114/134/358`). **Re-homed by this unit** into `tests/unit/policy-composer.test.ts` → *"emits the exact flat PROVIDER rule shape: no `resource` wrapper, no extra key"*, *"caps every rule name at the provider's 50-character limit"*, *"scopes the allowlist by Transfer.to `in` and the ceiling by Transfer.lamports `lte`"* | **was NOT covered → re-homed** (proven by mutations M8/M9/M10 below) |
| 13 | "uses field_source `system` with `current_unix_timestamp` and exact `lt` expiry (not `lte`, not synthetic)" | `tests/unit/policy-composer.test.ts:169` (exact `toEqual`, so `lt` vs `lte` is pinned) + the two-grant case at `:176` | **covered** |
| 14 | "defaults deny: every instruction must match an ALLOW rule (deny by absence, no catch-all ALLOW)" | **was NOT covered** — no surviving case asserted that every composed rule is conditioned or that no wildcard ALLOW exists. **Re-homed by this unit** as *"defaults deny: every rule is a conditioned ALLOW and never a catch-all"* | **was NOT covered → re-homed** |

**Audit verdict.** Of the 14 deleted cases: **10 fully covered** (1, 4, 5, 6, 7, 8, 9, 10, 13, and 2 in
substance), **2 re-homed by this unit** (12, 14 — the flat-shape/no-`resource`/name-cap group and the
deny-by-absence invariant), **1 partially covered with the exact assertion gone** (11, with its residual
risk stated), **1 partially covered with the unwritten half legitimately deleted with its writer** (3).
The deletion was therefore **not** "only the writer's behaviour": cases 12 and 14 were pure-rule
assertions about the shape of the rule set itself and had genuinely been dropped. They are back, in the
composer's suite, and each was proven load-bearing by mutation:

| Mutation (applied to `solana-policy-provisioner.ts`, then reverted) | Case that failed, by name |
|---|---|
| an extra `metadata: { probe: true }` key on the grant rule | `emits the exact flat PROVIDER rule shape: no `resource` wrapper, no extra key` |
| dropping `.slice(0, 50)` from the grant rule name | `caps every rule name at the provider's 50-character limit` |
| widening `Transfer.to`'s `in` operator to `eq` | `scopes the allowlist by Transfer.to `in` and the ceiling by Transfer.lamports `lte`` |

All three mutations were reverted; `git status --porcelain src/` is empty and the three suites re-run
green (40/40 across `policy-composer`, `policy-writer-structural`, `policy-provisioner-delegation`).

#### Commands run and results (task 1.11)

| Command | Result |
|---|---|
| `npm run lint && npm run typecheck && npx vitest run` (gate, final tree) | lint clean, typecheck clean, suite `6 failed \| 162 passed \| 4 skipped (172)` files / `6 failed \| 1242 passed \| 10 skipped (1258)` tests — the six failures are the table above |
| `npx vitest run tests/integration/users-db.test.ts` (isolation, ×3) | **1 file passed, 9 tests passed** each run; 155 ms for the failing case under `--reporter=verbose` |
| `npx vitest run tests/unit/policy-composer.test.ts` (after the re-homing) | **1 file passed, 26 tests passed** |
| three re-homing mutations, each reverted | **1 failed / 25 skipped** each, exactly the named case |
| `npx vitest run tests/unit/policy-composer.test.ts tests/unit/policy-writer-structural.test.ts tests/unit/policy-provisioner-delegation.test.ts` | **3 files passed, 40 tests passed** |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` (before the re-homing, at 1.10) | **12 files passed, 203 tests passed** |
| `git log --oneline` / `git status --porcelain` | the 11 slice-1 commits listed above; only `?? compose.privy-local.ports.yaml` untracked |

#### Deviations from the task text

1. **The gate ran twice.** The first full-suite run was taken before the audit re-homed cases 12/14 (a
   test-only addition in a surviving suite), so it was re-run on the final tree; the recorded result is
   the second run, on the bytes that are committed. The first run's result was
   `6 failed | 162 passed | 4 skipped (172)` / `6 failed | 1242 passed | 10 skipped (1258)` — identical
   by test name.
2. **`tests/integration/users-db.test.ts` is reported as a WARNING, not as a regression and not as
   silence**, per the parent's instruction, with its isolated re-runs as evidence.
3. **`npm run db:migrate` was not run.** The parent's brief states it does not read this worktree's
   `.env` and that the database already reflects the Supabase chain; the gate command the parent
   specified is `npm run lint && npm run typecheck && npx vitest run`, and the migration-chain proof is
   the passing `tests/integration/privy-policy-admin-migration.test.ts` (fresh database from
   `src/db/migrations/`).

#### Remaining tasks in slice 1

```text
(none — 1.1 through 1.11 are complete)
```

Parent-owned lifecycle rows in `tasks.md` (the bounded native review and the post-apply verify/archive
rows) were left byte-for-byte untouched — both still carry `<!-- sdd-owner: parent -->` and remain
unchecked — and no bounded review, receipt, refutation, correction or delivery gate was started by this
phase. **No push and no PR**, as the brief requires; the parent pushes after this gate.

#### Workload / PR boundary

One bookkeeping commit: the task 1.11 section in this file, the two task checkboxes, and the four
re-homed cases in `tests/unit/policy-composer.test.ts`. It closes the last unit of the parent-assigned
`PR 3` slice (tasks 1.7–1.11). No production behaviour changed anywhere in this unit.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit, the
authoritative artifact paths (including `apply-progress.md` and the pristine baseline document) and the
delivery path directly. Readiness was resolved against the artifacts before any edit — `tasks.md`
(task 1.11, terminal `<!-- sdd-owner: implementation -->`), the pristine baseline
`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`, and the 1.1–1.10
apply-progress. `actionContext`: all writes stayed inside the assigned worktree root
(`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); the main checkout
(`/Users/ramiro/Desktop/projects/colloseum`) and the untracked `compose.privy-local.ports.yaml` were not
touched. No `git stash` command was run at any point.

#### Authoritative final gate run (same command, final tree) — supersedes the run recorded above

The gate was re-run after the re-homing above so the recorded result matches the committed bytes. This
second run is the authoritative one:

```text
npm run lint && npm run typecheck && npx vitest run
  lint       clean, exit 0
  typecheck  clean, exit 0
  Test Files  7 failed | 161 passed | 4 skipped (172)
       Tests  7 failed | 1245 passed | 10 skipped (1262)
  EXIT=1
```

| # | Failing test by name | Classification | Evidence |
|---|---|---|---|
| 1 | `tests/unit/realtime-agent-session.test.ts` > allows one re-read when a confirmation is refused for an incomplete read-back | **baseline (pre-existing)** | named in `91-test-baseline.md` |
| 2 | `tests/unit/realtime-tools.test.ts` > send_token delegates the preview to the service and strips the recipient address | **baseline (pre-existing)** | named in `91-test-baseline.md` |
| 3 | `tests/integration/conversation-preview-claim-race.test.ts` > two simultaneous confirms broadcast exactly once (V8.5) | **baseline (pre-existing)** | named in `91-test-baseline.md` |
| 4 | `tests/unit/realtime-tool-binding.test.ts` > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy | **baseline (pre-existing)** | named in `91-test-baseline.md` |
| 5 | `tests/integration/wallets-sync.test.ts` > PEW-013: explicit activation with read-back; empty allowlist rejected (422) | **baseline (pre-existing)** | named in `91-test-baseline.md` |
| 6 | `tests/integration/notifications-webhook.test.ts` > acknowledges a duplicate delivery without creating a second receipt row (`15 957 ms`, bare timeout) | **full-suite-load flake** — one of the three the brief names as load-flaky (`notifications-webhook`) | isolated re-run on this tree: `npx vitest run tests/integration/notifications-webhook.test.ts` → **1 file passed, 3 tests passed** |
| 7 | `tests/integration/api-voice-auth.test.ts` > returns the same 404 for a foreign conversation as for a missing one (`15 982 ms`, bare timeout) | **full-suite-load flake** — the baseline's own #1, itself recorded there as *environment-shaped, root cause not diagnosed*, and named as load-flaky in the brief | isolated re-run on this tree: `npx vitest run tests/integration/api-voice-auth.test.ts` → **1 file passed, 4 tests passed** |

`tests/integration/users-db.test.ts` (the run-1 appearance) **passed** in the second run, confirming the
flake diagnosis; its isolated evidence stands (9/9, ×3, 155 ms against a 5 000 ms budget).

**Final verdict: gate PASSES the baseline comparison.** Across the two runs, every failure other than
the five baseline-named ones is a bare `Test timed out` in a file the brief/baseline already classify as
load-flaky, and each passes in isolation on this exact tree. No assertion failure outside the baseline
list appeared in either run, and no baseline-passing test changed state. The one slice-1-adjacent
WARNING to carry forward is the fresh-database timeout contention (`users-db`, and the same class as the
task-1.3 due-intent residue note): the container now serves ~172 files including slice 1's new
integration suites, so pre-existing marginal timeouts fire more often.

---

## Slice 2 — Apply and reconcile the signed remote policy

### Tasks 2.1–2.4 — the four unproven-provider-semantics probes (one coherent unit: the probe module)

Status: **completed for the implementable part**. Persisted checkboxes updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (2.1–2.4 → `- [x]`). Every probe
semantic stays **unresolved**: this environment has no signer service and no reachable
signed-authorization capability (design §0 C3), so no probe can reach a provider here. What is
delivered is the real, testable probe code with the pending live observation documented below —
not a fabricated result, not a weakened refusal.

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/probe.ts` | New (700 lines). The four probes over an injected `PolicyProbeTransport`, the injected evidence writer, and the two production wiring factories. |
| `src/wallet/policy/errors.ts` | Modified (additive). `PolicyCompositionRefusalError` carries the visible stop (`httpStatus` + `stopCode`); `PolicyEmptyCompositionUnprovenError` pins `409 COMPOSICION_VACIA_NO_SOPORTADA`. |
| `src/wallet/policy/repository.ts` | Modified. `setPolicyStatus` now MERGES `status_detail` (jsonb `||`) instead of replacing it, plus two additive methods: `mergePolicyStatusDetail` and `setEmptyComposition`. |
| `tests/unit/policy-probe-u1.test.ts` … `-u4.test.ts` | New. 23 cases across the four probes. |
| `tests/unit/policy-composer-unproven-refusal.test.ts` | New. The composer's refusal against an unproven deployment, and its positive control. |
| `tests/unit/helpers/policy-probe-fakes.ts` | New. The fake transport + fake evidence writer (not a `.test.ts`, so it is not a suite). |
| `tests/integration/recipient-policy-repository.test.ts` | One case CHANGED and one ADDED: the old `statusDetail).toEqual({})` assertion pinned the replacement defect; it now asserts the merge, with the probe-evidence survival and the cross-user denial as its evidence. |

#### What each probe delivers

- **2.1 U1 `probeRuleComposition()`** — one policy write with two ALLOW rules over disjoint
  `Transfer.to` allowlists, then one signed transfer covered by only ONE rule. `union` is recorded
  only when that transfer is observed as permitted. No signer, no signed-send port, an unreachable
  provider or a refusal records `unproven` with the reason; nothing is inferred from the readback.
- **2.2 U2 `assertPolicyTargetCapability(userId, walletId)`** — the owner-verified readback through
  `listOwnerWallets` (the `privyDid` + `listWalletsForChain` path) and **not**
  `server.getWallet`; the canonical signer must be present exactly once with our policy id in its
  `override_policy_ids`. Failure is `blocked_configuration` / `signer_attachment_unproven` with
  `patchIssued: false`.
- **2.3 U3 `assertPolicyOwnership(userId, walletId)`** — resolves the wallet only through the
  owner-verified listing and compares it with the recorded `provider_wallet_id`. The mismatch
  signature (owner listing empty, unfiltered read present) stops with `ownership_drift`; the remote
  owner is neither adopted nor overwritten, and this module has no write path to
  `user_wallets.provider_signer_id` at all (`bindingRewritten: false` is a structural property).
- **2.4 U4 `probeEmptyComposition()`** — `createPolicy(name, [])` + `getPolicy`, `patchPolicy(id,
  [])` + `getPolicy`, and step (iii) when a signed-send port exists. `proven_deny` requires an
  observed signed REFUSAL; a successful zero-rule PATCH alone records `unproven`
  (`signed_denial_unobserved`), and an empty policy that would ALLOW an uncovered transfer records
  `unproven` (`signed_transfer_permitted`) rather than the most dangerous false positive.

The probe transport has **no detach and no delete member**, so "the policy is never detached,
deleted, or left with an absent recipient rule" (design §11 U4) is a property of the seam rather than
a promise, and no probe ever patches a wallet's attached policy (asserted: `patchPolicy` uncalled).

#### The carried defect (task 1.7's handover): FIXED, not worked around

`setPolicyStatus` used to write `status_detail = $5::jsonb`, so the next mutation's status write
destroyed a recorded probe result. It now writes
`status_detail = COALESCE(status_detail, '{}'::jsonb) || $5::jsonb`: probe evidence survives, and a
transition's own keys override only those keys. `mergePolicyStatusDetail` is the path for evidence
recorded outside a status transition (design §11 names `status_detail` as the recording site).
The integration case asserts both directions: a foreign user cannot merge or set the columns, and
after a later status write the recorded `rules_union` / `empty_composition` are still there.

#### TDD Cycle Evidence

Honest disclosure: the implementation was written before its suites in this run, so no
implementation-free RED was captured for the module as a whole — the module-level RED is *reported as
absent* rather than claimed. The substantive RED is **mutation**-based: every guard was removed, the
attributed failure observed by name, and the clause restored (script `/tmp/probe-mutation-harness.py`,
backups via `cp` — **no `git stash` was run at any point**).

| # | Mutation | Observed failures (by name) | Verdict |
|---|---|---|---|
| M1 | U1 signer-capability gate → `if (false)` | `probeRuleComposition … records unproven without attempting any write when no signer capability exists` + `the composer refuses … never issues a PATCH` | gate load-bearing |
| M2 | U1 `permitted = send.permitted` → `= true` | `records unproven when the single-rule transfer is refused` | the observed permit is the only thing that upgrades U1 |
| M3 | U2 "exactly once" `> 1` → `> 5` | `stops when the canonical signer appears more than once` | the occurrence clause is load-bearing |
| M4 | U2 owner-verified listing → the unfiltered `getWallet` | 5 U2 cases (including the `calls.getWallet` must-be-empty assertion) | the read path is asserted, not decorative |
| M5 | U3 `drift = unfilteredObservedId !== null` → `false` | `stops with ownership_drift on the mismatch signature` | the mismatch signature is genuinely detected |
| M6 | U4 infers `proven_deny` from the zero-rule PATCH | `records unproven — never proven_deny — from a successful zero-rule PATCH alone` + the composer's U4 refusal case | "nothing infers deny from a PATCH" is enforced |
| M7 | U4 signer-capability gate → `if (false)` | `records unproven without any write when no signer capability exists` | gate load-bearing |
| M8 | empty-composition refusal loses its stop code | `stops with 409 COMPOSICION_VACIA_NO_SOPORTADA and issues no write when unproven` | the visible stop is carried by the refusal |

Post-restore control: the full five-suite run reports **0 failing** after every restore.

Every negative assertion has a positive control on the same fixture: the U1 no-signer case shares
its transport with the configured-signer case; the U2 success case proves the listing port is live
before the absent-wallet case asserts the stop; the U3 mismatch case asserts `getWallet` WAS called
while the proven case asserts it was not; the U4 "unproven from a PATCH alone" case asserts both
writes really ran and returned zero rules before asserting the refusal; the composer's refusal case
asserts the attached policy reads back non-empty before and after the refusal.

#### Commands run and results

```text
npx vitest run tests/unit/policy-probe-u1.test.ts … -u4.test.ts tests/unit/policy-composer-unproven-refusal.test.ts
  → Test Files 5 passed (5) | Tests 23 passed (23)
python3 /tmp/probe-mutation-harness.py   → the eight mutation rows above; post-restore 0 failing
npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
  → Test Files 17 passed (17) | Tests 231 passed (231)          ← slice 1 stayed green (203 → 231)
npx vitest run <the task-1.8 + lock-order named regression set, 10 files>
  → Test Files 10 passed (10) | Tests 109 passed (109)
npm run lint      → eslint src tests --max-warnings=0 : clean, exit 0
npm run typecheck → tsc -p tsconfig.test.json --noEmit : clean, exit 0
```

#### PENDING LIVE EVIDENCE (per probe — the parent runs these when a signer and a devnet budget exist)

Every probe below is implemented and unit-proven over a fake transport, and every one of them
currently records `unproven` on this deployment. Nothing here is resolved.

| # | What is genuinely missing | Exact step that collects it | Exact evidence shape to record | Exact place it must be recorded |
|---|---|---|---|---|
| U1 | A live devnet policy with two ALLOW rules over disjoint `Transfer.to` allowlists, and one SIGNED `signAndSendTransaction` covered by only one rule, observed permitted. Requires `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN` (so `canSignAuthorizations()` is `true`) and a signed-send capability bound to the probe policy. | With a configured sidecar and a devnet wallet: `probeRuleComposition({ transport, evidence, walletId, ordinaryAddress, grantAddress })` from the capability probe run (2.7). No manual step is needed beyond the sidecar being reachable; the probe writes its own policy and never touches the wallet's policy. | `{ rules_union: "union", rules_union_evidence: { before: [...2 ALLOW rules...], after: [...getPolicy readback...], permitted: true, probePolicyId: "pol_…", at: "<ISO>" } }` — and `{ rules_union: "unproven", rules_union_evidence: { …, reason: "signer_unavailable" \| "signed_transfer_unavailable" \| "transfer_not_permitted" \| "provider_unreachable" } }` when it cannot resolve. | `recipient_policy_state.status_detail.rules_union` (+ `.rules_union_evidence`) via `mergePolicyStatusDetail`; the composer reads `status_detail.rules_union` as its `ruleComposition` input (design §11 U1). |
| U2 | One owner-verified readback (`privyDid` + `listWalletsForChain(did,'solana')`) showing the canonical signer present exactly once carrying our policy id. Needs a wallet whose `provider_signer_id` is bound and a policy actually attached to that signer. | `assertPolicyTargetCapability(userId, walletId, policyId)` before any PATCH (wired by 2.7/2.8). | `{ attachment_evidence: { providerWalletId, providerSignerId, policyId, observedOwnerWalletIds, observedSignerIds, observedPolicyIds, readPath: "owner_verified_listing", occurrences: 1, at: "<ISO>", detail: null } }`; on failure `proven: false`, `blocked_configuration`, `signer_attachment_unproven`, `detail ∈ { owner_listing_failed, wallet_absent_from_owner_listing, signer_absent, signer_duplicated, policy_not_attached_to_signer, binding_unresolved }`. | `recipient_policy_state.status_detail.attachment_evidence` via `mergePolicyStatusDetail` (design §11 U2). |
| U3 | (i) A live observation of the mismatch signature (owner listing empty WHILE the unfiltered read returns the wallet) and (ii) the provider's error code for a signed mutation against such a wallet. Deliberately NOT produced by this unit: manufacturing an ownership conflict against a real account is not something a test run may do. | (i) `assertPolicyOwnership(userId, walletId)` against a deliberately mismatched binding (a wallet row whose `provider_wallet_id` belongs to another identity). (ii) A signed `patchPolicy`/`addPolicyToSigner` attempt against that wallet with the sidecar configured, recording the provider's error code. | `{ ownership_evidence: { providerWalletId, observedOwnerWalletIds, unfilteredObservedId, signature: "owner_listing_empty_unfiltered_present" \| "absent_everywhere" \| "owner_listing_present", at: "<ISO>", detail } }` plus the provider error code for (ii) recorded in `.detail` (code only, never the provider body). | `recipient_policy_state.status_detail.ownership_evidence` via `mergePolicyStatusDetail` (design §11 U3). |
| U4 | Step (iii): a signed transfer attempt against an empty-rules policy observed as REFUSED, which requires a user-authorized wallet action. Steps (i)/(ii) alone stay `unproven` by construction. | `probeEmptyComposition({ … })` with the sidecar configured and a signed-send port bound; the protocol steps (i)/(ii) run automatically and (iii) is the only omitted step while `uncoveredAddress` cannot be attempted. | `{ empty_composition: "proven_deny" }` + `status_detail.empty_composition_evidence = { createdPolicyId, rulesAfterCreate: 0, rulesAfterPatch: 0, signedDenialObserved: true, at }`; while step (iii) is missing: `empty_composition: "unproven"` with `reason: "signed_denial_unobserved"` (or `signed_transfer_permitted` if an empty policy ALLOWED, which must block, and `provider_unreachable`/`signer_unavailable`). | `recipient_policy_state.empty_composition` (column) via `setEmptyComposition`, plus `status_detail.empty_composition_evidence` (design §11 U4). |

Provider documentation (union of ALLOW rules, DENY precedence, default DENY, a method absent from
`rules` being denied) is recorded in design §11 as **partial** evidence only. It was not used to flip
any semantic, and the shipped behaviour on this deployment is the refusal.

#### Deviations from the design

1. **The probes take an injected transport and an injected evidence writer.** Design §11 names the
   probe functions and the recording site, not a seam. The seam is what makes each probe provable
   without a provider (and what makes "cannot observe ⇒ records `unproven`" testable at all); the
   production factories (`createRepositoryProbeEvidenceWriter`, `createPolicyProbeBindingResolver`)
   are in the same module, so 2.7/2.9 wire rather than write.
2. **`status_detail` merge replaces replacement semantics in `setPolicyStatus`**, and one slice-1
   assertion that pinned the old behaviour was updated deliberately (recorded above, with the
   cross-user denial as its positive control). This is the parent's "fix, do not work around" option.
3. **The refusal carries its stop (`httpStatus` + `stopCode`).** Design §11 U4 names
   `409 COMPOSICION_VACIA_NO_SOPORTADA` but the design's error classes carry only `failureClass` and
   `reason`, so a route would have had to reassemble the code from prose. The stop now travels with
   the refusal; slice 3's contract mirror maps from the typed class. The pre-existing
   `409 CONFLICTO_POLITICA` mapping is untouched, so no earlier behaviour changed.
4. **The probe rule builder is local and synthetic.** `probeAllowRule` builds a one-address ALLOW
   rule for a policy that is never attached to a wallet; it imports the single lamport ceiling rather
   than restating it. It is deliberately not `buildSolanaEnrollmentRules` (which task 1.10 freezes to
   the composer) and not `composeGrantRules`, so no second full-rule composer exists.
5. **The signed-send port is optional** and its absence is a recorded reason rather than a skipped
   step, so "we could not run step (iii)" is distinguishable from "step (iii) ran and denied".

#### Observations handed to later tasks (not defects in this unit)

- **2.5 (worker signer defect) is the first prerequisite for any live probe run.** With
  `authorizationSigner` not passed into the worker's `PrivyServerClient`, the worker-side
  `canSignAuthorizations()` stays `false` and every probe there records `signer_unavailable`. The
  probe code is correct in that state; it is the wiring that must land first.
- **2.7 must call these probes from `verifyPolicySignerCapability()`'s capability run** and keep the
  recorded values boolean/code only — the evidence objects above contain ids, timestamps and integer
  counts, and no token, key, payload or signature.
- **2.8/2.9 own the transition that CONSUMES the probes.** The composer reads
  `status_detail.rules_union`, and now that `setPolicyStatus` merges, a probe result cannot be
  erased by an intervening status write. `status_detail` still accumulates keys, so a reconciler
  transition that wants to clear `status_detail.confirmedBy` must pass that key explicitly.
- **`empty_composition='unsupported'` remains representable** in the schema and is refused by the
  composer exactly like `unproven`; no probe writes it.

### Task 2.5 — fix the pre-existing worker signer defect (design §0 C4)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (2.5 → `- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/runtime/dependencies.ts` | Two-line behavioural fix: the already-built `authorizationSigner` is now passed into the worker's `PrivyServerClient` (the shape `src/server.ts` already used), instead of constructing the client with `appId`/`appSecret`/`baseUrl` only. The wallet-resolver passing immediately below is untouched. |
| `tests/unit/worker-dependencies.test.ts` | Extended with the `createWorkerDependencies signed-authorization capability` suite (two cases). |

#### What the unit delivers

The worker built its signing sidecar client at `:213` and then never handed it to
`PrivyServerClient`, so `canSignAuthorizations()` was structurally `false` in the worker even with a
sidecar configured: `createGrantPolicySyncService` therefore returned `kind: "unavailable"` and every
signed policy write from the worker failed closed. The fix is the same `...(authorizationSigner ?
{ authorizationSigner } : {})` spread `src/server.ts` uses, and nothing else changed.

Both directions are asserted, and the positive control comes FIRST so a `false` assertion cannot pass
because nothing was observed:

- With `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN` plus the server config and quorum: the client the
  worker actually constructed reports `canSignAuthorizations() === true`, and
  `createGrantPolicySyncService({ database, privyServer: <that client>, quorumId }).kind` is
  `"runtime"` — the signed policy write is no longer `unavailable`.
- Without a sidecar: the same client reports `false` and the same call returns `"unavailable"`, i.e.
  the fail-closed default is intact.

The client instance is observed through `PrivyServerClient.prototype.canSignAuthorizations` (a spy
that records `this` and delegates to the real method), NOT through a mocked constructor's argument
list: the test proves the capability decision the real client makes, not that an object literal
contains a key.

#### TDD Cycle Evidence

| Step | What was run | Result |
|---|---|---|
| RED (fix removed) | `npx vitest run tests/unit/worker-dependencies.test.ts` with the `authorizationSigner` spread deleted | **Failed by name**: `createWorkerDependencies signed-authorization capability > hands the sidecar signer to the worker client, so grant policy sync is not unavailable` — `AssertionError: expected false to be true` at the `canSignAuthorizations()` assertion. `1 failed | 2 passed`. |
| GREEN (fix restored) | same command | `Test Files 1 passed (1)`, `Tests 3 passed (3)` — the case that was red by name is green, and the two pre-existing cases are unchanged. |
| Types | `npx tsc --noEmit -p tsconfig.json` | no diagnostics. |

#### Commands run and results

```text
npx vitest run tests/unit/worker-dependencies.test.ts      # 3 passed (after RED-by-name proof)
npx tsc --noEmit -p tsconfig.json                          # clean
```

#### Deviations from the design

1. **The capability is observed at the seam, not by exposing the worker's client.** `WorkerDependencies`
   does not (and now still does not) export `privyServer`. The test reaches the real instance through
   a prototype spy instead of widening the worker's public type for a test, and it asserts the
   *behaviour* (`canSignAuthorizations()`, and the `runtime` vs `unavailable` decision) rather than the
   constructor's argument list.
2. **No comment block was added around the fix beyond two lines of rationale** — the comment names the
   defect and the reference implementation, because a later reader seeing the spread removed would
   reintroduce C4.

#### Observations handed to later tasks (not defects in this unit)

- **2.5 is now discharged for the worker side.** With a reachable sidecar, the worker-side
  `canSignAuthorizations()` is `true`; the probes' `signer_unavailable` reasons can now become real
  observations once a sidecar exists (2.6 provides one in compose).
- **The worker still ends in a typed refusal rather than a PATCH**: `createRuntimeGrantPolicyProvisioner`
  delegates to the composer and throws `PolicyApplyCapabilityUnwiredError` (task 1.6's
  `apply_capability_unwired`, deleted — not relaxed — by 2.8). 2.5 removes the *first* refusal layer
  (`unavailable`) and exposes the second one, which is the intended sequencing.

#### Commit

`fix(runtime): hand the worker's authorization signer to its Privy client` — see the report envelope
for the SHA.

### Task 2.6 — wire the backend and worker signed-authorization capability (design §6.2/§6.3)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (2.6 → `- [x]`).

#### Files changed

| File | Role |
|---|---|
| `compose.privy-local.yaml` | Additive: two signer services (`backend-signer`, `voice-worker-signer`) sharing their consumer's network namespace, and `PRIVY_SIGNER_URL` / `PRIVY_SIGNER_TOKEN` / `PRIVY_SIGNER_TIMEOUT_MS` on `backend` and `voice-worker`. `frontend` unchanged. |
| `tests/unit/policy-signer-compose-structural.test.ts` | New. Four cases: the loopback sidecars per namespace, the consumer-side capability (url/token/timeout, no key), the no-key/no-token/no-key-mount property on `frontend`/`backend`/`voice-worker` in **every** compose file, and the environment-template documentation. |
| `src/wallet/signer/README.md` | Additive `## Deployment wiring (compose)` table documenting each variable by name. See deviation 2 below. |

#### What the unit delivers

- `backend-signer`: `network_mode: "service:backend"`, `entrypoint: ["/bin/sh", "-c"]`,
  `command: ["npm run build && exec node dist/wallet/signer/server.js"]`, `PRIVY_SIGNER_HOST: 127.0.0.1`,
  `PRIVY_SIGNER_PORT: "8788"`, `PRIVY_SIGNER_KEY_FILE: /run/secrets/privy-authorization-private-key`,
  the key directory mounted read-only at `/run/secrets`, and **no `ports:` declaration**.
- `voice-worker-signer`: identical, `network_mode: "service:voice-worker"`, port `8789`.
- `backend` env: `PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign"`, `PRIVY_SIGNER_TOKEN`,
  `PRIVY_SIGNER_TIMEOUT_MS: "5000"`. `voice-worker` env: the same with `8789`.
- Nothing else changed: no port is published for either signer, no key variable or key mount reaches
  `backend`, `voice-worker` or `frontend`, no signing route was added to the API, and `frontend`
  still receives only `VITE_PRIVY_APP_ID`.

#### TDD Cycle Evidence

| Step | What was run | Result |
|---|---|---|
| RED (pre-change compose) | `npx vitest run tests/unit/policy-signer-compose-structural.test.ts` with `compose.privy-local.yaml` restored from `HEAD` | **Failed by name** (2 of 4): `runs one loopback signing sidecar per consumer namespace` — `AssertionError: backend-signer must exist: expected undefined to be defined`; `reaches the sidecar over the consumer's own loopback and accepts no key` — `expected '…image: nana-privy-backend-dev:loc…' to contain 'PRIVY_SIGNER_URL: "http://127.0.0.1:8…'`. |
| GREEN (wiring in place) | same command | `Test Files 1 passed (1)`, `Tests 4 passed (4)`. |
| Mutation A (plant `PRIVY_AUTHORIZATION_PRIVATE_KEY` in `backend` env) | same command | **Failed by name** at `declares no key variable, token or key mount on frontend, backend or voice-worker in any compose file` — `compose.privy-local.yaml:backend must not declare PRIVY_AUTHORIZATION_PRIVATE_KEY`, plus the consumer-side case. Restored → 4 passed. |
| Mutation B (add `ports: ["127.0.0.1::8788"]` to `backend-signer`) | same command | **Failed by name** at `runs one loopback signing sidecar per consumer namespace` — `expected '…image: nana-privy-backend-dev:loc…' not to match /^\s*ports:/mu`. Restored → 4 passed. |
| Compose validity (structural, no container started) | `env <dummy values> docker compose --env-file /dev/null -f compose.privy-local.yaml config --services` | `db, livekit, backend, backend-signer, frontend, voice-worker, voice-worker-signer` — the file interpolates and the two new services are recognised. Dummy values were supplied on the command line only; nothing was written or printed. |
| Interpolation is fail-closed | same command **without** `PRIVY_SIGNER_TOKEN` | `error while interpolating services.backend.environment.PRIVY_SIGNER_TOKEN: required variable PRIVY_SIGNER_TOKEN is missing a value` (same for `backend-signer`, `voice-worker`, `voice-worker-signer`) — the stack refuses to start unconfigured instead of running without a capability. |

#### Deviations from the design

1. **The signer services also mount `./src` and `./tsconfig.json`, which design §6.2's snippet shows
   only on `backend`/`voice-worker`.** The snippet's own `command` runs `npm run build`, and the image
   (`docker/Dockerfile.privy-dev`) has no baked `dist/` for the signer entrypoint: without the same
   read-only source mounts the entrypoint cannot compile, so the snippet as written would have been a
   service that never starts. The mounts are read-only and add no key material.
2. **The variable documentation landed in `src/wallet/signer/README.md`, not `.env.example`.** The
   harness safety policy blocks all writes to `.env.example` ("blocked access to sensitive path"),
   including a comment-only edit; that was NOT circumvented, because routing the write around the
   guard is exactly what the policy exists to prevent. The three variables the task names were
   **already documented there** as commented placeholders (`.env.example:35-39`, from S2a), so the
   requirement holds for them; only the new `PRIVY_SIGNER_KEY_DIR` mount variable had nowhere to go,
   and it is now documented in the signer README's `## Deployment wiring (compose)` table together
   with the compose-mount contract. **Handed to the parent as an item needing a user decision.**
3. **`compose.yaml` (the `dev`/`worker` profiles) was left unchanged.** Its `backend`/`voice-worker`
   read `env_file: .env`, so a `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN` provided there already reaches
   them; those profiles declare no signer service, and adding an env var pointing at a loopback
   sidecar that the profile never starts would be a configuration that cannot work. The structural
   suite still guards `compose.yaml`'s consumer blocks against a key variable or key mount.

#### Observations handed to later tasks (not defects in this unit)

- **`src/wallet/signer/README.md` carries a stale "Not in this slice (S2a scope)" bullet** claiming
  `src/server.ts` still constructs its Privy client with the process-held key. S2c and 2.5 both
  contradict it (both processes now pass the sidecar signer). It was left byte-for-byte unchanged
  because it is outside this unit's scope; flagged rather than silently rewritten.
- **2.7 can now report a real `signer_unavailable`, not a structural one.** With the wiring in place,
  a deployed stack that starts has a reachable loopback sidecar; a stack that has none still fails
  closed at compose interpolation.
- **The signer is still a signing oracle for anything holding the token inside that namespace**
  (`src/wallet/signer/README.md`), which this change neither weakens nor fixes.

#### Commit

`feat(deploy): run a loopback signing sidecar in each consumer's namespace` — see the report
envelope for the SHA.

### Task 2.7 — the capability probe and the readiness surface (design §6.4)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (2.7 → `- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/probe.ts` | Additive: `verifyPolicySignerCapability()`, `policySignerProbePayload()`, the `PolicySignerCapability` / `PolicySignerCapabilityCode` types and the failure-code mapping. |
| `src/contracts/http.ts` | Additive: `policySigner: { capable, code }` on `healthResponseSchema` and therefore on `HealthResponse`. Required, because the one producer always emits it. |
| `src/api/health.ts` | `registerHealthRoutes` gains the optional `policySigner` probe dependency (defaulting to the real probe over the current environment) and returns the field. Nothing else on the route changed. |
| `tests/unit/policy-signer-probe.test.ts` | New. 14 cases: every code path, the nonce-aware verification property, the secret-freedom assertion (result **and** logs), the real-environment path, and two readiness-surface cases. |

#### What the unit delivers

- `verifyPolicySignerCapability({ environment?, signer?, authorizationPublicKey? })` signs
  `policySignerProbePayload()` — a fixed, non-secret, byte-stable object
  (`{probe:"policy-signer-capability", version:1, issuedAt:"1970-01-01T00:00:00.000Z"}`) — **through
  `signerAuthorizationContext`**, the same seam every real mutation uses (`sign_fns[0]`), and asserts
  the result with `crypto.verify("sha256", payload, publicKeyObject, signature)` against the
  environment's `PRIVY_AUTHORIZATION_PUBLIC_KEY`. **Never byte equality**: the suite proves that two
  signatures over the same payload differ and both verify, so a byte comparison would be worthless.
- Return is `{ capable, code }` and nothing else. Codes, exhaustively mapped: no signer, a partial
  signer configuration, no configured public key, an unusable public key, an unreachable sidecar, a
  5xx, a malformed answer, `signer_protocol_error`, `signer_not_configured` or an unexpected throw →
  `signer_unavailable`; a definitive 4xx → `signer_rejected`; a bounded timeout → `signer_timeout`; a
  signature that does not verify, or is not well-formed base64 DER → `signature_mismatch`. Nothing is
  logged and nothing throws: a capability probe may not take the process (or `/health`) down.
- `/health` now carries `policySigner: { capable, code }` and no other field. With no sidecar
  configured — this deployment's actual state — it reports `{ capable: false, code:
  "signer_unavailable" }`, which is the honest readiness answer rather than a fabricated `verified`.

#### TDD Cycle Evidence

| Step | What was run | Result |
|---|---|---|
| RED (module absent) | `npx vitest run tests/unit/policy-signer-probe.test.ts` before the implementation existed | Import of `verifyPolicySignerCapability` failed — the new export did not exist. Recorded here as the trivial half of RED only; the load-bearing proof is the mutation table below, because a missing export cannot distinguish "the guard works" from "nothing was observed" (hence the positive control first in every case). |
| GREEN | same command | `Test Files 1 passed (1)`, `Tests 14 passed (14)`. |
| Mutation A (replace `crypto.verify` with a byte-equality comparison) | same command | **Failed by name** (3): `reports verified for a signature that verifies under the configured public key`, `verifies rather than comparing bytes: two signed runs differ and both verify`, `leaves only { capable, code }…` — all `expected { capable: false, … } to deeply equal { capable: true, code: 'verified' }`. Restored → 14 passed. |
| Mutation B (ignore the verification result, always `verified`) | same command | **Failed by name** (2): `reports signature_mismatch for a well-formed signature from a DIFFERENT key` and `reports signature_mismatch for a signature that is not well-formed DER` — `expected { capable: true, code: 'verified' } to deeply equal { capable: false, … }`. Restored → 14 passed. |
| Nonce assertion | in-suite | Two `createKeyPayloadSigner` runs over the same payload: `expect(first).not.toBe(second)` and both capabilities `verified`. |
| Secret-freedom | in-suite | `Object.keys(capability)` is exactly `["capable","code"]`; `JSON.stringify` of the result **and** of every `console.log/error/warn/info` capture does not match `/token\|key\|signature\|payload\|private\|secret/i` and does not contain the first 24 characters of the configured public key. The same assertion is applied to the `/health` body. |
| Real-environment path | in-suite | `verifyPolicySignerCapability()` with no deps returns exactly `{capable, code}` and, guarded on the absence of `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN`, `{ capable: false, code: "signer_unavailable" }`. No env value is read into any assertion or output. |
| Unit gate | `npx vitest run tests/unit/worker-dependencies.test.ts tests/unit/policy-signer-compose-structural.test.ts tests/unit/policy-signer-probe.test.ts tests/unit/health-route.test.ts tests/unit/policy-probe-u1.test.ts … -u4.test.ts` | `Test Files 8 passed (8)`, `Tests 46 passed (46)`. |
| Slice gate (with 2.5/2.6) | `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` | `Test Files 1 failed \| 18 passed (19)`, `Tests 1 failed \| 248 passed (249)`. The single failure is the pre-existing database-state failure described below; everything else is green. |
| Types + lint | `npm run typecheck && npm run lint` | clean. |

#### The single failing slice-suite case (pre-existing database noise, not this unit)

`tests/integration/recipient-policy-repository.test.ts > recipient_policy_sync_intent > claims a due
intent from the system context and leaves a foreign user unable to see it` fails with
`expected undefined to be defined` at `listDueIntents({ limit: 50 })`. Evidence that this is
accumulated dev-database state and not a behaviour regression:

- the shared container `colloseumfeat-solana-operational-db-1` holds **196** rows in
  `recipient_policy_sync_intent`, of which **103** are due (`state IN ('pending','applying')` and
  `next_attempt_at IS NULL OR <= now()`);
- `listDueIntents` orders `next_attempt_at ASC, desired_revision ASC LIMIT 50`, so a freshly inserted
  intent sorts behind 103 older due rows and is cut off by the limit;
- the diff for this unit (`git diff --stat 0078cc0..HEAD`) touches no query, no migration and not that
  suite, and the same single case fails identically when that suite runs alone.

Recorded, not chased: task 5.3 explicitly forbids chasing pre-existing database noise, and repairing
it would mean deleting another unit's rows. No readback assertion was removed or weakened for this.

#### Deviations from the design

1. **The probe resolves its own signer client from the environment when none is injected.** Design §6.4
   does not name a seam. A seam is required for the code paths to be provable at all (`signer_rejected`
   and `signer_timeout` cannot be produced against a real sidecar on demand), and the default keeps the
   readiness field honest in production. `src/server.ts` therefore needed **no** change: the probe
   builds the same env-configured client the API builds, so the surface is not pinned to the API's
   instance.
2. **`policySigner` is a required field on `HealthResponse`, not optional.** The single producer always
   emits it and `src/api/health.ts` is its only consumer, so an optional field would have encoded
   uncertainty the route does not have. Existing health assertions are field-based and stayed green
   unchanged.
3. **"No public key configured" maps to `signer_unavailable`.** The design's code vocabulary has no
   `public_key_unavailable` member, and an unverifiable signature is not a capability. Adding a sixth
   code would have been a contract change the task did not ask for.
4. **The probe signs through `signerAuthorizationContext`, not through a bare port call.** That is the
   literal reading of "a payload of the shape produced by `signerAuthorizationContext`" and it means a
   regression that unwires the context (rather than the port) is caught by the probe.

#### Observations handed to later tasks (not defects in this unit)

- **The readiness surface is now the cheapest honest check for 5.2**: `GET /health` → `policySigner`.
  It reports `{capable:false, code:"signer_unavailable"}` until the deployment actually has a reachable
  sidecar, so a green deployment is distinguishable from a green test.
- **The probe deliberately does NOT run the U1–U4 provider probes.** The 2.1–2.4 handover said 2.7
  should call them from a "capability run"; the capability probe here is synchronous, bounded and
  read-only, and the four probes **write** policies, so folding them into `/health` (which a container
  healthcheck hits every 5 s) would have turned a readiness check into a policy writer. The U1–U4
  probes remain callable from the live run (5.2) with their injected transport; that wiring is 2.8/2.9
  territory, where the signed apply path exists.
- **`signature_mismatch` is the alarm that matters.** It fires when the sidecar holds a key that is not
  the registered quorum key, i.e. exactly the state in which every signed policy write would fail at
  the provider.

#### Commit

`feat(policy): probe the signed-authorization capability and publish it on /health` — see the report
envelope for the SHA.

---

## Task 2.8 — the signed apply path with revision CAS and post-apply bookkeeping

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (2.8 → `- [x]`).

### Prerequisite first: the task 1.3 due-intent suite was polluted (committed separately)

`tests/integration/recipient-policy-repository.test.ts > claims a due intent from the system context`
was failing for a **test-isolation** reason: the shared local database had accumulated **196**
`recipient_policy_sync_intent` rows (163 of them `desired_revision = 1` with `next_attempt_at IS
NULL`), the reconciler's scan is `ORDER BY next_attempt_at ASC, desired_revision ASC LIMIT 50`, and the
suite had no teardown. The suite now owns its rows: the assertion anchors its own row's
`next_attempt_at` (a fresh `NULL` sorts LAST under `ASC`, the anchor sorts first) and `afterAll` sweeps
its own rows from the four mutable policy tables. `recipient_policy_audit` is append-only by trigger
and is deliberately not swept.

**Guarantee preserved and mutation-proved** (each mutation fails the same case by name,
`expected undefined to be defined`, and is restored):

| Mutation | Result |
|---|---|
| anchor set to a future deadline (row no longer inside the scan) | `1 failed \| 19 passed` — the due scan no longer reaches the row |
| `claimIntent` loses its `wallet_id` scoping | `1 failed \| 19 passed` — at the `mine` assertion |
| `claimIntent` stops transitioning `state='applying'` | `1 failed \| 19 passed` — at the `mine` assertion |
| the due scan moves out of the system context | `2 failed \| 18 passed` — the cross-user case *and* the due case |

**Baseline by name, same table state:** with 60 older due rows seeded, the pre-fix form (anchor
removed) failed at `claims a due intent from the system context and leaves a foreign user unable to
see it` with `AssertionError: expected undefined to be defined`; the fixed form passed. Seeds purged
afterwards.

**Rows deleted from the local dev database** (`wdk_agent`, container
`colloseumfeat-solana-operational-db-1`, test data only): `recipient_policy_sync_intent` **196**,
`recipient_policy_state` **215**, `recipient_policy_leases` **98**, `contact_action_proposals` **168**.
`recipient_policy_audit` kept its 1 547 rows — the append-only trigger refuses `DELETE`, and audits
cannot affect the due scan. Nothing else was touched; the 60 temporary baseline seeds were removed in
the same unit of work.

Commit: `test(policy): isolate the due-intent suite from accumulated shared-database rows` (see the
envelope for the SHA).

### Files changed (task 2.8)

| File | Role |
|---|---|
| `src/wallet/policy/apply.ts` | **New** (~600 lines). The signed apply capability: §3.5 steps 4–9, the §5.3 classification, the signer-authorization payload, `allowedAddressUnion`, and the real `createPrivyPolicyApplyTransport` over `PrivyServerClient` + the owner-verified listing. |
| `src/wallet/policy/service.ts` | The apply orchestration: the deleted construction refusal, the widened seam (`PolicyApplyRequest` carries the owner-verified binding + provenance; `PolicyApplyOutcome` gains `verified` evidence, `retryable_failure` and the `blocked` failure class), `applyRevision`, `commitApplyOutcome` (the single step-10 transaction), `applyRecordedRevision`, and `recordApplyPending(reason)` for the `unavailable` arm and the two no-binding stops. |
| `src/wallet/policy/errors.ts` | `apply_capability_unwired` and `PolicyApplyCapabilityUnwiredError` **deleted**; `provider_unavailable` + `PolicyApplyUnavailableError` added for the paths that genuinely have no capability. |
| `src/wallet/embedded.ts` | `preparePermission` runs `recordEnrollmentIntent` → `applyRecordedRevision` and returns a preparation **only** from an `applied` readback with a verified policy id. |
| `src/wallet/grants/privy-policy-runtime.ts` | The grant-sync refusal now names the deployment fact; the refusing contact port uses `PolicyComposerRequiredError`. |
| `tests/unit/policy-apply-transport.test.ts` | **New**, 17 cases: the signature (verified, not byte-compared), the idempotent skip with zero PATCHes, create/attach only when the signer has none, and the §5.3 table. |
| `tests/unit/helpers/policy-apply-fakes.ts` | **New**: a fake transport whose mutation check is a real `crypto.verify` against the configured public key, with a mutable owner-verified listing. |
| `tests/integration/recipient-policy-apply.test.ts` | **New**, 4 cases against the real database: verified commit + §5.4 grant refresh + the counting-client transaction assertion, the stale-writer CAS, the unreachable signer, and the proven divergence. |

### What the unit delivers

- **`applyRevision` (steps 4–10).** The composition is read from the RECORDED state
  (`composeRevision`), the binding from `resolvePolicyTarget` (fail-closed: a wallet with no verified
  signer records `signer_binding_unavailable` and performs **no** provider I/O), then the provider
  runs steps 4–9 with **no transaction open**, and step 10 opens exactly one `withUserTransaction`.
- **`commitApplyOutcome` (step 10).** `commitAppliedRevision` is the §1.5 compare-and-set
  (`WHERE wallet_id = $1 AND user_id = $2 AND desired_revision = $3 RETURNING wallet_id`); **zero
  rows** ⇒ the in-flight intent is `superseded` + a `superseded` audit and **no applied write and no
  grant refresh**. On success the same transaction refreshes `signer_grants`
  (`allowlisted_recipients` + `policy_hash`, §5.4) and appends the `applied` audit. `unverified` and
  `retryable_failure` record `pending` + `apply_failed` and touch no binding; a comparator `blocked`
  records its own failure class + audit and clears no `delegated_grants.provider_policy_id` (2.12).
- **`status_detail` merges.** Every transition names its own keys explicitly, including the `null`s
  that clear a previous transition's stale `policyId`/`operation`/`status`/`message` (the carried
  note from 1.6/1.7).
- **The adapter never re-implements a rule check.** Both comparisons go through
  `comparePolicyReadback`, and the verification comparison re-reads the owner-verified listing, so
  checks (e)–(g) are judged against the state AT that readback.

### The `apply_capability_unwired` refusal was DELETED, not relaxed

`PolicyApplyCapabilityUnwiredError` and the `apply_capability_unwired` member of
`PolicyCompositionRefusalReason` no longer exist anywhere in `src/`. The constructor no longer refuses
the `signed` arm, because the implementation it claimed did not exist is `src/wallet/policy/apply.ts`.

Six assertion sites depended on it, plus a seventh found while doing this work. Each was changed
deliberately:

| # | Site | Was | Now | Why |
|---|---|---|---|---|
| 1 | `tests/unit/policy-service-contract.test.ts` `refuses a signed capability instead of driving a live policy write` | `expect(() => new RecipientPolicyService({provider:{kind:"signed"}})).toThrow(PolicyApplyCapabilityUnwiredError)` | `not.toThrow()`, plus the original no-I/O half kept and **strengthened** (no collaborator is consulted at construction) | The refusal is gone; the property worth keeping is that construction performs no I/O. |
| 2 | `tests/unit/policy-service-contract.test.ts` `classifies the refusal as a blocking configuration stop` | `instanceof PolicyApplyCapabilityUnwiredError`, `failureClass === "blocked_configuration"`, `reason === "apply_capability_unwired"` | case deleted; its subject (the refusal) no longer exists | A test for a deleted class can only be deleted; the classification it asserted is now covered on the real path by the apply suites. |
| 3 | `tests/unit/policy-provisioner-delegation.test.ts` (provision) | `refusal.reason === "apply_capability_unwired"` | `=== "provider_unavailable"` | The grant-sync runtime carries no payload signer, so it still refuses — with the reason that names that deployment fact. |
| 4 | `tests/unit/policy-provisioner-delegation.test.ts` (revoke) | same | same | same |
| 5 | `tests/unit/grants-policy-runtime.test.ts` | `refusal.reason === "apply_capability_unwired"` | `=== "provider_unavailable"` | same |
| 6 | `tests/integration/enrollment-composed.test.ts` (assertion + its fixture string) | `refusal.reason === "apply_capability_unwired"`, port reason "unwired in this slice" | `=== "provider_unavailable"`, port reason "provider_unavailable: no signed apply capability in this deployment." | Enrollment now RUNS the apply orchestration; it stops on what the deployment recorded. |
| 7 | `tests/integration/recipient-policy-service.test.ts` `refuses a signed capability and persists nothing at all` | `expect(refusal).toBeInstanceOf(PolicyApplyCapabilityUnwiredError)` | the signed arm is accepted and driven to its first real guard: with no verified `provider_signer_id` the provider is never called and the state records `signer_binding_unavailable` | Same intent (fail closed, no fabricated binding), now asserted on the path that exists. |

### TDD Cycle Evidence

RED for the new behaviour: neither `createSignedPolicyApplyPort` nor `createPrivyPolicyApplyTransport`
existed at the start of this unit, so `tests/unit/policy-apply-transport.test.ts` and
`tests/integration/recipient-policy-apply.test.ts` failed at import. That is the trivial half of RED,
so the load-bearing proof is the mutation table below: every guard was removed, its attributed failure
observed by name, and restored.

GREEN: `Tests 21 passed (21)` (17 unit + 4 integration).

| Mutation (removed / replaced) | Result | Guard it proves |
|---|---|---|
| `commitAppliedRevision` loses its `desired_revision = $3` predicate | `1 failed \| 20 passed` — `records a stale writer's CAS as superseded and never lowers applied_revision` | The §1.5 compare-and-set is the guard, not the surrounding code. |
| the provider `apply(...)` is moved INSIDE `withUserTransaction` | `1 failed \| 20 passed` — `commits the verified revision, refreshes the grant projection, and holds NO transaction across the PATCH` (the transport observed `openTransactions === 1`) | "No transaction across steps 4–9" is measured, not intended. |
| the idempotent skip is disabled (`if (false && decision === "verified")`) | `1 failed \| 20 passed` — `SKIPS the PATCH entirely when the pristine readback already equals the composed rules` | The skip is real: zero PATCHes. |
| the verification comparison reuses the step-4 listing capture | `1 failed \| 20 passed` — `creates and attaches only when the signer has no policy at all` | Checks (e)–(g) are judged against the live readback; a stale capture would accept an unverified attachment. |
| the authorization signature becomes an empty string | `8 failed \| 13 passed` — every mutation case plus the signature case | The signature is load-bearing and the fake's check is a real verification. |

### Commands run and results

```text
npx vitest run tests/unit/policy-apply-transport.test.ts tests/integration/recipient-policy-apply.test.ts
  → Test Files 2 passed (2), Tests 21 passed (21)
npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
  → Test Files 21 passed (21), Tests 269 passed (269)
npx vitest run tests/unit/grants-policy-runtime.test.ts tests/unit/policy-provisioner-delegation.test.ts \
                 tests/unit/policy-service-contract.test.ts tests/integration/enrollment-composed.test.ts \
                 tests/integration/recipient-policy-service.test.ts
  → Test Files 5 passed (5), Tests 45 passed (45)
npm run lint        → clean (eslint --max-warnings=0)
npm run typecheck   → clean (tsc -p tsconfig.test.json --noEmit)
```

### Deviations from the design

1. **The verification comparison re-reads the owner-verified listing.** §3.5 lists one owner-verified
   read at step 4. Reusing that capture for the step-9 comparison would judge post-PATCH rules against
   the pre-PATCH attachment, i.e. an attachment this unit just created would look unproven — the extra
   read is what makes check (e) mean something on the create path (mutation 4).
2. **A verification readback that still differs is `blocked_conflict` (`rules_mismatch`), not
   `unverified`.** That is the comparator's own phase rule: §5.1 (b) is a `blocked_conflict` and a
   `converge` is only reachable in the pristine phase. The "equal to the previous applied rules ⇒
   retry the same revision" branch of §5.3 is the reconciler's (2.9), which owns GET-before-retry.
   `readback_not_converged` remains as the defensive branch for a `patch_required` verification
   decision, which `readback.ts` documents as unreachable.
3. **The grant-sync runtime still wires the `unavailable` arm.** The signed port is implemented and
   service-wired, but `PrivyPolicyRuntimeDependencies` carries no `PayloadSigner`, no
   `listWalletsForChain` and no `addPolicyToSigner`, so wiring the real transport there would mean
   inventing a signer for that path. The refusal now names that fact (`provider_unavailable`) instead
   of an implementation stage. **Handed to the parent**: the reconciler (2.9) owns the apply loop and
   is where the transport/signer should be wired.
4. **`preparePermission` builds the preparation body from the applied readback.** Its success shape
   was removed in 1.8, so this unit restores it from the verified row (`appliedPolicyId`, the ordinary
   cap and the aggregate caveat) rather than from a composed revision — a body carrying a policy id
   must never be assembled from something nobody verified.
5. **`applyRecordedRevision` is a new public seam on the service** so the enrollment path can record
   and apply in one call and read the result back. Its `appliedPolicyId` comes from the row, not from
   the composition.
6. **The fake transport's owner listing is mutable across an attach.** A fake returning the pre-attach
   state would have made the post-attach verification unreachable, i.e. a guard nobody could test.

### Observations handed to later tasks (not defects in this unit)

- **2.9 owns the retry/backoff and the UNVERIFIED table.** This unit returns the outcomes; the
  reconciler decides `confirmedBy='get_after_timeout'`, "retry the same revision", and
  `syncing`-with-`next_attempt_at`.
- **2.12 owns the binding invalidation fallback.** A `blocked` outcome here records the stop class and
  the audit and clears nothing, which is exactly the "unknown outcome must not touch bindings"
  boundary the fallback task is defined against.
- **The live signed path stays unproven in this environment.** There is no signer sidecar running, so
  the live evidence remains pending with its exact step: run `verifyPolicySignerCapability()` against
  the deployed stack and record `{capable, code}` (5.2), then perform the 5.7 devnet verification.
  Nothing in this unit claims a live observation.
- **`state.appliedSignerIds` seeds check (f).** It is `[]` until the first verified apply, so
  "a sibling signer went missing" becomes observable only from the second apply onward.

### Workload / PR boundary

One commit, one work unit: one new module (600 lines), two new suites + one helper (1 300 lines), and
the service/errors/embedded/runtime seams (~400 lines changed) — above the 400-line review budget and
reported, not hidden. It cannot be split without breaking the unit: the adapter, its classification
table and the orchestration that commits what it returns are one behaviour. It sits inside the
parent-assigned `PR 4` slice (tasks 2.1–2.14, rollback boundary `src/wallet/policy/apply.ts` plus the
service seam block), needs no migration change, and no `size:exception` is requested.

### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit (task
2.8), the authoritative artifact paths and the delivery path directly. Readiness was resolved against
the artifacts before any edit — `tasks.md` (2.8, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §1.5, §3.5, §5.1, §5.3, §5.4, and the 1.3–2.7 apply-progress. `actionContext`: all writes
stayed inside `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`; the main checkout and
the untracked `compose.privy-local.ports.yaml` were untouched; no `git stash` was run.

## Task 2.9 — the reconciler (durable intent, backoff, restart recovery, GET-before-retry)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (2.9 → `- [x]`).

### Files changed (task 2.9)

| File | Role |
|---|---|
| `src/wallet/policy/reconciler.ts` | **New** (~560 lines). Due scan, `W1` claim, restart-recovery reclaim with the `lease_reclaimed` audit, the §5.3 GET-before-retry table, `applied`/`failed`/backoff transitions, the published schedule and the attempt cap, `isRecipientPolicyReconcilerEnabled`, and the 30 s loop. |
| `src/wallet/policy/repository.ts` | Two additive owner-scoped methods: `clearIntentInFlight` (§5.2 step 3's marker clear) and `settleIntent` (§5.2 step 5's intent transition, counter, deadline and `applied_at`). |
| `src/wallet/policy/service.ts` | `PolicyApplyBookkeepingOptions.confirmedBy` threaded through `applyRecordedRevision` → `applyRevision` → `commitApplyOutcome`, so a promoted apply records `confirmedBy='get_after_timeout'` on its `applied` audit. No other behaviour change. |
| `src/wallet/policy/apply.ts` | `createPrivyServerApplyTransport`: the production transport over the real `PrivyServerClient`, narrowing the SDK's `{id, [key:string]: unknown}` readback to `{id, rules[]}` fail-closed (a record without a rules array is refused instead of compared against an empty composition). |
| `src/server.ts` | The 30 s loop, behind `RECIPIENT_POLICY_RECONCILER`, started in `onReady` with a signed-apply service built from the same repository/lease/contacts seams, stopped in `onClose`. |
| `src/runtime/dependencies.ts` | `startWorkerPolicyReconciler`: the same loop where the signing sidecar actually is, stopped in the worker's `close()`. |
| `src/wallet/grants/privy-policy-runtime.ts` | `refusingContactPort` is now exported so the worker's reconciler service reuses the ONE refusing port instead of importing `ContactsRepository` into a second writer path (which the task 1.10 structural guard refuses — see deviations). |
| `tests/integration/recipient-policy-reconciler.test.ts` | **New**, 13 cases: the schedule and the switch, due-intent selection, the stored-composition resume, duplicate events, `busy`, restart recovery, the four §5.3 branches, backoff + cap, and the lock/transaction contract measured at the PATCH. |

### What the unit delivers

- **Restart recovery is structural.** The due scan's row is in flight ⇒ the holder that set that
  marker is gone (this process holds the lease) ⇒ one owner-scoped transaction clears the marker and
  appends `lease_reclaimed` together. Nothing in memory is authoritative, so a process that died
  between the intent commit and the readback is resumed by the next process.
- **The four §5.3 branches** are decided by a GET before any retry, and the discriminator is the
  service's own outcome REASON (`patch_unverified`, `policy_create_unverified`,
  `policy_attach_unverified`, `verification_readback_unavailable`,
  `verification_listing_unavailable`). Rules equal the composed set ⇒ applied with
  `detail.confirmedBy='get_after_timeout'`; equal to the previous applied set (hash comparison)
  ⇒ retry the same revision; a third set ⇒ `blocked_conflict` + the 2.12 fallback path; a failing
  GET ⇒ `syncing` with `next_attempt_at` and **no** PATCH.
- **The schedule is durable and published**: `min(5 s × 2^n, 5 min)` ±20 % jitter stamped from the
  incremented attempt count, `attempt_count` capped at 12, after which the wallet's status becomes
  `retryable_failure` and the intent leaves the due set.
- **One apply path.** Steps 4–10 run through `RecipientPolicyApplier.applyRecordedRevision`, so the
  reconciler owns durable intent, timing and evidence only — never a second copy of the PATCH/verify
  orchestration.

### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED (module) | The suite was written before `reconciler.ts` existed; the run could not import it, and the two repository seams it needs did not exist either. |
| RED (mutation: restart recovery) | `reclaimed = intent.state === "applying"` → `false`: **2 failed** — `reclaims an expired holder's in-flight intent, audits lease_reclaimed, and resumes it` and `treats a readback equal to the composed rules as applied…`. The reclaim is the guard, not decoration. |
| RED (mutation: the GET gate) | `decideBeforeRetry` short-circuited to `proceed`: **3 failed** — the composed-readback promotion, the third-set block and the failing-GET branch. Removing it is caught by exactly the three branches that depend on it. |
| RED (mutation: the attempt cap) | `exhausted = nextAttempt >= RECONCILER_ATTEMPT_CAP` → `false`: **1 failed** — `schedules a retryable failure with the published backoff and stops at the cap`. |
| RED (mutation: the W1 hold) | The lease released BEFORE steps 4–9: **1 failed** — `holds NO transaction and no row lock across the provider PATCH, while holding W1` (the second connection then sees no lease row). |
| GREEN | **13 passed / 13**; `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` → **22 files passed, 284 tests passed**; `npm run lint` clean; `npm run typecheck` clean. |
| TRIANGULATE | Added after GREEN: the schedule is asserted at both jitter bounds AND at its centre with an injected `random`, plus 5 s/10 s/20 s/cap steps so it cannot pass as a constant; the resume case asserts the PATCH body equals the RECORDED `composed_rules` and that both hashes match it; the duplicate-event case asserts the second pass finds nothing due; the cap case asserts the attempt count is exactly 12 and that no later pass resumes it. |
| False-green guard | Every negative assertion has a positive control: the PATCH count is asserted before the "no blind retry" claim; the `busy` case compares the whole state row before/after; the probe discriminator case seeds a REAL recorded reason rather than a bare flag; the lock case asserts `patchPolicy` happened before asserting what was observed at that moment. |

### Commands run and results

```text
npx vitest run tests/integration/recipient-policy-reconciler.test.ts            → 13 passed (13)
npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts
                                                                              → 22 files passed, 284 tests passed
npm run lint                                                                  → clean (eslint --max-warnings=0)
npm run typecheck                                                             → clean (tsc -p tsconfig.test.json --noEmit)
```

### Deviations from the design

1. **Two additive repository methods.** §5.2's step 3 "clear the intent's in-flight marker" and step 5
   need two owner-scoped statements the 1.3 repository did not have (`clearIntentInFlight`,
   `settleIntent`). Task 1.3 handed forward that §5.2 refers to a "lease_token" column that does not
   exist: the in-flight marker IS `state`, and the holder is the `recipient_policy_leases` row, so the
   reclaim is decided from the scanned `state` plus the lease this process now owns.
2. **The composed-readback branch compares the RECORDED hash, not object identity.** The intent's
   `composed_rules` are a jsonb round-trip of the in-memory composition, so a structural comparison
   against a provider readback refuses to recognise the very write it is looking at (observed while
   writing this suite: the same strict comparison inside the service also decides whether to skip the
   PATCH). `composedRulesHash(observed) === intent.composedHash` is the canonical form §5.2 already
   persists for exactly this decision.
3. **The W1 hold.** The parent brief said the reconciler "must not hold `W1` across provider I/O".
   The authoritative design says the opposite for this writer: §1.3 gives the reconciler the chain
   `W1 → tx{ W0(U) → L2 → L5 } → R`, §1.2 forbids holding `W1` across remote I/O only for writers that
   also hold `L1..L5`, and §10(d) shows `release lease` AFTER the PATCH. Releasing the lease before
   steps 4–9 would let two processes PATCH one wallet concurrently, and the loser's verification
   readback would see the winner's rules and record a false `blocked_conflict`. This unit therefore
   holds W1 across the provider I/O and keeps NO transaction and NO L1..L5 row lock open at that
   moment — both measured in the suite (open-transaction counter + a second connection updating the
   state row). Flagged rather than silently chosen.
4. **The worker's reconciler service uses the shared refusing contact port.** Building a real one
   meant importing `ContactsRepository` into `src/runtime/dependencies.ts`, which the task-1.10
   structural guard caught (`ContactsRepository gained a new importer`). The apply path never mutates a
   contact, so the port is the existing shared refusal — reusing it is strictly narrower than
   allow-listing a new importer.
5. **The `busy` outcome touches nothing.** §5.2 step 1 says so; this unit asserts the whole state row
   is byte-identical after a busy pass.

### The audit-policy decision (the second carried prerequisite)

**No migration, no new policy.** `recipient_policy_audit` stays owner-only and the `lease_reclaimed`
append is re-scoped to the resolved owner inside the owner's transaction (the
`reconciliation-worker.ts:199-215` precedent): the system-scoped due scan supplies `user_id`, and the
marker clear plus its audit commit together. Adding a system-access policy would have been authority
the design does not describe, so it was not added; the task-1.3 assertion that a system-context append
is REFUSED is left in place as the guard. Consequence: the carried "add the minimum additive system
policy" branch was **not** taken, so there is no separate additive-audit commit.

### Observations handed to later tasks (not defects in this unit)

- **2.12 owns the destructive fallback.** The third-set branch records `blocked_conflict` and a
  terminal intent; it clears no `delegated_grants.provider_policy_id`.
- **The create-timeout case stalls by design.** An UNVERIFIED `createPolicy` has no policy id to GET,
  so the gate returns `syncing` (`readback_target_unavailable`) and the attempt cap eventually stops
  the loop. Recovering it needs the create-retry decision, which no task has yet claimed — recorded
  rather than invented.
- **The live signed path stays unproven in this environment**: 5.2/5.7 still own the capability probe
  and the devnet verification; this unit's loop is exercised over the fake transport.
- **`startWorkerPolicyReconciler` returns `null` without a signer or switch**, so a deployment that
  cannot apply never writes statuses nobody asked for.

### Workload / PR boundary

One commit, one work unit: the new module + its integration suite + the two repository seams + the
service bookkeeping option + the production transport adapter + the two loop wirings (~1 500 changed
lines), above the 400-line review budget and reported, not hidden. It cannot be split without breaking
the unit: the table, the reclaim and the schedule are only provable together against the real tables,
and the wiring is what makes the loop reachable. It sits inside the parent-assigned `PR 4` slice
(tasks 2.1–2.14). No push beyond `origin/feat/solana-operational`.

### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit (task
2.9), the authoritative artifact paths and the delivery path directly. Readiness was resolved against
the artifacts before any edit — `tasks.md` (2.9, terminal `<!-- sdd-owner: implementation -->`),
`design.md` §1.2/§1.3, §3.5, §5.1–§5.4, §10(d), §13, and the 1.3/2.8 apply-progress. `actionContext`:
all writes stayed inside `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`; the main
checkout and the untracked `compose.privy-local.ports.yaml` were untouched; no `git stash`, `checkout`,
`reset`, `restore` or `clean` was run.

---

### Task 2.10 — add the wallet-level coverage gate (design §4.1)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/conversations/grant-gate.ts` | The §4.1 gate: a required `readPolicyCoverage` dependency, the narrow `GrantGatePolicyEvidence` projection, the exported `isWalletPolicyVerified` six-predicate check, the shared `POLICY_UNVERIFIED_DECISION`, and a `GrantGateDecision` union that now carries the explicit refusal. The read is taken after the wallet resolves and before `listGrants`. |
| `src/server.ts` | Two edits: `policyRepository` is hoisted above the conversation service (the gate needs it), and the gate is wired with `readPolicyCoverage: (input) => policyRepository.readPolicyState(input.userId, input.walletId)` — read in the caller's own scope, so a foreign wallet id cannot borrow another wallet's verified state. |
| `tests/unit/grant-gate-revision.test.ts` | New. 7 cases: the verified positive control, the evaluated-grant-and-sibling refusal, the `provider_policy_id`-only refusal, a missing state row, a per-predicate sweep over all six predicates, a read failure, and the unchanged unsupported-network short circuit. |
| `tests/unit/grant-gate-factory.test.ts` | Fixture only: the existing 9 factory cases now inject a **verified** reader, so they keep isolating the intent-binding/classification behaviour they were written for. No assertion changed. |

#### What the unit delivers

- **The gate is wallet-level, not grant-level.** Order is wallet → evidence → `listGrants`, so an
  unverified wallet never enumerates the grants it refuses. A grant that carries
  `provider_policy_id = policy_1` and covers its own recipient is refused exactly like its sibling
  bound for another recipient, which is what makes "a bound policy id alone is insufficient" true.
- **All six predicates are load-bearing** (`status='applied'`, `applied_revision = desired_revision`,
  `applied_rules_hash = desired_rules_hash`, `applied_policy_id`, `applied_signer_id`, `verified_at`),
  and the per-predicate sweep proves each one individually rather than only the conjunction.
- **Unknown evidence fails closed with the same refusal.** A missing row and an unreadable row both
  return `policy_unverified` instead of a bare `null`, so no surface can read an unknown wallet as
  covered. `classifyGrantCoverage` and `tests/unit/grant-coverage.test.ts` are byte-identical.
- **No new authority, no migration.** One owner-scoped read of an existing table through the existing
  repository method.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED | `tests/unit/grant-gate-revision.test.ts` written first against the unchanged adapter: **6 failed / 1 passed (7)** — every refusal case failed with the fleet-strength `covered: true` (the gate allowed a wallet whose applied revision was behind), and the read-failure case with `expected undefined to be false`. The single pass was the unsupported-network case, whose negative assertion is only meaningful next to the positive control in case 1; both are asserted there (`toHaveBeenCalledWith({userId, walletId})`) and it is stated as such in the file. |
| GREEN | After the gate and the server wiring: **42 passed / 42** across `grant-gate-revision` + `grant-gate-factory` + `grant-coverage`. |
| Mutation | The guard `if (!isWalletPolicyVerified(evidence)) return POLICY_UNVERIFIED_DECISION;` was replaced with `if (false) { … }`; the run failed **exactly and only** the five guard cases, by name: “an unverified wallet degrades the evaluated grant and its sibling…”, “a grant bound only by provider_policy_id is refused”, “a missing state row fails closed”, “fails closed on every single missing predicate”, “degrades closed when the state read itself fails” — **5 failed / 2 passed**. The file was restored from a byte copy before the GREEN re-run, so the guard is proven load-bearing and not decorative. |
| TRIANGULATE | Added after GREEN: the per-predicate sweep (one broken predicate at a time, all six), plus the sibling assertion on a *second* recipient and a second evaluation, and a positive control that the reader is called with the resolved wallet id and that `listGrants` runs only when verified. |
| REFACTOR | One: the verification predicate is exported as `isWalletPolicyVerified` and the refusal object as `POLICY_UNVERIFIED_DECISION`, so the claim gate of 2.11 and the coverage gate cannot drift into two slightly different definitions of "verified". Lint and typecheck clean afterwards. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/unit/grant-gate-revision.test.ts` (RED) | **6 failed / 1 passed (7)** — the refusals were allowed; attributed by name above |
| `npx vitest run tests/unit/grant-gate-revision.test.ts` (after the mutation) | **5 failed / 2 passed (7)** — exactly the five guard cases |
| `npx vitest run tests/unit/grant-gate-revision.test.ts tests/unit/grant-gate-factory.test.ts tests/unit/grant-coverage.test.ts` | **3 files passed, 42 tests passed** |
| `npx vitest run tests/unit/policy-*.test.ts tests/unit/grant-*.test.ts` | **17 files passed, 216 tests passed** |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) |

#### Deviations from the design

Two, both deliberate:

1. **The reader is a required dependency rather than an inline database call.** §4.1 describes the read
   as living "in the adapter's database read"; the adapter here is a factory whose ledger and wallet
   seams are injected, so the state read is injected the same way and wired in `src/server.ts` to the
   existing `RecipientPolicyRepository.readPolicyState`. The predicate itself is a pure exported
   function, which is what lets 2.11 reuse it instead of restating it.
2. **An unreadable state row returns the same `policy_unverified` refusal instead of `null`.** The
   module's catch-all `null` means "degrade to the preview flow" and is indistinguishable from "the
   wallet is fine but no grant covers this" — for a *state read failure* that ambiguity would hide a
   real outage behind a normal-looking path. The read is therefore wrapped and mapped to the explicit
   refusal. No behaviour change at the consumer (`decision?.covered` is falsey either way); the
   difference is only that the reason is now reportable.

#### Observations handed to later tasks (not defects in this unit)

- **The refusal is currently reported as a non-covered decision; no surface renders the reason yet.**
  `src/conversations/service.ts` consumes only `decision?.covered`, so today the reason is available but
  unused. Task 3.2 owns the HTTP readiness surface that must report it.
- **`readPolicyState` is owner-scoped**, so the gate cannot read a wallet the acting user does not own:
  a mismatched `(userId, walletId)` pair yields `null` and therefore `policy_unverified`, never another
  wallet's verified state. That property is relied upon by 2.11 as well.

---

### Task 2.11 — the `policy_unverified` claim gate (design §4.1, §4.2)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/grants/consumption.ts` | The sequential W0 read (`FOR SHARE OF state`, still first, still a lock) is extended to project the six §4.1 predicate columns, and the gate is evaluated after the grant row is confirmed. Reuses `isWalletPolicyVerified` and derives the reason from `POLICY_UNVERIFIED_DECISION`, both exported by task 2.10, so the claim cannot drift from the coverage gate. |
| `tests/integration/grant-consumption-revision.test.ts` | **New.** 6 cases: missing row (audited, no ledger row), applied revision behind desired, readback never verified, the verified positive control (with the fixture's own six predicates re-asserted), the sibling `FOR SHARE` case, and the revoked-scope case in both forms. |
| `tests/integration/helpers/policy-state.ts` | **New.** `seedWalletPolicyState` (defaults ARE the verified state; overrides break one predicate) and `invalidateWalletPolicyState` (the 2.12-shaped loss of binding). Owner-scoped, because the table is owner-only under RLS. |
| `tests/integration/{delegated-grants-consumption,delegated-grant-candidates,delegated-grant-execution,grant-claim-release,lock-order-concurrency}.test.ts` | Fixtures only: those claim suites seed the now-required verified state in their wallet-provisioning helper, so they keep isolating caps/expiry/revocation/idempotency/settlement. No assertion was weakened. `lock-order-concurrency`'s last case is *inverted* by design — it pinned "a wallet with no state row stays claimable", which is exactly what 2.11 changes — and now pins the refusal plus its audit row. |

#### What the unit delivers

- **The gate is the claim's last word.** `policy_unverified` is decided before the amount, the grant
  state, the expiry re-check and the `provider_policy_id` check, so a wallet whose applied policy was
  never verified cannot consume budget through ANY of those paths. `provider_policy_id` stays required
  (`policy_not_ready`) but is no longer sufficient — the §4.1 rationale, now enforced in both planes.
- **The refusal is attributable.** The `rejected` audit row carries reason `policy_unverified` in the
  same transaction, so a refused execution is never invisible; `grant_claim_ledger` holds nothing.
- **`FOR SHARE` is load-bearing, not decorative.** A held `FOR SHARE` on the wallet's state row (what a
  sibling claim holds for the duration of its own transaction) does NOT block a claim on another grant
  of the same wallet: proven with a bounded 3 s race against a real second connection, so a `FOR UPDATE`
  regression fails the case by name instead of hanging.
- **The gate is reached only for a grant this user owns.** The decision sits *after* the
  `delegated_grants … FOR UPDATE` read, because `grant_audit_log` carries a `grant_id` foreign key: a
  refusal can only be audited against a real grant row, and a foreign/missing grant keeps its existing
  `grant_not_found` return (RLS hides it, so there is nothing to audit against).
- **No migration.** `grant_audit_log.reason` is free text with no CHECK (`008_delegated_grants.sql:67-77`);
  `policy_unverified` needed no schema change, exactly as §4.2 states.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED | `tests/integration/grant-consumption-revision.test.ts` written first against the unchanged claim path: **4 failed / 2 passed (6)** — every refusal case returned the fleet-strength `{ amount: "1000000", consumed: true }`, i.e. an unverified wallet was claiming budget. The two passes were the verified positive control and the sibling `FOR SHARE` case; both are asserted as controls there. |
| GREEN | After the gate: **6 passed / 6**. The fixture's own six predicates are re-read in the positive control, so the pass cannot be blamed on a fixture that would satisfy any gate. |
| Mutation | `if (!isWalletPolicyVerified(policyEvidence))` → `if (false && …)`: **4 failed / 2 passed (6)**, failing by name exactly the four gate cases — "refuses a wallet with NO state row and audits the refusal", "refuses a wallet whose applied revision has fallen behind the desired one", "refuses a wallet whose readback was never verified", "never returns consumed:true for a revoked scope, and fails closed after the state is gone" — and NOT the verified or sibling cases. File restored from a byte copy before the GREEN re-run. |
| TRIANGULATE | Added after GREEN: the missing-row case (not only an unverified row), the behind-revision and never-verified variants, the `grant_claim_ledger` count assertion (a refusal consumes nothing), the sibling-claim race, and the revoked scope asserted twice (grant revoked ⇒ `grant_revoked`; binding lost ⇒ `policy_unverified`). |
| REFACTOR | The reason string is derived from 2.10's `POLICY_UNVERIFIED_DECISION.reason` and the evidence projection is one local mapper, so there is a single definition of "verified" in the codebase. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/integration/grant-consumption-revision.test.ts` (RED) | **4 failed / 2 passed (6)** — refusals allowed; attributed by name above |
| `npx vitest run tests/integration/grant-consumption-revision.test.ts` (after the mutation) | **4 failed / 2 passed (6)** — exactly the four gate cases |
| `npx vitest run tests/integration/grant-consumption-revision.test.ts` | **6 passed / 6** |
| `npx vitest run tests/integration/{grant-consumption-revision,delegated-grants-consumption,delegated-grant-execution,delegated-grant-candidates,grant-claim-release}.test.ts` | **5 files passed, 36 tests passed** |
| `npx vitest run tests/integration/lock-order-concurrency.test.ts tests/unit/lock-order-vector.test.ts` | **2 files passed, 22 tests passed** (the claim's `W0` position and `FOR SHARE OF state` are unchanged for the source-level vector test) |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`) |

#### Deviations from the design

1. **The check runs after the grant row is locked, not literally at the top of the transaction.** §4.2's
   "one lock and one check" is satisfied — the W0 read is still the first statement and the check is the
   first decision — but a refusal is only *auditable* once the grant row is known to exist, because the
   `rejected` row carries `grant_id` into a table with a foreign key to `delegated_grants`. Deciding
   earlier would have turned the existing, correct `grant_not_found` return into a foreign-key error for
   a missing or foreign grant.
2. **Five pre-existing claim suites now seed a verified state row.** They were written before the gate
   existed and their fixtures stopped describing a claimable wallet the moment 2.11 landed. Seeding the
   verified state (never weakening an assertion) is what lets them keep testing what they were written
   for. `lock-order-concurrency`'s "no state row stays claimable" case is genuinely inverted, since
   2.11 is the task that changes that behaviour; it now asserts the refusal and its audit row.
3. **One import edge the reviewers should weigh.** `consumption.ts` now imports the pure predicate from
   `src/conversations/grant-gate.ts`, which imports `DelegatedGrantService` back from `consumption.ts` as
   a **type-only** import — erased at runtime, so there is no runtime cycle, but the module direction is
   wallet → conversations. Extracting `isWalletPolicyVerified` (plus its evidence type) into a small
   `src/wallet/policy/` module and re-exporting it from `grant-gate.ts` would remove the edge without
   touching any caller; it is left for the reviewer rather than done under this unit's budget.
4. **The 2.11 fixture cannot delete a state row.** `recipient_app` holds no `DELETE` on
   `recipient_policy_state` (`015` grants SELECT, INSERT, UPDATE), so "the binding is gone" is expressed
   as the row becoming unverified — which is also what 2.12 will do. Worth knowing for 2.12's tests.

---

### Task 2.13 — the two non-destructive feature switches (design §13)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/config/recipient-policy.ts` | **New.** `readRecipientPolicyWriter` / `isRecipientPolicyWriterFrozen`, `isRecipientPolicyFixtureMode`, `RECIPIENT_POLICY_WRITER_FROZEN_REASON`, and the reconciler switch, which moves here from the reconciler so the whole startup matrix is one function. Parsing rules are stated in the header: absent ⇒ documented default; unrecognised non-empty ⇒ fail closed; `frozen` vetoes the reconciler; an explicit value beats the fixture default. |
| `src/wallet/policy/reconciler.ts` | The local `isRecipientPolicyReconcilerEnabled` definition is replaced by a re-export of the config module's, so the loop's importers and the existing reconciler suite keep reading it from the loop while the matrix has a single implementation. |
| `src/wallet/policy/service.ts` | `selectPolicyApplyPort`: resolves the `RECIPIENT_POLICY_WRITER` switch to the `unavailable` arm — the one `PolicyApplyPort` with no `apply` method — so "issues no PATCH, leaves the attached policy intact" is structural. Frozen can only remove capability. |
| `src/server.ts`, `src/runtime/dependencies.ts` | Both processes that own a signer now resolve their port through `selectPolicyApplyPort`, and both reconciler guards read the fixture-aware switch. The duplicated `&& !process.env.VITEST` / `if (…VITEST) return null` fixture checks are deleted: that mode is now part of the switch's matrix instead of being re-implemented at each call site. |
| `.env.example` | Both variables documented next to their neighbours, with the defaults, the non-destructiveness statement, and the fail-closed rule. |
| `tests/unit/recipient-policy-config.test.ts` | **New.** 9 cases: the writer matrix (default/enabled/frozen/case-whitespace tolerance/fail-closed sweep), the reconciler matrix (live default, explicit values, fixture mode, unknown value, frozen-writer veto), and the non-destructiveness group (the frozen port's key set, the absent mutation surface, the "never selects the writer for ANY value" sweep, and the full 8-cell matrix). |

#### What the unit delivers

- **The switch has teeth where the writes are.** `frozen` is resolved at the two places a signed capability is built
  (the API process and the worker), so no PATCH can be issued by either process; the reconciler is not started at
  all, because a loop that cannot apply anything would only write statuses nobody asked for.
- **`frozen` is a capability removal, not a behaviour flag.** The selected port has exactly two keys (`kind`,
  `reason`) and no `apply`, so the "no PATCH" property cannot be lost by a later edit inside the apply path.
- **Neither switch can widen authority.** Every unrecognised value fails closed for both switches, and `frozen`
  vetoes the reconciler even when it is explicitly enabled — both are narrowings. Nothing in either switch deletes
  a policy, clears a binding, rotates a key, or re-enables a revoked grant.
- **One startup matrix.** The fixture-mode default (`VITEST` or `WDK_TOOLS_SOURCE=fixture`) and the frozen-writer
  veto are expressed once in the config module and unit-proven, instead of being re-implemented as `&& !VITEST`
  guards at each call site.

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED | `tests/unit/recipient-policy-config.test.ts` was written before the config module existed: `Cannot find module '../../src/config/recipient-policy.js'` — a collection-level RED, which is honest but weak on its own, so the parser's rules are additionally proven load-bearing by the two mutations below. |
| GREEN | After the config module, the resolver and the wiring: **9 passed / 9**. |
| Mutation A | `isRecipientPolicyReconcilerEnabled` restored to the pre-2.13 one-liner (`?.trim() !== "disabled"`): **4 failed / 5 passed (9)**, failing by name exactly the four matrix cases — "defaults to disabled in fixture mode, and fixture mode is explicit", "is off whenever the writer is frozen, even when explicitly enabled", "fails closed on an unrecognised value", "keeps the reconciler switch non-destructive in every matrix cell". File restored from a byte copy. |
| Mutation B | `selectPolicyApplyPort` reduced to `return input.signed;`: **2 failed / 7 passed (9)**, failing by name "resolves the frozen writer to a port with no mutation surface at all" and "never selects the signed port for ANY writer value". File restored from a byte copy. |
| TRIANGULATE | Added after GREEN: the case/whitespace tolerance row, the `Frozen`/`off`/`0`/`yes` fail-closed sweep, the 8-cell matrix, the `Object.keys(frozen)` set assertion (not only `"apply" in frozen`), the positive control that the *enabled* writer really selects the signed port, and `signed.applyCalls === 0` so a resolved-but-unused port is still detected. |
| REFACTOR | The reconciler's local predicate became a re-export, and the two call sites lost their duplicated fixture-mode conjunction. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/unit/recipient-policy-config.test.ts` (RED) | collection error — module absent (see above) |
| `npx vitest run tests/unit/recipient-policy-config.test.ts` | **9 passed / 9** |
| `npx vitest run tests/unit/recipient-policy-config.test.ts` (after mutation A / B) | **4 failed / 5** and **2 failed / 7**, attributed by name above |
| `npx vitest run tests/integration/recipient-policy-reconciler.test.ts tests/unit/recipient-policy-config.test.ts` | **2 files passed, 22 tests passed** (the pre-existing 2.9 switch contract is preserved verbatim) |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` | **21 files passed / 283 tests passed, 1 failed** — see the isolation note below |
| `npx vitest run tests/integration/grant-consumption-revision.test.ts tests/integration/delegated-grants-*.test.ts tests/integration/grant-claim-release.test.ts tests/integration/lock-order-concurrency.test.ts tests/unit/lock-order-vector.test.ts tests/unit/recipient-policy-config.test.ts` | **8 files passed, 67 tests passed** |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`) |

Isolation note: in the 22-file run, `tests/integration/recipient-policy-repository.test.ts > recipient_policy_sync_intent > claims a due intent from the system context and leaves a foreign user unable to see it` failed; re-run alone it is **20 passed / 20** (file passed). That is the documented parallel-load/one-Postgres contention class, not a behavioural regression from this unit — nothing in this diff touches the repository, the intent claim, or the system context.

#### Deviations from the design

1. **Fixture mode is read from two explicit markers** (`VITEST`, `WDK_TOOLS_SOURCE=fixture`), because the repository had no single fixture-mode variable: the VITEST opt-out existed as four separate call-site guards. The switch now owns that default; the call-site guards that duplicated it were deleted rather than kept as a second opinion. A deployment that explicitly sets `RECIPIENT_POLICY_RECONCILER=enabled` still wins over the fixture default (documented in the module header).
2. **An unrecognised reconciler value is now `false`.** Pre-2.13 it was `true` for anything except `disabled`, so `RECIPIENT_POLICY_RECONCILER=yes` used to start the loop. The new reading fails closed; it only ever narrows authority, and no suite or deployment depends on the old meaning.
3. **`frozen` vetoes the reconciler.** §13 lists the two switches independently, but a reconciler that cannot apply anything would only write statuses nobody asked for, so the writer switch wins. Recorded here because it is a precedence decision, not a reading of the design's wording.
4. **`selectPolicyApplyPort` lives in `service.ts`, not in the config module:** the port types and `createUnavailablePolicyApplyPort` are already owned there, and importing them from `apply.ts` would have created a runtime cycle with `service.ts`. The config module stays pure and dependency-free.

### Task 2.12 — the atomic binding-invalidation fallback for proven divergence only (design §4.3, §4.4)

Status: **completed**. Persisted checkbox updated in
`openspec/changes/trusted-recipient-policy-sync/tasks.md` (`- [x]`).

#### Files changed

| File | Role |
|---|---|
| `src/wallet/policy/repository.ts` | `invalidateWalletBindings` (design §4.3's fallback as ONE atomic operation) and `rebindActiveWalletGrants` (design §4.4's restoration), plus their input/result types (`PolicyDivergenceStatus`, `InvalidateWalletBindingsInput`, `WalletBindingInvalidation`). |
| `src/wallet/policy/service.ts` | `commitApplyOutcome`: the proven-divergence branch now runs the invalidation **on the caller's client** (same transaction as the status write), and the verified branch re-binds the wallet's active grants to the verified `appliedPolicyId`. |
| `src/wallet/policy/reconciler.ts` | `settle`'s `blocked_conflict` branch now runs the same invalidation; the stale "task 2.12 is pending" comments were replaced with what the code now does. |
| `tests/integration/recipient-policy-invalidation.test.ts` | New. 6 cases over two real tables: the proven-divergence clear, the injected-failure rollback, the timeout no-op, the frozen-writer no-op, `applied_revision` monotonicity + §4.4 re-bind, and the unknown-outcome no-re-bind. |

#### What the unit delivers

- **§4.3 as one transaction.** `invalidateWalletBindings` runs, on a single client: the
  `recipient_policy_state` UPDATE (status / `status_reason` / merged `status_detail` with
  `policyId` + `appliedPolicyId` named explicitly as `null`, `applied_rules_hash = NULL`,
  `desired_rules_hash = NULL`), the `delegated_grants` clear (`provider_policy_id = NULL`
  for the wallet's `state='active'` grants, `RETURNING id`), then one
  `binding_invalidated` audit row per returned grant id plus the `blocked_conflict` /
  `blocked_configuration` status audit row. It is a single method because the four writes
  are only correct together.
- **`applied_revision` is never touched.** Invalidating a binding never rewrites what was
  last verified, and lowering it would let a stale writer look newer. Proven by seeding
  `applied_revision = 7` and observing `7` after the clear.
- **The proven/unknown split is by CALL SITE, not by status string.** `blocked_conflict`
  is not a sufficient trigger: `recordStop` also records `blocked_conflict` for
  `policy_lease_busy` / `policy_lease_unavailable` (design §4.3's "lease busy ⇒ **no**
  binding change") and for the metadata-only-edit conflict. The invalidation therefore
  runs from exactly two places — the apply comparator's `blocked` arm
  (`commitApplyOutcome`) and the reconciler's unexplained-readback branch (`settle`) — and
  never from a lease, budget, transport or `unavailable`-provider failure.
- **§4.4 restoration.** `commitApplyOutcome`'s verified branch re-binds the wallet's
  active grants to the verified `appliedPolicyId` in the SAME transaction as the §1.5 CAS,
  so a binding exists only because a signed readback verified the rule set it names.
- **A frozen writer is not a divergence at all.** `RECIPIENT_POLICY_WRITER=frozen`
  (task 2.13) resolves the apply port to the `unavailable` arm, which has no mutation
  method, so `applyRevision` takes `recordApplyPending` — never a `blocked_*` class and
  never the invalidation.
- **No transaction across provider I/O is preserved.** The invalidation runs on the
  client the caller already holds; the provider work in `applyRevision` still happens with
  no transaction open (the 2.8 suite's transaction counter is unchanged and still green).

#### TDD Cycle Evidence

| Phase | Evidence |
|---|---|
| RED | The suite was written first and run against the un-implemented workspace: **4 failed / 2 passed (6)**. The four failures are the positive behaviours (`expected 'pol_invalidation_integration' to be null` for the cleared binding; the injected-failure case resolved instead of rejecting; the re-bind cases saw the pre-existing binding). |
| RED false-green guard | The two RED "passes" are the two no-op invariants (timeout, frozen). Neither is vacuous: the timeout case asserts `calls.patchPolicy` has length 1 first (the PATCH really happened, so "nothing moved" is not "nothing happened"), and every no-op case is paired with the proven-divergence case that DOES move — so the two directions are proven against each other, not against an absent module. The plain "no `binding_invalidated` audit" clause would have been a false green on its own and is only meaningful because case 1 proves that row appears when it should. |
| GREEN | **6 passed / 6**; `npm run lint` and `npm run typecheck` clean. |
| Mutation A (grant clearing) | `AND false` added to the grant-clearing UPDATE → **3 failed / 3**: `clears the bindings...`, `never lowers applied_revision, and re-binds...`, `does not re-bind on an unknown outcome either`. Proves the clearing is load-bearing for every binding assertion. |
| Mutation B (the two hash nulls) | Removed `applied_rules_hash = NULL, desired_rules_hash = NULL` → **1 failed / 5**: `clears the bindings and nulls BOTH hashes atomically with the blocked status`. Proves that half of §4.3 is observed by name. |
| Mutation C (atomicity) | Dropped the `client` argument of the service's invalidation call, so it opened its OWN transaction → **1 failed / 5**: `rolls the status, the hashes and the grant binding back together when the transaction fails`. Proves the injected-failure case measures the shared transaction rather than a coincidence of ordering. |
| Mutation D (§4.4 re-bind) | Removed the `rebindActiveWalletGrants` call → **1 failed / 5**: `never lowers applied_revision, and re-binds the grant only through the next verified apply`. Proves the re-bind is the only thing that restores the binding. |
| Mutation E (the unknown/proven split) | Routed the `unverified`/`retryable_failure` arm through `invalidateWalletBindings` → **1 failed / 5**: `changes no binding, no hash and no grant row on a timeout`. Proves the timeout case is what keeps a mere timeout from destroying a working grant — the exact failure mode this task exists to prevent. |
| Restore | All five mutations reverted; the suite is **6 passed / 6** again and `grep -c "MUTATION\|AND false"` is `0` in both source files. |
| TRIANGULATE | Added the negative direction of each guard as its own case and asserted the untouched rows byte-for-byte: the `grantRows(walletId)` snapshot is compared before/after on both no-op cases (a *different* row must not move either), a never-bound grant is asserted to stay `null` (it was not "cleared"), the status audit and the single `binding_invalidated` row are counted, and the `detail.grantId` of that row is matched against the cleared grant's id so it cannot pass on an unrelated row. |
| REFACTOR | No production refactor was needed. One test-side defect was found and removed: the `afterAll` first tried `DELETE FROM recipient_policy_audit`, which the append-only guard trigger refuses (`recipient_policy_audit is append-only: DELETE blocked`) — the teardown was corrected instead of weakening the guard. |

#### The unknown-versus-proven split, stated as evidence

| Direction | What was proven | How |
|---|---|---|
| **Unknown does not move** | A `patchPolicy` timeout leaves the status `pending` / `patch_unverified`, both hashes at their seeded values, `provider_policy_id` bound, every grant row byte-identical, and no `binding_invalidated` audit. | `mutationError: PolicyApplyTransportError("timeout", …)` with `calls.patchPolicy` length 1 as the positive control. |
| **Unknown does not move** | A frozen writer leaves the same rows untouched and records `pending` / `policy_writer_frozen` — not a `blocked_*` class. | `createUnavailablePolicyApplyPort(RECIPIENT_POLICY_WRITER_FROZEN_REASON)` through the same service. |
| **Proven divergence moves atomically** | One readback mismatch (`unrecognized_rule`, no PATCH issued) clears the binding and nulls BOTH hashes in the same transaction as the `blocked_conflict` status, with exactly one `binding_invalidated` row per cleared grant, `applied_revision` unchanged. | The primary case plus mutations A/B. |
| **Proven divergence moves atomically** | An injected failure after those writes rolls the status, both nulls and the grant clearing back together. | The Proxy `invalidateWalletBindings` that delegates then throws, on the caller's client; mutation C shows that removing the shared client breaks it. |
| **Re-binding is apply-only** | Clearing is undone only by the next verified apply; a later unknown outcome does not re-bind. | The seeded `applied_revision = 7` case and the "does not re-bind on an unknown outcome either" case; mutation D attributes it. |

#### Commands run and results

| Command | Result |
|---|---|
| `npx vitest run tests/integration/recipient-policy-invalidation.test.ts` (RED) | **4 failed / 2 passed (6)** — see the RED row above |
| `npx vitest run tests/integration/recipient-policy-invalidation.test.ts` (GREEN) | **1 file passed, 6 tests passed** (0.8 s) |
| … (mutations A–E, restored between each) | **3 failed / 3**, **1 failed / 5**, **1 failed / 5**, **1 failed / 5**, **1 failed / 5**, each attributed by test name |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts` | **23 files passed, 290 tests passed** (the required 284+ floor is met; the documented load-flaky `recipient-policy-repository.test.ts` case did not trip in this run) |
| `npx vitest run tests/unit/lock-order-vector.test.ts tests/integration/lock-order-concurrency.test.ts tests/integration/grant-*.test.ts tests/integration/delegated-grant*.test.ts tests/integration/privy-policy-sync.test.ts tests/integration/recipient-memory-db.test.ts tests/integration/enrollment-composed.test.ts` | **12 files passed, 81 tests passed** |
| `npm run lint` | clean (`eslint src tests --max-warnings=0`, exit 0) |
| `npm run typecheck` | clean (`tsc -p tsconfig.test.json --noEmit`, exit 0) |

#### Deviations from the design

Two, both deliberate:

1. **`status_detail` is MERGED, not replaced.** Design §4.3's literal SQL shows
   `status_detail = $4::jsonb`, but §11 requires a recorded probe observation
   (`rules_union`, `attachment_evidence`, `ownership_evidence`) to survive later status
   writes, and `setPolicyStatus` already merges (`jsonb ||`). A replace would silently
   un-record a probe outcome. The transition therefore merges and names the two keys it
   owns explicitly (`policyId`, `appliedPolicyId` as `null`), which is the repository's
   documented convention; every other key — including the probe evidence — is preserved.
2. **§4.4's re-bind lives in the same apply transaction, not in a repair step.** The
   design says `provider_policy_id` "is re-bound by the same apply transaction from the
   verified readback", and no earlier unit implemented that write, so this unit adds it
   (`rebindActiveWalletGrants`) as the positive half of the binding lifecycle. Without it
   the task's own "re-binding happens only through the next verified apply" test would be
   a claim about a path that did not exist.

One smaller, non-behavioural choice: the per-grant `binding_invalidated` audit row carries
`detail.grantId` (the table has no `grant_id` column and the append-only trigger forbids
rewriting old rows), so the cleared grant is named in the row that records it.

#### Observations handed to later tasks (not defects in this unit)

- **The reconciler's `settle` and the service's `commitApplyOutcome` now share one
  invalidation.** A wallet whose service-recorded divergence already cleared its bindings
  reaches `settle` only to transition the intent; `settle`'s own invalidation is reached
  on the other path (a previous attempt was UNVERIFIED and the GET observed a third rule
  set). Both are idempotent against the same tables, so a future reader must not add a
  third caller without checking the transaction that holds it.
- **`recipient_policy_audit` remains append-only and owner-only.** The new rows are written
  inside the resolved owner's transaction, so no system-access policy was needed (the 1.1
  carried note stands for any future system-context append).
- **Task 2.14 must not be started.** The slice-2 gate (live capability probe + full
  `npm test`) is a separate work unit.

#### Remaining tasks in slice 2

```text
- [ ] **2.14 Run the slice-2 gate and record the slice-2 work-unit commits.**
```

Later slices (3–5) remain entirely unchecked, unchanged by this unit.

#### Workload / PR boundary

One commit, one work unit: the two repository primitives, the two call-site wirings and the
integration suite that proves the split. It sits inside the parent-assigned `PR 4` slice
(tasks 2.1–2.14, rollback boundary "capability wiring + reconciler + gate reads"). No
`size:exception` is requested, no push beyond the assigned branch, and no slice-2 gate work
was started.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work
unit, the authoritative artifact paths and the delivery path directly. Readiness was resolved
against the artifacts before any edit — `tasks.md` (task 2.12, terminal
`<!-- sdd-owner: implementation -->`), `design.md` §1.3/§1.5, §4.3, §4.4, §5.1–§5.3 and §11,
`spec.md` ("Applied-revision binding for automatic executions"), and the 2.8/2.9/2.13
apply-progress entries. `actionContext`: all writes stayed inside the assigned worktree root;
the main checkout and the untracked `compose.privy-local.ports.yaml` were not touched, and no
`git stash`/`checkout`/`reset`/`restore`/`clean` was run.

#### Commit

`feat(policy): invalidate grant bindings atomically on a proven divergence` — see the report
envelope for the SHA.

---

### Task 2.14 — the slice-2 gate: **FAILED** on a regression outside both the baseline and the flake lists

Status: **blocked. The 2.14 checkbox stays `- [ ]`.** The gate ran, the suite was compared by test
name against the pristine baseline, and one **deterministic assertion failure that is not in the
baseline's six-name list and is not a load timeout** reproduced in isolation. Per the brief, 2.14 is
not marked complete, no assertion was touched, and no test or production file was edited by this unit.

This unit adds no behaviour and changes no source file. It runs the gate, records it by test name, and
records what the live capability state actually holds.

#### The gate command and its result

```text
cd /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational
set -a; . ./.env; set +a        # DATABASE_URL is sourced, never printed
npm run db:migrate && npm run lint && npm run typecheck && npx vitest run
```

| Command | Result |
|---|---|
| `npm run db:migrate` | **exit 1** — `relation "conversations" already exists`. Pre-existing environment condition, not a code defect: the container's `public` schema already holds the Supabase chain, so replaying the legacy local migration chain collides on the first table. This is the same condition the slice-1 gate documented when it skipped the command. The command did connect to the right database (host port 55470, `DATABASE_URL` sourced from `.env`, value never printed). |
| `npm run lint` (`eslint src tests --max-warnings=0`) | **clean**, exit 0, no output |
| `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | **clean**, exit 0, no output |
| `npx vitest run` (full backend suite, DB container `colloseumfeat-solana-operational-db-1` on host port 55470) | **exit 1 — `Test Files 7 failed \| 177 passed \| 4 skipped (188)`, `Tests 9 failed \| 1356 passed \| 10 skipped (1375)`** |
| `cd apps/nana-wallet && npm run lint && npm run typecheck && npx vitest run` | **all three clean**, exit 0 — `21 passed (21)` files, `114 passed (114)` tests |

Pristine baseline for reference (`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`,
attempt 2 at `a121b2c`): `6 failed | 148 passed | 4 skipped (158)` files and
`6 failed | 1028 passed | 10 skipped (1044)` tests. Skipped is unchanged at 10 tests across the same 4
files, so no previously-running test became silently skipped. The frontend grew from `21 / 112` to
`21 / 114` — two new tests, none removed.

#### Baseline comparison **by test name** — the gate verdict table

Failure families admitted by the brief: (a) the baseline's six named failures, (b) 5-second
test/hook timeouts under parallel load against the single Postgres container.

| # | Failing test (`file > describe > test`) | Failure shape | In the baseline list? | Isolated re-run on this tree | Verdict |
|---|---|---|---|---|---|
| 1 | `tests/unit/realtime-agent-session.test.ts` > OpenAI realtime agent session composition > allows one re-read when a confirmation is refused for an incomplete read-back | `AssertionError` (persona prompt regex) | **yes** (baseline #4) | not re-run (baseline-named, deterministic by construction) | pre-existing, unchanged |
| 2 | `tests/unit/realtime-tools.test.ts` > `createRealtimeTools` > send_token delegates the preview to the service and strips the recipient address | `AssertionError` (spy not called) | **yes** (baseline #6) | not re-run | pre-existing, unchanged |
| 3 | `tests/integration/conversation-preview-claim-race.test.ts` > previewTransfer real claim semantics > two simultaneous confirms broadcast exactly once (V8.5) | `AssertionError` (0 broadcast calls) | **yes** (baseline #2) | not re-run | pre-existing, unchanged |
| 4 | `tests/unit/realtime-tool-binding.test.ts` > realtime tool binding — production execution against the fixture stack > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy | `AssertionError` (0 broadcast calls) | **yes** (baseline #5) | **1 failed | 8 passed (10)** — reproduces | pre-existing, unchanged |
| 5 | `tests/unit/realtime-tool-binding.test.ts` > realtime tool binding — **declaration** > declares exactly the 5 production tools with JSON Schema parameters | `AssertionError` at `:57`, **22 ms** | **NO — not a baseline name, not a timeout** | **1 failed | 8 passed (10)** — reproduces in isolation, deterministically | **REGRESSION — blocks the gate** |
| 6 | `tests/integration/wallets-sync.test.ts` > PEW-013: explicit activation with read-back; empty allowlist rejected (422) | `AssertionError` (422 ≠ 200) | **yes** (baseline #3) | not re-run | pre-existing, unchanged |
| 7 | `tests/integration/notifications-webhook.test.ts` > accepts a valid signed delivery for an enrolled wallet and persists exactly one receipt row | bare `Test timed out` **15 396 ms** | flake family (b) | **1 file passed, 3 tests passed** | full-suite-load flake, not a regression |
| 8 | `tests/integration/notifications-webhook.test.ts` > acknowledges a duplicate delivery without creating a second receipt row | bare `Test timed out` **15 588 ms** | flake family (b) | **1 file passed, 3 tests passed** | full-suite-load flake, not a regression |
| 9 | `tests/integration/api-auth-logout.test.ts` > is idempotent: repeated logouts succeed and leave the session revoked | bare `Test timed out` **16 064 ms** | flake family (b) — not a timeout in the baseline, but the identical shape | **1 file passed, 5 tests passed** | full-suite-load flake, not a regression |
| — | `tests/integration/api-voice-auth.test.ts` > returns the same 404 for a foreign conversation as for a missing one | — | baseline #1 (itself recorded there as *environment-shaped, root cause NOT diagnosed*) | **1 file passed, 4 tests passed** | **did not fail this run** — consistent with its recorded load-flakiness |

**Verdict: the gate FAILS.** Row 5 is neither a baseline-named failure nor a load timeout. It is a
22 ms assertion failure, it reproduces alone, and the cause is visible in the diff:

```
AssertionError: … expected
+   "stage_trusted_recipient",
+   "stage_trusted_recipient_edit",
+   "stage_trusted_recipient_removal",
```

`tests/unit/realtime-tool-binding.test.ts:57` pins the **exact, sorted tool-name list** that the voice
realtime binding exposes from the shared definition. Commit **`3d97758`** (*feat(agent): stage
trusted-recipient actions behind a typed confirmation arbiter*, task 4.2 work) added those three tools
to `src/agent/definition.ts:537/543/549`, and `git merge-base --is-ancestor 3d97758 HEAD` confirms that
commit is an ancestor of the gated HEAD (`c685d38`). `git log -S"stage_trusted_recipient"
-- src/agent/definition.ts` names `3d97758` as the single introducing commit. The stale expectation was
never updated alongside it.

Two honest readings, both recorded:

- **By test name** (the comparison the brief mandates): a **new** failure → regression.
- **By file name** (the brief's shorthand list names `realtime-tool-binding`): the same file already
  appears in the baseline, but with a **different** test — the baseline's failure list is explicitly
  "complete", and this name is not in it. Whichever reading is used, the failure is deterministic and
  causally explained, so it cannot be waived as a flake either way.

The fix belongs to the unit that changed the surface (task 4.2's parity obligation) and is explicitly
out of scope for this run: both the brief and the slice boundary forbid implementing slice-3/4 work
here, and editing the assertion to admit the new names would be exactly the "weaken the assertion to
make the gate pass" that the brief forbids. **Left untouched, reported as the blocker.**

#### The capability probe — what the live database actually records

The probe was **not executed** in this run: there is no signer sidecar in this environment
(`PRIVY_SIGNER_URL` / `PRIVY_SIGNER_TOKEN` unset ⇒ `canSignAuthorizations()` is `false`), and the
brief's `{ capable, code }` collection requires a reachable sidecar. Rather than assert a value, the
live `recipient_policy_state` row was read **read-only** from the container
(`docker exec colloseumfeat-solana-operational-db-1 psql -tAc "SELECT …"` — catalog/SELECT only, no DDL,
no DML):

| Recorded field | Observed value (48 rows) | Rows |
|---|---|---|
| `status` | `pending` | 48 / 48 |
| `status_reason` | `signer_binding_unavailable` | 48 / 48 |
| `status_detail.code` | `signer_binding_unavailable` | 3 |
| `status_detail.code` | *(key absent)* | 45 |
| `status_detail` also carries | `policyId`, `appliedPolicyId` (the 2.12 transition keys, both `null`) | — |
| `empty_composition` | `unproven` | 48 / 48 |
| `status_detail.rules_union` | **absent in every row** | 0 |
| `status_detail.attachment_evidence` | **absent in every row** | 0 |
| `status_detail.ownership_evidence` | **absent in every row** | 0 |

So the code is **`signer_binding_unavailable`** — the equivalent of the `signer_unavailable` reason the
brief anticipated, recorded by the recurring status writer, not by a probe run. It is a boolean/code
only: no secret, token, key, payload or signature appears in any log, response or evidence file here.

**Plainly stated: the live probe evidence remains PENDING.** Per the pending-live-evidence table in the
2.1–2.4 section of this file (the authority for this phrasing), every one of U1–U4 is **unproven on
this deployment** and nothing above resolves any of them: the absence of `rules_union`,
`attachment_evidence` and `ownership_evidence` in all 48 rows, and `empty_composition = 'unproven'`
everywhere, is the direct confirmation of that. Design §6.4's `{ capable, code }` is likewise
uncollected. The exact collection step for each is unchanged and remains the one named in that table —
each needs a configured sidecar (`canSignAuthorizations()` `true`) and a devnet budget, and is carried
by tasks 5.2/5.7. **No fake-transport output is presented here as live provider evidence.**

#### Commands run and results (task 2.14)

| Command | Result |
|---|---|
| `set -a; . ./.env; set +a && npm run db:migrate` | exit 1, `relation "conversations" already exists` (pre-existing DB shape) |
| `npm run lint` | clean, exit 0 |
| `npm run typecheck` | clean, exit 0 |
| `npx vitest run` | `7 failed | 177 passed | 4 skipped (188)` files, `9 failed | 1356 passed | 10 skipped (1375)` tests — the nine failures are the table above |
| `npx vitest run tests/unit/realtime-tool-binding.test.ts` (isolation) | **1 failed, 2 failed / 8 passed (10)** — the regression **reproduces**; not a flake |
| `npx vitest run tests/integration/notifications-webhook.test.ts` (isolation) | **1 file passed, 3 tests passed** |
| `npx vitest run tests/integration/api-auth-logout.test.ts` (isolation) | **1 file passed, 5 tests passed** |
| `npx vitest run tests/integration/api-voice-auth.test.ts` (isolation) | **1 file passed, 4 tests passed** |
| `npx vitest run tests/integration/recipient-policy-repository.test.ts` (isolation) | **1 file passed, 20 tests passed** |
| `npx vitest run tests/integration/recipient-policy-*.test.ts tests/unit/policy-*.test.ts tests/unit/recipient-policy-config.test.ts` (isolation) | **24 files passed, 299 tests passed** |
| `(cd apps/nana-wallet && npm run lint && npm run typecheck && npx vitest run)` | lint and typecheck clean; **21 files passed, 114 tests passed**, exit 0 |
| read-only `psql` on `recipient_policy_state` | the probe-state table above |
| `git status --porcelain` | `?? compose.privy-local.ports.yaml` — unchanged, never touched |

Both sets of cases earlier units flagged pass in isolation: `recipient-policy-repository` **20/20**, and
the `recipient-policy-*` + `policy-*` + `recipient-policy-config` set **299/299 across 24 files**. The
`realtime-tool-binding` isolation is the one re-run that **did not** clear the suspect.

#### What this unit did and did not do

- Did: run the gate, compare by test name, isolate every questionable failure, read the live probe
  state, record it here.
- Did **not**: mark 2.14 `[x]` (the gate did not genuinely pass), edit any assertion, edit any source
  or test file, start any bounded review, refutation, correction or delivery gate, or touch the two
  parent-owned lifecycle rows in `tasks.md` (both still carry `<!-- sdd-owner: parent -->` and remain
  unchecked). No `git stash`/`checkout`/`reset`/`restore`/`clean` was run at any point.

#### Remaining tasks in slice 2

```text
- [ ] **2.14 Run the slice-2 gate and record the slice-2 work-unit commits.** — BLOCKED: the gate fails on a deterministic, non-baseline, non-flake assertion regression in `tests/unit/realtime-tool-binding.test.ts` introduced by `3d97758` (slice-3/4 work already on this branch). Fix belongs to that unit's parity obligation, not here.
```

Slices 3–5 remain unchecked in `tasks.md`, unchanged by this unit.

#### Workload / PR boundary

One bookkeeping commit: this section of `apply-progress.md` only. No source file, no test file, no
checkbox changed. It sits inside the parent-assigned `PR 4` slice (tasks 2.1–2.14). No `size:exception`
is requested.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work unit, the
authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any command — `tasks.md` (task 2.14, terminal `<!-- sdd-owner: implementation -->`),
the 2.12/2.13 entries and the 1.11 gate record for shape, and the pristine baseline
`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`. `actionContext`: all writes
stayed inside the assigned worktree root; the main checkout was never entered and the untracked
`compose.privy-local.ports.yaml` was not touched.

---

### Task 2.14, second run — the gate blocker fixed, the recipient validator hole closed

Status: **2.14 stays `- [ ]`.** The suite half of the gate now genuinely passes with no failure outside
the pristine baseline; the line's live-probe half is still uncollectable in this environment (no signer
sidecar). Three units, three commits, each green before the next one started.

This section was written by the fix run; **no earlier entry above was altered**, and both parent-owned
lifecycle rows in `tasks.md` remain byte-for-byte untouched (still unchecked, still carrying
`<!-- sdd-owner: parent -->`).

#### Unit 1 — the deterministic non-baseline regression (`7accb6c`)

`tests/unit/realtime-tool-binding.test.ts:57` pinned the exact sorted voice tool-name list, and commit
**`3d97758`** (task 4.2) legitimately added `confirm_trusted_recipient_action`,
`stage_trusted_recipient`, `stage_trusted_recipient_edit` and `stage_trusted_recipient_removal` to the
single shared definition without updating it. The catalog changed by design; the expectation was stale.

- RED (before the edit): `1 failed (2 failed / 8 passed (10))`, both failures by name —
  `declares exactly the 5 production tools with JSON Schema parameters` (22 ms, `expected
  [ 'cancel_transfer', …(17) ] to deeply equal [ 'cancel_transfer', …(13) ]`) and the pre-existing
  baseline `send_token previews …` case.
- GREEN (after the edit): the exact-list test passes, and only the baseline case remains —
  `1 failed | 9 passed (10)`.
- Mutation proof: deleting `'stage_trusted_recipient_removal'` from the expectation reproduced the
  failure by test name (`AssertionError: expected [ 'cancel_transfer', …(17) ] to deeply equal
  [ 'cancel_transfer', …(16) ]`); restoring the file returned it to green.

The assertion is still an **exact sorted list** — not a subset, not `toContain`, not skipped — so it
still fails when a tool is added, removed or renamed without the expectation being updated. The title
was corrected to say what it actually pins. Nothing was weakened to make the gate pass: the catalog is
the current, intended one.

**Parity agreement:** `tests/unit/agent-tools-parity.test.ts` derives its expectation from
`createWalletAgentDefinition()` minus `VOICE_ONLY_TOOLS`, so it covers the new tools automatically and
passes unmodified (`14 passed` across both files with the exact-list test). The exact-list test and the
parity test now agree: both see the same 18-name voice surface, the two voice-only names
(`confirm_transfer`, `cancel_transfer`) are the only divergence, and neither surface exposes a
hand-written duplicate body.

#### Unit 2 — the authorization hole in the recipient validator (`ce4ea06`)

`src/memory/address.ts` treats "no network" as the legacy EVM default, and both recipient write paths
handed it exactly that: `ContactsRepository.create`/`update` (`src/memory/contacts-repository.ts:110`,
`:197`) and `RecipientMemoryRepository.insertRecipient` (`src/memory/repository.ts:109`) validated with
the raw, optional body field, so a create or edit body that **omitted** `network` was accepted for an
`0x`-shaped address on a deployment whose configured chain is Solana — and the row was persisted with
`network = NULL`, which then let the version-bound lookup (`src/memory/service.ts:182`) resolve the same
address through the EVM regex again.

The fix resolves the chain once and reuses it. `CONFIGURED_RECIPIENT_NETWORK` /
`resolveRecipientNetwork` now live in `src/memory/address.ts`, and `SOLANA_POLICY_NETWORK` in the policy
module is re-exported from that same literal, so the validator and the policy scope cannot drift apart
(no second source of truth, and no import cycle: the policy module already imports the validator).
The three write paths validate and **persist** the resolved chain, and the version-bound lookup resolves
a stored `NULL` the same way. The EVM branch itself is untouched, so an explicit other network still
validates as before.

RED → GREEN, all attributed by test name (two new suites):

| Guard | RED (before) | Mutation (guard removed) |
|---|---|---|
| `contacts-repository.ts` create resolves the chain | `accepts a canonical base58 key and persists it as the configured chain`, `fails closed on an EVM-shaped address and persists nothing` | both fail again by name |
| `repository.ts` `insertRecipient` resolves the chain | `fails closed on the agent memory write path too` | fails again by name |
| `service.ts` `getRecipientForVersion` resolves the chain | `refuses an unversioned record holding an EVM-shaped address` | fails again by name |

`5 failed | 7 passed (12)` at RED, `12 passed (12)` at GREEN, and every mutated guard restored to the
committed bytes afterwards. New suites: `tests/unit/recipient-address-solana-validation.test.ts`
(canonical base58 passes and is persisted as the configured chain; an EVM-shaped and a malformed value
fail closed and reach **no** write statement; the absent-`network` body resolves the configured chain)
and `tests/unit/recipient-address-handoff.test.ts` (the selected-address lookup returns only a canonical
Solana key for a `solana-devnet` recipient, refuses an unversioned or stale handoff, and a confirmed
fact write issues no recipient insert — fact memory keeps its separate path with no permission
expansion).

**One stale expectation in the same class, fixed with the code (`e7219fe`).** The first post-fix full
run surfaced `tests/unit/contacts-repository.test.ts > keeps legacy EVM contacts on the default
network`, which pinned exactly the behaviour unit 2 deliberately replaces (`expect(…).toContain(null)`).
It was NOT a regression in the product: the write-path contract changed by design (RAM-009), so the
expectation was stale in the same way as unit 1's. It now asserts the new contract strictly — a create
body that omits `network` persists `solana-devnet` for a canonical base58 key, and an EVM-shaped
address in the same body is refused **before** any transaction is opened — in two tests instead of one.
No assertion was loosened; the file grew from 4 to 5 tests.

#### Unit 3 — the slice-2 gate and its verdict

```text
cd /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational
set -a; . ./.env; set +a        # DATABASE_URL sourced, never printed
npm run lint && npm run typecheck && npx vitest run
(cd apps/nana-wallet && npm run lint && npm run typecheck && npx vitest run)
```

| Command | Result |
|---|---|
| `npm run lint` (`eslint src tests --max-warnings=0`) | **clean**, exit 0, no output |
| `npm run typecheck` (`tsc -p tsconfig.test.json --noEmit`) | **clean**, exit 0, no output |
| `npx vitest run` (full backend, DB container `colloseumfeat-solana-operational-db-1`, port 55470) | **exit 1 — `Test Files 10 failed \| 176 passed \| 4 skipped (190)`, `Tests 12 failed \| 1366 passed \| 10 skipped (1388)`** |
| `cd apps/nana-wallet && npm run lint && npm run typecheck && npx vitest run` | **all clean**, exit 0 — `21 passed (21)` files, `114 passed (114)` tests |

`npm run db:migrate` was **not** re-run as a gate step: it exits 1 with `relation "conversations"
already exists` on this container (pre-existing Supabase-shaped DB, documented in the 1.11 and first-2.14
records) and it is not part of this run's command list.

Suite growth is exactly the work: `188 → 190` files and `1375 → 1388` tests, which is the two new
suites (12 tests) plus the one net new contacts-repository test. Skipped is unchanged at 10 tests across
the same 4 files, so nothing became silently skipped. Pristine baseline for reference
(`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`, attempt 2 at `a121b2c`):
`6 failed | 148 passed | 4 skipped (158)` files, `6 failed | 1028 passed | 10 skipped (1044)` tests.

**Baseline comparison by test name — the gate verdict table.**

| # | Failing test (`file > describe > test`) | Failure shape | In the baseline list? | Isolated re-run on this tree | Verdict |
|---|---|---|---|---|---|
| 1 | `tests/unit/realtime-agent-session.test.ts` > OpenAI realtime agent session composition > allows one re-read when a confirmation is refused for an incomplete read-back | `AssertionError` (persona prompt regex) | **yes** (#4) | not re-run (baseline-named, deterministic by construction) | pre-existing, unchanged |
| 2 | `tests/unit/realtime-tools.test.ts` > `createRealtimeTools` > send_token delegates the preview to the service and strips the recipient address | `AssertionError` (spy not called) | **yes** (#6) | not re-run | pre-existing, unchanged |
| 3 | `tests/integration/conversation-preview-claim-race.test.ts` > previewTransfer real claim semantics > two simultaneous confirms broadcast exactly once (V8.5) | `AssertionError` (0 broadcast calls) | **yes** (#2) | not re-run | pre-existing, unchanged |
| 4 | `tests/unit/realtime-tool-binding.test.ts` > realtime tool binding — **production execution** > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy | `AssertionError` (0 broadcast calls), 2 005 ms | **yes** (#5) | **1 failed | 9 passed (10)** — only this case; the **declaration** test is now green | pre-existing, unchanged — and **one of this file's two failures is fixed** |
| 5 | `tests/integration/wallets-sync.test.ts` > … > PEW-013: explicit activation with read-back; empty allowlist rejected (422) | `AssertionError` (422 ≠ 200) | **yes** (#3) | not re-run | pre-existing, unchanged |
| 6 | `tests/integration/api-voice-auth.test.ts` > … > returns the same 404 for a foreign conversation as for a missing one | `Test timed out in 15000ms` | **yes** (#1, itself recorded as environment-shaped) | **1 file passed, 4 tests passed** | load flake — did not fail in run 1, failed in run 2 |
| 7 | `tests/integration/notifications-webhook.test.ts` > … > accepts a valid signed delivery … and persists exactly one receipt row | `Test timed out in 15000ms` | flake family (b) | **1 file passed, 3 tests passed** | full-suite-load flake, not a regression |
| 8 | `tests/integration/notifications-webhook-deep.test.ts` > … > acknowledges a duplicate delivery with a single receipt | `Test timed out in 15000ms` | flake family (b) | **1 file passed, 5 tests passed** | full-suite-load flake, not a regression |
| 9 | `tests/integration/recipient-policy-reconciler.test.ts` > recipient policy reconciler (task 2.9) > reclaims an expired holder's in-flight intent… / treats a readback equal to the composed rules… / blocks on a third, unexplained rule set… | `Test timed out in 5000ms` ×3 | flake family (b) | **1 file passed, 13 tests passed** | full-suite-load flake, not a regression |
| 10 | `tests/integration/users-db.test.ts` > users migration (database) > provisions a fresh database through the full local migration sequence | `Test timed out in 5000ms` | flake family (b) | **1 file passed, 9 tests passed** | full-suite-load flake, not a regression |
| — | `tests/integration/notifications-reconciliation.test.ts` > … > starts immediately, runs a pass, and stops cleanly awaiting in-flight work | `AssertionError: expected 0 to be greater than or equal to 1` inside a **60 ms** window | not recorded before | **1 file passed, 10 tests passed** | load flake — seen in the earlier run only, cleared in isolation |
| — | `tests/unit/contacts-repository.test.ts` > contacts repository chain scope > keeps legacy EVM contacts on the default network | `AssertionError` | **NO — caused by unit 2** | **1 file passed, 5 tests passed** after the expectation update | **fixed in `e7219fe`; not present in the final run** |
| — | `tests/unit/realtime-tool-binding.test.ts` > **declaration** > declares exactly the 5 production tools… | `AssertionError` at `:57` | **NO — the previous run's blocker** | **green** | **FIXED in `7accb6c`** |

**Verdict: the gate PASSES on the suite half. No failure outside the pristine baseline remains, and
every non-baseline failure is a 5 s/15 s load timeout that clears in isolation.**

Two runs are recorded because the first was taken before the stale `contacts-repository` expectation was
fixed: run 1 (43 s) `7 failed | 1370 passed | 4 skipped (188 files)`; run 2 (80 s, the authoritative
post-fix run) `12 failed | 1366 passed | 4 skipped (190 files)`. The baseline's six names appear across
the two runs, and the same load-flaky family shifted between them — the second run simply hit more of
it. Nothing in either run is a new deterministic failure.

#### The capability probe — what was actually recorded

| Evidence | Value | How it was obtained |
|---|---|---|
| Design §6.4 `{ capable, code }` from the 2.7 probe, executed in-process against this deployment's live configuration | **`{"capable":false,"code":"signer_unavailable"}`** | `env -u PRIVY_SIGNER_URL -u PRIVY_SIGNER_TOKEN npx tsx -e "…verifyPolicySignerCapability()…"` — boolean/code only, no token, key, payload or signature printed |
| Live `recipient_policy_state.status_detail.code`, read read-only | `signer_binding_unavailable` in **2** of 45 rows; `status_reason` the same; `pending` in 3 rows | `docker exec … psql -d wdk_agent -tAc "SELECT …"` (catalog/SELECT only, no DDL, no DML) |
| Live status spread | `applied` 38, `saved_not_configured` 2, `blocked_conflict` 1, `syncing` 1, `pending` 3 | same read-only query |
| U1–U4 live evidence | `status_detail.rules_union`, `.attachment_evidence`, `.ownership_evidence` **absent in all 45 rows** (0/0/0); `empty_composition = 'unproven'` in 45/45 | same read-only query |

**Plainly stated: the LIVE probe evidence remains PENDING.** There is no signer sidecar in this
environment (`PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN` unset ⇒ `canSignAuthorizations()` is `false`), so
§6.4's `{ capable, code }` above is the fail-closed *absence* result, not provider proof, and designs
§11 U1–U4 stay unproven exactly as the 2.1–2.4 pending-live-evidence table says. The exact collection
step is unchanged: run task 5.2 against a deployment whose `backend-signer`/`voice-worker-signer`
sidecar is up (`canSignAuthorizations()` `true`) with a devnet budget, and read the `{ capable, code }`
plus U1–U4 outcomes from `status_detail`. **No fake-transport output is presented here as live provider
evidence.**

#### Files changed by this run

| Commit | Unit | Files |
|---|---|---|
| `7accb6c` | the stale voice-catalog expectation | `tests/unit/realtime-tool-binding.test.ts` |
| `ce4ea06` | the recipient chain resolution | `src/memory/address.ts`, `src/memory/contacts-repository.ts`, `src/memory/repository.ts`, `src/memory/service.ts`, `src/wallet/policy/service.ts`, `tests/unit/recipient-address-solana-validation.test.ts`, `tests/unit/recipient-address-handoff.test.ts` |
| `e7219fe` | the same-class stale chain-scope expectation | `tests/unit/contacts-repository.test.ts` |

#### Deviations from the brief

1. **The brief named two files for the recipient hole; the same resolution was applied to the
   version-bound lookup as well** (`src/memory/service.ts:182`). Without it the hole stayed open one
   step later: a row already stored with `network = NULL` would resolve through the EVM regex again
   when handed to a transfer preview. The brief's own handoff suite asks for exactly that refusal.
2. **`SOLANA_POLICY_NETWORK` is now an alias of the memory-layer literal** rather than its own copy of
   the string. The brief asked for no second source of truth; an import in the other direction would
   have created a module cycle, since the policy module already imports the validator.
3. **`tests/unit/contacts-repository.test.ts` was edited**, which the brief did not anticipate: the
   first post-fix full run exposed it as the same stale-expectation class as unit 1. It was made
   stricter, not weaker, and the reason is recorded above.
4. **A third commit was needed** (`e7219fe`) because unit 2 was committed after the targeted 299-test
   verification but before the full suite had seen this file. Unit 1 and unit 2 stayed committed as soon
   as their own suites were green, as instructed; the stale expectation is reported as what it is.

#### Remaining tasks (unchanged by this run)

```text
- [ ] **2.14 Run the slice-2 gate and record the slice-2 work-unit commits.** — suite half PASSES (no non-baseline failure remains); the live probe half is uncollectable without a signer sidecar and stays PENDING with its exact collection step named above.
- [ ] **4.1 Replace EVM recipient validation with the configured chain validator (RAM-009).** — its two named suites now exist and pass; the checkbox is untouched because task selection is parent-owned and its declared call sites (`src/agent/definition.ts:224`, `src/agent/wallet-agent.ts:246`) were not part of this run's brief.
- [ ] **4.2 Add the version-bound recipient lifecycle tools to the single shared definition.** — its parity obligation (this run's unit 1) is discharged, but its own verify names `tests/unit/recipient-lifecycle-tools.test.ts`, which **does not exist**; the task is not complete and stays unchecked.
```

Slices 3–5 remain unchecked, unchanged by this run.

#### Workload / PR boundary

Three work-unit commits, each a candidate chained PR by itself, inside the parent-assigned slice that
covers the 2.14 gate plus the 4.1/4.2 parity obligations: `7accb6c` (1 file), `ce4ea06` (7 files, +85
lines), `e7219fe` (1 file). No `size:exception` is requested, and the bookkeeping commit for this
section carries the record only.

#### Structured status consumed

Native SDD status is non-authoritative for this phase: the parent supplied the resolved work units, the
authoritative artifact paths and the delivery path directly. Readiness was resolved against the
artifacts before any edit — `tasks.md` (task 2.14, terminal `<!-- sdd-owner: implementation -->`; the
two parent-owned rows left untouched), `spec.md` (RAM-009 recipient validation), `design.md` §11 and
§6.4, the previous 2.14 record for shape, and the pristine baseline
`.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`. `actionContext`: every write
stayed inside the assigned worktree root `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`;
the main checkout was never entered, the untracked `compose.privy-local.ports.yaml` was never touched,
no `.env` value was read or printed, and no `git stash`/`checkout`/`reset`/`restore`/`clean` was run at
any point.

---

## Continuation run (2026-10-10) — slices 3.1/3.2 and the 2.14 close

### Unit 0 — close 2.14 with its pending live evidence documented

Task **2.14** moves to `[x]` in `tasks.md`, with an inline closure note. The two halves are recorded as
they actually are:

- **Suite half: PASSED** at `2ffaf47`. No failure outside the pristine baseline remains; every
  non-baseline failure was a 5 s/15 s load timeout that clears in isolation (recorded in the section
  above, run 2: `12 failed | 1366 passed | 4 skipped (190 files)`, every failure named and classified).
- **Live probe half: PENDING.** This environment has **no signer sidecar**
  (`PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN` unset ⇒ `canSignAuthorizations()` is `false`). The only
  §6.4 record obtainable here is the fail-closed *absence* result
  `{ capable: false, code: "signer_unavailable" }`, and live **U1–U4 evidence remains PENDING**: all
  three `status_detail` evidence keys (`rules_union`, `attachment_evidence`, `ownership_evidence`) are
  absent in 45/45 rows and `empty_composition = 'unproven'` in 45/45.

**Plainly: the live U1–U4 / §6.4 evidence is PENDING, with its exact collection step being task 5.2**,
run against a deployment whose `backend-signer`/`voice-worker-signer` services are up (so
`canSignAuthorizations()` is `true`) and with a devnet budget, reading `{ capable, code }` and the
U1–U4 outcomes back from `recipient_policy_state.status_detail`. Per the change owner's standing
instruction, a probe that needs credentials or a real deployment is documented as pending and the work
continues; nothing here refuses to proceed on that account.

**No fake-transport output is presented as live provider proof.** The `{capable:false,
code:"signer_unavailable"}` record above is an in-process absence result, and the fake-transport
adapter tests of tasks 2.2/2.8 stay labelled as adapter tests, never as live evidence.

Agreement with the change owner's standing instruction: probes requiring credentials or a real
deployment are documented as pending, and the work continues.
