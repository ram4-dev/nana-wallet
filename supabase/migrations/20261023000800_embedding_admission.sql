-- Scoped admission only. Reserved identities do not permit provider calls.
DO $admission$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding admission owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_admit_request(scope text,byte_count integer,job_id uuid DEFAULT NULL,claim_token uuid DEFAULT NULL)
RETURNS TABLE(status text,reservation_id uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE effective_role text := current_setting('role',true); owner_id uuid;
BEGIN
  IF $1 IS NULL OR $1 NOT IN ('query','drain') OR $2 IS NULL OR $2 NOT BETWEEN 1 AND 6000 THEN
    RAISE EXCEPTION 'invalid embedding admission input' USING ERRCODE='22023';
  END IF;
  -- role is PostgreSQL-enforced SET LOCAL ROLE, not a caller-owned custom GUC.
  IF effective_role IS NULL OR effective_role NOT IN ('recipient_app','embedding_worker','service_role') THEN
    RAISE EXCEPTION 'embedding admission role required' USING ERRCODE='42501';
  END IF;
  IF NOT pg_has_role(session_user,effective_role,'MEMBER')
    OR NOT has_function_privilege(effective_role,'public.embedding_admit_request(text,integer,uuid,uuid)','EXECUTE') THEN
    RAISE EXCEPTION 'embedding admission role denied' USING ERRCODE='42501';
  END IF;
  IF $1='query' THEN
    IF effective_role<>'recipient_app' THEN
      RAISE EXCEPTION 'query admission role denied' USING ERRCODE='42501';
    END IF;
    BEGIN
      owner_id := nullif(current_setting('app.user_id',true),'')::uuid;
    EXCEPTION WHEN invalid_text_representation THEN
      RAISE EXCEPTION 'query admission owner required' USING ERRCODE='42501';
    END;
    IF owner_id IS NULL OR NOT EXISTS (SELECT FROM public.users u WHERE u.id=owner_id) THEN
      RAISE EXCEPTION 'query admission owner required' USING ERRCODE='42501';
    END IF;
  ELSIF effective_role NOT IN ('embedding_worker','service_role') THEN
    RAISE EXCEPTION 'drain admission role denied' USING ERRCODE='42501';
  END IF;
  RETURN QUERY SELECT * FROM embedding_private.reserve_request($1,$2,owner_id,$3,$4);
END
$body$;
$ddl$;
  REVOKE ALL ON FUNCTION public.embedding_admit_request(text,integer,uuid,uuid) FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION public.embedding_admit_request(text,integer,uuid,uuid) FROM %I',role_name);
      IF role_name IN ('recipient_app','embedding_worker','service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.embedding_admit_request(text,integer,uuid,uuid) TO %I',role_name);
      END IF;
    END IF;
  END LOOP;
END
$admission$;
