"""U2.3b1 private capacity proof on both complete default-path chains."""
import runpy
proof = """BEGIN;
DO $proof$
DECLARE run uuid; j record; r record; admitted integer := 0;
BEGIN
  IF (SELECT status FROM embedding_private.reserve_request('query',1,gen_random_uuid(),NULL,NULL))<>'deferred' THEN RAISE EXCEPTION 'dormancy'; END IF;
  IF (SELECT count(*) FROM pg_proc p JOIN pg_roles o ON o.oid=p.proowner WHERE proname='reserve_request' AND prosecdef AND (o.rolsuper OR o.rolbypassrls) AND proconfig=ARRAY['search_path=pg_catalog, extensions','row_security=off'])<>1 THEN RAISE EXCEPTION 'definer'; END IF;
  IF EXISTS (SELECT FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE proname='reserve_request' AND a.grantee<>p.proowner) OR has_schema_privilege('embedding_worker','embedding_private','USAGE') THEN RAISE EXCEPTION 'private grants'; END IF;
  PERFORM embedding_private.activate(); UPDATE embedding_private.control SET claims_enabled=true;
  INSERT INTO users(id,privy_did) VALUES('00000000-0000-4000-8000-000000000001','did:fixture:capacity');
  INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana','ana','fixture',now());
  INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana es mi hija',now());
  SELECT run_token INTO STRICT run FROM public.embedding_begin_drain();
  FOR j IN SELECT * FROM public.embedding_claim_jobs(run,4) LOOP
    SELECT * INTO STRICT r FROM embedding_private.reserve_request('drain',6000,NULL,j.job_id,j.claim_token);
    IF r.status<>'admitted' OR r.reservation_id IS NULL OR r.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'drain admission'; END IF;
    IF NOT EXISTS (SELECT FROM embedding_private.reservations WHERE id=r.reservation_id AND owner_id=j.owner_id AND kind=j.kind AND source_id=j.source_id AND incarnation=j.incarnation AND generation=j.generation AND revision=j.revision AND run_token=run) THEN RAISE EXCEPTION 'binding'; END IF;
    IF (SELECT status FROM embedding_private.reserve_request('drain',6000,NULL,j.job_id,j.claim_token))<>'deferred' THEN RAISE EXCEPTION 'duplicate'; END IF;
    admitted := admitted+1;
  END LOOP;
  FOR n IN 1..3 LOOP
    IF (SELECT status FROM embedding_private.reserve_request('query',6000,gen_random_uuid(),NULL,NULL))<>(CASE WHEN n<=2 THEN 'admitted' ELSE 'deferred' END) THEN RAISE EXCEPTION 'independent query pool'; END IF;
  END LOOP;
  IF admitted<>2 OR (SELECT count(*) FROM embedding_private.reservations)<>4 OR (SELECT request_count FROM embedding_private.control)<>4 OR EXISTS (SELECT FROM embedding_private.jobs WHERE attempts<>0) THEN RAISE EXCEPTION 'nonvacuity/no charge'; END IF;
END $proof$;
ROLLBACK;
"""
runpy.run_path('tests/integration/helpers/embedding-complete-chains.py')['check_chains'](__file__, 26, proof)
