CREATE TABLE public.conversation_live_leases (
  conversation_id UUID PRIMARY KEY REFERENCES public.conversations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  binding_jti UUID NOT NULL UNIQUE,
  participant_identity TEXT NOT NULL,
  worker_id TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  renewed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE public.conversation_live_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_live_leases FORCE ROW LEVEL SECURITY;
CREATE POLICY conversation_live_lease_user_isolation ON public.conversation_live_leases
  USING (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON public.conversation_live_leases TO recipient_app;
