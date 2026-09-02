DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recipient_app') THEN
    CREATE ROLE recipient_app NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
  END IF;
END
$$;

GRANT recipient_app TO postgres;

CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA extensions;
CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA extensions;

CREATE TABLE IF NOT EXISTS public.recipients (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL CHECK (length(trim(address)) > 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  embedding extensions.vector(384) NOT NULL,
  embedding_model_revision TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  address_confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.user_memories (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL,
  fact TEXT NOT NULL CHECK (length(trim(fact)) > 0),
  kind TEXT NOT NULL DEFAULT 'relationship',
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  embedding extensions.vector(384) NOT NULL,
  embedding_model_revision TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipients_user_status_name_idx ON public.recipients (user_id, status, normalized_name);
CREATE INDEX IF NOT EXISTS user_memories_user_status_idx ON public.user_memories (user_id, status);

ALTER TABLE public.recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE public.user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_memories FORCE ROW LEVEL SECURITY;

CREATE POLICY recipient_user_isolation ON public.recipients
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY user_memory_isolation ON public.user_memories
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public, extensions TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.recipients, public.user_memories TO recipient_app;
