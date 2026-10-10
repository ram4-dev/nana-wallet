-- 016_contact_action_proposal_payload.sql
-- Immutable, server-owned presentation data for trusted-recipient proposals.
-- A voice/text model may propose a label, but it never supplies an address:
-- address remains NULL until the authenticated review channel pastes/scans it.

ALTER TABLE contact_action_proposals
  ALTER COLUMN address DROP NOT NULL;

ALTER TABLE contact_action_proposals
  ADD COLUMN IF NOT EXISTS payload JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'contact_action_proposals_payload_object_ck') THEN
    ALTER TABLE contact_action_proposals
      ADD CONSTRAINT contact_action_proposals_payload_object_ck
      CHECK (jsonb_typeof(payload) = 'object') NOT VALID;
  END IF;
END $$;
