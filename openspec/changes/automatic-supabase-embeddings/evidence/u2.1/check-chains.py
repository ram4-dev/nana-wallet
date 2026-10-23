"""U2.1 isolated complete-chain proof; no remote transport or env-file loading."""
import hashlib, json, os, pathlib, subprocess, uuid
root = pathlib.Path(__file__).resolve().parent
container = 'nana-auto-embedding-db-1'
records = []
def digest(data): return hashlib.sha256(data).hexdigest()
def call(argv, sql=None, source=None, env=None):
    result = subprocess.run(argv, input=sql, capture_output=True, text=True, env=env, timeout=60)
    output = result.stdout + result.stderr
    with (root / 'chains.log').open('a') as log: log.write(json.dumps(argv) + '\n' + output)
    records.append(dict(argv=argv, stdin_path=source, stdin_sha256=digest(sql.encode()) if sql else None,
                        environment_overrides={k: env[k] for k in ['DATABASE_URL', 'DOTENV_CONFIG_PATH', 'EVAL_REAL']} if env else {},
                        exit_code=result.returncode, output_sha256=digest(output.encode())))
    (root / 'chain-commands.json').write_text(json.dumps(records, indent=2) + '\n')
    assert result.returncode == 0, output
    return result.stdout
for chain in ['supabase', 'mirror']:
    name = 'embedding_u21_' + chain + '_' + uuid.uuid4().hex[:12]
    def psql(sql, database=name, source=None):
        return call(['docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'], sql, source)
    psql('CREATE DATABASE "' + name + '" TEMPLATE template0;', 'postgres')
    try:
        if chain == 'supabase': psql('CREATE SCHEMA extensions;')
        psql(pathlib.Path('supabase/roles.sql').read_text(), source='supabase/roles.sql')
        directory = pathlib.Path('supabase/migrations' if chain == 'supabase' else 'src/db/migrations')
        files = sorted(directory.glob('*.sql')); assert len(files) == 23
        if chain == 'supabase':
            for path in files:
                output = psql(path.read_text() + '\nSHOW search_path;', source=str(path))
                assert output.strip().splitlines()[-1] == '"$user", public'
        else:
            env = dict(os.environ, DATABASE_URL='postgres://postgres@127.0.0.1:55544/' + name, DOTENV_CONFIG_PATH='/dev/null', EVAL_REAL='0')
            call(['npm', 'run', 'db:migrate'], env=env)
            assert psql('SELECT count(*) FROM schema_migrations;').strip() == '23'
        proof = """DO $proof$ BEGIN
IF EXISTS (SELECT FROM embedding_private.control WHERE activated OR claims_enabled OR semantic_enabled) OR EXISTS (SELECT FROM embedding_private.jobs) THEN RAISE EXCEPTION 'dormancy'; END IF;
IF (SELECT count(*) FROM pg_class WHERE oid IN ('public.recipients'::regclass,'public.user_memories'::regclass) AND relrowsecurity AND relforcerowsecurity)<>2 THEN RAISE EXCEPTION 'RLS'; END IF;
IF (SELECT count(*) FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE pronamespace='public'::regnamespace AND proname IN ('embedding_begin_drain','embedding_claim_jobs','embedding_read_job') AND prosecdef AND (r.rolsuper OR r.rolbypassrls) AND proconfig=ARRAY['search_path=pg_catalog, extensions','row_security=off'])<>3 THEN RAISE EXCEPTION 'definer'; END IF;
IF EXISTS (SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE proname IN ('embedding_begin_drain','embedding_claim_jobs','embedding_read_job') AND a.grantee=0) THEN RAISE EXCEPTION 'PUBLIC'; END IF;
IF has_schema_privilege('embedding_worker','embedding_private','USAGE') OR has_table_privilege('embedding_worker','public.recipients','SELECT,INSERT,UPDATE,DELETE') OR has_table_privilege('embedding_worker','public.user_memories','SELECT,INSERT,UPDATE,DELETE') THEN RAISE EXCEPTION 'worker overgrant'; END IF;
IF (SELECT count(*) FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('recipients','user_memories') AND column_name IN ('embedding','embedding_model_revision') AND is_nullable='YES')<>4 THEN RAISE EXCEPTION 'nullable'; END IF;
IF EXISTS (SELECT FROM public.embedding_begin_drain()) THEN RAISE EXCEPTION 'disabled run'; END IF;
END $proof$;
SELECT version(); SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE extname='vector'; SHOW search_path;
"""
        output = psql(proof)
        assert output.strip().splitlines()[-2:] == [('extensions' if chain == 'supabase' else 'public'), '"$user", public']
    finally: psql('DROP DATABASE "' + name + '";', 'postgres')
print('PASS: two independent complete 23-migration chains; default paths, dormancy, RLS and least-privilege definers; scratch DBs dropped.')
