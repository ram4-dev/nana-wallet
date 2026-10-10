-- 015_recipient_policy_sync.sql
-- Trusted recipient policy sync (tasks 1.1, 1.2): the durable state the single
-- composer needs. Local mirror: src/db/migrations/015_recipient_policy_sync.sql.
--
-- WHY five new tables for one feature: each one removes a way the current code
-- is allowed to lie.
--   * recipient_policy_state        — one wallet-scoped row holding BOTH the
--     desired and the applied revision, so "enabled" can never be reported from
--     a successful call without a verified readback. `applied_rules_hash` is a
--     distinct field from the legacy consent-envelope `policy_hash`, which is
--     not a rule hash at all and feeds no authorization decision.
--   * recipient_policy_sync_intent  — the durable desired intent (outbox). A
--     restart resumes the EXACT composed rules instead of recomputing them from
--     mutable tables, which is what makes recovery honest.
--   * contact_action_proposals      — the immutable, versioned, one-use
--     proposal that screen/text/voice authorization consumes exactly once.
--   * recipient_policy_leases       — cross-process wallet serialization: one
--     holder per wallet no matter which process composes a revision.
--   * recipient_policy_audit        — append-only evidence, including the
--     blocked states that must be recorded instead of silently assumed.
--
-- Additive only: nothing is dropped, narrowed or rewritten, every statement is
-- re-appliable, and every foreign key is added NOT VALID behind an existence
-- guard exactly like 008/010. Rollback is disabling the feature switches and
-- dropping these five tables; no existing table changes shape.

-- ---------------------------------------------------------------------------
-- recipient_policy_state: one row per wallet; desired vs. applied revision.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.recipient_policy_state (
  wallet_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  desired_revision BIGINT NOT NULL DEFAULT 0
    CONSTRAINT recipient_policy_state_desired_revision_ck CHECK (desired_revision >= 0),
  applied_revision BIGINT NOT NULL DEFAULT 0
    CONSTRAINT recipient_policy_state_applied_revision_ck CHECK (applied_revision >= 0),
  -- NULL until a verified readback proves the rules; NULL is the fail-closed
  -- state, so the coverage gate can never read "verified" by default.
  desired_rules_hash TEXT,
  applied_rules_hash TEXT,
  applied_policy_id TEXT,
  applied_signer_id TEXT,
  -- Sibling signer ids observed at the last verified readback: without a
  -- recorded prior observation "unrelated signers preserved" is uncheckable.
  applied_signer_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Address union of the verified readback, kept so signer_grants can be
  -- refreshed consistently from one authoritative place.
  applied_recipients JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Written ONCE from the wallet's newest active signer_grants enrollment
  -- consent row and never re-derived: durable consent provenance rather than
  -- "whatever the remote policy currently says".
  consent_baseline JSONB NOT NULL DEFAULT '[]'::jsonb,
  consent_provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- Unproven by default: a fresh database blocks the last-recipient removal
  -- instead of guessing that an empty rule set is a supported deny.
  empty_composition TEXT NOT NULL DEFAULT 'unproven'
    CONSTRAINT recipient_policy_state_empty_composition_ck
      CHECK (empty_composition IN ('unproven','proven_deny','unsupported')),
  status TEXT NOT NULL DEFAULT 'saved_not_configured'
    CONSTRAINT recipient_policy_state_status_ck CHECK (status IN (
      'saved_not_configured','pending','syncing','applied',
      'retryable_failure','blocked_conflict','blocked_configuration')),
  status_reason TEXT,
  -- Bounded evidence only (policyId, observed hash, reason, code): never a
  -- secret, signature, token, key or transcript.
  status_detail JSONB NOT NULL DEFAULT '{}'::jsonb,
  attempt_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT recipient_policy_state_attempt_count_ck CHECK (attempt_count >= 0),
  next_attempt_at TIMESTAMPTZ,
  verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- "revision 7 overwrites revision 8" is impossible at the database level.
  CONSTRAINT recipient_policy_state_revision_order_ck
    CHECK (applied_revision <= desired_revision),
  -- An applied status must carry the whole evidence set. This is what makes a
  -- fabricated success unreachable rather than merely discouraged.
  CONSTRAINT recipient_policy_state_applied_complete_ck CHECK (
    status <> 'applied' OR (applied_revision = desired_revision
                            AND applied_rules_hash IS NOT NULL
                            AND applied_policy_id IS NOT NULL
                            AND applied_signer_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS recipient_policy_state_user_idx
  ON public.recipient_policy_state (user_id);
-- Partial: the reconciler only scans wallets that can still make progress.
CREATE INDEX IF NOT EXISTS recipient_policy_state_retry_idx
  ON public.recipient_policy_state (next_attempt_at)
  WHERE status IN ('pending','retryable_failure','syncing');

-- ---------------------------------------------------------------------------
-- recipient_policy_sync_intent: durable desired intent / outbox.
-- One intent per (wallet, desired revision); exactly one in flight per wallet.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.recipient_policy_sync_intent (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  user_id UUID NOT NULL,
  desired_revision BIGINT NOT NULL
    CONSTRAINT recipient_policy_sync_intent_desired_revision_ck CHECK (desired_revision > 0),
  origin TEXT NOT NULL
    CONSTRAINT recipient_policy_sync_intent_origin_ck CHECK (origin IN
      ('screen','text','voice','reconciler','enrollment','grant_create','grant_revoke',
       'grant_expiry','migration_backfill')),
  action TEXT
    CONSTRAINT recipient_policy_sync_intent_action_ck CHECK (action IN
      ('create','edit','rename','address_change','remove')),
  contact_id UUID,
  contact_version BIGINT,
  -- The exact intent the reconciler compares against the readback. Stored, not
  -- recomputed, so the comparison is an equality between two persisted
  -- artifacts instead of a recomputation that could drift.
  composed_rules JSONB NOT NULL,
  composed_hash TEXT NOT NULL,
  idempotency_key TEXT,
  state TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT recipient_policy_sync_intent_state_ck CHECK (state IN
      ('pending','applying','applied','superseded','failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT recipient_policy_sync_intent_attempt_count_ck CHECK (attempt_count >= 0),
  last_error TEXT,
  last_attempt_at TIMESTAMPTZ,
  next_attempt_at TIMESTAMPTZ,
  applied_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS recipient_policy_sync_intent_revision_idx
  ON public.recipient_policy_sync_intent (wallet_id, desired_revision);
-- Exactly one in-flight intent per wallet: a new mutation supersedes the old
-- one explicitly instead of racing it.
CREATE UNIQUE INDEX IF NOT EXISTS recipient_policy_sync_intent_inflight_idx
  ON public.recipient_policy_sync_intent (wallet_id) WHERE state IN ('pending','applying');
-- Replay of the same client key returns the same result rather than a second
-- mutation.
CREATE UNIQUE INDEX IF NOT EXISTS recipient_policy_sync_intent_idempotency_idx
  ON public.recipient_policy_sync_intent (wallet_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS recipient_policy_sync_intent_due_idx
  ON public.recipient_policy_sync_intent (next_attempt_at, desired_revision)
  WHERE state IN ('pending','applying');

-- ---------------------------------------------------------------------------
-- contact_action_proposals: immutable, versioned, one-use authorization.
-- Only the status/consumption columns and published_at are ever written; a
-- changed address is a NEW row with version = version + 1.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.contact_action_proposals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  wallet_id UUID,
  conversation_id UUID,
  kind TEXT NOT NULL DEFAULT 'contact'
    CONSTRAINT contact_action_proposals_kind_ck CHECK (kind IN ('contact','transfer')),
  action TEXT NOT NULL
    CONSTRAINT contact_action_proposals_action_ck CHECK (action IN
      ('create','edit','rename','address_change','remove')),
  contact_id UUID,
  contact_version BIGINT,
  address TEXT NOT NULL,
  previous_address TEXT,
  revoked_grant_ids UUID[] NOT NULL DEFAULT '{}',
  version INTEGER NOT NULL DEFAULT 1
    CONSTRAINT contact_action_proposals_version_ck CHECK (version > 0),
  supersedes_id UUID,
  proposal_hash TEXT NOT NULL,
  origin TEXT NOT NULL
    CONSTRAINT contact_action_proposals_origin_ck CHECK (origin IN ('screen','text','voice')),
  status TEXT NOT NULL DEFAULT 'open'
    CONSTRAINT contact_action_proposals_status_ck CHECK (status IN
      ('open','consumed','expired','cancelled','superseded')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  -- Publication evidence only: never proof that the user read the card.
  published_at TIMESTAMPTZ,
  confirmed_user_turn BIGINT,
  consumed_at TIMESTAMPTZ,
  consumed_by_tool TEXT,
  consumed_by_session TEXT
);

-- The cross-process "one authorization window at a time" rule: two processes
-- cannot hold two open contact proposals for the same conversation.
CREATE UNIQUE INDEX IF NOT EXISTS contact_action_proposals_one_open_idx
  ON public.contact_action_proposals (user_id, conversation_id) WHERE status = 'open';
-- An immutable version identity: (id, version) is the only consumable tuple.
CREATE UNIQUE INDEX IF NOT EXISTS contact_action_proposals_version_idx
  ON public.contact_action_proposals (user_id, id, version);
CREATE INDEX IF NOT EXISTS contact_action_proposals_open_idx
  ON public.contact_action_proposals (conversation_id) WHERE status = 'open';

-- ---------------------------------------------------------------------------
-- recipient_policy_leases: cross-process wallet serialization. One holder per
-- wallet; the holder is reclaimed only after expires_at. The acquire / renew /
-- release functions are appended by the next task in this slice.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.recipient_policy_leases (
  wallet_id UUID PRIMARY KEY,
  user_id UUID NOT NULL,
  lease_token TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  -- Recorded so a diagnostic can tell whether the intent was superseded while
  -- the holder waited for the lease.
  desired_revision_at_acquire BIGINT NOT NULL DEFAULT 0,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);

-- ---------------------------------------------------------------------------
-- recipient_policy_audit: append-only evidence.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.recipient_policy_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL,
  user_id UUID NOT NULL,
  desired_revision BIGINT,
  applied_revision BIGINT,
  event TEXT NOT NULL
    CONSTRAINT recipient_policy_audit_event_ck CHECK (event IN (
      'intent_recorded','revocation_disclosed','lease_acquired','lease_reclaimed',
      'apply_attempt','applied','readback_mismatch','apply_failed','superseded',
      'blocked_conflict','blocked_configuration','drift_repaired','binding_invalidated',
      'proposal_published','proposal_consumed','evidence_refused')),
  reason TEXT,
  detail JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipient_policy_audit_wallet_created_idx
  ON public.recipient_policy_audit (wallet_id, created_at);
CREATE INDEX IF NOT EXISTS recipient_policy_audit_user_event_idx
  ON public.recipient_policy_audit (user_id, event);

-- Append-only enforcement: audit rows are immutable. Postgres lacks a row-level
-- deny on UPDATE/DELETE for the table owner, so we enforce with a guard trigger
-- exactly like grant_audit_log.
CREATE OR REPLACE FUNCTION public.recipient_policy_audit_append_only_guard()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'recipient_policy_audit is append-only: % blocked', TG_OP;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS recipient_policy_audit_append_only ON public.recipient_policy_audit;
CREATE TRIGGER recipient_policy_audit_append_only
  BEFORE UPDATE OR DELETE ON public.recipient_policy_audit
  FOR EACH ROW EXECUTE FUNCTION public.recipient_policy_audit_append_only_guard();

-- ---------------------------------------------------------------------------
-- Row Level Security
-- Policy state, intent, audit and proposals are owner data
-- (app.user_id scoped). The intent additionally serves the reconciler scan,
-- which runs anonymously across wallets. The lease row is never user data:
-- policies allow it only when no app.user_id is set, so a user transaction
-- cannot serialize or steal another wallet's composition.
-- ---------------------------------------------------------------------------

ALTER TABLE public.recipient_policy_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_sync_intent ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_sync_intent FORCE ROW LEVEL SECURITY;
ALTER TABLE public.contact_action_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.contact_action_proposals FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_leases FORCE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipient_policy_audit FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recipient_policy_state_user_isolation ON public.recipient_policy_state;
CREATE POLICY recipient_policy_state_user_isolation ON public.recipient_policy_state
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS recipient_policy_sync_intent_user_isolation ON public.recipient_policy_sync_intent;
CREATE POLICY recipient_policy_sync_intent_user_isolation ON public.recipient_policy_sync_intent
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
-- Reconciler access: the owner path writes intents; the anonymous system
-- context enumerates due intents and claims them for every wallet.
DROP POLICY IF EXISTS recipient_policy_sync_intent_system_access ON public.recipient_policy_sync_intent;
CREATE POLICY recipient_policy_sync_intent_system_access ON public.recipient_policy_sync_intent
  FOR ALL
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');

DROP POLICY IF EXISTS contact_action_proposals_user_isolation ON public.contact_action_proposals;
CREATE POLICY contact_action_proposals_user_isolation ON public.contact_action_proposals
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS recipient_policy_audit_user_isolation ON public.recipient_policy_audit;
CREATE POLICY recipient_policy_audit_user_isolation ON public.recipient_policy_audit
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS recipient_policy_leases_system_only ON public.recipient_policy_leases;
CREATE POLICY recipient_policy_leases_system_only ON public.recipient_policy_leases
  FOR ALL
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '')
  WITH CHECK (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');

-- ---------------------------------------------------------------------------
-- Privileges: REVOKE then GRANT, so nothing is reachable through PUBLIC.
-- The audit log is insert/select only (the trigger makes UPDATE/DELETE raise
-- anyway, and withholding the privilege keeps the intent explicit).
-- ---------------------------------------------------------------------------

REVOKE ALL ON public.recipient_policy_state FROM PUBLIC;
REVOKE ALL ON public.recipient_policy_sync_intent FROM PUBLIC;
REVOKE ALL ON public.contact_action_proposals FROM PUBLIC;
REVOKE ALL ON public.recipient_policy_leases FROM PUBLIC;
REVOKE ALL ON public.recipient_policy_audit FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON public.recipient_policy_state TO recipient_app;
GRANT SELECT, INSERT, UPDATE ON public.recipient_policy_sync_intent TO recipient_app;
GRANT SELECT, INSERT, UPDATE ON public.contact_action_proposals TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipient_policy_leases TO recipient_app;
GRANT SELECT, INSERT ON public.recipient_policy_audit TO recipient_app;

-- ---------------------------------------------------------------------------
-- NOT VALID foreign keys behind existence guards: new writes must reference a
-- provisioned user / wallet / contact, and no historical row is scanned or
-- rewritten. Same pattern as 008/010.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_state_user_id_users_fk') THEN
    ALTER TABLE public.recipient_policy_state ADD CONSTRAINT recipient_policy_state_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_state_wallet_id_wallets_fk') THEN
    ALTER TABLE public.recipient_policy_state ADD CONSTRAINT recipient_policy_state_wallet_id_wallets_fk
      FOREIGN KEY (wallet_id) REFERENCES public.user_wallets(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_sync_intent_user_id_users_fk') THEN
    ALTER TABLE public.recipient_policy_sync_intent ADD CONSTRAINT recipient_policy_sync_intent_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_sync_intent_wallet_id_wallets_fk') THEN
    ALTER TABLE public.recipient_policy_sync_intent ADD CONSTRAINT recipient_policy_sync_intent_wallet_id_wallets_fk
      FOREIGN KEY (wallet_id) REFERENCES public.user_wallets(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_sync_intent_contact_id_recipients_fk') THEN
    ALTER TABLE public.recipient_policy_sync_intent ADD CONSTRAINT recipient_policy_sync_intent_contact_id_recipients_fk
      FOREIGN KEY (contact_id) REFERENCES public.recipients(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_audit_user_id_users_fk') THEN
    ALTER TABLE public.recipient_policy_audit ADD CONSTRAINT recipient_policy_audit_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_audit_wallet_id_wallets_fk') THEN
    ALTER TABLE public.recipient_policy_audit ADD CONSTRAINT recipient_policy_audit_wallet_id_wallets_fk
      FOREIGN KEY (wallet_id) REFERENCES public.user_wallets(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_action_proposals_user_id_users_fk') THEN
    ALTER TABLE public.contact_action_proposals ADD CONSTRAINT contact_action_proposals_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_action_proposals_wallet_id_wallets_fk') THEN
    ALTER TABLE public.contact_action_proposals ADD CONSTRAINT contact_action_proposals_wallet_id_wallets_fk
      FOREIGN KEY (wallet_id) REFERENCES public.user_wallets(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_action_proposals_contact_id_recipients_fk') THEN
    ALTER TABLE public.contact_action_proposals ADD CONSTRAINT contact_action_proposals_contact_id_recipients_fk
      FOREIGN KEY (contact_id) REFERENCES public.recipients(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_action_proposals_supersedes_id_proposals_fk') THEN
    ALTER TABLE public.contact_action_proposals ADD CONSTRAINT contact_action_proposals_supersedes_id_proposals_fk
      FOREIGN KEY (supersedes_id) REFERENCES public.contact_action_proposals(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_leases_user_id_users_fk') THEN
    ALTER TABLE public.recipient_policy_leases ADD CONSTRAINT recipient_policy_leases_user_id_users_fk
      FOREIGN KEY (user_id) REFERENCES public.users(id) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'recipient_policy_leases_wallet_id_wallets_fk') THEN
    ALTER TABLE public.recipient_policy_leases ADD CONSTRAINT recipient_policy_leases_wallet_id_wallets_fk
      FOREIGN KEY (wallet_id) REFERENCES public.user_wallets(id) NOT VALID;
  END IF;
END
$$;

-- ---------------------------------------------------------------------------
-- Task 1.2 — recipient policy lease functions (design §1.4, §2.4).
--
-- The lease is the `W1` slot of the canonical lock order: a short-lived row
-- that serializes compose+apply for one wallet ACROSS PROCESSES, held outside
-- any transaction and never across remote I/O. Only the row can do that job —
-- §1.2 forbids holding a database lock while a provider call is in flight.
--
-- Shape mirrors `acquire_reconciliation_lease`
-- (src/db/migrations/013_wallet_notifications.sql:106): same
-- delete-expired-then-upsert-on-conflict, same table-qualified column
-- references inside the `RETURNS TABLE (lease_token)` OUT-variable trap, and no
-- `SECURITY DEFINER` (recipient_app holds the privileges on the table).
--
-- Reclaim happens ONLY through `expires_at`: a crashed holder cannot corrupt
-- anything, because the lease serializes work whose result is revision-verified
-- (§1.5) and fully recomposed from persisted intent (§5.2). Worst case after a
-- crash is one recomposition, never a partial rule set.
--
-- Declared here rather than beside the table above so that every task in this
-- slice keeps a purely additive diff.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.acquire_recipient_policy_lease(
  p_wallet_id UUID,
  p_user_id UUID,
  p_owner_id TEXT,
  p_lease_seconds INTEGER DEFAULT 60
) RETURNS TABLE (lease_token TEXT)
LANGUAGE plpgsql
AS $$
DECLARE
  v_token TEXT;
  v_desired_revision BIGINT;
BEGIN
  -- Diagnostic, not authorization: it lets a later inspection tell whether the
  -- holder's intent was superseded while it waited. 0 when the wallet has no
  -- state row yet, which is why the column defaults to 0 as well.
  SELECT rps.desired_revision INTO v_desired_revision
  FROM public.recipient_policy_state AS rps
  WHERE rps.wallet_id = p_wallet_id;

  IF v_desired_revision IS NULL THEN
    v_desired_revision := 0;
  END IF;

  -- Expired lease rows are reclaimable by any holder.
  DELETE FROM public.recipient_policy_leases
  WHERE wallet_id = p_wallet_id
    AND expires_at <= now();

  -- Insert a fresh lease, or reclaim only an expired row on conflict. When
  -- another holder has a live lease, the WHERE skips the update and no row is
  -- produced: the caller receives NULL (excluded). Column references are
  -- table-qualified to avoid clashing with the RETURNS TABLE(lease_token) OUT
  -- variable inside plpgsql.
  WITH upserted AS (
    INSERT INTO public.recipient_policy_leases AS existing
      (wallet_id, user_id, lease_token, owner_id,
       desired_revision_at_acquire, acquired_at, expires_at)
    VALUES (
      p_wallet_id, p_user_id,
      md5(random()::text || clock_timestamp()::text || p_owner_id),
      p_owner_id, v_desired_revision, now(),
      now() + make_interval(secs => p_lease_seconds)
    )
    ON CONFLICT (wallet_id) DO UPDATE
      SET lease_token = EXCLUDED.lease_token,
          user_id = EXCLUDED.user_id,
          owner_id = EXCLUDED.owner_id,
          desired_revision_at_acquire = EXCLUDED.desired_revision_at_acquire,
          acquired_at = EXCLUDED.acquired_at,
          expires_at = EXCLUDED.expires_at
      WHERE existing.expires_at <= now()
    RETURNING existing.lease_token AS granted_token
  )
  SELECT granted_token INTO v_token FROM upserted;

  RETURN QUERY SELECT v_token;
END;
$$;

-- Token-guarded renewal. `false` means the caller no longer holds the lease:
-- either it was reclaimed after expiry, or the holder has passed the hard hold
-- ceiling and must release and re-acquire instead of renewing forever. The
-- ceiling is enforced here, by the same authority that owns the row, so no
-- caller can opt out of it.
CREATE OR REPLACE FUNCTION public.renew_recipient_policy_lease(
  p_wallet_id UUID,
  p_lease_token TEXT,
  p_lease_seconds INTEGER DEFAULT 60,
  p_max_hold_seconds INTEGER DEFAULT 300
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_updated INTEGER;
BEGIN
  UPDATE public.recipient_policy_leases
     SET expires_at = now() + make_interval(secs => p_lease_seconds)
   WHERE wallet_id = p_wallet_id
     AND lease_token = p_lease_token
     AND acquired_at > now() - make_interval(secs => p_max_hold_seconds);

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  RETURN v_updated > 0;
END;
$$;

-- Token-guarded release. A stale holder's release matches no row, so it can
-- never evict the holder that reclaimed the lease.
CREATE OR REPLACE FUNCTION public.release_recipient_policy_lease(
  p_wallet_id UUID,
  p_lease_token TEXT
) RETURNS BOOLEAN
LANGUAGE plpgsql
AS $$
DECLARE
  v_deleted INTEGER;
BEGIN
  DELETE FROM public.recipient_policy_leases
   WHERE wallet_id = p_wallet_id
     AND lease_token = p_lease_token;

  GET DIAGNOSTICS v_deleted = ROW_COUNT;
  RETURN v_deleted > 0;
END;
$$;

-- The acquire function records `desired_revision_at_acquire` by reading
-- recipient_policy_state, and acquire runs in the anonymous system context
-- (§1.4). Every other policy on that table is owner-scoped, so without this one
-- the read returns zero rows, the function falls back to its 0 default, and the
-- diagnostic reports "the intent never moved" forever. A column that lies is
-- worse than no column, so the read is granted explicitly.
--
-- SELECT only: the system context (the reconciler and the lease holders) gains
-- no write authority over policy state, and user transactions keep their
-- existing owner isolation unchanged.
DROP POLICY IF EXISTS recipient_policy_state_system_read ON public.recipient_policy_state;
CREATE POLICY recipient_policy_state_system_read ON public.recipient_policy_state
  FOR SELECT
  USING (current_setting('app.user_id', true) IS NULL
         OR current_setting('app.user_id', true) = '');
