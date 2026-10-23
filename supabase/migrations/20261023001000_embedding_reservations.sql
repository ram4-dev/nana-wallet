-- Reservation-only cleanup. Never refund admission charges or provider attempts.
DO $release$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding release owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
  EXECUTE $ddl$
CREATE FUNCTION embedding_private.job_reservation_after() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
BEGIN
  IF OLD.claim_token IS NOT NULL THEN
    UPDATE embedding_private.reservations r SET state='released',released_at=clock_timestamp()
      WHERE (r.scope,r.job_id,r.claim_token,r.run_token,r.owner_id,r.kind,r.source_id,r.incarnation,r.generation,r.revision)
        IS NOT DISTINCT FROM ('drain'::text,OLD.id,OLD.claim_token,OLD.run_token,OLD.owner_id,OLD.kind,OLD.source_id,OLD.incarnation,OLD.generation,OLD.revision)
      AND r.state IN ('reserved','started') AND (
        NEW.state IN ('done','failed')
        OR (OLD.state='leased' AND NEW.state='pending' AND NEW.claim_token IS NULL
          AND NEW.error_code IN ('provider_timeout','provider_network','provider_rate_limit','provider_5xx'))
        OR (r.state='reserved' AND (NEW.state,NEW.claim_token,NEW.run_token) IS DISTINCT FROM (OLD.state,OLD.claim_token,OLD.run_token)));
  END IF;
  RETURN NULL;
END $body$;
$ddl$;
  EXECUTE $ddl$
CREATE FUNCTION public.embedding_finish_request(reservation_id uuid,scope text,job_id uuid DEFAULT NULL,claim_token uuid DEFAULT NULL)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE r embedding_private.reservations%ROWTYPE;
BEGIN
  SELECT t.* INTO r FROM embedding_private.reservations t WHERE t.id=$1 FOR UPDATE;
  IF NOT FOUND THEN RETURN 'stale'; END IF;
  IF r.scope IS DISTINCT FROM $2 OR ($2='query' AND ($3 IS NOT NULL OR $4 IS NOT NULL))
    OR ($2='drain' AND (r.job_id,r.claim_token) IS DISTINCT FROM ($3,$4)) THEN RETURN 'stale'; END IF;
  IF r.state<>'released' THEN
    UPDATE embedding_private.reservations SET state='released',released_at=clock_timestamp() WHERE id=r.id;
  END IF;
  RETURN 'released';
END $body$;
$ddl$;
  CREATE TRIGGER embedding_job_reservation_after AFTER UPDATE ON embedding_private.jobs
    FOR EACH ROW EXECUTE FUNCTION embedding_private.job_reservation_after();
  REVOKE ALL ON FUNCTION embedding_private.job_reservation_after() FROM PUBLIC;
  REVOKE ALL ON FUNCTION public.embedding_finish_request(uuid,text,uuid,uuid) FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION embedding_private.job_reservation_after(),public.embedding_finish_request(uuid,text,uuid,uuid) FROM %I',role_name);
      IF role_name IN ('embedding_worker','service_role') THEN
        EXECUTE format('GRANT EXECUTE ON FUNCTION public.embedding_finish_request(uuid,text,uuid,uuid) TO %I',role_name);
      END IF;
    END IF;
  END LOOP;
END $release$;
