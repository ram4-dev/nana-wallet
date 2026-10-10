# Design: Trusted Recipient Policy Sync

Implementation design for change `trusted-recipient-policy-sync`. Requirements are fixed by
`openspec/changes/trusted-recipient-policy-sync/spec.md`; the approved design intent is
`.agent-workflow/tasks/trusted-recipient-policy-sync/03-design-discussion.md` revision 1 and the
outline is `04-structure-outline.md` revision 2. This document resolves the mechanical questions
those two leave open and is written against the code as it actually exists, not against the
outline's summary of it.

Worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch
`feat/solana-operational`. No push, no PR, no credential access, `WDK_TOOLS_SOURCE=fixture` by
default.

---

## 0. Code-grounding corrections and contradictions found

These are facts established by reading the source. Where the outline asserts something the code
contradicts, the design follows the code and the contradiction is recorded as a risk.

| # | Outline / proposal claim | What the code actually does | Design consequence |
| --- | --- | --- | --- |
| C1 | "three full-rule writers" replace the complete rule set | Confirmed, and worse than stated. `preparePermission` creates the Solana **enrollment** policy from `buildSolanaEnrollmentRules` (`src/wallet/embedded.ts:921-951`, rules built at `:926`); `composeGrantRules` is then PATCHed onto that **same** policy id (`src/wallet/grants/solana-policy-provisioner.ts:275`, rules from `:120`). The PATCH body is grant-only, so the enrollment allowlist rule is *overwritten*, not merged. Nothing ever re-adds it. | §3 makes the composed rule **set** authoritative and makes the two rule families coexist in one policy. That coexistence is a **new** provider reliance (U1 in §11). |
| C2 | "worker loopback endpoint" is not reachable from the backend | There is no worker HTTP endpoint at all. The loopback-bound thing is the Privy authorization signing sidecar (`src/wallet/signer/server.ts:220-225`, `:260-266`), which refuses any non-loopback bind by design. | §6 replaces the claim with the accurate one: a sidecar sharing the worker's network namespace is unreachable from the backend namespace, and the fix is a **separate** signer capability for the backend. |
| C3 | "backend obtains its own reachable signed-authorization capability" | The backend already builds a signer (`src/server.ts:219`, passed at `:227`) but **no compose service provides one**: `compose.privy-local.yaml` declares neither `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN` on `backend` or `voice-worker` nor a signer service. `PRIVY_SIGNER_*` appears only as commented placeholders in `.env.example:33-38`. | In the live local stack today `canSignAuthorizations()` is false (`src/wallet/privy-server-client.ts:301-303`), so `createGrantPolicySyncService` returns `unavailable` (`src/wallet/grants/privy-policy-runtime.ts:191-201`) and every signed policy write fails closed. §6 specifies the missing deployment wiring. |
| C4 | "both processes receive the injected service and their own signed-authorization capability" | The **worker** builds `PrivyServerClient` **without** passing its signer: `src/runtime/dependencies.ts:213` creates `authorizationSigner`, `:214-219` constructs the client with `appId/appSecret/baseUrl` only. The signer is passed only to the wallet resolver (`:221-226`). Compare `src/server.ts:220-228`, which does pass it. | Concrete defect to fix in slice 2: even with a sidecar configured, worker-side grant policy sync stays `unavailable`. §6 and §12 list it. |
| C5 | "signer attachment, unrelated signers, ownership" preserved | The composer's signer/attachment read uses `server.getWallet(providerWalletId)` with **no owner filter** (`src/wallet/grants/privy-policy-runtime.ts:36-59`), whereas `completePermission` reads through owner-verified listings (`src/wallet/embedded.ts:1040-1052`, `:1188-1199`). | The composer cannot assert ownership from the current read path. §3 requires an owner-verified read using the existing `privyDid(userId)` + `listWalletsForChain(privyDid,'solana')` seam. Without it, requirement "ownership preserved" is unprovable. |
| C6 | "policy_hash consistent" | `policy_hash` is a **consent-envelope** hash over `${transferLimit}|${window}|${recipients.join(',')}` (`src/wallet/embedded.ts:1573-1585`), not a hash of the composed rules. No authorization decision reads it. | §3/§4 introduce a distinct authoritative `applied_rules_hash` (sha256 over the canonical composed rule set) and keep `policy_hash` as a refreshed compatibility field. |
| C7 | "the existing claim/revoke locks" | Four lock families exist, and their relative order differs by path — see §1.1. | §1 defines one order and mandates the reordering refactor. |

---

## 1. Locking, leasing and transaction boundaries

### 1.1 What the existing writers actually do

| Writer | Locks taken (in order) | Evidence |
| --- | --- | --- |
| `PrivyPolicySyncService.syncGrant` | advisory `dgc-grant-<id>` → `delegated_grants FOR UPDATE` → advisory `dgc-wallet-<walletId>` | `src/wallet/grants/privy-policy-sync.ts:93`, `:96` → `:276`, `:105` |
| `PrivyPolicySyncService.syncRevocation` | advisory `dgc-grant-<id>` → `delegated_grants FOR UPDATE` → advisory `dgc-wallet-<walletId>` | `src/wallet/grants/privy-policy-sync.ts:187`, `:190` → `:276`, `:197` |
| `DelegatedGrantService.claimConsumption` | advisory `dgc-grant-<id>` → `delegated_grants FOR UPDATE` | `src/wallet/grants/consumption.ts:396`, `:404`, `:449-452` |
| `DelegatedGrantService.settleGrantReservation` | advisory `dgc-grant-<id>` → grant row | `src/wallet/grants/consumption.ts:579`, `:592` |
| `DelegatedGrantService.revokeGrant` / `getGrant` | advisory `dgc-grant-<id>` → grant row | `src/wallet/grants/consumption.ts:356`, `:362`, `:335-349` |
| `ContactsRepository.update` / `.archive` | `recipients FOR UPDATE` only | `src/memory/contacts-repository.ts:155-162` (`update`), `:226-240` (`archive`) |
| `EmbeddedWalletService.lockWalletSync` | advisory `nana-wallet-sync:<userId>` only | `src/wallet/embedded.ts:654-659` |
| `PrivyPolicyAdmin.attachPolicyToSigner` | no DB lock; remote readback only | `src/wallet/grants/privy-policy-admin.ts:100-176` |

The invariant that already holds everywhere is **grant advisory lock before grant row lock**. The
outline's requirement to "document the lock order once and acquire it in that same order" is
therefore satisfiable without rewriting the claim path: the new locks must be *prepended* or
*appended*, never inserted between those two.

### 1.2 Canonical lock order (documented once in `docs/architecture.md` §"Wallet policy lock order")

```
W1   recipient_policy_leases row      acquire/renew/release in its own short transaction
                                      (exclusive holder of the wallet; NOT held inside any
                                       other transaction and NOT held across remote I/O by
                                       any writer that also holds L1..L5)
W0   recipient_policy_state row       FOR SHARE in read/claim transactions,
                                      FOR UPDATE in the applying transaction
L1   advisory xact  dgc-grant-<id>    ascending grant id
L2   row lock       delegated_grants  FOR UPDATE, ascending id
L3   row lock       recipients        FOR UPDATE, ascending id
L4   advisory xact  dgc-wallet-<id>   legacy shim only; never taken by the composer
L5   appends        grant_audit_log / grant_claim_ledger / recipient_policy_* /
                    contact_action_proposals
----- transaction boundary -----
R    provider I/O (createPolicy / patchPolicy / getPolicy / getWallet) strictly AFTER commit
```

Two rules make this a total order:

1. **Every policy-affecting writer takes `W1` first.** Any writer that must take `L1..L5` either
   holds `W1` or is a read/claim path that takes `W0` in `FOR SHARE` mode.
2. **No transaction ever takes a lower-numbered lock after a higher-numbered one.**

`W0` is placed before `L1` deliberately. The apply transaction needs `recipient_policy_state`
`FOR UPDATE` and grant row locks; the claim transaction needs `recipient_policy_state` `FOR SHARE`
and already holds a grant row lock. If the claim took `W0` *after* its grant locks, the apply and
claim transactions would form the classic cycle (apply: state → grant row; claim: grant row →
state). Prepending `W0 FOR SHARE` to the claim removes it. This is the single most important
ordering decision in §1.

### 1.3 Per-writer chains after the change

```
claim            : W0(S) → L1 → L2 → L5                     (existing path, W0 prepended at
                                                             consumption.ts:396)
settle/revoke    : W0(S) → L1 → L2 → L5                     (settle does not need S; it may skip
                                                             W0 and keep L1 → L2)
removal/contact  : W1 → tx{ W0(U) → L1(all affected, asc) → L2 → L3 → L5 } → R
create/edit      : W1 → tx{ W0(U) → L3 → L5 } → R
grant create     : W1 → tx{ W0(U) → L2(insert) → L5 } → R
grant revoke     : W0(S) → L1 → L2 → L5 → R                 (syncRevocation routes to composer)
apply/reconciler : W1 → tx{ W0(U) → L2 → L5 } → R            (single writer of applied revision)
enrollment       : W1 → tx{ W0(U) → L5 } → R                 (prepare/complete)
wallet sync      : LX = nana-wallet-sync:<userId>            (never nested today)
```

Every chain is a subsequence of the canonical list, so no cycle exists. The two hard
requirements this satisfies:

- **Deadlock-free by construction**, because lock acquisition is monotone in a single global order.
- **Claim vs removal**: the removal holds `W1` and the affected `L1`/`L2`; a concurrent claim
  holding `L1`/`L2` for the same grant either completes first (removal then observes
  `state='revoked'` and skips it) or blocks until the removal commits and then sees `revoked`. A
  claim can never succeed against a revoked scope.

`LX` is user-scoped and used by wallet sync (`src/wallet/embedded.ts:654-659`), which touches no
grant or recipient rows. No current path nests `LX` with `W1..L5`. The rule is recorded as: if any
future path needs both, the order is `W1 → LX → W0 → L1 → L2 → L3 → L4 → L5`, asserted by a
lock-order test.

### 1.4 The lease: exact shape and semantics

Table `recipient_policy_leases` (§2.4). API in `src/wallet/policy/lease.ts`:

```ts
acquirePolicyLease(deps: { database; walletId; userId; ownerId; waitBudgetMs? }):
  Promise<{ status: "acquired"; token: string } | { status: "busy" } | { status: "unavailable" }>
renewPolicyLease(deps, { walletId, token, leaseSeconds? }): Promise<boolean>
releasePolicyLease(deps, { walletId, token }): Promise<void>
```

- **Acquire** calls the SQL function `acquire_recipient_policy_lease(wallet_id, user_id, owner_id,
  lease_seconds)`, which mirrors `acquire_reconciliation_lease`
  (`src/db/migrations/013_wallet_notifications.sql:106-160`): delete expired rows, then
  `INSERT ... ON CONFLICT (wallet_id) DO UPDATE ... WHERE recipient_policy_leases.expires_at <= now()`,
  returning the token or no row. The function runs in `withSystemTransaction` (no user context),
  matching the existing system-only ingestion pattern (`src/db/client.ts:47-63`).
- **Bounded wait**: the caller retries with exponential backoff (100 ms × 2^n, capped at 1 s) up to
  `waitBudgetMs` (default 3 000 ms, configurable). Exhaustion returns `busy`; the operation is
  recorded as `pending` with `next_attempt_at` and the surface reports
  saved/pending — never a fabricated success. Nothing waits unboundedly.
- **Renew**: `UPDATE ... SET expires_at = now() + make_interval(secs => $3) WHERE wallet_id = $1
  AND lease_token = $2`. Token-guarded, so a lease reclaimed after expiry cannot be renewed by the
  original holder. Renewed every 10 s (`setInterval`, the same cadence as the room lease renewal in
  `src/livekit/worker.ts`); TTL 60 s; hard hold ceiling 300 s, after which the holder releases and
  re-acquires rather than renewing forever.
- **Release**: token-guarded `DELETE`. Always called in a `finally`.
- **Crash behaviour**: the row is reclaimed only after `expires_at <= now()`. A crashed holder
  cannot corrupt anything, because the only thing the lease protects is the *serialization* of
  compose+apply; every write is revision-verified (§1.5) and every apply is a full recomposition
  from persisted desired intent (§5.2). Worst case after a crash is a re-composition, never a
  partial rule set.
- **Revision at acquire**: the row records `desired_revision_at_acquire`, so a later inspection can
  tell whether the holder's intent was superseded while it waited.

### 1.5 Revision verification, and why a stale writer cannot overwrite

Every composition carries the `desired_revision` it was built from
(`recipient_policy_sync_intent.desired_revision`, §2.2). The applying transaction commits the
applied revision with a compare-and-set:

```sql
UPDATE recipient_policy_state
   SET applied_revision = $2, applied_rules_hash = $3, applied_policy_id = $4,
       applied_signer_id = $5, applied_signer_ids = $6::jsonb,
       status = 'applied', status_reason = NULL, verified_at = now(), updated_at = now()
 WHERE wallet_id = $7 AND desired_revision = $2
 RETURNING wallet_id
```

Zero rows updated means the desired revision moved while the holder was applying: the intent is
recorded `superseded` (audit `superseded`), no applied revision is written, and the holder
recomposes from the new desired revision. A stale writer therefore cannot downgrade
`applied_revision`; the `CHECK (applied_revision <= desired_revision)` in §2.1 plus the CAS make
"revision 7 overwrites revision 8" impossible at the database level.

`applied_revision` only ever moves forward, because the CAS predicate ties it to the current
desired revision and desired revisions are monotone (`CACHE`-free `desired_revision = desired_revision + 1`).

### 1.6 The recipient mutation transaction (removal, the hard case)

`RecipientPolicyService.remove(userId, contactId, expectedVersion, idempotencyKey)`:

**Phase A — read, no locks** (needed for the disclosure that must precede mutation):
1. Resolve `walletId` (ready `solana-devnet` wallet) and the target contact.
2. `aliases = SELECT id, version FROM recipients WHERE user_id=$1 AND status='active' AND
   address = <target address> ORDER BY id`.
3. `affected = SELECT id, recipients FROM delegated_grants WHERE wallet_id=$1 AND state='active'
   AND recipients @> to_jsonb(ARRAY[<target address>]::text[]) ORDER BY id`.
4. `lastAlias = aliases.length === 1`.
5. Build the proposal payload (immutable): action `remove`, contact id + version, address, and
   `affected_grant_ids` when `lastAlias`.

**Phase B — the transaction** (`withUserTransaction(userId, …)`):
1. `W1`: `acquirePolicyLease` (outside the transaction, bounded).
2. `W0(U)`: `SELECT ... FROM recipient_policy_state WHERE wallet_id=$1 FOR UPDATE`; insert the row
   if absent (`ON CONFLICT DO NOTHING` then re-select).
3. `L1`: one `pg_advisory_xact_lock(hashtext('dgc-grant-<id>'))` per affected grant, **ascending id**.
4. `L2`: `SELECT ... FROM delegated_grants WHERE id = ANY($1) ORDER BY id FOR UPDATE`.
5. `L3`: `SELECT ... FROM recipients WHERE user_id=$1 AND status='active' AND address=$2 ORDER BY id
   FOR UPDATE`.
6. **Re-derive under lock** and abort-check:
   - recompute the alias set; if `aliases` still has exactly the ids from Phase A, proceed;
   - recompute the affected set. If it now contains a grant not locked in step 3, `ROLLBACK` and
     restart the whole operation (bounded: 3 retries, then `blocked_conflict`). This can only be
     caused by a grant created between Phase A and Phase B, and grant creation must hold `W1`, so in
     practice it cannot happen — the check is a cheap invariant assertion, not a load path.
7. Mutations, all in this one transaction:
   - `UPDATE recipients SET status='inactive', updated_at=now() WHERE user_id=$1 AND id=$2 AND
     version=$3` — zero rows ⇒ `ContactsConflictError` (409), rollback;
   - if `lastAlias`: for each affected grant, `UPDATE delegated_grants SET state='revoked',
     revoked_at=now(), updated_at=now() WHERE id=$1 AND user_id=$2 AND state='active'` and append
     its `revoked` audit row via `appendGrantAudit` (`src/wallet/grants/consumption.ts` import;
     the `revoked` event is already in the audit CHECK, `src/db/migrations/008_delegated_grants.sql:70-72`);
   - `desired_revision = desired_revision + 1` on `recipient_policy_state`;
   - insert the `recipient_policy_sync_intent` row for that revision with the composed rules
     (`state='pending'`, `origin='screen'|'text'|'voice'`);
   - insert the audit rows (`intent_recorded`, and `revocation_disclosed` with the grant ids).
8. Commit. **Only then** the bounded apply attempt (§5).

The composed rules for step 7 are produced by `composeRevision()` **inside** the transaction
reading the post-mutation projection, but the result is *validated* against the Phase A projection
so that a metadata-only edit can be proven rule-identical (§3.4).

Transitions not covered by remote I/O: contact mutation, desired revision, grant revocation,
revocation audits and the durable intent are all committed before the first provider call. The
provider call never runs inside a transaction, so no database lock is held across remote I/O.

### 1.7 Deadlock / lock-order analysis against every writer found

- Claim against apply: both monotone in the canonical order; the only shared pair is
  (`W0`, grant locks) and `W0` is first in both. No cycle.
- Claim against removal: identical chain shape for claim; removal takes the same locks in the same
  order plus `L3` after `L2`. No cycle.
- Grant-create against removal: both take `W1` first, so they are mutually exclusive for the wallet;
  the abort-check in §1.6 step 6 is unreachable in practice.
- `syncGrant`/`syncRevocation` against removal: the composer path takes `W1`; the legacy path takes
  `W0/L1/L2` without `W1`. Both are monotone, so no deadlock; ordering between them is resolved by
  `L1`/`L2` contention. Slice 1 removes the legacy direction anyway (§3.5).
- Enrollment against apply: both take `W1`; enrollment only touches `L5` and `signer_grants`.
- `LX` (wallet sync) against anything above: not nested anywhere today. Rule recorded; asserted by
  test.

Tests: a lock-order unit test (a declarative order vector the modules must match) plus a DB
integration test that runs claim ‖ removal and claim ‖ apply concurrently under two connections
with `statement_timeout` set, asserting no `40P01` deadlock and one serialized outcome.

---

## 2. Migration shape

New file: `src/db/migrations/015_recipient_policy_sync.sql` (+ the Supabase-chain mirror, per the
existing convention noted in the 008/010 headers). `015` is the next free prefix after
`014_session_floor.sql`. Note that the series already contains two `012_*` files
(`012_chain_scoped_recipients.sql`, `012_grant_claim_release.sql`), so prefix uniqueness is *not* a
repo invariant: the runner filters `.sql`, sorts by filename and records the exact filename in
`schema_migrations` (`src/db/migrate.ts:14-18`). Ordering is therefore by full filename, and
`015_…` sorts after `014_…`.

Additive only: no column is dropped or narrowed, no existing row is rewritten, no constraint is
replaced. Every `CREATE TABLE`/`CREATE INDEX` uses `IF NOT EXISTS`, every `ALTER TABLE ADD
CONSTRAINT` uses the `IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = …)` guard and
`NOT VALID` — exactly the house pattern of `008_delegated_grants.sql:115-145` and
`012_chain_scoped_recipients.sql:6-22`.

### 2.1 `recipient_policy_state` — one row per wallet

```sql
CREATE TABLE IF NOT EXISTS recipient_policy_state (
  wallet_id            UUID PRIMARY KEY,
  user_id              UUID NOT NULL,
  desired_revision     BIGINT NOT NULL DEFAULT 0 CHECK (desired_revision >= 0),
  applied_revision     BIGINT NOT NULL DEFAULT 0 CHECK (applied_revision >= 0),
  desired_rules_hash   TEXT,
  applied_rules_hash   TEXT,
  applied_policy_id    TEXT,
  applied_signer_id    TEXT,
  applied_signer_ids   JSONB NOT NULL DEFAULT '[]'::jsonb,
  applied_recipients   JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_baseline     JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_provenance   JSONB NOT NULL DEFAULT '{}'::jsonb,
  empty_composition    TEXT NOT NULL DEFAULT 'unproven'
    CHECK (empty_composition IN ('unproven','proven_deny','unsupported')),
  status               TEXT NOT NULL DEFAULT 'saved_not_configured'
    CHECK (status IN ('saved_not_configured','pending','syncing','applied',
                      'retryable_failure','blocked_conflict','blocked_configuration')),
  status_reason        TEXT,
  status_detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count        INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at      TIMESTAMPTZ,
  verified_at          TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT recipient_policy_state_revision_order_ck
    CHECK (applied_revision <= desired_revision),
  CONSTRAINT recipient_policy_state_applied_complete_ck CHECK (
    status <> 'applied' OR (applied_revision = desired_revision
                            AND applied_rules_hash IS NOT NULL
                            AND applied_policy_id IS NOT NULL
                            AND applied_signer_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS recipient_policy_state_user_idx
  ON recipient_policy_state (user_id);
CREATE INDEX IF NOT EXISTS recipient_policy_state_retry_idx
  ON recipient_policy_state (next_attempt_at)
  WHERE status IN ('pending','retryable_failure','syncing');
```

- `consent_baseline` / `consent_provenance` are written **once**, on first composition, from the
  wallet's newest `state='active'` `signer_grants` row (`allowlisted_recipients` +
  `signer_enrollment_snapshot`, columns from `006_embedded_wallets.sql:29-45` and
  `010_canonical_signer_binding.sql:19-20`) and are never re-derived. That is what makes the
  retained baseline durable consent provenance rather than "whatever the remote policy currently
  says". `applied_recipients` is the verified readback's address union, kept so
  `signer_grants.allowlisted_recipients` can be refreshed consistently (§5.3).
- `applied_signer_ids` records the sibling signer ids observed at the last verified readback. Without
  a recorded prior observation, "unrelated signers preserved" is not a checkable statement.
- `empty_composition` defaults to `unproven` and is only written by a recorded probe result (§11).
  A fresh database therefore blocks the last-recipient removal rather than guessing.
- `status_detail` carries bounded evidence (`policyId`, `observedRulesHash`, `reason`, `code`) and
  **never** a secret, signature, token, key or transcript (spec: "Read APIs MUST NOT expose
  secrets, signatures, or key material").

### 2.2 `recipient_policy_sync_intent` — durable desired intent / outbox

```sql
CREATE TABLE IF NOT EXISTS recipient_policy_sync_intent (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id         UUID NOT NULL,
  user_id           UUID NOT NULL,
  desired_revision  BIGINT NOT NULL CHECK (desired_revision > 0),
  origin            TEXT NOT NULL CHECK (origin IN
    ('screen','text','voice','reconciler','enrollment','grant_create','grant_revoke',
     'grant_expiry','migration_backfill')),
  action            TEXT CHECK (action IN
    ('create','edit','rename','address_change','remove')),
  contact_id        UUID,
  contact_version   BIGINT,
  composed_rules    JSONB NOT NULL,
  composed_hash     TEXT NOT NULL,
  idempotency_key   TEXT,
  state             TEXT NOT NULL DEFAULT 'pending'
    CHECK (state IN ('pending','applying','applied','superseded','failed')),
  attempt_count     INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error        TEXT,
  last_attempt_at   TIMESTAMPTZ,
  next_attempt_at   TIMESTAMPTZ,
  applied_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recipient_policy_sync_intent_revision_idx
  ON recipient_policy_sync_intent (wallet_id, desired_revision);
-- Exactly one in-flight intent per wallet: a new mutation supersedes the old one explicitly.
CREATE UNIQUE INDEX IF NOT EXISTS recipient_policy_sync_intent_inflight_idx
  ON recipient_policy_sync_intent (wallet_id) WHERE state IN ('pending','applying');
CREATE UNIQUE INDEX IF NOT EXISTS recipient_policy_sync_intent_idempotency_idx
  ON recipient_policy_sync_intent (wallet_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recipient_policy_sync_intent_due_idx
  ON recipient_policy_sync_intent (next_attempt_at, desired_revision)
  WHERE state IN ('pending','applying');
```

`composed_rules` is the exact intent the reconciler compares against the readback. Storing it means
a restart can retry without re-deriving from mutable tables, and it makes the comparison an
equality between two stored artifacts rather than a recomputation that could drift.

### 2.3 `contact_action_proposals` — immutable, versioned, one-use

```sql
CREATE TABLE IF NOT EXISTS contact_action_proposals (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL,
  wallet_id         UUID,
  conversation_id   UUID,
  kind              TEXT NOT NULL DEFAULT 'contact'
    CHECK (kind IN ('contact','transfer')),
  action            TEXT NOT NULL CHECK (action IN ('create','edit','rename','address_change','remove')),
  contact_id        UUID,
  contact_version   BIGINT,
  address           TEXT NOT NULL,
  previous_address  TEXT,
  revoked_grant_ids UUID[] NOT NULL DEFAULT '{}',
  version           INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  supersedes_id     UUID,
  proposal_hash     TEXT NOT NULL,
  origin            TEXT NOT NULL CHECK (origin IN ('screen','text','voice')),
  status            TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open','consumed','expired','cancelled','superseded')),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at        TIMESTAMPTZ NOT NULL,
  published_at      TIMESTAMPTZ,
  confirmed_user_turn BIGINT,
  consumed_at       TIMESTAMPTZ,
  consumed_by_tool  TEXT,
  consumed_by_session TEXT
);

CREATE UNIQUE INDEX IF NOT EXISTS contact_action_proposals_one_open_idx
  ON contact_action_proposals (user_id, conversation_id) WHERE status = 'open';
CREATE UNIQUE INDEX IF NOT EXISTS contact_action_proposals_version_idx
  ON contact_action_proposals (user_id, id, version);
CREATE INDEX IF NOT EXISTS contact_action_proposals_open_idx
  ON contact_action_proposals (conversation_id) WHERE status = 'open';
```

The partial unique index is the cross-process "one window at a time" enforcement: two processes
cannot hold two open contact proposals for the same conversation. Immutability of a version is
enforced by convention plus the fact that the only writes are the status/consumption columns and
`published_at` — the identity columns (`address`, `action`, `version`, `revoked_grant_ids`) are never
updated; a changed address is a **new row** with `version = version + 1` and `supersedes_id` set.

### 2.4 `recipient_policy_leases` + functions

```sql
CREATE TABLE IF NOT EXISTS recipient_policy_leases (
  wallet_id                UUID PRIMARY KEY,
  user_id                  UUID NOT NULL,
  lease_token              TEXT NOT NULL,
  owner_id                 TEXT NOT NULL,
  desired_revision_at_acquire BIGINT NOT NULL DEFAULT 0,
  acquired_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at               TIMESTAMPTZ NOT NULL
);

CREATE OR REPLACE FUNCTION acquire_recipient_policy_lease(
  p_wallet_id UUID, p_user_id UUID, p_owner_id TEXT, p_lease_seconds INTEGER DEFAULT 60
) RETURNS TABLE (lease_token TEXT) LANGUAGE plpgsql AS $$ … $$;
CREATE OR REPLACE FUNCTION renew_recipient_policy_lease(
  p_wallet_id UUID, p_lease_token TEXT, p_lease_seconds INTEGER DEFAULT 60
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$ … $$;
CREATE OR REPLACE FUNCTION release_recipient_policy_lease(
  p_wallet_id UUID, p_lease_token TEXT
) RETURNS BOOLEAN LANGUAGE plpgsql AS $$ … $$;
```

Bodies mirror `acquire_reconciliation_lease` exactly (`src/db/migrations/013_wallet_notifications.sql:126-160`),
including the table-qualified column references inside the `RETURNS TABLE(lease_token)` OUT
variable trap. `renew` and `release` are token-guarded and both `RETURN` the affected row count as a
boolean, so a stale holder learns its lease was taken over.

`desired_revision_at_acquire` is read from `recipient_policy_state` inside `acquire`, so a
diagnostic can tell whether the intent moved while queued.

### 2.5 `recipient_policy_audit` — append-only evidence

```sql
CREATE TABLE IF NOT EXISTS recipient_policy_audit (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id        UUID NOT NULL,
  user_id          UUID NOT NULL,
  desired_revision BIGINT,
  applied_revision BIGINT,
  event            TEXT NOT NULL CHECK (event IN (
    'intent_recorded','revocation_disclosed','lease_acquired','lease_reclaimed',
    'apply_attempt','applied','readback_mismatch','apply_failed','superseded',
    'blocked_conflict','blocked_configuration','drift_repaired','binding_invalidated',
    'proposal_published','proposal_consumed','evidence_refused')),
  reason           TEXT,
  detail           JSONB,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipient_policy_audit_wallet_created_idx
  ON recipient_policy_audit (wallet_id, created_at);
CREATE INDEX IF NOT EXISTS recipient_policy_audit_user_event_idx
  ON recipient_policy_audit (user_id, event);
```

Append-only is enforced with the same guard trigger pattern as `grant_audit_log`
(`src/db/migrations/008_delegated_grants.sql:84-95`): a `BEFORE UPDATE OR DELETE` trigger that
`RAISE EXCEPTION`s.

### 2.6 RLS, grants and FKs

Following `008` and `013`:

- `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` on all five tables.
- User-isolation policy (`user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`, both
  `USING` and `WITH CHECK`) on `recipient_policy_state`, `recipient_policy_sync_intent` (plus a
  system-access policy for the reconciler scan, mirroring
  `assistant_lifecycle_outbox_system_access`), `recipient_policy_audit` and
  `contact_action_proposals`.
- System-only policy (no `app.user_id` set) on `recipient_policy_leases`, mirroring
  `reconciliation_leases_system_only` (`013_wallet_notifications.sql:186-192`).
- `REVOKE ALL … FROM PUBLIC` then `GRANT` to `recipient_app`:
  - `recipient_policy_state`, `recipient_policy_sync_intent`, `contact_action_proposals`: `SELECT,
    INSERT, UPDATE`;
  - `recipient_policy_audit`: `SELECT, INSERT` only;
  - `recipient_policy_leases`: `SELECT, INSERT, UPDATE, DELETE`. The three functions need
    `SECURITY DEFINER` only if `recipient_app` lacks a privilege; `013`'s function runs as the
    invoker under the app role, so the same style is used (no `SECURITY DEFINER`).
- FKs, each guarded and `NOT VALID`, matching `008_delegated_grants.sql:115-145`: `user_id →
  users(id)` on all five; `wallet_id → user_wallets(id)` on state/intent/audit/proposals/leases;
  `contact_id → recipients(id)` on intent and proposals; `supersedes_id → contact_action_proposals(id)`.

### 2.7 `signer_grants` / `delegated_grants` — no schema change

No column is added to `signer_grants`. Slice 2 **writes** `signer_grants.allowlisted_recipients` and
`policy_hash` from the verified readback, and writes the authoritative binding in
`recipient_policy_state.applied_rules_hash`. `delegated_grants.provider_policy_id` keeps its meaning
("the provider policy id this grant was last bound to") and is the column the atomic invalidation
fallback clears (§4.3).

---

## 3. One composer

New module `src/wallet/policy/` containing `composer.ts`, `service.ts`, `lease.ts`,
`reconciler.ts`, `readback.ts`, `probe.ts`, `errors.ts`.

### 3.1 Inputs

```ts
export type ComposeInput = {
  walletId: string;
  userId: string;
  /** Frozen consent baseline, from recipient_policy_state.consent_baseline. */
  baseline: { addresses: string[]; provenance: BaselineProvenance };
  /** Active confirmed Solana contacts (recipients.status='active', network='solana-devnet'). */
  contacts: Array<{ id: string; version: number; address: string }>;
  /** Active delegated grants, ledger-shaped. */
  grants: GrantPolicyInput[];              // src/wallet/grants/solana-policy-provisioner.ts:55-65
  ordinaryCapLamports: string;             // always "10000000"
  emptyComposition: "unproven" | "proven_deny" | "unsupported";
};
```

`ComposeInput` is assembled by `service.ts` from
`recipients` (RLS-scoped), `delegated_grants` (via `listActiveGrants`, which already validates owner
scope and chain family at `src/wallet/grants/privy-policy-runtime.ts:74-110`) and
`recipient_policy_state`. The composer itself is a **pure function** — no I/O, no clock — so every
invariant below is unit-testable without a database.

### 3.2 Outputs and guarantees

```ts
export type ComposedPolicy = {
  rules: GrantPolicyRule[];            // exact PATCH body and exact readback comparator
  hash: string;                        // sha256 over the canonical serialization
  ordinaryRecipients: string[];        // sorted baseline ∪ contact addresses
  grantRecipients: Array<{ grantId: string; recipients: string[] }>;
  provenance: Record<string, "baseline" | "contact" | "grant">;
};
```

Guarantees, each a stated invariant with a test:

1. **Ordinary ceiling is exactly 10 000 000 lamports.** The ordinary rule is byte-identical in name
   and conditions to `buildSolanaEnrollmentRules` (`src/wallet/grants/solana-enrollment-rules.ts:44-62`),
   including `name: "Solana transfer allowlist"`. The value originates from the single constant
   `SOLANA_MAX_PER_TRANSFER_LAMPORTS = "10000000"` (`src/wallet/embedded.ts:19`).
2. **No consent expansion.** The ordinary rule's allowlist is `baseline ∪ active confirmed Solana
   contacts` only. Grant recipients are **not** folded into it — they appear exclusively in their own
   conditioned rules. *(Rejected alternative: include grant recipients in the ordinary rule. It would
   widen the 0.01 SOL allowlist beyond the trusted-contact consent the user gave, and `spec.md`'s
   "Invariants preserved through every composition" forbids broadening. It is also unnecessary: a
   transfer to a grant recipient is already permitted by that grant's own rule.)*
3. **Delegated limits and expiries untouched.** Grant rules are produced by the existing
   `composeGrantRules` (`src/wallet/grants/solana-policy-provisioner.ts:120-147`), which reads
   `max_per_transfer` and the stored `expires_at` from the ledger and never synthesizes a window.
   One rule per grant, `name = solana-grant-<grantId>` truncated to 50 characters.
4. **Determinism.** Array ordering is fixed: rule order = ordinary rule first, then grants ascending
   by `grantId` byte order; address arrays sorted by JavaScript default string comparison
   (UTF-16 code-unit order, stable and locale-independent — `localeCompare` is rejected because it is
   locale-sensitive and would make the hash environment-dependent).
5. **Hash.** `hash = sha256(JSON.stringify(canonical))`, where `canonical` is an array of arrays with
   object keys emitted in a fixed declared order (not `Object.keys` order). This is a *rule* hash;
   it is deliberately distinct from the consent-envelope `policy_hash` computed by
   `deterministicPolicyHash` (`src/wallet/embedded.ts:1573-1585`), which hashes
   `limit|window|recipients.join(',')`, not rules. Both exist; only `composed rules hash` feeds the
   authorization gate.
6. **Ownership / attachment.** The composer never selects the signer. The canonical signer comes
   from `user_wallets.provider_signer_id` through `resolvePolicyTarget`
   (`src/wallet/grants/privy-policy-admin.ts:68-96`), which already refuses a missing binding, a
   non-ready wallet, and a quorum id used as a signer identity (`:100-113`).
7. **Unrelated signers.** `attachPolicyToSigner` remains the narrow, complete-list mutation with
   post-mutation readback (`src/wallet/grants/privy-policy-admin.ts:121-176`); the composer adds a
   readback assertion that every id in `applied_signer_ids` is still present.
8. **Empty composition never detaches.** If `ordinaryRecipients.length === 0 && grants.length === 0`:
   `emptyComposition` must be `'proven_deny'` to emit `rules: []`; `'unsupported'`/`'unproven'`
   throws `PolicyEmptyCompositionUnprovenError`, which the service maps to
   `blocked_configuration` and a visible stop, leaving the recipient in place (§11.1).

### 3.3 Collapsing the three writers

| Current writer | Entry point | After |
| --- | --- | --- |
| Enrollment rules | `buildSolanaEnrollmentRules` called from `preparePermission` (`src/wallet/embedded.ts:926`) | The composer emits the ordinary rule; the function is moved behind `composer.ts` and is no longer imported by `embedded.ts`. |
| Grant full-rule PATCH | `createSolanaGrantPolicyProvisioner(...).provisionPolicy` / `.revokePolicyRules` (`src/wallet/grants/solana-policy-provisioner.ts:177`, `:224`, `:312`) | **Deleted.** `createRuntimeGrantPolicyProvisioner` (`src/wallet/grants/privy-policy-runtime.ts:145-183`) keeps its `GrantPolicyProvisioner` port because `PrivyPolicySyncService` depends on it, but both methods delegate to `composeAndApply(walletId, cause)`. |
| Contact-only third writer | (new, would be) | Never created. Contact mutations call the same service. |
| Enrollment policy creation in `preparePermission` | `privyServer.createPolicy(...)` at `src/wallet/embedded.ts:925-931` | Removed from `preparePermission`; policy creation happens only inside the composer. |

Unreachable **by construction**, not by convention:

- `composeGrantRules` is re-exported from `src/wallet/policy/composer.ts` as the internal rule
  builder and imported nowhere else.
- A structural test (pattern: `tests/unit/signer-worker-path.test.ts:256-290`, which asserts a set of
  files never read the authorization key) asserts that no file outside `src/wallet/policy/**` and
  `src/wallet/signer/**` calls `createPolicy`, `patchPolicy`, or `addPolicyToSigner`.
- The repository-level mutation methods on `ContactsRepository` become `private`-by-module: the
  `RecipientPolicyService` is the only exported caller. The structural test asserts no module outside
  `src/wallet/policy/**` and `src/api/contacts.ts` imports `ContactsRepository` for mutation.
- A path that cannot route through the composer throws `PolicyComposerRequiredError`, which the
  service maps to a typed configuration error (spec: "Unsupported writer path fails visibly").

### 3.4 `preparePermission`'s pending-policy reuse

Today: `preparePermission` reuses `existing.provider_policy_id` from the newest `pending`
`signer_grants` row (`src/wallet/embedded.ts:906-921`), and `completePermission` then only asserts
that the canonical signer carries **that stored id** (`src/wallet/embedded.ts:1238-1269`, attach+readback at `:1303-1360`). A reused pending
policy can therefore hold a rule set that predates a later contact change, and completion activates
it on the strength of the id alone.

Replacement:

1. `preparePermission` **no longer creates or reuses a policy**. It records the enrollment consent
   intent (recipients the user approved) as a `recipient_policy_sync_intent` row with
   `origin='enrollment'` and composes the desired revision.
2. The composer creates the policy only when the signer has none
   (`getSignerPolicyIds(walletId).length === 0`), attaches it via the narrow
   `attachPolicyToSigner`, verifies the post-attach signer readback (the existing check at
   `src/wallet/grants/solana-policy-provisioner.ts:260-270` is preserved verbatim), then PATCHes the
   composed rules and verifies the readback.
3. `completePermission` verifies against `recipient_policy_state.applied_policy_id` **plus** a rule
   readback that equals `applied_rules_hash`, instead of against the pending row's stored id. A
   pending row whose stored id no longer matches the applied revision can no longer activate.
4. Retry-idempotency of `prepare` is preserved by a different mechanism: the durable intent row for
   the wallet's current desired revision is reused rather than a policy created per retry.

The `signer_enrollment_snapshot` mechanism (`src/wallet/embedded.ts:899-901`, `:1386-1395`) is
untouched — it still solves the pre-consent signer diff.

### 3.5 Ordering of the composer's I/O

`composeAndApply(userId, walletId, cause)`:

```
1  W1 acquire lease (bounded wait)
2  tx{ W0(U) → read desired revision + composed_rules + signer/attachment expectation }
3  commit
4  R: owner-verified signer readback  (privyDid(userId) → listWalletsForChain('solana'))
5  R: getPolicy(applied_policy_id ?? attached[0])           ← the pristine readback
6  compare (see §5.1); unknown rule / owner / attachment drift → §4.3 invalidation, stop
7  R: createPolicy / attachPolicyToSigner only if the signer has no policy
8  R: patchPolicy(policyId, { rules })  — idempotent: skip when the pristine readback already
                                          equals the composed rules
9  R: getPolicy(policyId)                                   ← the verification readback
10 tx{ W0(U) → CAS applied revision (§1.5) → refresh signer_grants → audit } → commit
11 W1 release
```

No transaction is open at steps 4–9. A failed step 8 leaves the intent durable with
`state='pending'`/`'applying'` and `next_attempt_at` set; the applied revision is unchanged, so
automatic execution stays blocked by the revision gate (§4.1) without needing the destructive
fallback.

---

## 4. Applied-revision binding for delegated executions

### 4.1 Coverage (classification) gate

`createGrantGate` resolves the wallet at `src/conversations/grant-gate.ts:109-112` and then reads
all grants (`:124`) before classifying (`:125`). Immediately after the wallet id is resolved, and
before `listGrants`, the gate reads `recipient_policy_state` for that wallet and forces
`covered: false` (mode `not_covered`, reason `policy_unverified`) unless **all** of:

```
status = 'applied'
AND applied_revision = desired_revision
AND applied_rules_hash = desired_rules_hash
AND applied_policy_id IS NOT NULL
AND applied_signer_id IS NOT NULL
AND verified_at IS NOT NULL
```

The pure classifier (`classifyGrantCoverage`, `src/conversations/grant-coverage.ts`) is **unchanged**
— its unit tests keep their meaning — and the wallet-level check lives in the adapter's database
read. This is the requirement "a bound policy ID alone is insufficient": `provider_policy_id` is
still required at the claim (`src/wallet/grants/consumption.ts:490-495`, `policy_not_ready`), but it
is no longer sufficient, because an unverified wallet degrades **all** of its grants, including
siblings for other recipients.

### 4.2 Claim gate

`claimConsumption` (`src/wallet/grants/consumption.ts:396`) gains exactly one lock and one check, at
the top of its transaction, before the existing `dgc-grant-` advisory lock:

```sql
SELECT status, desired_revision, applied_revision, desired_rules_hash, applied_rules_hash
  FROM recipient_policy_state WHERE wallet_id = $1 FOR SHARE
```

Missing row, or any predicate from §4.1 failing ⇒ append a `rejected` audit row with reason
`policy_unverified` and return `{ consumed: false, reason: "policy_unverified" }`. The existing
`reason` column is free text with no CHECK (`008_delegated_grants.sql:67-77` only constrains
`event`), so no migration is needed for the new reason code.

`FOR SHARE` (not `FOR UPDATE`) is deliberate: the claim must not block sibling claims, only the
apply transaction that changes the revision. Read locks do not conflict with each other.

### 4.3 Atomic fallback that invalidates every affected binding

Triggered only on **proven** divergence, in one transaction:

| Condition | Status | Fallback |
| --- | --- | --- |
| Readback differs from `composed_rules` (step 6/9 of §3.5) | `blocked_conflict` | clear bindings |
| Remote rule with no provenance (§5.1d) | `blocked_conflict` | clear bindings |
| Owner drift | `blocked_configuration` | clear bindings, no PATCH |
| Canonical signer absent/ambiguous/policy id mismatch/sibling signer lost | `blocked_configuration` | clear bindings, no PATCH |
| Readback unreachable, PATCH timeout, lease busy, budget exhausted | `syncing` / `retryable_failure` / `pending` | **no** binding change |

The fallback transaction:

```sql
UPDATE recipient_policy_state
   SET status = $2, status_reason = $3, status_detail = $4::jsonb,
       applied_rules_hash = NULL, desired_rules_hash = NULL,
       updated_at = now()
 WHERE wallet_id = $1
RETURNING desired_revision;

UPDATE delegated_grants
   SET provider_policy_id = NULL, updated_at = now()
 WHERE wallet_id = $1 AND state = 'active' AND provider_policy_id IS NOT NULL
RETURNING id;                                   -- one audit row per returned id
```

plus one `binding_invalidated` audit row per returned grant id and one
`blocked_conflict`/`blocked_configuration` row on `recipient_policy_audit`. Clearing
`provider_policy_id` is the existing fail-closed posture for this codebase
(`src/wallet/grants/privy-policy-sync.ts:163-175` clears it on any provisioning failure), extended
from one grant to the whole wallet because the policy is per-wallet now.

The distinction in the table matters and is a design decision: **an unknown outcome is not the same
as a proven mismatch.** Unknown outcomes block by way of the revision gate (non-destructive, and
recoverable by a readback); proven mismatches additionally destroy the stale binding, because from
that moment the provider's rule set is known *not* to be our consent-complete intent.

### 4.4 Restoring automatic execution

A successful apply that writes `applied_revision = desired_revision` with matching hashes restores
coverage on the next evaluation. `provider_policy_id` is re-bound by the same apply transaction from
the verified readback (the composer knows the policy id it PATCHed and verified). No manual repair
step exists, and no grant is re-granted or extended as a side effect — the grant row's limits,
window and expiry are untouched by all of §4.

---

## 5. Reconciler

`src/wallet/policy/reconciler.ts`.

### 5.1 What the readback is compared against

Two readbacks, both from `getPolicy(policyId)` (`src/wallet/grants/privy-policy-admin.ts` →
`src/wallet/grants/privy-policy-runtime.ts:62-70`, which already throws when `rules` is not an array):

- **pristine** readback (step 5) decides whether any PATCH is needed at all;
- **verification** readback (step 9) decides whether the revision may be marked applied.

Comparison, in this order:

| Check | Comparison | Failure class |
| --- | --- | --- |
| (a) policy id | `readback.id === expectedPolicyId` | `blocked_conflict` |
| (b) rule-set equality | `isDeepStrictEqual(readback.rules, composed.rules)` — the existing structural comparator, key-order independent (`src/wallet/grants/solana-policy-provisioner.ts:97-99`) | `blocked_conflict` |
| (c) unknown rule | every `readback.rules[i].name` ∈ composed names | `blocked_conflict` |
| (d) address provenance | every `Transfer.to` entry in every readback rule ∈ `provenance` keys (baseline ∪ contacts ∪ grant recipients) | `blocked_conflict` |
| (e) canonical signer attachment | owner-verified readback shows the canonical signer **exactly once**, carrying **exactly** our policy id | `blocked_configuration` |
| (f) unrelated signers | every id in `applied_signer_ids` still present in the owner-verified signer list | `blocked_configuration` |
| (g) ownership | the wallet was resolved from the owner-verified listing for `privyDid(userId)` | `blocked_configuration` |

Checks (c) and (d) are what make the spec's "unknown remote rules MUST block mutation instead of
being deleted or copied into desired state" mechanically true: we never write `composed.rules`
derived from the readback, and we refuse to PATCH while an unexplained rule exists. Test1's drift is
repaired because Test1 *has* provenance — its address is an active confirmed contact — so the
composer already emits it and the PATCH legitimately converges. A remote entry with no consent record
stops the flow with a recorded `blocked_conflict`.

Checks (e) and (f) require the composer to switch its signer read to the **owner-verified** path
(§0 C5). Until that is done in slice 2, (e)–(g) cannot be evaluated and the flow must stop as
`blocked_configuration` — that is the fail-closed choice, and it is why U2 in §11 is a blocking stop
condition rather than an assumption.

### 5.2 Retry and backoff from durable intent

`reconcileWallet(walletId)`:

```
1  claim lease (bounded); busy → return without touching state
2  SELECT * FROM recipient_policy_sync_intent
     WHERE wallet_id=$1 AND state IN ('pending','applying')
       AND (next_attempt_at IS NULL OR next_attempt_at <= now())
     ORDER BY desired_revision LIMIT 1
   none → release, return
3  if the intent row's lease_token is set and its holder's lease is expired:
     audit 'lease_reclaimed'; clear the intent's in-flight marker   ← restart recovery
4  run §3.5 steps 4–10 for that revision
5  on success: intent.state='applied', applied_at=now()
   on retryable failure: attempt_count+1, last_error, next_attempt_at = now()+backoff
   on proven divergence: intent.state='failed' + §4.3 fallback
6  release lease
```

Backoff: `min(5s × 2^attempt_count, 5min)` with ±20 % jitter, `attempt_count` capped at 12 before the
state becomes `retryable_failure` and stops auto-retrying (the user-visible retry endpoint still
works).

**Restart recovery is structural, not special-cased**: nothing in memory is authoritative. A process
that dies after committing intent and before the readback leaves `state='applying'` with an expired
lease; the next reconciler pass reclaims it at step 3 and resumes from the stored
`composed_rules`/`composed_hash`. This is why `composed_rules` is persisted rather than recomputed.

**Scheduling**: a `setInterval` loop (30 s) started in both `src/server.ts` and
`src/runtime/dependencies.ts`, guarded by the env switch `RECIPIENT_POLICY_RECONCILER=enabled|disabled`.
No extra cross-process coordination primitive is introduced: the lease already guarantees that only
one process can apply a given wallet, so two loops cannot double-apply.

### 5.3 Ambiguous PATCH: GET-before-retry

`patchPolicy` failures surface as `PrivyServerError`
(`src/wallet/privy-server-client.ts:166-175`). Classification:

```
timeout / 5xx / network            → UNVERIFIED
4xx                                → DEFINITIVE REJECTION (validation/shape problem)
```

An UNVERIFIED outcome never triggers a second blind PATCH. The reconciler first performs the
verification readback (§5.1) and decides:

| GET result | Decision |
| --- | --- |
| rules equal `composed.rules` | treat as applied; record `applied` with `detail.confirmedBy = "get_after_timeout"` |
| rules equal the previous applied rules | safe to retry the same revision |
| a third, unexplained rule set | `blocked_conflict` + §4.3 fallback |
| GET itself fails | `syncing` with `next_attempt_at`; **no** retry of the PATCH until a GET succeeds |

A DEFINITIVE 4xx rejection is `retryable_failure` with the provider message recorded in
`last_error`/`detail` (bounded, no secrets) and no readback-based promotion.

### 5.4 Post-apply bookkeeping

On a verified apply: within the same transaction, refresh `signer_grants` for the wallet's newest
`state='active'` row — `allowlisted_recipients` = the verified address union,
`policy_hash` = the applied rule hash — so the two representations of the same intent agree (spec
success criterion "`allowlisted_recipients` and `policy_hash` consistently"). `applied_recipients`
in `recipient_policy_state` is the same value, so a later diagnostic can detect a divergence without
the provider.

---

## 6. Backend signed-authorization capability

### 6.1 What the topology actually is

From `compose.privy-local.yaml`: `db`, `livekit`, `backend`, `voice-worker`, `frontend`. `backend`
and `voice-worker` are separate containers with separate network namespaces
(`compose.privy-local.yaml:46-108`); `frontend` receives only `VITE_PRIVY_APP_ID`
(`:109-117`). Neither application service declares `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN`, and no
signer service exists. `compose.privy-local.ports.yaml` only overrides host ports. `compose.yaml`'s
`backend`/`voice-worker` dev profiles are the same story.

Consequence: `createWorkerPayloadSigner` returns `undefined`, `canSignAuthorizations()` is false, and
`createGrantPolicySyncService` returns the `unavailable` provisioner — every signed policy write
fails closed. This is the *state of the world*, and slice 2 must add the missing capability rather
than assume it exists.

### 6.2 Wiring

The sidecar refuses any non-loopback bind (`src/wallet/signer/server.ts:220-225`) and re-checks the
bound address after `listen` (`:260-266`). It therefore cannot be a normal service reached over the
compose network. It must **share the consumer's network namespace**:

```yaml
# compose.privy-local.yaml (additive)
  backend-signer:
    image: nana-privy-backend-dev:local
    restart: unless-stopped
    entrypoint: ["/bin/sh", "-c"]
    command: ["npm run build && exec node dist/wallet/signer/server.js"]
    network_mode: "service:backend"          # loopback of the backend container
    environment:
      PRIVY_SIGNER_TOKEN: ${PRIVY_SIGNER_TOKEN:?}
      PRIVY_SIGNER_KEY_FILE: /run/secrets/privy-authorization-private-key
      PRIVY_SIGNER_HOST: 127.0.0.1
      PRIVY_SIGNER_PORT: "8788"
    volumes:
      - ${PRIVY_SIGNER_KEY_DIR:-./.secrets}:/run/secrets:ro

  voice-worker-signer:
    image: nana-privy-backend-dev:local
    restart: unless-stopped
    entrypoint: ["/bin/sh", "-c"]
    command: ["npm run build && exec node dist/wallet/signer/server.js"]
    network_mode: "service:voice-worker"     # loopback of the worker container
    environment: { …same, PRIVY_SIGNER_PORT: "8789" }
    volumes:
      - ${PRIVY_SIGNER_KEY_DIR:-./.secrets}:/run/secrets:ro

# and, on backend and voice-worker respectively:
#   PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign"   (worker: 8789)
#   PRIVY_SIGNER_TOKEN: ${PRIVY_SIGNER_TOKEN:?}
#   PRIVY_SIGNER_TIMEOUT_MS: "5000"
```

Two sidecars, one per consumer namespace, because a single sidecar can only share one namespace and
the backend must not depend on the worker being up. Distinct ports are belt-and-braces; the namespaces
are already distinct.

### 6.3 What must NOT happen

- No `PRIVY_AUTHORIZATION_PRIVATE_KEY`, `PRIVY_SIGNER_KEY_FILE` or `PRIVY_SIGNER_TOKEN` in the
  `frontend` service environment (today it has only `VITE_PRIVY_APP_ID`; that stays true).
- No key material in `backend` or `voice-worker`: their containers must never mount
  `privy-authorization-private-key`. The backend holds `PRIVY_SIGNER_URL` + a shared token, which is
  a capability, not a key.
- No `ports:` declaration on either signer service. The loopback bind is the second line of defence;
  the absence of a published port is the first.
- No signing proxy inside the backend (no `/v1/signer/*` route, no sign endpoint re-export). The
  backend talks to `127.0.0.1:8788/sign` directly.
- No secret, token, key, payload or signature value in any log line, error message or HTTP response
  (already enforced in `src/wallet/signer/server.ts:43-51` and `src/wallet/signer/client.ts:19-38`;
  the new code must not regress it).
- The signer's own honest limitation stands: the endpoint is a signing oracle reachable by anything
  holding the token inside that namespace (`src/wallet/signer/README.md:76-98`). This change does not
  weaken it and does not claim to fix it.

### 6.4 Verification without exposing secrets

Three layers, none of which reads or prints a secret:

1. **Structural** — a test in the style of `tests/unit/signer-worker-path.test.ts` asserts that the
   compose files declare no key variable on `frontend`/`backend`/`voice-worker`, that no signer
   service declares `ports:`, and that `network_mode: service:` is present on both signer services.
2. **Capability probe** — `verifyPolicySignerCapability()` in `src/wallet/policy/probe.ts`:
   signs one fixed, non-secret payload of exactly the shape produced by
   `signerAuthorizationContext` (`src/wallet/signer/authorization-context.ts`) and returns
   `{ capable: boolean, code: 'verified'|'signer_unavailable'|'signer_rejected'
   |'signer_timeout'|'signature_mismatch' }`.
   - The assertion is **verification, never byte-equality**: ECDSA P-256 uses a random per-signature
     nonce, so two signatures over the same payload are never equal
     (`src/wallet/signer/README.md:99-107`). The check is
     `crypto.verify("sha256", payload, publicKeyObject, signature)` against the configured
     `PRIVY_AUTHORIZATION_PUBLIC_KEY`, which `readPrivyServerConfig` has already validated as P-256
     SPKI DER (`src/config/privy-server.ts:39-63`).
   - This proves **authority**, not just reachability: only the holder of the private key matching the
     registered quorum public key can produce a signature that verifies.
   - Only the boolean and the code leave the function. No token, key, payload or signature is
     returned or logged.
3. **Readiness surface** — the existing health route (`src/server.ts:234-237`) gains
   `policySigner: { capable: boolean, code: string }`. No other field is added and no read API
   changes shape.

---

## 7. Confirmation arbiter

### 7.1 Shape

`src/conversations/confirmation-arbiter.ts`, pure and I/O-free:

```ts
export type ActionKind = "transfer" | "contact";
export type ActionWindow = {
  kind: ActionKind;
  actionId: string;          // transfer: previewId; contact: proposalId
  userId: string;
  createdAt: number;
  version: number;           // immutable preview/proposal version
  conversationId: string;
};

createConfirmationArbiter(deps: {
  classifiers: { isConfirmation(text: string): boolean; isCancellation(text: string): boolean };
  onObservation?(event: Record<string, string | number | boolean | null>): void;
  boundedWaitMs?: number;    // default 2_000
}): {
  open(window: ActionWindow): { status: "opened" } | { status: "conflict"; current: ActionWindow };
  recordEvidence(input: {
    kind: ActionKind; actionId: string; userId: string; sessionId: string;
    text: string; isFinal: boolean; authenticatedSpeaker: boolean; createdAt: number;
  }): void;
  consume(input: {
    kind: ActionKind; actionId: string; userId: string; version: number; tool: string;
  }): { status: "consumed" } | { status: "refused"; code: ArbiterRefusalCode };
  waitAndConsume(input /* as consume */, timeoutMs?: number): Promise<…>;
  cancel(kind: ActionKind, actionId: string): void;
  clear(actionId: string): void;
  current(): ActionWindow | undefined;
};
```

`ArbiterRefusalCode ∈ { 'no_window' | 'kind_mismatch' | 'action_mismatch' | 'user_mismatch' |
'version_mismatch' | 'already_consumed' | 'expired' | 'no_evidence' | 'evidence_expired' |
'model_supplied' }`.

### 7.2 Where it lives, given two processes

| Process | Instance | Scope | Evidence source |
| --- | --- | --- | --- |
| voice worker | one per LiveKit job, built beside the existing `voiceDecisionGate` | the bound conversation (`binding.conversationId`, `binding.sub`) | `attachVoiceDecisionTranscripts` (`src/livekit/voice-decision-transcripts.ts:19-35`), authenticated speaker via the existing `isAuthenticatedSpeaker` predicate |
| backend | one per `ConversationSession` (`src/conversations/session-state.ts:5-12`) | the typed/text conversation | the server-side turn handler; never a tool argument |

The in-process arbiter owns the **window** (which kind may be authorized right now). The persisted
`contact_action_proposals` row owns **one-use**, and that is what spans processes:

```sql
UPDATE contact_action_proposals
   SET status = 'consumed', consumed_at = now(),
       consumed_by_tool = $4, consumed_by_session = $5
 WHERE id = $1 AND version = $2 AND user_id = $3
   AND status = 'open' AND consumed_at IS NULL AND expires_at > now()
RETURNING id, action, contact_id, contact_version, address, revoked_grant_ids
```

Executed inside the mutation transaction, in the `L5` slot. Zero rows ⇒ refused. Two processes
presenting the same evidence cannot both consume, because the row update is the serialization point.
The partial unique index (§2.3) independently prevents two open proposals per conversation.

### 7.3 Extending the transfer gate without regressing it

The transfer kind is a **delegation**, not a reimplementation:

- `voiceDecisionGate.prepare(previewId, createdAt)` → `arbiter.open({kind:'transfer', actionId:
  previewId, userId, createdAt, version: 0, conversationId})`.
  `version: 0` is intentional: transfer previews have no versioned proposal and this change must not
  invent one.
- The transfer evidence eligibility rule is inherited verbatim: a final, authenticated transcript
  with `input.createdAt > previewCreatedAt` (`src/livekit/voice-decision-gate.ts:96-104`), interim
  transcripts rejected, previous-turn confirmations rejected.
- `waitAndConsume` keeps the 2 000 ms bound, the wake-on-evidence behaviour, and invalidation on
  replacement/clear/consumption (`src/livekit/voice-decision-gate.ts:141-176`). The
  `boundedWaitMs` default is the same constant; the arbiter must not redefine it (spec: "The arbiter
  MUST NOT redefine the transfer gate's bounded wait for a delayed final transcript").
- Consumption is once per action id, and a consumed action id is never re-armed by later evidence.
- Regression proof: the whole `voice-decision-gate` unit suite must pass unchanged, plus an adapter
  test that drives the transfer path exclusively through the arbiter and asserts behavioural
  equivalence for every existing scenario (immediate, delayed, replayed, replaced, cleared, interim,
  unauthenticated).

### 7.4 Fail-closed collision handling in both opening orders

Order A (transfer open, then contact):

```
open(transfer P1) → { status: "opened" }
open(contact C1)  → { status: "conflict", current: {kind:"transfer", actionId:P1} }
                    → contact tool returns { status: "confirmation_required",
                      code: "conflict_active_window" }; no proposal is published,
                      no window opens, no mutation
```

Order B (contact open, then transfer): mirrored. The contact window is open; `open(transfer P1)`
returns a conflict, and the transfer tool returns its existing "confirmation-required" shape so the
current transfer UX is unchanged. In both orders, a single affirmative can authorize only the kind
whose window is open, because `consume` matches on `{kind, actionId, userId, version}` and
`recordEvidence` stamps the kind it was recorded for. There is no shared boolean anywhere.

The user's exit is explicit: `cancel`/`clear` for the open action, which is what "until the user
explicitly cancels or replaces the conflicting action" means in the spec. Replacing a transfer
preview already clears it (`setPendingTransfer` in
`src/conversations/session-state.ts:15-18`); replacing a contact proposal supersedes it (§8.3).

### 7.5 Model-supplied identifiers and turn counters

The arbiter's API takes no identifier from a tool call: `recordEvidence` is only reachable from the
transcript/listener seams. The recipient tools' schemas are `.strict()`, so a call carrying
`confirmationId`, `timestamp` or `turnCount` is rejected at schema validation with a typed error
rather than ignored. Precedent for `.strict()` in this repo: `selectedAddressLookupSchema` at
`src/memory/tools.ts:11`. The existing text-path turn counting
(`session-state.ts:79-84`, `confirmMemoryWrite`: `currentUserTurn <= pending.stagedUserTurn`) is
retained only as the text path's own ordering rule and is **never** evidence for a voice action; the
new `contact_action_proposals.confirmed_user_turn` records the ordinal for audit, and `consume`
rejects a call whose ordinal is not strictly after the proposal's creation.

---

## 8. Voice proposal card

### 8.1 Publication path

1. Worker persists `contact_action_proposals(status='open', published_at = NULL)` in `L5`.
2. Worker publishes a reliable LiveKit data message to the **bound authenticated participant**,
   using the same seam as the existing revision publication in `src/livekit/worker.ts`
   (`agentParticipant.publishData(bytes, { reliable: true, topic: "...", destination_identities:
   [participant.identity] })`):

   ```jsonc
   // topic: "contact_action_proposal"
   { "type": "contact_action_proposal",
     "proposalId": "…", "proposalVersion": 1, "conversationId": "…",
     "action": "create", "contactId": null, "contactVersion": null,
     "address": "<exact base58 public key>",
     "previousAddress": null,
     "revokedGrantIds": [],
     "summary": "Agregar a Sofía como destinataria de confianza",
     "revocationDisclosure": null,
     "expiresAt": "2026-…Z" }
   ```

   `destination_identities` is the verified participant identity: `verifyLiveVoiceBinding` resolved
   `binding.sub` and `RoomConversation.bind` rejects a participant whose identity differs
   (`src/livekit/room-conversation.ts:67-74`). A card never goes to the room at large.
3. The publication is awaited. Only if both the `publishData` promise resolves **and**

   ```sql
   UPDATE contact_action_proposals SET published_at = now()
    WHERE id = $1 AND version = $2 AND status = 'open'
   ```

   affects one row does the worker call `arbiter.open({kind:'contact', …})`. The speaker path is
   otherwise unchanged.

### 8.2 What gates what

- **Publication success gates the window.** If publication fails (participant gone, publish error, or
  the row update affects nothing because the proposal was superseded/consumed/expired), the window
  never opens, and the contact tool returns `{ status: 'proposal_not_published' }`. An affirmative
  received before publication cannot authorize anything: with no window, `recordEvidence` drops the
  transcript.
- **`published_at` is publication evidence, not proof of reading.** This is stated explicitly in the
  code comment and in the spec; the design does not claim more.
- **No bound visual client** ⇒ `ctx.room.remoteParticipants` does not contain the bound identity ⇒
  the worker refuses permission creation with a message asking for the review channel, while the
  contact may still be saved as not enabled (spec scenario "Absent bound visual client refuses
  permission creation").
- **Publication happens before the window, always**; there is no code path that opens a contact
  window without a successful publication, asserted by an integration test that makes `publishData`
  reject and then checks that no consumption is possible.

### 8.3 Verified pasted / scanned address source

The address is never a spoken value and never derived from a name:

- The recipient tools' schemas expose `proposalId`, `contactId`, `expectedVersion` only — **no
  `address` field** for contact actions. A tool call carrying an address or a name-derived address is
  rejected by the strict schema.
- The address enters a proposal by exactly two routes:
  1. the HTTP path (screen), where it is validated by `isValidSolanaAddress`
     (`src/memory/address.ts:10-18`) before it ever reaches the service, and
  2. the review channel: the card renders an address input; the user pastes, or on mobile scans with
     the Capacitor scanner; the value round-trips through
     `POST /v1/contact-actions/:proposalId/address` (§9), which re-validates the canonical base58
     form, appends `previous_address`, and creates a **new immutable version**
     (`version = version + 1`, `supersedes_id = old id`, old row → `status='superseded'`), then
     re-publishes the card.
- The window re-opens only for the new version, so a window opened for version *n* can never be
  consumed by an affirmative that arrived while version *n+1* was being prepared. This is how
  "immutable proposal version" and "verified pasted/scanned source" are reconciled with the need to
  correct an address.
- The user-visible summary and the spoken narration never contain the raw address (consistent with the
  existing instruction "never read a raw number / never invent an address"), and the "transfer address
  suppression" behaviour described in the outline is unchanged for transfers.

### 8.4 Reconnect / reload

`GET /v1/contact-actions/:proposalId` (§9) is the reconstruction path for the UI after a reload or
reconnect. The card is a rendering of the persisted row, so a reload cannot change what the user is
reviewing; an expired row renders as expired and cannot be consumed.

---

## 9. HTTP contract delta

`src/contracts/http.ts` and `apps/nana-wallet/src/lib/api-types.ts` change together in the same work
unit (hard repo rule, `AGENTS.md`).

### 9.1 Shared shapes

```ts
export const policyReadinessSchema = z.enum([
  "saved_not_configured", "pending", "syncing", "applied",
  "retryable_failure", "blocked_conflict", "blocked_configuration",
]);

export const contactPermissionSchema = z.object({
  state: policyReadinessSchema,
  desiredRevision: z.number().int().nonnegative(),
  appliedRevision: z.number().int().nonnegative(),
  retryable: z.boolean(),
  reason: z.string().optional(),
});
```

`contactSchema` gains `permission: contactPermissionSchema` (additive). `Contact` and
`CreateContactInput`/`UpdateContactInput` in `api-types.ts` gain the same field / the new optional
inputs below. No existing field changes name, type or optionality, and no existing response gains a
wrapper object — the current `{ ok: true, data: … }` envelope is preserved so `api.ts` and the MSW
handlers change additively.

`readContactPermission(walletId)`: reads `recipient_policy_state` and derives
`{ state, desiredRevision, appliedRevision, retryable, reason }`. `retryable` is true for
`pending`, `syncing`, `retryable_failure`. No secrets, signatures or key material: the field set is
closed and asserted by a test that fails if the serialized response contains any key named
`secret|key|signature|token|appSecret`.

### 9.2 Endpoints

All mutations accept an optional `Idempotency-Key` request header (uniform channel; no body field).
Bodies are `.strict()`.

| Method + path | Body / params | Success | Errors |
| --- | --- | --- | --- |
| `GET /v1/contacts` | — | `200 {ok:true,data:Contact[]}` with `permission` per contact | 401 |
| `POST /v1/contacts` | `{name, description, address, network?: "solana-devnet"}` + header `Idempotency-Key?` | `201 {ok:true,data:Contact}` (state honest: `applied` only after verified readback, otherwise `pending`/`syncing`/`retryable_failure`) | `422 DATOS_INVALIDOS` (validation, unknown key such as `policyId`/`signerId`/`cap`, non-Solana address), `409 CONFLICTO_POLITICA` (stale `expectedPolicyRevision` / blocked conflict), `503 PERMISO_CONFIGURACION_BLOQUEADA`, `409 COMPOSICION_VACIA_NO_SOPORTADA` |
| `PATCH /v1/contacts/:id` | `{name?, description?, address?, network?, expectedVersion, expectedPolicyRevision?}` + header | `200 {ok:true,data:Contact}` | `409 VERSION_OBSOLETA` (unchanged code, contact version), `409 REVISION_POLITICA_OBSOLETA`, `409 COBERTURA_DESCONOCIDA` (unknown remote rule), `422`, `404 CONTACTO_NO_ENCONTRADO` |
| `DELETE /v1/contacts/:id` | `?expectedVersion=N` + header | `200 {ok:true,data:{contact:Contact, revocation:{grantIds:string[], state: "pending"\|"applied"\|"retryable_failure"}}}` | `409 COMPOSICION_VACIA_NO_SOPORTADA`, `409 VERSION_OBSOLETA`, `404` |
| `POST /v1/contacts/:id/reveal-cbu` | — | unchanged | unchanged |
| `GET /v1/recipient-policy` | — | `200 {ok:true,data:{state,desiredRevision,appliedRevision,appliedPolicyId?}}` | `401` |
| `POST /v1/recipient-policy/retry` | — + header | `202 {ok:true,data:{state:"syncing",desiredRevision}}` | `409 COMPOSICION_VACIA_NO_SOPORTADA`, `503` |
| `GET /v1/contact-actions/:proposalId` | — | `200 {ok:true,data:{proposalId,proposalVersion,action,contactId?,contactVersion?,address,previousAddress?,revokedGrantIds,revocationDisclosure?,expiresAt,status}}` | `404` |
| `POST /v1/contact-actions/:proposalId/address` | `{address, expectedProposalVersion}` + header | `200 {ok:true,data:{proposalId,proposalVersion,address}}` (new version) | `409 PROPUESTA_OBSOLETA`, `422 DATOS_INVALIDOS`, `404` |

New error codes (`{ok:false,error:{code,message}}`, the existing envelope):
`CONFLICTO_POLITICA`, `REVISION_POLITICA_OBSOLETA`, `COBERTURA_DESCONOCIDA`,
`PERMISO_CONFIGURACION_BLOQUEADA`, `COMPOSICION_VACIA_NO_SOPORTADA`, `PROPUESTA_OBSOLETA`.
Existing codes `DATOS_INVALIDOS`, `VERSION_OBSOLETA`, `CONTACTO_NO_ENCONTRADO`, `ERROR_INTERNO` are
preserved verbatim so no current client breaks.

**Status honesty is contractual**: no endpoint may return `applied` unless
`verified_at IS NOT NULL AND applied_revision = desired_revision`; a removal never returns
`revocation.state: "applied"` before the readback confirms the revoked scope.

**Idempotency**: `Idempotency-Key` is stored as
`recipient_policy_sync_intent.idempotency_key` (unique per wallet). A replay returns the stored
result — the same `desired_revision` and the same computed `permission` snapshot — and performs no
second composition, no second PATCH, and no second audit row.

**Mirrored frontend surface**: `apps/nana-wallet/src/lib/api-types.ts` (the shapes above),
`apps/nana-wallet/src/lib/api.ts` (the eight methods, incl. an `ApiError` code passthrough for the new
codes), `apps/nana-wallet/src/mocks/handlers.ts` (fixtures for every readiness state, the empty-
composition conflict, the stale-revision conflict and the proposal card), and
`apps/nana-wallet/src/features/wallet/AddTrustedRecipient.tsx` plus the profile contact editing
surface: the network `<select>` is removed (Solana validation only, no chain picker), the
save/remove flows report the returned `permission.state`, and a removal whose response carries
`revocation.grantIds.length > 0` shows the disclosure before submitting (the screen path fetches the
affected grants from `GET /v1/contacts` + a pre-flight read, or renders the disclosure returned by a
`409`/dry-run response — implementation detail for the tasks phase, not a contract change).

---

## 10. Sequence diagrams

### (a) Add a trusted recipient through the screen

```mermaid
sequenceDiagram
  autonumber
  actor U as User (screen /perfil)
  participant FE as Nana frontend
  participant API as Backend /v1/contacts
  participant SVC as RecipientPolicyService
  participant DB as Postgres
  participant CMP as Policy composer
  participant P as Privy API

  U->>FE: name + pasted Solana address + Save
  FE->>API: POST /v1/contacts (Idempotency-Key, strict body)
  API->>SVC: create(userId, input, embedding)
  SVC->>SVC: validate canonical base58 (isValidSolanaAddress)
  SVC->>DB: W1 acquire_policy_lease(wallet)
  Note over SVC,DB: bounded wait; busy → 200 pending, never "enabled"
  SVC->>DB: tx{ W0(U) → L3 contacts INSERT → desired_revision+1 → intent(composed_rules) → audit } commit
  SVC->>CMP: composeAndApply(walletId, revision)
  CMP->>P: owner-verified signer readback (privyDid → listWalletsForChain)
  CMP->>P: getPolicy(attached[0])
  alt pristine readback already equals composed rules
    CMP->>CMP: no PATCH needed
  else needs apply
    CMP->>P: patchPolicy(policyId, composed.rules)
    CMP->>P: getPolicy(policyId)  (verification readback)
  end
  CMP->>CMP: compare (a)-(g) §5.1
  alt verified
    CMP->>DB: tx{ CAS applied_revision → signer_grants refresh → audit 'applied' } commit
    SVC->>DB: release lease
    SVC-->>API: permission = applied
  else mismatch / unknown rule
    CMP->>DB: tx{ status blocked_conflict → clear provider_policy_id → audits } commit
    SVC-->>API: permission = blocked_conflict (no PATCH retained)
  else unverified (timeout / unreachable)
    CMP->>DB: status syncing + next_attempt_at
    SVC-->>API: permission = syncing (honest, retryable)
  end
  API-->>FE: 201 { contact.permission.state }
  FE-->>U: shows saved / pending / applied — never "enabled" before verified
  Note over SVC,P: step 2 of the flow: no success state before the readback above
```

### (b) Remove a trusted recipient with an affected delegated grant

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant FE as Frontend / voice UI
  participant API as RecipientPolicyService
  participant DB as Postgres
  participant CMP as Policy composer
  participant P as Privy API

  U->>API: remove contact
  API->>DB: Phase A read (no locks): aliases, affected active grants, lastAlias
  API-->>FE: proposal: action=remove, address, revokedGrantIds=[g1,g2] (disclosure)
  FE-->>U: "Quitar a Sofía también revoca 2 permisos de pago automático"
  U->>API: confirm (screen: button; voice: arbiter window after the card)
  API->>DB: W1 acquire_policy_lease
  API->>DB: tx{ W0(U) → L1 dgc-grant-<g1>,<g2> asc → L2 grants FOR UPDATE asc → L3 recipients FOR UPDATE asc }
  API->>DB: re-derive aliases + affected set under lock (abort+retry on widening)
  API->>DB: tx{ archive contact (version CAS) ; revoke g1,g2 whole + 'revoked' audit each ; desired_revision+1 ; intent ; audits } commit
  Note over API,DB: provider I/O happens only after this commit
  API->>CMP: composeAndApply(walletId, revision)
  CMP->>P: owner-verified readback → patchPolicy(remaining rules) → readback verify
  alt verified remaining rules
    CMP->>DB: tx{ CAS applied_revision ; audit 'applied' } commit
    API-->>FE: revocation.state = applied
  else unverified
    CMP->>DB: status syncing / retryable_failure
    API-->>FE: revocation.state = pending — "la revocación remota todavía no está verificada"
  end
  FE-->>U: honest states; grants stay revoked in the ledger either way
```

### (c) Text / voice contact action with confirmation evidence

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant TL as Voice listener / text turns
  participant AR as Typed arbiter (per session)
  participant WK as Worker / backend tool
  participant DB as Postgres
  participant R as LiveKit room
  participant UI as Bound conversation UI

  U->>WK: "agregá a Sofía" (text) / spoken request (voice, no address)
  WK->>DB: resolve contact by name (ambiguous → ask first)
  alt voice and no verified address source
    WK-->>U: "necesito la dirección pegada o escaneada"
  end
  WK->>DB: L5 INSERT contact_action_proposals(open, v1, address)
  alt voice
    WK->>R: publishData topic=contact_action_proposal, destination=[bound identity]
    R->>UI: proposal card (exact address, action, version, revocation disclosure)
    WK->>DB: UPDATE published_at WHERE id/version AND status='open'
  end
  WK->>AR: open({kind:'contact', actionId:proposalId, userId, createdAt, version})
  alt another window already open (either order)
    AR-->>WK: conflict → tool returns confirmation_required; nothing authorized
  end
  U->>TL: "sí" (final, authenticated, after the proposal)
  TL->>AR: recordEvidence({kind:'contact', actionId, userId, sessionId, createdAt>…})
  WK->>AR: waitAndConsume({kind:'contact', actionId, version, tool})
  AR-->>WK: consumed (bounded 2s wait inherited; interim/foreign/expired refused)
  WK->>DB: tx{ L5 CAS consume proposal (status='open', version, not expired) → contact mutation → desired_revision+1 → intent → audit } commit
  Note over WK,DB: zero rows on the CAS ⇒ refused, nothing mutated, evidence never re-armed
  WK->>U: honest status (saved / pending / applied), never "habilitado" before readback
```

### (d) Reconciler retry after timeout / restart

```mermaid
sequenceDiagram
  autonumber
  participant R1 as Process A (crashed at T0)
  participant DB as Postgres
  participant R2 as Process B (after restart)
  participant P as Privy API

  R1->>DB: tx{ intent(revision 7, state='pending', composed_rules) ; desired_revision=7 } commit
  R1->>P: patchPolicy(...)  → timeout (unverified)
  R1->>DB: status='syncing', next_attempt_at=now()+backoff
  R1--xR1: process dies; lease row expires (TTL 60s)
  Note over DB: claim/coverage gate: applied_revision(6) != desired_revision(7) ⇒ all grants blocked
  R2->>DB: acquire_policy_lease → reclaimed (expires_at <= now())
  R2->>DB: SELECT intent WHERE state IN ('pending','applying') AND due
  R2->>P: getPolicy(policyId)   (GET-before-retry)
  alt rules already equal composed_rules
    R2->>DB: tx{ CAS applied_revision=7 (desired still 7) ; signer_grants refresh ; audit applied
                detail.confirmedBy='get_after_timeout' } commit
  else rules equal the previous applied rules
    R2->>P: patchPolicy(composed.rules) → getPolicy → verify
    R2->>DB: tx{ CAS applied_revision=7 ; audit } commit
  else third, unexplained rule set
    R2->>DB: tx{ status blocked_conflict ; clear provider_policy_id on active grants ;
                audit binding_invalidated } commit
  else GET fails
    R2->>DB: status='syncing', next_attempt_at=now()+backoff
  end
  R2->>DB: release lease
  Note over DB,P: applied_revision advances only after a signed readback verifies the rules
```

### (e) Conversational transfer through the typed arbiter (no regression path)

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant WK as Voice worker
  participant AR as Typed arbiter
  participant DB as Postgres
  participant G as Grant gate
  participant P as Privy

  U->>WK: "mandale 0,005 SOL a Sofía"
  WK->>DB: search_recipients → selection (recipientId, recipientVersion)
  WK->>G: classify coverage (grant gate consults the ledger)
  G->>DB: read recipient_policy_state (applied_revision == desired_revision?)
  alt verified revision
    G-->>WK: covered candidate (grantId, amountSmallestUnits)
  else unverified / mismatched
    G-->>WK: not covered → ordinary preview + explicit confirmation
  end
  WK->>DB: persist preview (previewId)
  WK->>AR: open({kind:'transfer', actionId: previewId, createdAt, version: 0})
  Note over AR: if a contact window is open → conflict, fail closed (both orders)
  U->>WK: "sí" (final, authenticated, after the preview)
  WK->>AR: waitAndConsume({kind:'transfer', actionId: previewId}, 2000ms)
  AR-->>WK: consumed
  WK->>DB: tx{ claimConsumption: W0(S) → L1 dgc-grant → L2 FOR UPDATE → checks
                (incl. policy_unverified) → claim + 'used' audit } commit
  WK->>P: broadcast under the signer policy (enclave enforces allowlist + cap)
  P-->>WK: result → finality → honest report
```

---

## 11. Unproven provider semantics: evidence, cheap early checks, stop conditions

The rule for all four: **never assume**. Each has (i) a cheap pre-mutation check that runs before any
write, (ii) exactly what evidence would resolve it, and (iii) a blocking stop that leaves the previous
policy attached.

### U1 — Coexistence of several ALLOW rules in one policy (newly introduced by §3)

This is new: today the code never leaves two rule families in one policy — `patchPolicy` at
`src/wallet/grants/solana-policy-provisioner.ts:275` sends grant-only rules and thereby *erases* the
enrollment rule. The composer requires that the enrollment rule and per-grant rules coexist and that
Privy's evaluation is a union (permit if any ALLOW rule matches), not an intersection and not a
rejection of extra rules.

**External documentary evidence (privacy-provider documentation, recorded 2026-10-10, still not a
substitute for the probe below).** The Privy policy documentation states the evaluation rule directly:
*"If any rule evaluates to an `ALLOW` action, and no rules evaluate to `DENY`, then the policy engine
will `ALLOW` the request"*, and separately *"`DENY` actions take precedence over `ALLOW` actions"* —
so multi-family `ALLOW` composition is a union, not an intersection, and not a rejection of extra
rules (`https://docs.privy.io/controls/policies/overview`, quoted passages captured in
`.agent-workflow/tasks/trusted-recipient-policy-sync/02-research.md`). This lowers U1 from "unproven
provider semantics" to "documented, unconfirmed on this deployment". The probe stays mandatory
because the documentation is versionless, does not describe multi-rule interaction on `solana`
`signAndSendTransaction` specifically, and no documented statement can be stronger than an observed
permit on the deployment actually in use. Until the probe records `union`, the composer's
fail-closed refusal remains the shipped behaviour.

- **Evidence that resolves it**: one devnet policy write with two ALLOW rules over disjoint
  `Transfer.to` allowlists, then a signed `signAndSendTransaction` to an address covered by only one
  rule, observed as permitted. Recorded as `recipient_policy_state.status_detail.rules_union`
  evidence with both rule sets and the observed outcome.
- **Cheap early check**: `probeRuleComposition()` in `src/wallet/policy/probe.ts` runs once per
  deployment during the capability probe (§6.4) and records its result; until it records `union`, the
  composer refuses multi-family composition.
- **Blocking stop**: `blocked_configuration`, reason `rule_composition_semantics_unproven`; **no
  PATCH is issued** and the previously attached policy stays exactly as it is. The recipient change may
  still be persisted as saved-not-enabled.
- *Partial prior evidence, explicitly not treated as proof*: the existing readback equality check
  (`:278-290`, revoke `:335-347`) fails closed unless the post-PATCH set equals exactly what was sent.
  That is consistent with replace semantics but does not distinguish replace from a merge that dedupes;
  the probe records the observed before/after sets.

### U2 — Signer attachment asserted by readback

- **Evidence that resolves it**: one owner-verified readback showing the canonical signer
  (`user_wallets.provider_signer_id`, resolved through `resolvePolicyTarget`,
  `src/wallet/grants/privy-policy-admin.ts:68-96`) present exactly once with
  `override_policy_ids` containing our policy id, obtained through
  `privyDid(userId)` + `listWalletsForChain(privyDid, 'solana')` — not through the unfiltered
  `server.getWallet` used today at `src/wallet/grants/privy-policy-runtime.ts:38`. Recorded as
  `status_detail.attachment_evidence` with the observed ids and timestamp.
- **Cheap early check**: `assertPolicyTargetCapability(userId, walletId)` runs before any PATCH; §5.1(e)
  and (f) are the same assertion in the post-apply path.
- **Blocking stop**: `blocked_configuration`, reason `signer_attachment_unproven`; no policy write, the
  previous policy stays attached.

### U3 — Ownership conflict

- **Evidence that resolves it**: (i) a readback where the owner-verified listing returns **no** record
  for `user_wallets.provider_wallet_id` while the unfiltered read returns one — the observable
  ownership-mismatch signature; and (ii) the provider's error code for a signed mutation against such
  a wallet. Recorded as `status_detail.ownership_evidence`.
- **Cheap early check**: the composer resolves the wallet only through the owner-verified listing and
  compares it to the stored `provider_wallet_id`; a mismatch stops before composing.
- **Blocking stop**: `blocked_configuration`, reason `ownership_drift`; the remote owner is neither
  adopted nor overwritten, and `user_wallets.provider_signer_id` is never rewritten (the store guard
  `AND provider_signer_id IS NULL` at `src/wallet/grants/privy-policy-admin.ts:186-208` already
  encodes "never guess").

### U4 — Empty composed policy / deny behaviour

- **External documentary evidence (recorded 2026-10-10, not a substitute for the probe)**: the Privy
  documentation states *"If no rules resolve, the policy will default to `DENY`"* and *"If the request
  does not satisfy *any* of the rules for the policy, the policy engine defaults to `DENY` the
  request"*, and that a method absent from `rules` is denied by default
  (`https://docs.privy.io/controls/policies/overview`). That is the deny behaviour U4 needs, and it
  changes the *expected* outcome from unknown to documented. It does **not** prove what this
  deployment returns for an empty `rules` array on `createPolicy`/`patchPolicy` — an empty array may
  be rejected as invalid input rather than treated as "no rules resolve", which is exactly the
  distinction `proven_deny` records. The probe stays mandatory.
- **Evidence that resolves it**: on devnet, (i) `createPolicy(name, [], {chainType:'solana'})` then
  `getPolicy` → observe whether an empty-rules policy is accepted and what it returns; (ii)
  `patchPolicy(id, [])` then `getPolicy` → observe; (iii) a signed transfer attempt against the
  empty-rules policy, observed as a provider refusal. (iii) requires a user-authorized wallet action
  and is therefore the only step that may be omitted, in which case `empty_composition` stays
  `unproven`.
- **Cheap early check**: `recipient_policy_state.empty_composition` is read by the composer and
  defaults to `unproven`. Nothing infers it from a successful zero-rule PATCH.
- **Blocking stop**: `blocked_configuration`, reason `empty_composition_unproven`; the last recipient
  is kept, the operation stops visibly with an explicit message
  (`409 COMPOSICION_VACIA_NO_SOPORTADA`), and the existing restrictive policy is left attached. The
  policy is never detached, deleted, or left with an absent recipient rule.

---

## 12. Implementation order and test strategy

### 12.1 Order across the five slices

| # | Slice | Depends on | Why it is here |
| --- | --- | --- | --- |
| 1 | Migration `015`, lease functions, `recipient_policy_sync` repository, `RecipientPolicyService`, composer + readback comparator, atomic removal with grant revocation, lock-order doc + refactor, strict contract types for the service seam | — | The database shape and the composer are the two things every later slice reads. §1's lock order must be correct before any second writer exists. |
| 2 | Apply + reconciler, capability wiring (§6), coverage/claim revision gate, binding invalidation fallback, probes U1–U4 | slice 1 (intent/state tables, composer, lease) | Status honesty is impossible before the reconciler exists; the capability wiring must land before any live verification. Its first act is fixing §0 C4 in the worker. |
| 3 | Screen/API vertical: `src/api/contacts.ts`, `src/contracts/http.ts`, mirrored frontend types/api/MSW, trusted-recipients UI, disclosure before removal | slices 1+2 (service + honest statuses) | The UI can only report what slices 1–2 record. |
| 4 | Text + voice: Solana validation replacement, recipient lifecycle tools, typed arbiter, proposal publication, card + paste/scan endpoint | slices 1+3 | The card reuses the mirrored contract and the review UI built in slice 3; the tools reuse the service from slice 1. |
| 5 | Deploy, verify, close | all | Rebuild/restart, built markers, signer capability probe, suite comparison against baseline, evidence, conventional commits, no push/PR. |

Deliberately *inside* slice 1, in this sub-order: `015` migration → lease functions → repository →
composer (pure, unit-tested to completion before any DB code) → service → removal semantics → delete
the legacy writer entry points → structural tests. The composer being finished and unit-proven before
the service is written is what keeps the transaction logic small.

### 12.2 Test strategy per layer

**Unit (Vitest, `tests/unit/`, no database)**
- Composer: determinism (same input ⇒ identical rules and hash across runs and locales); ordinary cap
  is exactly `10000000` and the ordinary rule is byte-identical to the enrollment builder's output;
  grant recipients never enter the ordinary allowlist; metadata-only edit produces a rule-identical
  composition and is therefore a *validation failure* when a rule would change; one rule per active
  grant with the ledger's own limits and stored expiry; empty composition throws unless
  `empty_composition='proven_deny'`.
- Hash: distinguished from `deterministicPolicyHash` (consent-envelope) by an explicit test that the
  two values differ for the same wallet state.
- Arbiter: typed keys; conflict in **both** opening orders; one-use; late evidence inside/outside the
  bound; interim transcript; unauthenticated speaker; model-supplied id/timestamp/turn count rejected
  by `.strict()` schemas; contact vs transfer never cross-authorize.
- Address: `isValidSolanaAddress` gates recipient draft, write and selected-address lookup; EVM-shaped
  and malformed values fail closed and persist nothing.
- Contract: `.strict()` bodies reject `policyId`, `signerId`, cap and unknown `network`; the
  serialized read payload contains no key matching `secret|key|signature|token`.
- Structural: no module outside `src/wallet/policy/**` and `src/wallet/signer/**` calls
  `createPolicy|patchPolicy|addPolicyToSigner`; the lock-order vector each module declares matches the
  canonical order; compose files declare no key var on `frontend`/`backend`/`voice-worker` and no
  `ports:` on a signer service.
- Regression: the existing `voice-decision-gate` suite must pass **unchanged**.

**DB integration (Vitest + `docker compose up -d db`, `tests/integration/`)**
- `015` applies cleanly and is idempotent on re-run; RLS blocks cross-user reads on all five tables.
- Lease: acquire/contend/renew/release; expiry reclaim by a second connection; a reclaimed holder's
  renew returns false; a release with a stale token is a no-op.
- Atomicity: an injected failure after the contact write rolls back contact, desired revision, grant
  revocation and audits together.
- Removal semantics: last alias revokes the affected whole grant + audit in one transaction; a second
  active alias prevents revocation; multi-recipient grant revoked whole, never narrowed; unrelated
  grants byte-for-byte unchanged; no grant migrated to a replacement address.
- Concurrency: claim ‖ removal and claim ‖ apply under two connections with a per-transaction
  statement timeout — no `40P01`, one serialized outcome, never `consumed: true` against a revoked
  scope.
- Revision: stale writer CAS returns zero rows and records `superseded`; `applied_revision` never
  decreases; a mismatch triggers binding invalidation atomically with the status change.
- Restart recovery: kill the applying writer mid-flight; after the lease TTL the second writer
  reclaims and resumes from `composed_rules`.
- Proposals: the conditional consume UPDATE is exactly-once under two concurrent consumers; the
  partial unique index rejects a second open proposal; an expired proposal cannot be consumed; a new
  version supersedes the old one.
- Idempotency: the same `Idempotency-Key` twice ⇒ one mutation, one intent, identical response.

**Adapter over a fake transport (`tests/unit` / `tests/simulation`, pattern:
`startFakePrivyApi` in `tests/unit/solana-user-wallet.test.ts`)**
- The real signed adapter issues a valid PATCH and its authorization signature **verifies** against the
  configured public key (never byte-equality).
- Readback equality passes; an extra unknown rule ⇒ `blocked_conflict`; owner drift and attachment
  drift ⇒ `blocked_configuration` with no PATCH issued.
- Timeout before PATCH, timeout after PATCH, 5xx, and a definitive 4xx ⇒ the §5.3 classification.
- Unreachable signer ⇒ `retryable_failure`, no binding change.
- Empty-policy probe responses are recorded as evidence, not inferred.

**Browser E2E**
- Create / edit / remove through the real API + database + adapter over a fake transport, then reload
  and observe the same `permission.state`.
- Retry from a `retryable_failure`; honest reporting of a failed revocation; duplicate alias; a
  contact on a wallet with no ready permission stays saved-not-enabled; no chain picker; the MSW
  fixtures cover every new state and error code.

**LiveKit session E2E**
- The real listener (`attachVoiceDecisionTranscripts`) driven end to end with a fake transport:
  authenticated final affirmative succeeds; foreign speaker, no speech, pre-proposal and expired
  affirmatives fail closed; a delayed final transcript inside the inherited 2 s bound completes the
  same call; replay is refused; contact/transfer collisions fail closed in both orders; an absent bound
  participant refuses permission creation; an unpublished card blocks the window; a spoken-only
  address is refused; a pasted address creates a new proposal version.

**Evals (`evals/`, `npm run eval`)**
- Both text and voice contexts expose the recipient lifecycle tools with correct argument discipline;
  ambiguous names trigger clarification before any mutation; no address is derived from a name;
  refusals are worded honestly; no spoken "habilitado" without a verified readback; the status wording
  set is the spec vocabulary. Evals are mandatory here per `AGENTS.md` rule 2.

### 12.3 Ordering/normalization for the later review

The review candidate must be **one frozen commit** with every source-mutating normalizer already run
and no source mutation afterwards. Concretely, before freezing:

```
npm run lint          # eslint src tests --max-warnings=0  ← the only source-mutating normalizer
npm run typecheck
npm run build
npm test              # with docker compose up -d db
npm run eval
(cd apps/nana-wallet && npm run lint && npm run typecheck && npm test)
```

`openspec/config.yaml` declares `formatter: false`, so there is no format step; `lint` is the one
mutator and it must run *before* the freeze and be convergent (a second run is a no-op). After the
freeze only check-only commands may run (`lint` as a verification-only re-run that changes nothing,
`typecheck`, tests, the browser/LiveKit E2E, the capability probe). Any byte, path or mode change after
the freeze invalidates the evidence and requires re-normalization plus a new review of the new bytes.
The receipt records the frozen commit SHA, an empty `git status --porcelain`, the exact commands and
their results, and the baseline comparison of pre-existing failures by test name (reported, never
hidden).

---

## 13. Rollback, feature switches and risks

Switches (env, read through the existing config modules, documented in `.env.example`):

- `RECIPIENT_POLICY_WRITER=enabled|frozen` (default `enabled`). `frozen` disables compose+apply: contact
  mutations still persist as saved-not-enabled intent, no PATCH is issued, the previously attached
  policy stays intact, and every surface reports the frozen state.
- `RECIPIENT_POLICY_RECONCILER=enabled|disabled` (default `enabled` in the live stack, `disabled` in
  fixture mode).

Both are non-destructive: they cannot delete a policy, clear a binding, rotate a key, or widen
authority. Data written by this change is additive; reverting the code leaves the tables in place and
unconsumed, and rows for unverified intent are left for review rather than mass-deleted. Grants revoked
by an approved last-alias removal stay revoked; re-granting always requires a fresh explicit approval.

| Risk | Likelihood | Mitigation | Residual |
| --- | --- | --- | --- |
| U1 (rule coexistence is not a union) proves false | Medium | The capability probe blocks before any PATCH; the composer refuses a multi-family composition while unproven | Blocked configuration until the probe resolves; no incorrect policy is ever installed |
| Provider semantics unresolved at apply time | Medium | Every probe result defaults to `unproven`; every stop is recorded with its evidence | Visible blocked state, never a fabricated outcome |
| Lock order regressed by a future writer | Low | Single documented order + a declarative lock-vector unit test + a concurrency integration test | Caught by CI, not in production |
| Lease starvation under sustained contention | Low | Bounded wait (3 s) with backoff, hard hold ceiling 300 s, honest `pending` result | A transient `pending` on a busy wallet; retry is user-visible and idempotent |
| `FOR SHARE` on the state row adds a hot row per wallet | Low | One row per wallet, held for the duration of a short transaction only; the apply transaction is the only `FOR UPDATE` taker | Sibling claims serialize only across an actual apply |
| Reviewer-normalization ordering | Low | §12.3 freeze discipline: normalization before candidate freeze, check-only after | Documented and evidenced |
