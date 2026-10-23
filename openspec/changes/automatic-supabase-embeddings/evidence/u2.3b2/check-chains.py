"""U2.3b2 actual scoped admission on both complete default-path chains."""
import runpy
proof = """BEGIN;
SELECT embedding_private.activate(); UPDATE embedding_private.control SET claims_enabled=true;
INSERT INTO users(id,privy_did) VALUES('00000000-0000-4000-8000-000000000001','did:fixture:admission');
INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana','ana','fixture',now());
INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana es mi hija',now());
SELECT pg_sleep(greatest(0,extract(epoch FROM max(available_at)-clock_timestamp()))) FROM embedding_private.jobs;
SET LOCAL ROLE embedding_worker;
DO $worker$
DECLARE run uuid; j record; r record; n integer := 0;
BEGIN
  PERFORM set_config('app.user_id','00000000-0000-4000-8000-000000000001',true);
  BEGIN
    PERFORM public.embedding_admit_request('query',1);
    RAISE EXCEPTION 'worker query authorized';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  SELECT run_token INTO STRICT run FROM public.embedding_begin_drain();
  FOR j IN SELECT * FROM public.embedding_claim_jobs(run,4) LOOP
    SELECT * INTO STRICT r FROM public.embedding_admit_request('drain',6000,j.job_id,j.claim_token);
    IF r.status<>'admitted' OR r.reservation_id IS NULL OR r.expires_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'bound admission';
  END IF;
    IF (SELECT status FROM public.embedding_admit_request('drain',6000,j.job_id,j.claim_token))<>'deferred' THEN
    RAISE EXCEPTION 'duplicate charge';
  END IF;
    n := n+1;
  END LOOP;
  IF n<>2 THEN
    RAISE EXCEPTION 'both domains absent';
  END IF;
END $worker$;
SET LOCAL ROLE recipient_app;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000001',true);
DO $app$ BEGIN
  FOR n IN 1..3 LOOP
    IF (SELECT status FROM public.embedding_admit_request('query',6000))<>(CASE WHEN n<=2 THEN 'admitted' ELSE 'deferred' END) THEN
    RAISE EXCEPTION 'query pool';
  END IF;
  END LOOP;
  BEGIN
    PERFORM public.embedding_begin_drain();
    RAISE EXCEPTION 'app drain authority';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $app$;
RESET ROLE;
DO $check$ BEGIN
  IF (SELECT request_count FROM embedding_private.control)<>4 OR (SELECT count(*) FROM embedding_private.reservations)<>4 OR EXISTS(SELECT FROM embedding_private.jobs WHERE attempts<>0) THEN
    RAISE EXCEPTION 'counts';
  END IF;
  IF (SELECT count(*) FROM embedding_private.reservations r JOIN embedding_private.jobs j ON r.job_id=j.id AND r.claim_token=j.claim_token AND r.run_token=j.run_token AND r.owner_id=j.owner_id AND r.kind=j.kind AND r.source_id=j.source_id AND r.incarnation=j.incarnation AND r.generation=j.generation AND r.revision=j.revision)<>2 THEN
    RAISE EXCEPTION 'identity';
  END IF;
  IF has_schema_privilege('recipient_app','embedding_private','USAGE') OR EXISTS(SELECT FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE p.oid='public.embedding_admit_request(text,integer,uuid,uuid)'::regprocedure AND a.grantee=0) THEN
    RAISE EXCEPTION 'grants';
  END IF;
END $check$;
ROLLBACK;
"""
runpy.run_path('tests/integration/helpers/embedding-complete-chains.py')['check_chains'](__file__, 27, proof)
