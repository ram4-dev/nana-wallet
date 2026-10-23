"""Run independent default-path full chains and stage-specific real SQL proof."""
import hashlib
import json
import os
import pathlib
import subprocess
import uuid


def check_chains(driver, expected_count, proof):
    output_dir = pathlib.Path(driver).resolve().parent
    container = os.environ['EMBEDDINGS_TEST_CONTAINER']
    records = []
    def call(argv, sql=None, source=None, env=None):
        result = subprocess.run(argv, input=sql, capture_output=True, text=True, env=env, timeout=60)
        output = result.stdout + result.stderr
        with (output_dir / 'chains.log').open('a') as log:
            log.write(json.dumps(argv) + '\n' + output)
        records.append(dict(argv=argv, stdin_path=source, stdin_sha256=hashlib.sha256(sql.encode()).hexdigest() if sql else None,
                            environment_overrides={k: env[k] for k in ['DATABASE_URL', 'DOTENV_CONFIG_PATH', 'EVAL_REAL']} if env else {},
                            exit_code=result.returncode, output_sha256=hashlib.sha256(output.encode()).hexdigest()))
        (output_dir / 'chain-commands.json').write_text(json.dumps(records, indent=2) + '\n')
        assert result.returncode == 0, output
        return result.stdout
    for chain in ['supabase', 'mirror']:
        name = 'embedding_chain_' + uuid.uuid4().hex
        def psql(sql, database=name, source=None):
            return call(['docker', 'exec', '-i', container, 'psql', '-U', 'postgres', '-d', database, '-v', 'ON_ERROR_STOP=1', '-At'], sql, source)
        psql('CREATE DATABASE "' + name + '" TEMPLATE template0;', 'postgres')
        try:
            if chain == 'supabase':
                psql('CREATE SCHEMA extensions;')
            psql(pathlib.Path('supabase/roles.sql').read_text(), source='supabase/roles.sql')
            directory = pathlib.Path('supabase/migrations' if chain == 'supabase' else 'src/db/migrations')
            files = sorted(directory.glob('*.sql'))
            assert len(files) == expected_count
            if chain == 'supabase':
                for path in files:
                    assert psql(path.read_text() + '\nSHOW search_path;', source=str(path)).strip().splitlines()[-1] == '"$user", public'
            else:
                env = dict(os.environ, DATABASE_URL='postgres://postgres@127.0.0.1:55544/' + name, DOTENV_CONFIG_PATH='/dev/null', EVAL_REAL='0')
                call(['npm', 'run', 'db:migrate'], env=env)
                assert psql('SELECT count(*) FROM schema_migrations;').strip() == str(expected_count)
            assert psql('SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE extname=\'vector\'; SHOW search_path;').strip().splitlines() == [('extensions' if chain == 'supabase' else 'public'), '"$user", public']
            psql("DO $$ BEGIN IF EXISTS (SELECT FROM embedding_private.control WHERE activated OR claims_enabled OR semantic_enabled) OR EXISTS (SELECT FROM embedding_private.jobs) THEN RAISE EXCEPTION 'dormancy'; END IF; END $$;")
            psql(proof, source=str(pathlib.Path(driver)))
            print('PASS', chain, expected_count, 'migrations and stage runtime proof')
        finally:
            psql('DROP DATABASE "' + name + '";', 'postgres')
