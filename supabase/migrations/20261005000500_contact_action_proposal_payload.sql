-- Mirror of src/db/migrations/016_contact_action_proposal_payload.sql.
-- The statements are deliberately additive and re-applicable.

ALTER TABLE public.contact_action_proposals
  ALTER COLUMN address DROP NOT NULL;

ALTER TABLE public.contact_action_proposals
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_action_proposals_payload_object_ck') THEN
    ALTER TABLE public.contact_action_proposals
      ADD CONSTRAINT contact_action_proposals_payload_object_ck
      CHECK (jsonb_typeof(payload) = 'object') NOT VALID;
  END IF;
END $$;
