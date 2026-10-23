-- Recovery only; admission/STARTED accounting and activation remain separate.
DO $recovery$
DECLARE role_name text; fail_signature text := 'public.embedding_fail(uuid,uuid,text,uuid,uuid,bigint,text,uuid,text,integer)';
  retry_signature text := 'public.embedding_retry(text,uuid,uuid,bigint)';
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding RPC owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_fail(job_id uuid,owner uuid,kind text,source_id uuid,incarnation uuid,
  generation bigint,revision text,claim_token uuid,error_code text,retry_after_seconds integer) RETURNS text
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE source_row record; job embedding_private.jobs%ROWTYPE; run_row embedding_private.control%ROWTYPE;
  terminal boolean; safe_code text; finished_at timestamptz; delay double precision;
BEGIN
  IF $9 IS NULL OR $9 NOT IN ('provider_timeout','provider_network','provider_rate_limit','provider_5xx','invalid_input','invalid_vector','input_oversize') THEN
    RAISE EXCEPTION 'invalid embedding error code' USING ERRCODE='22023';
  END IF;
  IF $3='recipient' THEN SELECT r.* INTO source_row FROM public.recipients r WHERE r.id=$4 FOR UPDATE;
  ELSIF $3='fact' THEN SELECT f.* INTO source_row FROM public.user_memories f WHERE f.id=$4 FOR UPDATE;
  ELSE RETURN 'stale'; END IF;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF (source_row.user_id,source_row.embedding_incarnation,source_row.embedding_generation,source_row.desired_embedding_revision,
    source_row.status,source_row.embedding_state) IS DISTINCT FROM ($2,$5,$6,$7,'active'::text,'pending'::text) THEN RETURN 'stale'; END IF;
  SELECT j.* INTO job FROM embedding_private.jobs j WHERE j.id=$1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF (job.owner_id,job.kind,job.source_id,job.incarnation,job.generation,job.revision,job.claim_token,job.state)
    IS DISTINCT FROM ($2,$3,$4,$5,$6,$7,$8,'leased'::text) THEN RETURN 'stale'; END IF;
  SELECT c.* INTO run_row FROM embedding_private.control c WHERE c.singleton FOR SHARE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  -- Capture time after source, job AND control waits, never at transaction start.
  finished_at := clock_timestamp();
  IF (run_row.activated,run_row.claims_enabled,run_row.pause_code,run_row.target_revision,run_row.run_token)
    IS DISTINCT FROM (true,true,NULL::text,$7,job.run_token) OR job.run_token IS NULL OR run_row.run_until IS NULL
    OR run_row.run_until<=finished_at OR job.lease_until<=finished_at THEN RETURN 'stale'; END IF;
  terminal := $9 IN ('invalid_input','invalid_vector','input_oversize') OR job.attempts>=5;
  safe_code := CASE WHEN job.attempts>=5 AND $9 LIKE 'provider_%' THEN 'attempts_exhausted' ELSE $9 END;
  delay := least(300,greatest(greatest(coalesce($10,0),0),5*power(2,greatest(job.attempts-1,0))*(1+random()*0.2)));
  IF terminal THEN
    IF $3='recipient' THEN UPDATE public.recipients SET embedding_state='failed' WHERE id=$4;
    ELSE UPDATE public.user_memories SET embedding_state='failed' WHERE id=$4; END IF;
  END IF;
  UPDATE embedding_private.jobs SET state=CASE WHEN terminal THEN 'failed' ELSE 'pending' END,error_code=safe_code,
    claim_token=NULL,lease_until=NULL,available_at=finished_at+delay*interval '1 second',updated_at=finished_at WHERE id=$1;
  RETURN 'applied';
END
$body$;
$ddl$;
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_retry(kind text,owner uuid,source_id uuid,expected_generation bigint) RETURNS bigint
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE source_row record; target text; next_generation bigint;
BEGIN
  IF $1='recipient' THEN SELECT r.* INTO source_row FROM public.recipients r WHERE r.id=$3 FOR UPDATE;
  ELSIF $1='fact' THEN SELECT f.* INTO source_row FROM public.user_memories f WHERE f.id=$3 FOR UPDATE;
  ELSE RETURN NULL; END IF;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT c.target_revision INTO target FROM embedding_private.control c WHERE c.singleton AND c.activated;
  IF NOT FOUND THEN RETURN NULL; END IF;
  IF (source_row.user_id,source_row.embedding_generation,source_row.status,source_row.embedding_state,source_row.desired_embedding_revision)
    IS DISTINCT FROM ($2,$4,'active'::text,'failed'::text,target) THEN RETURN NULL; END IF;
  -- The existing distinct-value guard advances exactly once without a business edit.
  IF $1='recipient' THEN
    UPDATE public.recipients SET desired_embedding_revision=NULL WHERE id=$3 RETURNING embedding_generation INTO next_generation;
  ELSE
    UPDATE public.user_memories SET desired_embedding_revision=NULL WHERE id=$3 RETURNING embedding_generation INTO next_generation;
  END IF;
  RETURN next_generation;
END
$body$;
$ddl$;
  EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM PUBLIC',fail_signature,retry_signature);
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION %s,%s FROM %I',fail_signature,retry_signature,role_name);
      IF role_name IN ('embedding_worker','service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I',fail_signature,role_name);
      END IF;
    END IF;
  END LOOP;
END
$recovery$;
