-- Mirror of src/db/migrations/017_recipient_alias_provenance.sql.
-- Trusted recipient by SNS alias (task 2.1): two additive schema facts.
-- The statements are deliberately additive and re-applicable.
--
-- WHY each of the two statements exists, and what would break without it:
--
--   (a) `recipient_policy_audit_event_ck` is a CLOSED vocabulary, deliberately:
--       the append-only evidence log can only record facts someone named. A moved
--       alias destination is a new fact, so it needs a new value,
--       `alias_destination_changed`, and the list is otherwise left byte-identical
--       in its original order. Reusing `drift_repaired` was rejected (design
--       §5.3): that event means "the reconciler converged the policy", which is
--       the opposite of "the destination moved and nothing here was changed".
--       Reusing it would make the audit assert the reverse of what happened.
--
--   (b) `recipient_policy_sync_intent.request_hash` binds an idempotency key to
--       the body that produced it (design §6.2). The lookup is
--       `(wallet_id, user_id, idempotency_key)` and the row's only other hash,
--       `composed_hash`, is the composed-POLICY hash, not a body hash, so a
--       replay carrying a different body silently returns the first result. That
--       is invisible on the paste path (the body IS the address) and
--       user-visible on the alias path (the same key with a different alias
--       returns the wrong contact).
--
--       NULLABLE and with NO DEFAULT, on purpose: NULL means "not comparable",
--       which is what makes the guard additive. A row written before this
--       migration — or an in-flight replay, or a path that supplies no key — is
--       treated as not comparable and falls back to today's behaviour, so this
--       column cannot break a replay that is already in flight.
--
-- Additive only: nothing is dropped (the CHECK is widened, never removed), no
-- column is narrowed, no row is rewritten, and no new table is created. Every
-- statement is re-appliable, so the chain CI and this worktree's local database
-- both apply can be re-run without an error and without a schema change.
--
-- NOTE ON SEQUENCING (design §15 D-C): D-C places this column with the
-- idempotency work unit, while task 2.1 places it here. The task list was
-- followed; the divergence is recorded in `apply-progress.md`. The column is
-- inert until task 3.1 writes and compares it.

-- ---------------------------------------------------------------------------
-- (a) Widen the closed audit vocabulary by exactly one value.
-- A CHECK cannot be altered in place, so it is dropped under its own name and
-- re-added with the extended list. The DROP is guarded, so a re-apply neither
-- fails nor duplicates the constraint; the re-added constraint is validated
-- (not NOT VALID), because every historical row satisfies a strict superset of
-- the vocabulary it was written under.
-- ---------------------------------------------------------------------------

ALTER TABLE public.recipient_policy_audit
  DROP CONSTRAINT IF EXISTS recipient_policy_audit_event_ck;

ALTER TABLE public.recipient_policy_audit
  ADD CONSTRAINT recipient_policy_audit_event_ck CHECK (event IN (
    'intent_recorded','revocation_disclosed','lease_acquired','lease_reclaimed',
    'apply_attempt','applied','readback_mismatch','apply_failed','superseded',
    'blocked_conflict','blocked_configuration','drift_repaired','binding_invalidated',
    'proposal_published','proposal_consumed','evidence_refused',
    'alias_destination_changed'));

-- ---------------------------------------------------------------------------
-- (b) Bind an idempotency key to the request body that produced it.
-- ---------------------------------------------------------------------------

ALTER TABLE public.recipient_policy_sync_intent
  ADD COLUMN IF NOT EXISTS request_hash TEXT;
