-- Private capacity only. A reservation never authorizes a provider call.
DO $capacity$
DECLARE role_name text;
BEGIN
  IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls)) THEN
    RAISE EXCEPTION 'embedding capacity owner must bypass forced RLS' USING ERRCODE='42501';
  END IF;
  CREATE TABLE embedding_private.owner_minutes (
    owner_id uuid NOT NULL, minute_started_at timestamptz NOT NULL,
    request_count integer NOT NULL CHECK (request_count BETWEEN 1 AND 6), PRIMARY KEY(owner_id,minute_started_at));
  CREATE TABLE embedding_private.reservations (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(), scope text NOT NULL CHECK (scope IN ('query','drain')),
    byte_count integer NOT NULL CHECK (byte_count BETWEEN 1 AND 6000), minute_started_at timestamptz NOT NULL,
    owner_id uuid NOT NULL, job_id uuid, claim_token uuid, run_token uuid,
    kind text, source_id uuid, incarnation uuid, generation bigint, revision text,
    state text NOT NULL DEFAULT 'reserved' CHECK (state IN ('reserved','started','released')),
    created_at timestamptz NOT NULL, started_at timestamptz, expires_at timestamptz NOT NULL, released_at timestamptz,
    UNIQUE(job_id,claim_token), CHECK (
      (scope='query' AND job_id IS NULL AND claim_token IS NULL AND run_token IS NULL AND kind IS NULL
        AND source_id IS NULL AND incarnation IS NULL AND generation IS NULL AND revision IS NULL)
      OR (scope='drain' AND job_id IS NOT NULL AND claim_token IS NOT NULL AND run_token IS NOT NULL
        AND kind IN ('recipient','fact') AND source_id IS NOT NULL AND incarnation IS NOT NULL AND generation>0 AND revision IS NOT NULL)));
  CREATE INDEX reservations_live_idx ON embedding_private.reservations(scope,expires_at) WHERE state IN ('reserved','started');
  EXECUTE $ddl$
CREATE FUNCTION embedding_private.reserve_request(scope text,byte_count integer,owner_id uuid,job_id uuid,claim_token uuid)
RETURNS TABLE(status text,reservation_id uuid,expires_at timestamptz)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,extensions SET row_security=off AS $body$
DECLARE job embedding_private.jobs%ROWTYPE; control_row embedding_private.control%ROWTYPE;
  admitted_at timestamptz; minute_at timestamptz; deadline timestamptz; owner_count integer;
BEGIN
  IF $1 IS NULL OR $1 NOT IN ('query','drain') OR $2 IS NULL OR $2 NOT BETWEEN 1 AND 6000
    OR ($1='query' AND ($3 IS NULL OR $4 IS NOT NULL OR $5 IS NOT NULL))
    OR ($1='drain' AND ($4 IS NULL OR $5 IS NULL)) THEN
    RAISE EXCEPTION 'invalid embedding reservation input' USING ERRCODE='22023';
  END IF;
  status := 'deferred';
  IF $1='drain' THEN
    SELECT j.* INTO job FROM embedding_private.jobs j WHERE j.id=$4 FOR UPDATE;
    IF NOT FOUND THEN RETURN NEXT; RETURN; END IF;
  END IF;
  SELECT c.* INTO STRICT control_row FROM embedding_private.control c WHERE c.singleton FOR UPDATE;
  admitted_at := clock_timestamp();
  IF NOT control_row.activated OR NOT control_row.claims_enabled OR control_row.pause_code IS NOT NULL THEN RETURN NEXT; RETURN; END IF;
  IF $1='drain' AND (job.state<>'leased' OR job.claim_token IS DISTINCT FROM $5 OR job.lease_until<=admitted_at
    OR job.run_token IS NULL OR job.run_token IS DISTINCT FROM control_row.run_token OR control_row.run_until IS NULL
    OR control_row.run_until<=admitted_at OR NOT EXISTS (SELECT FROM public.embedding_read_job($4,$5))
    OR EXISTS (SELECT FROM embedding_private.reservations r WHERE r.job_id=$4 AND r.claim_token=$5)) THEN RETURN NEXT; RETURN; END IF;
  minute_at := date_trunc('minute',admitted_at AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  IF control_row.minute_started_at IS DISTINCT FROM minute_at THEN
    control_row.request_count := 0; control_row.canonical_bytes := 0;
    control_row.query_request_count := 0; control_row.query_canonical_bytes := 0;
  END IF;
  IF control_row.request_count>=60 OR control_row.canonical_bytes>360000-$2
    OR ($1='drain' AND (control_row.request_count-control_row.query_request_count>=40
      OR control_row.canonical_bytes-control_row.query_canonical_bytes>240000-$2))
    OR (SELECT count(*) FROM embedding_private.reservations r WHERE r.scope=$1 AND r.state IN ('reserved','started') AND r.expires_at>clock_timestamp())>=2 THEN RETURN NEXT; RETURN; END IF;
  IF $1='query' THEN
    SELECT o.request_count INTO owner_count FROM embedding_private.owner_minutes o WHERE o.owner_id=$3 AND o.minute_started_at=minute_at FOR UPDATE;
    IF coalesce(owner_count,0)>=6 THEN RETURN NEXT; RETURN; END IF;
    INSERT INTO embedding_private.owner_minutes VALUES($3,minute_at,1)
      ON CONFLICT ON CONSTRAINT owner_minutes_pkey DO UPDATE SET request_count=embedding_private.owner_minutes.request_count+1;
  END IF;
  deadline := CASE WHEN $1='query' THEN admitted_at+interval '3 seconds'
    ELSE least(admitted_at+interval '15 seconds',job.lease_until,control_row.run_until) END;
  INSERT INTO embedding_private.reservations(scope,byte_count,minute_started_at,owner_id,job_id,claim_token,run_token,
    kind,source_id,incarnation,generation,revision,created_at,expires_at)
    VALUES($1,$2,minute_at,CASE WHEN $1='query' THEN $3 ELSE job.owner_id END,$4,$5,job.run_token,
      job.kind,job.source_id,job.incarnation,job.generation,job.revision,admitted_at,deadline) RETURNING id INTO reservation_id;
  UPDATE embedding_private.control SET minute_started_at=minute_at,request_count=control_row.request_count+1,
    canonical_bytes=control_row.canonical_bytes+$2,
    query_request_count=control_row.query_request_count+CASE WHEN $1='query' THEN 1 ELSE 0 END,
    query_canonical_bytes=control_row.query_canonical_bytes+CASE WHEN $1='query' THEN $2 ELSE 0 END WHERE singleton;
  status := 'admitted'; expires_at := deadline; RETURN NEXT;
END
$body$;
$ddl$;
  REVOKE ALL ON FUNCTION embedding_private.reserve_request(text,integer,uuid,uuid,uuid) FROM PUBLIC;
  REVOKE ALL ON TABLE embedding_private.reservations,embedding_private.owner_minutes FROM PUBLIC;
  FOREACH role_name IN ARRAY ARRAY['recipient_app','anon','authenticated','embedding_worker','service_role'] LOOP
    IF EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON FUNCTION embedding_private.reserve_request(text,integer,uuid,uuid,uuid) FROM %I',role_name);
      EXECUTE format('REVOKE ALL ON TABLE embedding_private.reservations,embedding_private.owner_minutes FROM %I',role_name);
    END IF;
  END LOOP;
END
$capacity$;
