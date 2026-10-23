-- Dormant expansion only: preserve legacy vectors, revisions, grants and NOT NULL.
-- PG16/17's built-in UUID function works with either pgcrypto extension schema.
-- Resolve pgvector's installed schema without changing the caller's search_path.
DO $foundation$
DECLARE vector_schema text;
BEGIN
  SELECT n.nspname INTO STRICT vector_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector';
  EXECUTE format($ddl$
ALTER TABLE public.recipients
  ADD COLUMN embedding_generation bigint NOT NULL DEFAULT 0 CHECK (embedding_generation >= 0),
  ADD COLUMN embedding_incarnation uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  ADD COLUMN desired_embedding_revision text,
  ADD COLUMN embedding_state text NOT NULL DEFAULT 'pending' CHECK (embedding_state IN ('pending','ready','failed','inactive')),
  ADD CONSTRAINT recipients_embedding_ready_check CHECK (embedding_state <> 'ready' OR (
    embedding IS NOT NULL AND embedding_model_revision IS NOT NULL AND desired_embedding_revision IS NOT NULL
    AND embedding_model_revision = desired_embedding_revision AND %1$I.vector_dims(embedding) = 384 AND %1$I.vector_norm(embedding) > 0));

ALTER TABLE public.user_memories
  ADD COLUMN embedding_generation bigint NOT NULL DEFAULT 0 CHECK (embedding_generation >= 0),
  ADD COLUMN embedding_incarnation uuid NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
  ADD COLUMN desired_embedding_revision text,
  ADD COLUMN embedding_state text NOT NULL DEFAULT 'pending' CHECK (embedding_state IN ('pending','ready','failed','inactive')),
  ADD CONSTRAINT user_memories_embedding_ready_check CHECK (embedding_state <> 'ready' OR (
    embedding IS NOT NULL AND embedding_model_revision IS NOT NULL AND desired_embedding_revision IS NOT NULL
    AND embedding_model_revision = desired_embedding_revision AND %1$I.vector_dims(embedding) = 384 AND %1$I.vector_norm(embedding) > 0));
  $ddl$, vector_schema);
END
$foundation$;

CREATE SCHEMA embedding_private;
REVOKE ALL ON SCHEMA embedding_private FROM PUBLIC;
CREATE TABLE embedding_private.control (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  activated boolean NOT NULL DEFAULT false,
  claims_enabled boolean NOT NULL DEFAULT false,
  semantic_enabled boolean NOT NULL DEFAULT false,
  target_revision text NOT NULL DEFAULT 'openai:text-embedding-3-small:384:nana-text-v1:l2:epoch1'
    CHECK (target_revision = 'openai:text-embedding-3-small:384:nana-text-v1:l2:epoch1'),
  run_token uuid,
  run_until timestamptz,
  pause_code text,
  minute_started_at timestamptz NOT NULL DEFAULT now(),
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  canonical_bytes integer NOT NULL DEFAULT 0 CHECK (canonical_bytes >= 0),
  query_request_count integer NOT NULL DEFAULT 0 CHECK (query_request_count >= 0),
  query_canonical_bytes integer NOT NULL DEFAULT 0 CHECK (query_canonical_bytes >= 0)
);
INSERT INTO embedding_private.control(singleton) VALUES (true);
REVOKE ALL ON ALL TABLES IN SCHEMA embedding_private FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA embedding_private FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA embedding_private FROM %I', role_name);
    END IF;
  END LOOP;
END
$$;
