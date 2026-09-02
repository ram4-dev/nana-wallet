CREATE TABLE public.conversations (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  user_id UUID NOT NULL,
  mode TEXT NOT NULL DEFAULT 'typed' CHECK (mode IN ('typed', 'live')),
  summary JSONB,
  summary_through_sequence BIGINT NOT NULL DEFAULT 0 CHECK (summary_through_sequence >= 0),
  next_message_sequence BIGINT NOT NULL DEFAULT 1 CHECK (next_message_sequence > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.conversation_state (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  revision BIGINT NOT NULL DEFAULT 0 CHECK (revision >= 0),
  language TEXT NOT NULL DEFAULT 'es' CHECK (language IN ('es', 'en')),
  generation BIGINT NOT NULL DEFAULT 1 CHECK (generation > 0),
  recipient_memory JSONB NOT NULL DEFAULT '{}'::jsonb,
  pending_interpretation JSONB,
  progress JSONB NOT NULL DEFAULT '{}'::jsonb,
  last_transaction_hash TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE public.conversation_messages (
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  sequence BIGINT NOT NULL CHECK (sequence > 0),
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
  payload JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (conversation_id, sequence)
);

CREATE TABLE public.conversation_transfer_attempts (
  id UUID PRIMARY KEY DEFAULT extensions.gen_random_uuid(),
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  state_revision BIGINT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('previewed', 'broadcasting', 'submitted', 'uncertain', 'confirmed', 'reverted', 'receipt_invalid', 'cancelled')),
  pending_transfer JSONB NOT NULL,
  recipient_id UUID,
  recipient_version BIGINT,
  claim_id UUID,
  claimed_by TEXT,
  claimed_at TIMESTAMPTZ,
  transaction_hash TEXT,
  wallet_result JSONB,
  receipt_result JSONB,
  failure JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX conversation_one_active_transfer_idx
  ON public.conversation_transfer_attempts (conversation_id)
  WHERE status IN ('previewed', 'broadcasting', 'submitted', 'uncertain');
CREATE INDEX conversation_messages_read_idx ON public.conversation_messages (conversation_id, sequence);
CREATE INDEX conversation_state_user_idx ON public.conversation_state (user_id, conversation_id);
CREATE INDEX conversation_transfer_attempts_active_idx ON public.conversation_transfer_attempts (conversation_id, status);

CREATE TABLE public.conversation_memory_confirmations (
  confirmation_id UUID PRIMARY KEY,
  conversation_id UUID NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  draft JSONB NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('staged', 'confirmed', 'consumed', 'expired')),
  expires_at TIMESTAMPTZ NOT NULL,
  staged_user_sequence BIGINT NOT NULL,
  confirmed_user_sequence BIGINT,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_state FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_messages FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_transfer_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_transfer_attempts FORCE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_memory_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_memory_confirmations FORCE ROW LEVEL SECURITY;

CREATE POLICY conversation_user_isolation ON public.conversations
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY conversation_state_user_isolation ON public.conversation_state
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY conversation_message_user_isolation ON public.conversation_messages
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY conversation_transfer_user_isolation ON public.conversation_transfer_attempts
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
CREATE POLICY conversation_memory_confirmation_user_isolation ON public.conversation_memory_confirmations
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversations, public.conversation_state, public.conversation_messages, public.conversation_transfer_attempts, public.conversation_memory_confirmations TO recipient_app;
