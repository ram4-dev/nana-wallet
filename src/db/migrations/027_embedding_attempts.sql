-- Once-only provider permission; rollout remains inactive and charges never refund.
DO $owner$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding start owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
END $owner$;
CREATE FUNCTION public.embedding_start_attempt(job_id uuid,claim_token uuid,reservation_id uuid)
RETURNS TABLE(status text,attempt integer,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE j embedding_private.jobs%ROWTYPE; c embedding_private.control%ROWTYPE;
  r embedding_private.reservations%ROWTYPE; s record; started timestamptz; source_kind text;
BEGIN
  status := 'stale';
  -- Discover only; blocking locks always follow source, job, control, reservation.
  SELECT t.* INTO j FROM embedding_private.jobs t WHERE t.id=$1;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  source_kind := j.kind;
  IF j.kind='recipient' THEN SELECT t.* INTO s FROM public.recipients t WHERE t.id=j.source_id FOR UPDATE;
  ELSE SELECT t.* INTO s FROM public.user_memories t WHERE t.id=j.source_id FOR UPDATE; END IF;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  SELECT t.* INTO j FROM embedding_private.jobs t WHERE t.id=$1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  SELECT t.* INTO STRICT c FROM embedding_private.control t WHERE t.singleton FOR SHARE;
  SELECT t.* INTO r FROM embedding_private.reservations t WHERE t.id=$3 FOR UPDATE;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  started := clock_timestamp();
  IF j.kind IS DISTINCT FROM source_kind OR (s.id,s.user_id,s.embedding_incarnation,s.embedding_generation,s.desired_embedding_revision,s.status,s.embedding_state)
      IS DISTINCT FROM (j.source_id,j.owner_id,j.incarnation,j.generation,j.revision,'active'::text,'pending'::text)
    OR (j.claim_token,j.state) IS DISTINCT FROM ($2,'leased'::text) OR $2 IS NULL OR j.lease_until<=started
    OR (c.activated,c.claims_enabled,c.pause_code,c.run_token,c.target_revision)
      IS DISTINCT FROM (true,true,NULL::text,j.run_token,j.revision) OR j.run_token IS NULL OR c.run_until IS NULL OR c.run_until<=started
    OR (r.scope,r.job_id,r.claim_token,r.run_token,r.owner_id,r.kind,r.source_id,r.incarnation,r.generation,r.revision)
      IS DISTINCT FROM ('drain'::text,j.id,j.claim_token,j.run_token,j.owner_id,j.kind,j.source_id,j.incarnation,j.generation,j.revision)
    OR r.expires_at<=started OR r.state NOT IN ('reserved','started') THEN RETURN NEXT; RETURN; END IF;
  IF r.state='started' THEN status := 'already_started'; attempt := j.attempts; expires_at := r.expires_at; RETURN NEXT; RETURN; END IF;
  IF j.attempts>=5 THEN RETURN NEXT; RETURN; END IF;
  expires_at := least(started+interval '15 seconds',j.lease_until,c.run_until);
  UPDATE embedding_private.reservations SET state='started',started_at=started,expires_at=embedding_start_attempt.expires_at WHERE id=r.id;
  UPDATE embedding_private.jobs SET attempts=attempts+1,updated_at=started WHERE id=j.id RETURNING attempts INTO attempt;
  status := 'started'; RETURN NEXT;
END $body$;
CREATE FUNCTION public.embedding_start_query(reservation_id uuid,byte_count integer)
RETURNS TABLE(status text,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE c embedding_private.control%ROWTYPE; r embedding_private.reservations%ROWTYPE; started timestamptz;
BEGIN
  status := 'stale';
  SELECT t.* INTO STRICT c FROM embedding_private.control t WHERE t.singleton FOR SHARE;
  SELECT t.* INTO r FROM embedding_private.reservations t WHERE t.id=$1 FOR UPDATE;
  IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  started := clock_timestamp();
  IF NOT c.activated OR NOT c.claims_enabled OR c.pause_code IS NOT NULL
    OR (r.scope,r.byte_count) IS DISTINCT FROM ('query'::text,$2) OR r.expires_at<=started
    OR r.state NOT IN ('reserved','started') THEN RETURN NEXT; RETURN; END IF;
  expires_at := r.expires_at;
  IF r.state='started' THEN status := 'already_started'; RETURN NEXT; RETURN; END IF;
  UPDATE embedding_private.reservations SET state='started',started_at=started WHERE id=r.id;
  status := 'started'; RETURN NEXT;
END $body$;
DO $grants$
DECLARE role_name text;
BEGIN
  REVOKE ALL ON FUNCTION public.embedding_start_attempt(uuid,uuid,uuid),public.embedding_start_query(uuid,integer) FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.embedding_start_attempt(uuid,uuid,uuid),public.embedding_start_query(uuid,integer) FROM %I',role_name);
      IF role_name IN ('embedding_worker','service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.embedding_start_attempt(uuid,uuid,uuid),public.embedding_start_query(uuid,integer) TO %I',role_name);
      END IF;
    END IF;
  END LOOP;
END $grants$;
