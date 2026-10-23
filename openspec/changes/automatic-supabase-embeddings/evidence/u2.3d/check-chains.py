"""U2.3d real release/late-finish proof on both complete default-path chains."""
import runpy
proof = """BEGIN;
SET LOCAL search_path=public,extensions;
SELECT embedding_private.activate(); UPDATE embedding_private.control SET claims_enabled=true;
INSERT INTO users(id,privy_did) VALUES('00000000-0000-4000-8000-000000000001','did:fixture:release');
INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana','ana','fixture',now());
INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana es mi hija',now());
SELECT pg_sleep(greatest(0,extract(epoch FROM max(available_at)-clock_timestamp()))) FROM embedding_private.jobs;
DO $proof$
DECLARE run uuid; j record; r record; phase integer; n integer; result text; v vector := ('[1,'||repeat('0,',382)||'0]')::vector;
BEGIN
  SELECT run_token INTO STRICT run FROM public.embedding_begin_drain();
  FOR phase IN 1..2 LOOP
    n := 0;
    FOR j IN SELECT * FROM public.embedding_claim_jobs(run,4) LOOP
      SET LOCAL ROLE embedding_worker;
      SELECT * INTO STRICT r FROM public.embedding_admit_request('drain',42,j.job_id,j.claim_token);
      IF r.status<>'admitted' OR (SELECT status FROM public.embedding_start_attempt(j.job_id,j.claim_token,r.reservation_id))<>'started' THEN RAISE EXCEPTION 'start required'; END IF;
      RESET ROLE;
      IF phase=2 THEN
        IF j.kind='recipient' THEN UPDATE recipients SET description='changed again' WHERE id=j.source_id;
        ELSE UPDATE user_memories SET fact='changed again' WHERE id=j.source_id; END IF;
        IF (SELECT state FROM embedding_private.reservations WHERE id=r.reservation_id)<>'started' THEN RAISE EXCEPTION 'outstanding transport lost slot'; END IF;
      END IF;
      SELECT public.embedding_complete(j.job_id,j.owner_id,j.kind,j.source_id,j.incarnation,j.generation,j.revision,j.claim_token,v) INTO result;
      IF result<>(CASE WHEN phase=1 THEN 'applied' ELSE 'stale' END) THEN RAISE EXCEPTION 'completion fence'; END IF;
      IF (SELECT state FROM embedding_private.reservations WHERE id=r.reservation_id)<>(CASE WHEN phase=1 THEN 'released' ELSE 'started' END) THEN RAISE EXCEPTION 'release lifetime'; END IF;
      IF public.embedding_finish_request(r.reservation_id,'drain',j.job_id,j.claim_token)<>'released' OR public.embedding_finish_request(r.reservation_id,'drain',j.job_id,j.claim_token)<>'released' THEN RAISE EXCEPTION 'idempotent finish'; END IF;
      n := n+1;
    END LOOP;
    IF n<>2 THEN RAISE EXCEPTION 'both domains required'; END IF;
    IF phase=1 THEN UPDATE recipients SET description='new generation'; UPDATE user_memories SET fact='new generation'; END IF;
  END LOOP;
  IF (SELECT request_count FROM embedding_private.control)<>4 OR (SELECT sum(attempts) FROM embedding_private.jobs)<>4 OR EXISTS(SELECT FROM embedding_private.reservations WHERE state<>'released') THEN RAISE EXCEPTION 'charges/attempts retained'; END IF;
END $proof$;
ROLLBACK;
"""
runpy.run_path('tests/integration/helpers/embedding-complete-chains.py')['check_chains'](__file__, 29, proof)
