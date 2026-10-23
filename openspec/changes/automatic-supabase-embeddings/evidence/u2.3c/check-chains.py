"""U2.3c real once-only starts on both complete default-path chains."""
import runpy
proof = """BEGIN;
SELECT embedding_private.activate(); UPDATE embedding_private.control SET claims_enabled=true;
INSERT INTO users(id,privy_did) VALUES('00000000-0000-4000-8000-000000000001','did:fixture:starts');
INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana','ana','fixture',now());
INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana es mi hija',now());
SELECT pg_sleep(greatest(0,extract(epoch FROM max(available_at)-clock_timestamp()))) FROM embedding_private.jobs;
SET LOCAL ROLE embedding_worker;
DO $worker$
DECLARE run uuid; j record; r record; s record; n integer := 0;
BEGIN
  SELECT run_token INTO STRICT run FROM public.embedding_begin_drain();
  FOR j IN SELECT * FROM public.embedding_claim_jobs(run,4) LOOP
    SELECT * INTO STRICT r FROM public.embedding_admit_request('drain',6000,j.job_id,j.claim_token);
    SELECT * INTO STRICT s FROM public.embedding_start_attempt(j.job_id,j.claim_token,r.reservation_id);
    IF r.status<>'admitted' OR s.status<>'started' OR s.attempt<>1 OR s.expires_at<=clock_timestamp()
      OR (SELECT status FROM public.embedding_start_attempt(j.job_id,j.claim_token,r.reservation_id))<>'already_started'
      OR (SELECT status FROM public.embedding_start_query(r.reservation_id,6000))<>'stale' THEN
      RAISE EXCEPTION 'once-only bound drain start';
    END IF;
    n := n+1;
  END LOOP;
  IF n<>2 THEN RAISE EXCEPTION 'both domains required'; END IF;
END $worker$;
SET LOCAL ROLE recipient_app;
SELECT set_config('app.user_id','00000000-0000-4000-8000-000000000001',true);
SELECT reservation_id AS query_id,expires_at AS deadline FROM public.embedding_admit_request('query',42) \\gset
SET LOCAL ROLE embedding_worker;
SELECT 1 / ((status='started' AND expires_at=:'deadline'::timestamptz)::int) FROM public.embedding_start_query(:'query_id',42);
SELECT 1 / ((status='already_started')::int) FROM public.embedding_start_query(:'query_id',42);
RESET ROLE;
DO $check$ BEGIN
  IF (SELECT sum(attempts) FROM embedding_private.jobs)<>2 OR (SELECT count(*) FROM embedding_private.reservations WHERE state='started')<>3 THEN RAISE EXCEPTION 'start counts'; END IF;
END $check$;
ROLLBACK;
"""
runpy.run_path('tests/integration/helpers/embedding-complete-chains.py')['check_chains'](__file__, 28, proof)
