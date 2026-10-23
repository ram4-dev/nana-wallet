-- Nullable expansion is dormant; only an operator may switch the empty, paused fleet.
-- One statement makes function creation, revocation and guarded nullability atomic.
DO $protection$
DECLARE role_name text;
BEGIN
  IF (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid IN ('public.recipients'::regclass,'public.user_memories'::regclass)
    AND ((tgname='embedding_source_before' AND tgfoid='embedding_private.source_before()'::regprocedure AND tgtype=23)
      OR (tgname='embedding_source_after' AND tgfoid='embedding_private.source_after()'::regprocedure AND tgtype=29)) AND tgenabled='O')<>4 THEN
    RAISE EXCEPTION 'embedding guards required' USING ERRCODE='23514';
  END IF;
  ALTER TABLE public.recipients ALTER COLUMN embedding DROP NOT NULL, ALTER COLUMN embedding_model_revision DROP NOT NULL;
  ALTER TABLE public.user_memories ALTER COLUMN embedding DROP NOT NULL, ALTER COLUMN embedding_model_revision DROP NOT NULL;
  EXECUTE $ddl$
CREATE FUNCTION embedding_private.activate() RETURNS void
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE table_name text; role_name text; columns text; protected_column text;
BEGIN
  -- Block source mutations until inventory, grants and control commit together.
  LOCK TABLE public.recipients,public.user_memories IN ACCESS EXCLUSIVE MODE;
  PERFORM 1 FROM embedding_private.control WHERE singleton FOR UPDATE;
  IF NOT FOUND OR EXISTS (SELECT FROM embedding_private.control WHERE activated OR claims_enabled OR semantic_enabled)
    OR EXISTS (SELECT FROM public.recipients) OR EXISTS (SELECT FROM public.user_memories)
    OR (SELECT count(*) FROM pg_catalog.pg_class WHERE oid IN ('public.recipients'::regclass,'public.user_memories'::regclass)
      AND relrowsecurity AND relforcerowsecurity)<>2
    OR (SELECT count(*) FROM pg_catalog.pg_trigger WHERE tgrelid IN ('public.recipients'::regclass,'public.user_memories'::regclass)
      AND ((tgname='embedding_source_before' AND tgfoid='embedding_private.source_before()'::regprocedure AND tgtype=23)
        OR (tgname='embedding_source_after' AND tgfoid='embedding_private.source_after()'::regprocedure AND tgtype=29)) AND tgenabled='O')<>4 THEN
    RAISE EXCEPTION 'unsafe embedding activation' USING ERRCODE='23514';
  END IF;
  REVOKE INSERT,UPDATE ON public.recipients,public.user_memories FROM recipient_app;
  FOREACH table_name IN ARRAY ARRAY['recipients','user_memories'] LOOP
    SELECT string_agg(quote_ident(attname),',') INTO columns FROM pg_catalog.pg_attribute
      WHERE attrelid=format('public.%I',table_name)::regclass AND attnum>0 AND NOT attisdropped;
    EXECUTE format('REVOKE INSERT(%1$s),UPDATE(%1$s) ON public.%2$I FROM recipient_app',columns,table_name);
  END LOOP;
  GRANT INSERT(user_id,name,normalized_name,description,address,network,version,status,provenance,address_confirmed_at,created_at,updated_at),
    UPDATE(name,normalized_name,description,address,network,version,status,provenance,address_confirmed_at,created_at,updated_at) ON public.recipients TO recipient_app;
  GRANT INSERT(user_id,fact,kind,version,status,provenance,confirmed_at,created_at,updated_at),
    UPDATE(fact,kind,version,status,provenance,confirmed_at,created_at,updated_at) ON public.user_memories TO recipient_app;
  -- REVOKE cannot cancel inherited/PUBLIC privileges: refuse rather than activate unsafely.
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      FOREACH table_name IN ARRAY ARRAY['recipients','user_memories'] LOOP
        FOREACH protected_column IN ARRAY ARRAY['id','embedding','embedding_model_revision','embedding_generation',
          'embedding_incarnation','desired_embedding_revision','embedding_state'] LOOP
          IF has_column_privilege(role_name,format('public.%I',table_name),protected_column,'INSERT,UPDATE') THEN
            RAISE EXCEPTION 'unsafe embedding grants' USING ERRCODE='23514';
          END IF;
        END LOOP;
        IF has_column_privilege(role_name,format('public.%I',table_name),'user_id','UPDATE') THEN
          RAISE EXCEPTION 'unsafe source owner grant' USING ERRCODE='23514';
        END IF;
      END LOOP;
    END IF;
  END LOOP;
  UPDATE embedding_private.control SET activated=true WHERE singleton;
END
$body$;
$ddl$;
  REVOKE ALL ON FUNCTION embedding_private.activate() FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','service_role','embedding_worker'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION embedding_private.activate() FROM %I',role_name);
    END IF;
  END LOOP;
END
$protection$;
