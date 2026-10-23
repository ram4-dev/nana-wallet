-- Guarded lifecycle only. Activation, nullable expansion and privilege switch are later units.
-- Discover pgvector without changing either migration chain's default search_path.
DO $lifecycle$
DECLARE vector_schema text; table_name text; role_name text;
BEGIN
  SELECT n.nspname INTO STRICT vector_schema FROM pg_catalog.pg_extension e
    JOIN pg_catalog.pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector';
  EXECUTE format($ddl$
CREATE FUNCTION embedding_private.source_before() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions AS $body$
DECLARE enabled boolean; target text; changed boolean;
BEGIN
  SELECT activated,target_revision INTO STRICT enabled,target FROM embedding_private.control WHERE singleton;
  IF NOT enabled THEN
    IF NEW.embedding IS NULL OR NEW.embedding_model_revision IS NULL
      OR length(btrim(NEW.embedding_model_revision))=0
      OR %1$I.vector_dims(NEW.embedding)<>384 OR NOT (%1$I.vector_norm(NEW.embedding)>0) THEN
      RAISE EXCEPTION 'invalid dormant embedding' USING ERRCODE='23514';
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP='INSERT' THEN
    NEW.embedding_incarnation := pg_catalog.gen_random_uuid();
    NEW.embedding_generation := 1;
    changed := true;
  ELSE
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.user_id IS DISTINCT FROM OLD.user_id THEN
      RAISE EXCEPTION 'immutable embedding source identity' USING ERRCODE='23514';
    END IF;
    changed := (to_jsonb(NEW)->'name',to_jsonb(NEW)->'description',to_jsonb(NEW)->'fact',NEW.status,NEW.desired_embedding_revision)
      IS DISTINCT FROM (to_jsonb(OLD)->'name',to_jsonb(OLD)->'description',to_jsonb(OLD)->'fact',OLD.status,OLD.desired_embedding_revision)
      OR OLD.desired_embedding_revision IS DISTINCT FROM target;
    NEW.embedding_incarnation := OLD.embedding_incarnation;
    NEW.embedding_generation := OLD.embedding_generation + CASE WHEN changed THEN 1 ELSE 0 END;
    NEW.desired_embedding_revision := OLD.desired_embedding_revision;
  END IF;
  IF changed THEN
    NEW.desired_embedding_revision := target;
    NEW.embedding := NULL;
    NEW.embedding_model_revision := NULL;
    NEW.embedding_state := CASE WHEN NEW.status='active' THEN 'pending' ELSE 'inactive' END;
  END IF;
  RETURN NEW;
END
$body$;
$ddl$, vector_schema);
EXECUTE $after$
CREATE FUNCTION embedding_private.source_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions AS $body$
DECLARE enabled boolean; source_row record; source_kind text;
BEGIN
  SELECT activated INTO STRICT enabled FROM embedding_private.control WHERE singleton;
  IF NOT enabled THEN RETURN NULL; END IF;
  IF TG_OP='DELETE' THEN source_row := OLD;
  ELSE
    IF TG_OP='UPDATE' THEN
      IF NEW.embedding_generation=OLD.embedding_generation THEN RETURN NULL; END IF;
    END IF;
    source_row := NEW;
  END IF;
  source_kind := CASE TG_TABLE_NAME WHEN 'recipients' THEN 'recipient' WHEN 'user_memories' THEN 'fact' END;
  -- The source mutation already holds its row lock; invalidate jobs second.
  UPDATE embedding_private.jobs SET state='superseded',claim_token=NULL,lease_until=NULL,updated_at=now()
    WHERE kind=source_kind AND owner_id=source_row.user_id AND source_id=source_row.id
      AND incarnation=source_row.embedding_incarnation AND state<>'superseded';
  IF TG_OP<>'DELETE' AND source_row.status='active' AND source_row.embedding_state='pending' THEN
    INSERT INTO embedding_private.jobs(kind,owner_id,source_id,incarnation,generation,revision)
      VALUES(source_kind,source_row.user_id,source_row.id,source_row.embedding_incarnation,
        source_row.embedding_generation,source_row.desired_embedding_revision);
  END IF;
  RETURN NULL;
END
$body$;
$after$;
REVOKE ALL ON FUNCTION embedding_private.source_before(),embedding_private.source_after() FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION embedding_private.source_before(),embedding_private.source_after() FROM %I',role_name);
    END IF;
  END LOOP;
  FOREACH table_name IN ARRAY ARRAY['recipients','user_memories'] LOOP
    EXECUTE format('CREATE TRIGGER embedding_source_before BEFORE INSERT OR UPDATE ON public.%I FOR EACH ROW EXECUTE FUNCTION embedding_private.source_before()',table_name);
    EXECUTE format('CREATE TRIGGER embedding_source_after AFTER INSERT OR UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION embedding_private.source_after()',table_name);
  END LOOP;
END
$lifecycle$;
