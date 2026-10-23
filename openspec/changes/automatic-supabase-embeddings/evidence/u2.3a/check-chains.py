"""U2.3a semantic proof after each independent complete fresh migration chain."""
import runpy
proof = """BEGIN;
SELECT embedding_private.activate();
UPDATE embedding_private.control SET claims_enabled=true;
INSERT INTO users(id,privy_did) VALUES('00000000-0000-4000-8000-000000000001','did:fixture:recovery');
INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana','ana','fixture',now());
INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES('00000000-0000-4000-8000-000000000001','Ana es mi hija',now());
DO $proof$
DECLARE run uuid; j record; next_generation bigint;
BEGIN
  IF (SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE proname IN ('embedding_fail','embedding_retry') AND prosecdef AND (r.rolsuper OR r.rolbypassrls) AND proconfig=ARRAY['search_path=pg_catalog, extensions','row_security=off'])<>2 THEN RAISE EXCEPTION 'definer'; END IF;
  IF EXISTS (SELECT FROM pg_proc p,LATERAL aclexplode(p.proacl) a WHERE proname IN ('embedding_fail','embedding_retry') AND a.grantee=0) THEN RAISE EXCEPTION 'PUBLIC grant'; END IF;
  IF has_function_privilege('embedding_worker','public.embedding_retry(text,uuid,uuid,bigint)','EXECUTE') OR has_schema_privilege('embedding_worker','embedding_private','USAGE') THEN RAISE EXCEPTION 'worker overgrant'; END IF;
  SELECT run_token INTO STRICT run FROM public.embedding_begin_drain();
  FOR j IN SELECT * FROM public.embedding_claim_jobs(run,4) LOOP
    IF public.embedding_fail(j.job_id,j.owner_id,j.kind,j.source_id,j.incarnation,j.generation,j.revision,j.claim_token,'invalid_input',NULL)<>'applied' THEN RAISE EXCEPTION 'failure not applied'; END IF;
    IF NOT EXISTS (SELECT FROM embedding_private.jobs WHERE id=j.job_id AND state='failed' AND error_code='invalid_input') THEN RAISE EXCEPTION 'terminal job'; END IF;
    next_generation := public.embedding_retry(j.kind,j.owner_id,j.source_id,j.generation);
    IF next_generation IS DISTINCT FROM j.generation+1 THEN RAISE EXCEPTION 'retry generation'; END IF;
    IF public.embedding_retry(j.kind,j.owner_id,j.source_id,j.generation) IS NOT NULL THEN RAISE EXCEPTION 'retry replay'; END IF;
    IF public.embedding_fail(j.job_id,j.owner_id,j.kind,j.source_id,j.incarnation,j.generation,j.revision,j.claim_token,'provider_timeout',NULL)<>'stale' THEN RAISE EXCEPTION 'old failure'; END IF;
    IF NOT EXISTS (SELECT FROM embedding_private.jobs WHERE kind=j.kind AND source_id=j.source_id AND generation=next_generation AND state='pending' AND attempts=0) THEN RAISE EXCEPTION 'new work'; END IF;
  END LOOP;
  IF (SELECT count(*) FROM embedding_private.jobs)<>4 THEN RAISE EXCEPTION 'both domains nonvacuity'; END IF;
END $proof$;
ROLLBACK;
"""
runpy.run_path('tests/integration/helpers/embedding-complete-chains.py')['check_chains'](__file__, 25, proof)
