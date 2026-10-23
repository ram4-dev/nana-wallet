-- Fenced publication only; claims stay disabled and provider admission is separate.
DO $completion$
DECLARE vector_schema text; role_name text; signature text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding RPC owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
  SELECT n.nspname INTO STRICT vector_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector';
  EXECUTE format($ddl$
CREATE FUNCTION public.embedding_complete(job_id uuid,owner uuid,kind text,source_id uuid,incarnation uuid,
  generation bigint,revision text,claim_token uuid,vector %1$I.vector) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE source_row record; job embedding_private.jobs%%ROWTYPE; run_row embedding_private.control%%ROWTYPE;
BEGIN
  IF $9 IS NULL OR %1$I.vector_dims($9)<>384 OR NOT (abs(%1$I.vector_norm($9)-1)<=0.00001) THEN
    RAISE EXCEPTION 'invalid embedding vector' USING ERRCODE='22023';
  END IF;
  -- Lifecycle invalidation owns the source first; never retain a job lock while waiting for it.
  IF $3='recipient' THEN
    SELECT r.* INTO source_row FROM public.recipients r WHERE r.id=$4 FOR UPDATE;
  ELSIF $3='fact' THEN
    SELECT f.* INTO source_row FROM public.user_memories f WHERE f.id=$4 FOR UPDATE;
  ELSE RETURN 'stale'; END IF;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF (source_row.user_id,source_row.embedding_incarnation,source_row.embedding_generation,source_row.desired_embedding_revision,
      source_row.status,source_row.embedding_state) IS DISTINCT FROM ($2,$5,$6,$7,'active'::text,'pending'::text) THEN RETURN 'stale'; END IF;
  SELECT j.* INTO job FROM embedding_private.jobs j WHERE j.id=$1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF (job.owner_id,job.kind,job.source_id,job.incarnation,job.generation,job.revision,job.claim_token,job.state)
      IS DISTINCT FROM ($2,$3,$4,$5,$6,$7,$8,'leased'::text) OR job.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  -- Pin the live run after both row locks; expiration is checked after every possible lock wait.
  SELECT c.* INTO run_row FROM embedding_private.control c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF (run_row.activated,run_row.claims_enabled,run_row.pause_code,run_row.target_revision,run_row.run_token)
    IS DISTINCT FROM (true,true,NULL::text,$7,job.run_token) OR job.run_token IS NULL OR run_row.run_until IS NULL
    OR run_row.run_until<=clock_timestamp() OR job.lease_until<=clock_timestamp() THEN RETURN 'stale'; END IF;
  IF $3='recipient' THEN
    UPDATE public.recipients SET embedding=$9,embedding_model_revision=$7,embedding_state='ready' WHERE id=$4;
  ELSE
    UPDATE public.user_memories SET embedding=$9,embedding_model_revision=$7,embedding_state='ready' WHERE id=$4;
  END IF;
  UPDATE embedding_private.jobs SET state='done',claim_token=NULL,lease_until=NULL,updated_at=clock_timestamp() WHERE id=$1;
  RETURN 'applied';
END
$body$;
$ddl$,vector_schema);
  signature := format('public.embedding_complete(uuid,uuid,text,uuid,uuid,bigint,text,uuid,%I.vector)',vector_schema);
  EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',signature);
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',signature,role_name);
      IF role_name IN ('embedding_worker','service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',signature,role_name);
      END IF;
    END IF;
  END LOOP;
END
$completion$;
