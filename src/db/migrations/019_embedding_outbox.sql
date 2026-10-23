-- Dormant reference-only queue; no triggers, claims, inference or source rewrites.
-- Logical polymorphic references survive source deletion for later fenced cleanup.
CREATE TABLE embedding_private.jobs (
  id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('recipient','fact')),
  owner_id uuid NOT NULL,
  source_id uuid NOT NULL,
  incarnation uuid NOT NULL,
  generation bigint NOT NULL CHECK (generation > 0),
  revision text NOT NULL CHECK (length(trim(revision)) > 0),
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','leased','done','failed','superseded')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  available_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  error_code text CHECK (error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_source_identity_key UNIQUE (kind,owner_id,source_id,incarnation,generation,revision),
  CONSTRAINT jobs_lease_check CHECK (
    (state = 'leased' AND claim_token IS NOT NULL AND lease_until IS NOT NULL)
    OR (state <> 'leased' AND claim_token IS NULL AND lease_until IS NULL))
);
CREATE INDEX jobs_due_idx ON embedding_private.jobs(available_at,id) WHERE state = 'pending';
CREATE INDEX jobs_expired_lease_idx ON embedding_private.jobs(lease_until,id) WHERE state = 'leased';

REVOKE ALL ON SCHEMA embedding_private FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA embedding_private FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA embedding_private FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA embedding_private FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA embedding_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA embedding_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA embedding_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA embedding_private FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;
