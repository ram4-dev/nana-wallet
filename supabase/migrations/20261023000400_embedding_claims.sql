-- Atomic, default-disabled worker surface. No source mutation or provider work.
DO $claims$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding RPC owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='embedding_worker') THEN
    CREATE ROLE embedding_worker NOLOGIN NOINHERIT;
  END IF;
  IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname='embedding_worker'
    AND (rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolinherit))
    OR EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member='embedding_worker'::regrole) THEN
    RAISE EXCEPTION 'unsafe embedding worker role' USING ERRCODE='42501';
  END IF;
  ALTER TABLE embedding_private.jobs ADD COLUMN run_token uuid;
  CREATE TYPE public.embedding_job_text AS (job_id uuid,kind text,owner_id uuid,source_id uuid,
    incarnation uuid,generation bigint,revision text,name text,description text,fact text);
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_begin_drain() RETURNS TABLE(run_token uuid,run_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
  UPDATE embedding_private.control c SET run_token=pg_catalog.gen_random_uuid(),run_until=clock_timestamp()+interval '90 seconds'
    WHERE c.singleton AND c.activated AND c.claims_enabled AND c.pause_code IS NULL
      AND (c.run_until IS NULL OR c.run_until<=clock_timestamp()) RETURNING c.run_token,c.run_until;
$body$;
$ddl$;
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_claim_jobs(run_token uuid,requested_limit integer)
RETURNS TABLE(job_id uuid,kind text,owner_id uuid,source_id uuid,incarnation uuid,generation bigint,revision text,claim_token uuid,lease_until timestamptz)
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
  WITH due AS (
    SELECT j.id FROM embedding_private.jobs j WHERE j.attempts<5 AND j.available_at<=clock_timestamp()
      AND (j.state='pending' OR (j.state='leased' AND j.lease_until<=clock_timestamp()))
      AND EXISTS (SELECT FROM embedding_private.control c WHERE c.singleton AND c.activated AND c.claims_enabled
        AND c.pause_code IS NULL AND c.run_token=$1 AND c.run_until>clock_timestamp())
    ORDER BY j.available_at,j.id LIMIT CASE WHEN $2>0 THEN least($2,4) ELSE 0 END FOR UPDATE OF j SKIP LOCKED
  ) UPDATE embedding_private.jobs j SET state='leased',claim_token=pg_catalog.gen_random_uuid(),
    lease_until=clock_timestamp()+interval '90 seconds',run_token=$1,updated_at=clock_timestamp()
    FROM due WHERE j.id=due.id RETURNING j.id,j.kind,j.owner_id,j.source_id,j.incarnation,j.generation,j.revision,j.claim_token,j.lease_until;
$body$;
$ddl$;
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_read_job(job_id uuid,claim_token uuid) RETURNS SETOF public.embedding_job_text
LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
  WITH live AS MATERIALIZED (
    SELECT j.* FROM embedding_private.jobs j JOIN embedding_private.control c ON c.singleton
      AND c.activated AND c.claims_enabled AND c.pause_code IS NULL AND c.run_token=j.run_token AND c.run_until>clock_timestamp()
    WHERE j.id=$1 AND j.claim_token=$2 AND j.state='leased' AND j.lease_until>clock_timestamp() AND j.revision=c.target_revision
  ) SELECT j.id,j.kind,j.owner_id,j.source_id,j.incarnation,j.generation,j.revision,r.name,r.description,NULL::text
    FROM live j JOIN public.recipients r ON j.kind='recipient' AND r.id=j.source_id AND r.user_id=j.owner_id
      AND r.embedding_incarnation=j.incarnation AND r.embedding_generation=j.generation AND r.desired_embedding_revision=j.revision
      AND r.status='active' AND r.embedding_state='pending'
  UNION ALL SELECT j.id,j.kind,j.owner_id,j.source_id,j.incarnation,j.generation,j.revision,NULL::text,NULL::text,f.fact
    FROM live j JOIN public.user_memories f ON j.kind='fact' AND f.id=j.source_id AND f.user_id=j.owner_id
      AND f.embedding_incarnation=j.incarnation AND f.embedding_generation=j.generation AND f.desired_embedding_revision=j.revision
      AND f.status='active' AND f.embedding_state='pending';
$body$;
$ddl$;
  REVOKE ALL ON FUNCTION public.embedding_begin_drain(),public.embedding_claim_jobs(uuid,integer),public.embedding_read_job(uuid,uuid) FROM PUBLIC;
  REVOKE ALL ON TYPE public.embedding_job_text FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA embedding_private FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA embedding_private FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL SEQUENCES IN SCHEMA embedding_private FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON ALL FUNCTIONS IN SCHEMA embedding_private FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON FUNCTION public.embedding_begin_drain(),public.embedding_claim_jobs(uuid,integer),public.embedding_read_job(uuid,uuid) FROM %I',role_name);
      IF role_name IN ('embedding_worker','service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.embedding_begin_drain(),public.embedding_claim_jobs(uuid,integer),public.embedding_read_job(uuid,uuid) TO %I',role_name);
        EXECUTE format('GRANT USAGE ON SCHEMA public TO %I',role_name);
        EXECUTE format('GRANT USAGE ON TYPE public.embedding_job_text TO %I',role_name);
      END IF;
    END IF;
  END LOOP;
END
$claims$;
