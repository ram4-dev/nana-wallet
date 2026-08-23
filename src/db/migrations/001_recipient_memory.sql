CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS recipients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT NOT NULL CHECK (length(trim(name)) > 0),
  normalized_name TEXT NOT NULL CHECK (length(trim(normalized_name)) > 0),
  description TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL CHECK (length(trim(address)) > 0),
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  embedding vector(384) NOT NULL,
  embedding_model_revision TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  address_confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS user_memories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  fact TEXT NOT NULL CHECK (length(trim(fact)) > 0),
  kind TEXT NOT NULL DEFAULT 'relationship',
  version BIGINT NOT NULL DEFAULT 1 CHECK (version > 0),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  embedding vector(384) NOT NULL,
  embedding_model_revision TEXT NOT NULL,
  provenance JSONB NOT NULL DEFAULT '{}'::jsonb,
  confirmed_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS recipients_user_status_name_idx
  ON recipients (user_id, status, normalized_name);
CREATE INDEX IF NOT EXISTS user_memories_user_status_idx
  ON user_memories (user_id, status);

ALTER TABLE recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE recipients FORCE ROW LEVEL SECURITY;
ALTER TABLE user_memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_memories FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS recipient_user_isolation ON recipients;
CREATE POLICY recipient_user_isolation ON recipients
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

DROP POLICY IF EXISTS user_memory_isolation ON user_memories;
CREATE POLICY user_memory_isolation ON user_memories
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT USAGE ON SCHEMA public TO recipient_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON recipients, user_memories TO recipient_app;
