import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chains, claimsNames, completionNames, recoveryNames, capacityNames, admissionNames, attemptsNames, embeddingDatabase } from './helpers/embedding-database.js';

const identity = ['job_id', 'kind', 'owner_id', 'source_id', 'incarnation', 'generation', 'revision'];
const signatures = ['embedding_begin_drain()', 'embedding_claim_jobs(uuid,integer)', 'embedding_read_job(uuid,uuid)'];
it.each(chains)('T4 atomic start publication under default psql autocommit: %s', async (chain) => {
  const f = await embeddingDatabase(chain);
  try {
    for (const apply of [f.applyFoundation, f.applyOutbox, f.applyLifecycle, f.applyProtection, f.applyClaims,
      f.applyCompletion, f.applyRecovery, f.applyCapacity, f.applyAdmission]) await apply();
    const sql = await readFile(`${chain === 'supabase' ? 'supabase/migrations' : 'src/db/migrations'}/${attemptsNames[chain]}`, 'utf8');
    const marker = '  REVOKE ALL ON FUNCTION public.embedding_start_attempt(uuid,uuid,uuid),public.embedding_start_query(uuid,integer) FROM PUBLIC;';
    expect(sql.split(marker)).toHaveLength(2);
    const snapshot = () => f.migration.query(`SELECT p.oid,p.proacl,CASE WHEN p.prokind='a' THEN p.prosrc ELSE pg_get_functiondef(p.oid) END AS definition
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname IN ('public','embedding_private') ORDER BY p.oid`);
    const before = (await snapshot()).rows;
    expect(() => f.psql(sql.replace(marker, "  RAISE EXCEPTION 'injected pregrant failure';\n" + marker))).toThrow('injected pregrant failure');
    expect((await f.migration.query(`SELECT to_regprocedure('public.embedding_start_attempt(uuid,uuid,uuid)') AS drain,
      to_regprocedure('public.embedding_start_query(uuid,integer)') AS query`)).rows).toEqual([{ drain: null, query: null }]);
    expect((await snapshot()).rows).toEqual(before);
  } finally { await f.cleanup(); }
}, 30_000);
describe.each(chains)('U2.1 real claim/read RPCs: %s', (chain) => {
  let fixture: Awaited<ReturnType<typeof embeddingDatabase>>;
  let serviceOwned = false;
  beforeAll(async () => {
    fixture = await embeddingDatabase(chain);
    const m = fixture.migration;
    serviceOwned = !(await m.query("SELECT FROM pg_roles WHERE rolname='service_role'")).rowCount;
    if (serviceOwned) await m.query('CREATE ROLE service_role NOLOGIN');
    await fixture.applyFoundation(); await fixture.applyOutbox(); await fixture.applyLifecycle(); await fixture.applyProtection();
    await fixture.applyClaims(); await fixture.applyCompletion(); await fixture.applyRecovery(); await fixture.applyCapacity(); await fixture.applyAdmission(); await fixture.applyAttempts();
  }, 30_000);
  afterAll(async () => {
    await fixture?.cleanup();
    if (serviceOwned) {
      const { Client } = await import('pg');
      const url = new URL((process.env.EMBEDDINGS_TEST_DATABASE_URL ?? process.env.DATABASE_URL)!); url.pathname = '/postgres';
      const admin = new Client({ connectionString: url.href }); await admin.connect();
      try { await admin.query('DROP ROLE service_role'); } finally { await admin.end(); }
    }
  });
  beforeEach(async () => { await fixture.migration.query('BEGIN'); });
  afterEach(async () => { publicCapacity = false; await fixture.migration.query('ROLLBACK'); });
  const roleQuery = async (role: string, sql: string, args: unknown[] = []) => {
    const m = fixture.migration; await m.query('SAVEPOINT rpc_role');
    try { await m.query(`SET LOCAL ROLE ${role}`); const result = await m.query(sql, args); await m.query('RESET ROLE'); return result.rows; }
    catch (error) { await m.query('ROLLBACK TO rpc_role'); throw error; }
    finally { await m.query('RELEASE rpc_role'); }
  };
  const worker = (sql: string, args: unknown[] = []) => roleQuery('embedding_worker', sql, args);
  const enable = async () => {
    const m = fixture.migration;
    await m.query('SELECT embedding_private.activate()');
    await m.query('UPDATE embedding_private.control SET claims_enabled=true');
    for (const name of ['Sofía', 'Ana']) {
      const owner = randomUUID(); await m.query('INSERT INTO users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
      for (let i = 0; i < 3; i++) await m.query(`INSERT INTO recipients(user_id,name,normalized_name,description,address,address_confirmed_at,provenance)
        VALUES($1,$2,$2,'Mi hija','dedicated-secret-address',now(),'{"private":"excluded"}')`, [owner, `${name}${i}`]);
      await m.query("INSERT INTO user_memories(user_id,fact,confirmed_at,provenance) VALUES($1,$2,now(),'{\"private\":\"excluded\"}')", [owner, `${name} es mi hija`]);
    }
    await expect.poll(async () => (await m.query('SELECT clock_timestamp()>=now() AS due')).rows[0].due).toBe(true);
    return (await worker('SELECT * FROM public.embedding_begin_drain()'))[0].run_token;
  };
  const claim = (run: string, limit = 4) => worker('SELECT * FROM public.embedding_claim_jobs($1,$2)', [run, limit]);
  const read = (job: Record<string, unknown>) => worker('SELECT * FROM public.embedding_read_job($1,$2)', [job.job_id, job.claim_token]);

  it('keeps dormant defaults and refuses disabled, paused, invalid or duplicate runs', async () => {
    const m = fixture.migration;
    expect((await m.query('SELECT activated,claims_enabled,semantic_enabled FROM embedding_private.control')).rows[0])
      .toEqual({ activated: false, claims_enabled: false, semantic_enabled: false });
    expect(await worker('SELECT * FROM public.embedding_begin_drain()')).toEqual([]);
    expect(await roleQuery('service_role', 'SELECT * FROM public.embedding_begin_drain()')).toEqual([]);
    const run = await enable();
    expect(await worker('SELECT * FROM public.embedding_begin_drain()')).toEqual([]);
    expect(await claim(randomUUID())).toEqual([]);
    for (const limit of [0, -1, null]) expect(await worker('SELECT * FROM public.embedding_claim_jobs($1,$2)', [run, limit])).toEqual([]);
    await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()-interval '1 second',pause_code='provider_auth'");
    expect(await worker('SELECT * FROM public.embedding_begin_drain()')).toEqual([]);
    expect(await claim(run)).toEqual([]);
  });

  it('caps claims at four without duplicates, source writes or spending provider attempts', async () => {
    const run = await enable(); const m = fixture.migration;
    const before = (await m.query('SELECT to_jsonb(r) AS data FROM recipients r UNION ALL SELECT to_jsonb(f) FROM user_memories f')).rows;
    await m.query('SET LOCAL search_path=pg_temp,public,extensions');
    const first = await claim(run, 100); const second = await claim(run, 100);
    expect(first).toHaveLength(4); expect(second).toHaveLength(4); expect(await claim(run)).toEqual([]);
    expect(new Set([...first, ...second].map((j) => j.job_id)).size).toBe(8);
    expect(Object.keys(first[0]).sort()).toEqual([...identity, 'claim_token', 'lease_until'].sort());
    expect((await m.query('SELECT DISTINCT attempts FROM embedding_private.jobs')).rows).toEqual([{ attempts: 0 }]);
    expect((await m.query('SELECT to_jsonb(r) AS data FROM recipients r UNION ALL SELECT to_jsonb(f) FROM user_memories f')).rows).toEqual(before);
    expect((await m.query("SELECT bool_and(lease_until>clock_timestamp() AND lease_until<=clock_timestamp()+interval '90 seconds') AS bounded FROM embedding_private.jobs")).rows[0].bounded).toBe(true);
  });

  it('projects actual owner text only and fences every source tuple field in one read', async () => {
    const run = await enable(); const m = fixture.migration;
    const jobs = [...await claim(run), ...await claim(run)];
    for (const job of jobs) {
      const table = job.kind === 'recipient' ? 'recipients' : 'user_memories';
      const source = (await m.query(`SELECT * FROM ${table} WHERE id=$1`, [job.source_id])).rows[0];
      await m.query("SELECT set_config('app.user_id',$1,true)", [randomUUID()]);
      expect(await read(job)).toEqual([{ ...Object.fromEntries(identity.map((key) => [key, job[key]])),
        name: source.name ?? null, description: source.description ?? null, fact: source.fact ?? null }]);
      for (const [column, value] of [['kind', job.kind === 'recipient' ? 'fact' : 'recipient'], ['owner_id', randomUUID()], ['source_id', randomUUID()], ['incarnation', randomUUID()], ['generation', '99'], ['revision', 'forged']]) {
        await m.query('SAVEPOINT forged'); await m.query(`UPDATE embedding_private.jobs SET ${column}=$2 WHERE id=$1`, [job.job_id, value]);
        expect(await read(job)).toEqual([]); await m.query('ROLLBACK TO forged'); await m.query('RELEASE forged');
      }
      expect(await read({ ...job, claim_token: randomUUID() })).toEqual([]);
      await m.query('SAVEPOINT deleted'); await m.query(`DELETE FROM ${table} WHERE id=$1`, [job.source_id]);
      expect(await read(job)).toEqual([]); await m.query('ROLLBACK TO deleted'); await m.query('RELEASE deleted');
      for (const change of ["status='inactive'", job.kind === 'recipient' ? "description='changed'" : "fact='changed'", "desired_embedding_revision='forged'"]) {
        await m.query('SAVEPOINT changed'); await m.query(`UPDATE ${table} SET ${change} WHERE id=$1`, [job.source_id]);
        expect(await read(job)).toEqual([]); await m.query('ROLLBACK TO changed'); await m.query('RELEASE changed');
      }
    }
  });

  it('refuses expired tokens and runs, rotating tokens on reclaim without consuming attempts', async () => {
    const run = await enable(); const m = fixture.migration; const [job] = await claim(run, 1);
    await m.query("UPDATE embedding_private.jobs SET available_at=clock_timestamp()+interval '1 hour' WHERE id<>$1", [job.job_id]);
    await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.job_id]);
    expect(await read(job)).toEqual([]);
    const [reclaimed] = await claim(run, 1); expect(reclaimed.job_id).toBe(job.job_id); expect(reclaimed.claim_token).not.toBe(job.claim_token);
    expect(await read(job)).toEqual([]); expect(await read(reclaimed)).toHaveLength(1);
    await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()-interval '1 second'");
    expect(await read(reclaimed)).toEqual([]); expect(await claim(run)).toEqual([]);
    const [next] = await worker('SELECT * FROM public.embedding_begin_drain()'); expect(next.run_token).not.toBe(run);
    expect(await read(reclaimed)).toEqual([]);
    await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [job.job_id]);
    const [current] = await claim(next.run_token, 1); expect(await read(current)).toHaveLength(1);
    expect((await m.query('SELECT attempts FROM embedding_private.jobs WHERE id=$1', [job.job_id])).rows[0].attempts).toBe(0);
  });

  it('enforces definer ownership, fixed search path and least-privilege RPC grants', async () => {
    await enable(); const m = fixture.migration;
    for (const signature of signatures) {
      const [config] = (await m.query(`SELECT p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls AS bypass
        FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.oid=$1::regprocedure`, [`public.${signature}`])).rows;
      expect(config).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, extensions', 'row_security=off'], bypass: true });
      expect((await m.query(`SELECT FROM pg_proc p,LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid=$1::regprocedure AND a.grantee=0`, [`public.${signature}`])).rowCount).toBe(0);
      expect((await m.query("SELECT has_function_privilege('service_role',$1,'EXECUTE') AS allowed", [`public.${signature}`])).rows[0].allowed).toBe(true);
    }
    for (const role of ['embedding_worker', 'service_role', 'recipient_app', 'anon', 'authenticated', 'embedding_probe_public']) {
      if (!(await m.query('SELECT FROM pg_roles WHERE rolname=$1', [role])).rowCount) await m.query(`CREATE ROLE ${role} NOLOGIN`);
      if (!['embedding_worker', 'service_role'].includes(role)) for (const sql of ['SELECT public.embedding_begin_drain()',
        `SELECT public.embedding_claim_jobs('${randomUUID()}',4)`, `SELECT public.embedding_read_job('${randomUUID()}','${randomUUID()}')`]) {
        await expect(roleQuery(role, sql)).rejects.toMatchObject({ code: '42501' });
      }
      for (const sql of ['SELECT * FROM embedding_private.jobs', 'UPDATE recipients SET embedding_state=\'ready\'', 'SELECT * FROM embedding_private.control']) {
        await expect(roleQuery(role, sql)).rejects.toMatchObject({ code: '42501' });
      }
    }
    await expect(roleQuery('recipient_app', await readFile(`src/db/migrations/${claimsNames.mirror}`, 'utf8'))).rejects.toMatchObject({ code: '42501' });
    expect((await m.query("SELECT rolcanlogin,rolsuper,rolbypassrls FROM pg_roles WHERE rolname='embedding_worker'")).rows[0])
      .toEqual({ rolcanlogin: false, rolsuper: false, rolbypassrls: false });
    expect(await readFile(`supabase/migrations/${claimsNames.supabase}`, 'utf8')).toBe(await readFile(`src/db/migrations/${claimsNames.mirror}`, 'utf8'));
  });


  // U2.2 T5/T6/T11: real completions; all mutations stay inside rollback-only fixtures.
  const vector = JSON.stringify([1, ...Array(383).fill(0)]);
  const complete = (j: Record<string, unknown>, v: string | null = vector, role = 'embedding_worker') => roleQuery(role,
    'SELECT public.embedding_complete($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',
    [j.job_id, j.owner_id, j.kind, j.source_id, j.incarnation, j.generation, j.revision, j.claim_token, v]);
  const fail = (j: Record<string, unknown>, code: string | null = 'provider_timeout', retry: number | null = null, role = 'embedding_worker') => roleQuery(role,
    'SELECT public.embedding_fail($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) AS result',
    [j.job_id,j.owner_id,j.kind,j.source_id,j.incarnation,j.generation,j.revision,j.claim_token,code,retry]);
  const snapshot = async () => {
    const rows = [];
    for (const t of ['recipients','user_memories','embedding_private.jobs','recipient_versions','recipient_policy_state',
      'recipient_policy_sync_intent','contact_action_proposals','recipient_policy_audit','signer_grants','delegated_grants','grant_claim_ledger','grant_audit_log']) {
      rows.push((await fixture.migration.query(`SELECT to_jsonb(t) AS data FROM ${t} t ORDER BY to_jsonb(t)::text`)).rows);
    }
    return rows;
  };
  const selected = async (kind: string) => {
    const run = await enable(); const jobs = [...await claim(run), ...await claim(run)];
    return { run, job: jobs.find((j) => j.kind === kind)! };
  };

  it.each(['recipient','fact'])('T11 %s: atomically completes once with unchanged business/history/policy/grants/attempts', async (kind) => {
    const { job } = await selected(kind); const m = fixture.migration; const wallet = randomUUID();
    const table = kind === 'recipient' ? 'recipients' : 'user_memories';
    await m.query("INSERT INTO user_wallets(id,user_id,provider,provider_wallet_id,chain_family,address) VALUES($1,$2,'fixture',$3,'solana','fixture')", [wallet, job.owner_id, wallet]);
    await m.query('INSERT INTO recipient_policy_state(wallet_id,user_id) VALUES($1,$2)', [wallet, job.owner_id]);
    await m.query('INSERT INTO recipient_versions(recipient_id,user_id,version,name,description,address) SELECT id,user_id,version,name,description,address FROM recipients');
    const before = await snapshot();
    await m.query("ALTER TABLE embedding_private.jobs ADD CONSTRAINT fixture_no_completion CHECK (state<>'done') NOT VALID");
    await expect(complete(job)).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot()).toEqual(before);
    await m.query('ALTER TABLE embedding_private.jobs DROP CONSTRAINT fixture_no_completion');
    await m.query('SAVEPOINT completed');
    await m.query('SET LOCAL search_path=pg_temp,public,extensions');
    expect(await complete(job, vector, 'service_role')).toEqual([{ result: 'applied' }]);
    const after = await snapshot(); const source = (await m.query(`SELECT * FROM ${table} WHERE id=$1`, [job.source_id])).rows[0];
    expect(source).toMatchObject({ embedding: vector, embedding_model_revision: job.revision, embedding_state: 'ready', embedding_generation: job.generation });
    for (let i = 0; i < 2; i++) expect(after[i]).toEqual(before[i].map(({ data }) => ({ data: data.id === job.source_id
      ? { ...data, embedding: vector, embedding_model_revision: job.revision, embedding_state: 'ready' } : data })));
    expect(after.slice(3)).toEqual(before.slice(3));
    expect((await m.query('SELECT state,claim_token,lease_until,attempts FROM embedding_private.jobs WHERE id=$1', [job.job_id])).rows[0])
      .toEqual({ state: 'done', claim_token: null, lease_until: null, attempts: 0 });
    expect(after[2]).toHaveLength(before[2].length);
    expect(after[2].filter(({ data }) => data.id !== job.job_id)).toEqual(before[2].filter(({ data }) => data.id !== job.job_id));
    expect(await complete(job)).toEqual([{ result: 'stale' }]); expect(await snapshot()).toEqual(after);
    await m.query('ROLLBACK TO completed'); expect(await snapshot()).toEqual(before);
    // Completion consumes no attempts; admission/start accounting belongs to U2.3.
    await m.query('UPDATE embedding_private.jobs SET attempts=5 WHERE id=$1', [job.job_id]);
    expect(await complete(job)).toEqual([{ result: 'applied' }]);
    expect((await m.query('SELECT attempts FROM embedding_private.jobs WHERE id=$1', [job.job_id])).rows[0].attempts).toBe(5);
  });

  it.each(['recipient','fact'])('T5/T6 %s: rejects every forged tuple/token and invalid vector without mutations', async (kind) => {
    const { job } = await selected(kind); const before = await snapshot();
    for (const [field, value] of [['job_id', randomUUID()], ['owner_id', randomUUID()], ['kind', kind === 'fact' ? 'recipient' : 'fact'],
      ['kind','arbitrary'], ['source_id',randomUUID()], ['incarnation',randomUUID()], ['generation','99'], ['revision','forged'], ['claim_token',randomUUID()]]) {
      expect(await complete({ ...job, [field]: value })).toEqual([{ result: 'stale' }]);
      expect(await complete({ ...job, [field]: null })).toEqual([{ result: 'stale' }]);
      expect(await fail({ ...job, [field]: value })).toEqual([{ result: 'stale' }]);
      expect(await fail({ ...job, [field]: null })).toEqual([{ result: 'stale' }]);
      expect(await snapshot()).toEqual(before);
    }
    for (const invalid of [null, '[1,0]', JSON.stringify(Array(384).fill(0)), JSON.stringify([2,...Array(383).fill(0)]),
      ...['NaN','Infinity','-Infinity'].map((n) => `[${n},${Array(383).fill(0).join(',')}]`)]) {
      await expect(complete(job, invalid)).rejects.toBeDefined(); expect(await snapshot()).toEqual(before);
    }
    expect(await complete(job)).toEqual([{ result: 'applied' }]);
  });

  it.each(['recipient','fact'])('T5/T6 %s: fences edits, archive/reactivation, deletion/reinsert, expired/replaced run/job leases', async (kind) => {
    const { job, run } = await selected(kind); const m = fixture.migration;
    const table = kind === 'recipient' ? 'recipients' : 'user_memories';
    const changes = [kind === 'recipient' ? "description='edited'" : "fact='edited'", "status='inactive'", "desired_embedding_revision='forged'"];
    const mutations = [...changes.map((s) => `UPDATE ${table} SET ${s} WHERE id='${job.source_id}'`),
      `UPDATE ${table} SET status='inactive' WHERE id='${job.source_id}'; UPDATE ${table} SET status='active' WHERE id='${job.source_id}'`,
      `DELETE FROM ${table} WHERE id='${job.source_id}'`,
      `DELETE FROM ${table} WHERE id='${job.source_id}'; INSERT INTO ${table}(id,user_id,${kind === 'recipient' ? 'name,normalized_name,description,address,address_confirmed_at' : 'fact,confirmed_at'}) VALUES('${job.source_id}','${job.owner_id}',${kind === 'recipient' ? "'Ana','ana','Hermana','fixture',now()" : "'Ana es mi hermana',now()"})`,
      `UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id='${job.job_id}'`,
      `UPDATE embedding_private.jobs SET claim_token=gen_random_uuid() WHERE id='${job.job_id}'`,
      "UPDATE embedding_private.control SET run_until=clock_timestamp()-interval '1 second'",
      'UPDATE embedding_private.control SET run_token=gen_random_uuid()',
      'UPDATE embedding_private.control SET claims_enabled=false', "UPDATE embedding_private.control SET pause_code='provider_auth'"];
    for (const sql of mutations) {
      await m.query('SAVEPOINT late'); await m.query(sql); const before = await snapshot();
      expect(await complete(job)).toEqual([{ result: 'stale' }]);
      expect(await fail(job)).toEqual([{ result: 'stale' }]); expect(await snapshot()).toEqual(before);
      await m.query('ROLLBACK TO late'); await m.query('RELEASE late');
    }
    await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second',available_at=clock_timestamp()-interval '1 hour' WHERE id=$1", [job.job_id]);
    const [reclaimed] = await claim(run, 1); expect(reclaimed.job_id).toBe(job.job_id);
    expect(reclaimed.claim_token).not.toBe(job.claim_token); expect(await complete(job)).toEqual([{ result: 'stale' }]);
    expect(await fail(job)).toEqual([{ result: 'stale' }]);
    expect(await complete(reclaimed)).toEqual([{ result: 'applied' }]);
  });

  it('U2.2 keeps definer/search-path and narrow worker/service grants, refusing all client roles', async () => {
    const { job } = await selected('recipient'); const m = fixture.migration;
    const [config] = (await m.query(`SELECT p.prosecdef,p.proconfig,r.rolsuper OR r.rolbypassrls AS bypass,
      EXISTS(SELECT FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS public_execute
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE p.proname='embedding_complete'`)).rows;
    expect(config).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, extensions','row_security=off'], bypass: true, public_execute: false });
    for (const role of ['recipient_app','anon','authenticated','embedding_probe_public']) {
      if (!(await m.query('SELECT FROM pg_roles WHERE rolname=$1', [role])).rowCount) await m.query(`CREATE ROLE ${role} NOLOGIN`);
      await expect(complete(job, vector, role)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await readFile(`supabase/migrations/${completionNames.supabase}`, 'utf8')).toBe(await readFile(`src/db/migrations/${completionNames.mirror}`, 'utf8'));
  });


  it.each(['recipient','fact'].flatMap((kind) => ['complete','fail'].map((operation) => ({ kind, operation }))))('T6 $kind/$operation: source-first locks and expiry after waits', async ({ kind, operation }) => {
    const runtime = await embeddingDatabase(chain); const m = runtime.migration;
    try {
      await runtime.applyFoundation(); await runtime.applyOutbox(); await runtime.applyLifecycle(); await runtime.applyProtection();
      await runtime.applyClaims(); await runtime.applyCompletion(); await runtime.applyRecovery(); await m.query('SELECT embedding_private.activate()');
      await m.query('UPDATE embedding_private.control SET claims_enabled=true');
      const owner = randomUUID(); await m.query('INSERT INTO users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
      const table = kind === 'recipient' ? 'recipients' : 'user_memories';
      const fields = kind === 'recipient' ? "name,normalized_name,description,address,address_confirmed_at) VALUES($1,'Ana','ana','Hermana','fixture',now())"
        : "fact,confirmed_at) VALUES($1,'Ana es mi hermana',now())";
      const [run] = (await m.query('SELECT * FROM public.embedding_begin_drain()')).rows;
      for (const barrier of ['source','control',...(operation === 'fail' ? ['job_lease','source_lease'] : [])]) {
        await m.query(`INSERT INTO ${table}(user_id,${fields}`, [owner]);
        await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()+interval '90 seconds'");
        const [j] = (await m.query('SELECT * FROM public.embedding_claim_jobs($1,1)', [run.run_token])).rows;
        if (barrier === 'control') await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()+interval '500 milliseconds'");
        if (barrier.endsWith('_lease')) await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()+interval '500 milliseconds' WHERE id=$1", [j.job_id]);
        await m.query('BEGIN'); await m.query("SET LOCAL lock_timeout='100ms'");
        await m.query(barrier === 'job_lease' ? `SELECT FROM embedding_private.jobs WHERE id='${j.job_id}' FOR UPDATE` : barrier !== 'control' ? `SELECT FROM ${table} WHERE id='${j.source_id}' FOR UPDATE` : 'SELECT FROM embedding_private.control FOR UPDATE');
        const result = runtime.database.withUserTransactionAnonymous(async (c) => {
          await c.query('SET LOCAL ROLE embedding_worker'); await c.query("SET LOCAL statement_timeout='3s'");
          return (await c.query(`SELECT public.embedding_${operation}($1,$2,$3,$4,$5,$6,$7,$8,${operation === 'fail' ? '$9,$10' : '$9'}) AS result`,
            [j.job_id,j.owner_id,j.kind,j.source_id,j.incarnation,j.generation,j.revision,j.claim_token,...(operation === 'fail' ? ['invalid_input',null] : [vector])])).rows;
        });
        void result.catch(() => {});
        try {
          await expect.poll(async () => { await m.query('SELECT pg_stat_clear_snapshot()'); return (await m.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND wait_event_type='Lock' AND query LIKE 'SELECT public.embedding_%'")).rows[0].n; }).toBe(1);
          if (barrier === 'source') await m.query('SELECT FROM embedding_private.jobs WHERE id=$1 FOR UPDATE NOWAIT', [j.job_id]);
          else await expect.poll(async () => (await m.query(barrier === 'control' ? 'SELECT run_until<=clock_timestamp() AS expired FROM embedding_private.control' : 'SELECT lease_until<=clock_timestamp() AS expired FROM embedding_private.jobs WHERE id=$1', barrier === 'control' ? [] : [j.job_id])).rows[0].expired).toBe(true);
        } finally { await m.query('ROLLBACK'); }
        expect(await result).toEqual([{ result: barrier === 'source' ? 'applied' : 'stale' }]);
        expect((await m.query(`SELECT embedding_state FROM ${table} WHERE id=$1`, [j.source_id])).rows[0].embedding_state)
          .toBe(barrier === 'source' ? (operation === 'fail' ? 'failed' : 'ready') : 'pending');
      }
    } finally { await m.query('ROLLBACK'); await runtime.cleanup(); }
  }, 30_000);

  it.each(['recipient','fact'])('U2.3a T7/T11 %s: classified failure, bounded backoff, rollback and explicit retry', async (kind) => {
    const { job } = await selected(kind); const m = fixture.migration;
    const table = kind === 'recipient' ? 'recipients' : 'user_memories';
    await m.query('INSERT INTO recipient_versions(recipient_id,user_id,version,name,description,address) SELECT id,user_id,version,name,description,address FROM recipients');
    const wallet = randomUUID();
    await m.query("INSERT INTO user_wallets(id,user_id,provider,provider_wallet_id,chain_family,address) VALUES($1,$2,'fixture',$3,'solana','fixture')", [wallet,job.owner_id,wallet]);
    await m.query('INSERT INTO recipient_policy_state(wallet_id,user_id) VALUES($1,$2)', [wallet,job.owner_id]);
    const before = await snapshot();
    for (const code of [null,'raw provider body','attempts_exhausted','provider_auth','provider_quota','provider_config']) {
      await expect(fail(job, code)).rejects.toMatchObject({ code: '22023' }); expect(await snapshot()).toEqual(before);
    }
    // Fixture-authored counts classify failures only; real STARTED accounting belongs to c/e.
    for (const [code,attempt,retry,lower,upper] of [['provider_timeout',0,null,5,6],['provider_network',2,-20,10,12],
      ['provider_5xx',4,null,40,48],['provider_rate_limit',1,120,120,120],['provider_rate_limit',1,2147483647,300,300],
      ['invalid_input',1,null,0,0],['invalid_vector',1,null,0,0],['input_oversize',1,null,0,0],['provider_timeout',5,null,0,0]] as const) {
      await m.query('SAVEPOINT failure'); await m.query('UPDATE embedding_private.jobs SET attempts=$2 WHERE id=$1', [job.job_id,attempt]);
      expect(await fail(job,code,retry,'service_role')).toEqual([{ result: 'applied' }]);
      const terminal = upper === 0; const after = await snapshot();
      for (let i = 0; i < 2; i++) expect(after[i]).toEqual(before[i].map(({ data }) => ({ data: data.id === job.source_id
        ? { ...data, embedding_state: terminal ? 'failed' : 'pending' } : data })));
      expect(after.slice(3)).toEqual(before.slice(3)); expect(after[2]).toHaveLength(before[2].length);
      expect(after[2].filter(({ data }) => data.id !== job.job_id)).toEqual(before[2].filter(({ data }) => data.id !== job.job_id));
      const [state] = (await m.query('SELECT state,attempts,error_code,claim_token,lease_until,extract(epoch FROM available_at-updated_at)::float8 AS delay FROM embedding_private.jobs WHERE id=$1', [job.job_id])).rows;
      expect(state).toMatchObject({ state: terminal ? 'failed' : 'pending', attempts: attempt, error_code: attempt === 5 ? 'attempts_exhausted' : code, claim_token: null, lease_until: null });
      if (retry === null && !terminal) expect(state.delay).toBeGreaterThan(lower);
      if (!terminal) { expect(state.delay).toBeGreaterThanOrEqual(lower); expect(state.delay).toBeLessThanOrEqual(upper); }
      expect(await fail(job)).toEqual([{ result: 'stale' }]);
      await m.query('ROLLBACK TO failure'); await m.query('RELEASE failure'); expect(await snapshot()).toEqual(before);
    }
    await m.query("ALTER TABLE embedding_private.jobs ADD CONSTRAINT fixture_no_failure CHECK (state<>'failed') NOT VALID");
    await expect(fail(job,'invalid_input')).rejects.toMatchObject({ code: '23514' }); expect(await snapshot()).toEqual(before);
    await m.query('ALTER TABLE embedding_private.jobs DROP CONSTRAINT fixture_no_failure');
    const retry = (generation: unknown) => m.query('SELECT public.embedding_retry($1,$2,$3,$4) AS generation', [kind,job.owner_id,job.source_id,generation]);
    expect((await retry(job.generation)).rows[0].generation).toBeNull();
    await m.query('UPDATE embedding_private.jobs SET attempts=5 WHERE id=$1', [job.job_id]);
    expect(await fail(job,'provider_timeout')).toEqual([{ result: 'applied' }]);
    for (const args of [[kind,randomUUID(),job.source_id,job.generation],[kind,job.owner_id,randomUUID(),job.generation],[kind,job.owner_id,job.source_id,null],['unsupported',job.owner_id,job.source_id,job.generation]]) {
      expect((await m.query('SELECT public.embedding_retry($1,$2,$3,$4) AS generation', args)).rows[0].generation).toBeNull();
    }
    for (const change of ["status='inactive'","desired_embedding_revision='forged'"]) {
      await m.query('SAVEPOINT retry_stale'); await m.query(`UPDATE ${table} SET ${change} WHERE id=$1`, [job.source_id]);
      expect((await retry(job.generation)).rows[0].generation).toBeNull(); await m.query('ROLLBACK TO retry_stale'); await m.query('RELEASE retry_stale');
    }
    expect((await retry(Number(job.generation)+1)).rows[0].generation).toBeNull();
    expect((await retry(job.generation)).rows[0].generation).toBe(String(Number(job.generation)+1));
    expect((await retry(job.generation)).rows[0].generation).toBeNull(); expect(await fail(job)).toEqual([{ result: 'stale' }]);
    const source = (await m.query(`SELECT to_jsonb(s) AS data FROM ${table} s WHERE id=$1`, [job.source_id])).rows[0].data;
    expect(source).toEqual({ ...before[kind === 'recipient' ? 0 : 1].find(({ data }) => data.id === job.source_id)!.data, embedding_generation: Number(job.generation)+1 });
    const jobs = (await m.query('SELECT state,attempts FROM embedding_private.jobs WHERE source_id=$1 ORDER BY generation', [job.source_id])).rows;
    expect(jobs).toEqual([{ state: 'superseded', attempts: 5 },{ state: 'pending', attempts: 0 }]);
    expect((await snapshot()).slice(3)).toEqual(before.slice(3));
    const healthy = (await m.query("SELECT * FROM embedding_private.jobs WHERE id<>$1 AND state='leased' LIMIT 1", [job.job_id])).rows[0];
    expect(await complete({ ...healthy, job_id: healthy.id })).toEqual([{ result: 'applied' }]);
    await expect.poll(async () => (await m.query("SELECT bool_and(available_at<=clock_timestamp()) AS due FROM embedding_private.jobs WHERE state='pending'")).rows[0].due).toBe(true);
    const [fresh] = await claim((await m.query('SELECT run_token FROM embedding_private.control')).rows[0].run_token,1);
    expect(fresh.generation).toBe(String(Number(job.generation)+1));
    expect(await complete(job)).toEqual([{ result: 'stale' }]); expect(await complete(fresh)).toEqual([{ result: 'applied' }]);
  });

  it('U2.3a enforces worker failure/operator-only retry and byte parity', async () => {
    const { job } = await selected('fact'); const m = fixture.migration;
    for (const name of ['embedding_fail','embedding_retry']) {
      const [config] = (await m.query(`SELECT prosecdef,proconfig,r.rolsuper OR r.rolbypassrls AS bypass,
        EXISTS(SELECT FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS public_execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE proname=$1`, [name])).rows;
      expect(config).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, extensions','row_security=off'], bypass: true, public_execute: false });
    }
    for (const role of ['recipient_app','anon','authenticated','embedding_probe_public','embedding_worker','service_role']) {
      if (!(await m.query('SELECT FROM pg_roles WHERE rolname=$1', [role])).rowCount) await m.query(`CREATE ROLE ${role} NOLOGIN`);
      await expect(roleQuery(role,'SELECT public.embedding_retry($1,$2,$3,$4)', ['fact',job.owner_id,job.source_id,job.generation])).rejects.toMatchObject({ code: '42501' });
      if (!['embedding_worker','service_role'].includes(role)) await expect(fail(job,'invalid_input',null,role)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await readFile(`supabase/migrations/${recoveryNames.supabase}`, 'utf8')).toBe(await readFile(`src/db/migrations/${recoveryNames.mirror}`, 'utf8'));
  });

  // U2.3b1: operator-only capacity, not provider-call permission.
  let publicCapacity = false;
  const admissionSql = 'SELECT * FROM public.embedding_admit_request($1,$2,$3,$4)';
  const reserve = async (scope = 'query', bytes: number | null = 6000, owner: unknown = randomUUID(), job: Record<string, unknown> = {}) => {
    if (!publicCapacity) return (await roleQuery('postgres', 'SELECT * FROM embedding_private.reserve_request($1,$2,$3,$4,$5)', [scope,bytes,owner,job.job_id ?? null,job.claim_token ?? null]))[0];
    if (scope === 'query') {
      await fixture.migration.query('INSERT INTO users(id,privy_did) VALUES($1,$2) ON CONFLICT DO NOTHING', [owner,String(owner)]);
      await fixture.migration.query("SELECT set_config('app.user_id',$1,true)", [owner]);
    }
    return (await roleQuery(scope === 'query' ? 'recipient_app' : 'embedding_worker', admissionSql, [scope,bytes,job.job_id ?? null,job.claim_token ?? null]))[0];
  };
  const capacitySnapshot = async () => (await fixture.migration.query(`SELECT * FROM (SELECT to_jsonb(c) AS data FROM embedding_private.control c
    UNION ALL SELECT to_jsonb(r) FROM embedding_private.reservations r UNION ALL SELECT to_jsonb(o) FROM embedding_private.owner_minutes o) s ORDER BY data::text`)).rows;
  const expire = () => fixture.migration.query("UPDATE embedding_private.reservations SET expires_at=clock_timestamp()-interval '1 second'");
  const deferred = { status: 'deferred', reservation_id: null, expires_at: null };
  // Keep per-minute limit fixtures inside one real UTC minute; rollover has its own test.
  const minuteWindow = (m: typeof fixture.migration) => m.query("SELECT pg_sleep(CASE WHEN extract(second FROM clock_timestamp())>58 THEN 60-extract(second FROM clock_timestamp()) ELSE 0 END)");

  it('U2.3b1 validates input/control, atomically rolls back charges and restricts private capabilities', async () => {
    const m = fixture.migration; const before = await capacitySnapshot();
    expect(await reserve()).toEqual(deferred); expect(await capacitySnapshot()).toEqual(before); await enable();
    for (const [scope,bytes,owner,job] of [['other',1,randomUUID(),{}],['query',0,randomUUID(),{}],['query',6001,randomUUID(),{}],
      ['query',null,randomUUID(),{}],['query',1,null,{}],['query',1,randomUUID(),{ job_id: randomUUID() }],['drain',1,null,{}]] as const) {
      const state = await capacitySnapshot();
      await expect(reserve(scope,bytes,owner,job)).rejects.toMatchObject({ code: '22023' }); expect(await capacitySnapshot()).toEqual(state);
    }
    for (const change of ["claims_enabled=false","pause_code='provider_auth'","activated=false"]) {
      await m.query('SAVEPOINT disabled'); await m.query(`UPDATE embedding_private.control SET ${change}`);
      const state = await capacitySnapshot(); expect(await reserve()).toEqual(deferred); expect(await capacitySnapshot()).toEqual(state); await m.query('ROLLBACK TO disabled');
    }
    const state = await capacitySnapshot(); await m.query('SAVEPOINT admission'); expect((await reserve()).status).toBe('admitted');
    await m.query('ROLLBACK TO admission'); expect(await capacitySnapshot()).toEqual(state);
    await m.query("ALTER TABLE embedding_private.reservations ADD CONSTRAINT fixture_reject CHECK (false) NOT VALID");
    await expect(reserve()).rejects.toMatchObject({ code: '23514' }); expect(await capacitySnapshot()).toEqual(state);
    const [config] = (await m.query(`SELECT prosecdef,proconfig,r.rolsuper OR r.rolbypassrls AS bypass,
      EXISTS(SELECT FROM aclexplode(p.proacl) a WHERE a.grantee=0 OR a.grantee<>p.proowner) AS extra_grant
      FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE proname='reserve_request' AND pronamespace='embedding_private'::regnamespace`)).rows;
    expect(config).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, extensions','row_security=off'], bypass: true, extra_grant: false });
    for (const role of ['recipient_app','anon','authenticated','embedding_probe_public','embedding_worker','service_role']) {
      if (!(await m.query('SELECT FROM pg_roles WHERE rolname=$1', [role])).rowCount) await m.query(`CREATE ROLE ${role} NOLOGIN`);
      for (const sql of ['SELECT * FROM embedding_private.reservations','SELECT * FROM embedding_private.owner_minutes',
        `SELECT embedding_private.reserve_request('query',1,'${randomUUID()}',NULL,NULL)`]) await expect(roleQuery(role,sql)).rejects.toMatchObject({ code: '42501' });
    }
    expect(await readFile(`supabase/migrations/${capacityNames.supabase}`, 'utf8')).toBe(await readFile(`src/db/migrations/${capacityNames.mirror}`, 'utf8'));
  });

  it.each(['U2.3b1','U2.3b2'])('%s enforces owner six, independent query slots, crash expiry and UTC rollover without refunds', async (unit) => {
    publicCapacity = unit === 'U2.3b2';
    await enable(); const m = fixture.migration; const owner = randomUUID();
    for (let n = 0; n < 6; n++) { expect((await reserve('query',1,owner)).status).toBe('admitted'); await expire(); }
    const before = await capacitySnapshot(); expect(await reserve('query',1,owner)).toEqual(deferred); expect(await capacitySnapshot()).toEqual(before);
    const first = await reserve(); expect(first.status).toBe('admitted');
    expect((await m.query('SELECT extract(epoch FROM expires_at-created_at)::float8 AS seconds FROM embedding_private.reservations WHERE id=$1', [first.reservation_id])).rows[0].seconds).toBe(3);
    await m.query("UPDATE embedding_private.reservations SET state='started' WHERE id=$1", [first.reservation_id]);
    await m.query("SET LOCAL TIME ZONE 'Pacific/Honolulu'");
    await m.query("UPDATE embedding_private.control SET minute_started_at=date_trunc('minute',clock_timestamp())-interval '1 minute',request_count=60,canonical_bytes=360000");
    expect((await reserve('query',1,owner)).status).toBe('deferred'); // owner quota survives global rollover.
    expect((await reserve()).status).toBe('admitted'); expect(await reserve()).toEqual(deferred);
    expect((await m.query(`SELECT request_count,canonical_bytes,minute_started_at=date_trunc('minute',clock_timestamp()) AS utc FROM embedding_private.control`)).rows[0])
      .toEqual({ request_count: 1, canonical_bytes: 6000, utc: true });
    expect((await m.query('SELECT state FROM embedding_private.reservations WHERE id=$1', [first.reservation_id])).rows[0].state).toBe('started');
    const minute = (await m.query('SELECT minute_started_at FROM embedding_private.control')).rows[0].minute_started_at;
    await expect.poll(async () => (await m.query("SELECT bool_and(expires_at<=clock_timestamp()) AS expired FROM embedding_private.reservations")).rows[0].expired, { timeout: 4000 }).toBe(true);
    await m.query("UPDATE embedding_private.owner_minutes SET minute_started_at=minute_started_at-interval '1 minute' WHERE owner_id=$1", [owner]);
    expect((await reserve('query',1,owner)).status).toBe('admitted');
    const counter = (await m.query('SELECT request_count,minute_started_at FROM embedding_private.control')).rows[0];
    expect(counter.request_count).toBe(counter.minute_started_at.getTime() === minute.getTime() ? 2 : 1);
  });

  it.each(['recipient','fact'].flatMap(kind => ['U2.3b1','U2.3b2'].map(unit => ({ kind,unit }))))('$unit $kind: exact immutable drain binding, two pools and actual 40+20 budgets', async ({ kind,unit }) => {
    publicCapacity = unit === 'U2.3b2';
    const { run,job } = await selected(kind); const m = fixture.migration;
    await m.query('INSERT INTO recipient_versions(recipient_id,user_id,version,name,description,address) SELECT id,user_id,version,name,description,address FROM recipients'); const sources = await snapshot();
    for (const changed of [{ ...job, job_id: randomUUID() },{ ...job, claim_token: randomUUID() }]) expect(await reserve('drain',1,null,changed)).toEqual(deferred);
    for (const change of ["run_token=gen_random_uuid()","lease_until=clock_timestamp()-interval '1 second'","revision='forged'","owner_id=gen_random_uuid()",
      "source_id=gen_random_uuid()","incarnation=gen_random_uuid()","generation=generation+1",kind === 'recipient' ? "kind='fact'" : "kind='recipient'"]) {
      await m.query('SAVEPOINT invalid_job'); await m.query(`UPDATE embedding_private.jobs SET ${change} WHERE id=$1`, [job.job_id]);
      const state = await capacitySnapshot(); expect(await reserve('drain',1,null,job)).toEqual(deferred); expect(await capacitySnapshot()).toEqual(state); await m.query('ROLLBACK TO invalid_job');
    }
    await minuteWindow(m);
    for (const [scope,total,requests] of [['query',359999,0],['drain',239999,0],['query',0,60],['drain',0,40]] as const) {
      await m.query('SAVEPOINT byte_limit'); await m.query("UPDATE embedding_private.control SET minute_started_at=date_trunc('minute',clock_timestamp()),canonical_bytes=$1,request_count=$2,query_canonical_bytes=0", [total,requests]);
      const state = await capacitySnapshot(); expect(await reserve(scope,2,job.owner_id,scope === 'drain' ? job : {})).toEqual(deferred); expect(await capacitySnapshot()).toEqual(state);
      if (requests === 0) expect((await reserve(scope,1,job.owner_id,scope === 'drain' ? job : {})).status).toBe('admitted'); await m.query('ROLLBACK TO byte_limit');
    }
    for (const target of ['embedding_private.jobs','embedding_private.control']) {
      await m.query('SAVEPOINT bounded'); const [limit] = (await m.query(`UPDATE ${target} SET ${target.endsWith('jobs') ? 'lease_until' : 'run_until'}=clock_timestamp()+interval '2 seconds' WHERE ${target.endsWith('jobs') ? 'id=$1' : 'singleton AND $1::uuid IS NOT NULL'} RETURNING ${target.endsWith('jobs') ? 'lease_until' : 'run_until'} AS deadline`, [job.job_id])).rows;
      expect((await reserve('drain',1,null,job)).expires_at).toEqual(limit.deadline); await m.query('ROLLBACK TO bounded');
    }
    const admitted = await reserve('drain',6000,randomUUID(),job); expect(admitted.status).toBe('admitted');
    const [binding] = (await m.query('SELECT * FROM embedding_private.reservations WHERE id=$1', [admitted.reservation_id])).rows;
    expect(binding).toMatchObject({ scope: 'drain', byte_count: 6000, owner_id: job.owner_id, job_id: job.job_id, claim_token: job.claim_token,
      run_token: run, kind, source_id: job.source_id, incarnation: job.incarnation, generation: job.generation, revision: job.revision, state: 'reserved', started_at: null, released_at: null });
    expect(binding.expires_at.getTime()-binding.created_at.getTime()).toBe(15000);
    const before = await capacitySnapshot(); expect(await reserve('drain',6000,null,job)).toEqual(deferred); expect(await capacitySnapshot()).toEqual(before);
    const others = (await m.query('SELECT id AS job_id,claim_token FROM embedding_private.jobs WHERE id<>$1 ORDER BY id', [job.job_id])).rows;
    expect((await reserve('drain',1,null,others[0])).status).toBe('admitted'); expect(await reserve('drain',1,null,others[1])).toEqual(deferred);
    expect((await reserve()).status).toBe('admitted'); expect((await reserve()).status).toBe('admitted'); expect(await reserve()).toEqual(deferred);
    expect(await snapshot()).toEqual(sources);
    // Independent budget fixture: real repeated claims and reservations, never provider starts.
    await m.query('ROLLBACK'); await m.query('BEGIN'); const next = await selected(kind); let current = next.job;
    await minuteWindow(m);
    for (let n = 0; n < 40; n++) {
      expect((await reserve('drain',6000,null,current)).status).toBe('admitted'); await expire();
      await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1", [current.job_id]);
      await expect.poll(async () => (await m.query('SELECT available_at<=clock_timestamp() AND lease_until<=clock_timestamp() AS due FROM embedding_private.jobs WHERE id=$1', [current.job_id])).rows[0].due).toBe(true);
      const reclaimed = await claim(next.run,1);
      expect(reclaimed).toHaveLength(1);
      [current] = reclaimed;
    }
    expect(await reserve('drain',1,null,current)).toEqual(deferred);
    for (let n = 0; n < 20; n++) { expect((await reserve()).status).toBe('admitted'); await expire(); }
    const full = await capacitySnapshot(); expect(await reserve('query',1)).toEqual(deferred); expect(await capacitySnapshot()).toEqual(full);
    expect((await m.query('SELECT request_count,canonical_bytes,query_request_count,query_canonical_bytes FROM embedding_private.control')).rows[0])
      .toEqual({ request_count: 60, canonical_bytes: 360000, query_request_count: 20, query_canonical_bytes: 120000 });
    expect((await m.query('SELECT DISTINCT attempts FROM embedding_private.jobs')).rows).toEqual([{ attempts: 0 }]);
  });

  it.each(['recipient','fact'].flatMap(kind => ['U2.3b1','U2.3b2'].map(unit => ({ kind,unit }))))('$unit $kind: two real connections serialize last slot/budget and recheck expiry after waiting', async ({ kind,unit }) => {
    const isPublic = unit === 'U2.3b2';
    const runtime = await embeddingDatabase(chain); const m = runtime.migration;
    try {
      await runtime.applyFoundation(); await runtime.applyOutbox(); await runtime.applyLifecycle(); await runtime.applyProtection();
      await runtime.applyClaims(); await runtime.applyCompletion(); await runtime.applyRecovery(); await runtime.applyCapacity(); await runtime.applyAdmission();
      await m.query('SELECT embedding_private.activate()'); await m.query('UPDATE embedding_private.control SET claims_enabled=true');
      const owner = randomUUID(); await m.query('INSERT INTO users(id,privy_did) VALUES($1,$2)', [owner,owner]);
      const table = kind === 'recipient' ? 'recipients' : 'user_memories';
      for (let n = 0; n < 3; n++) await m.query(kind === 'recipient' ? "INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES($1,'Ana','ana','fixture',now())" : "INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES($1,'Ana es mi hija',now())", [owner]);
      await expect.poll(async () => (await m.query('SELECT bool_and(available_at<=clock_timestamp()) AS due FROM embedding_private.jobs')).rows[0].due).toBe(true);
      const [run] = (await m.query('SELECT * FROM public.embedding_begin_drain()')).rows;
      for (const barrier of ['slot','budget','run_expiry','job_expiry']) {
        await minuteWindow(m);
        await m.query("UPDATE embedding_private.reservations SET state='released'");
        await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()+interval '90 seconds',minute_started_at=date_trunc('minute',clock_timestamp()),request_count=0,canonical_bytes=0,query_request_count=0,query_canonical_bytes=0");
        await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'");
        const jobs = (await m.query('SELECT * FROM public.embedding_claim_jobs($1,4)', [run.run_token])).rows;
        if (barrier === 'slot') await m.query("SELECT * FROM embedding_private.reserve_request('drain',1,NULL,$1,$2)", [jobs[2].job_id,jobs[2].claim_token]);
        if (barrier === 'budget') await m.query('UPDATE embedding_private.control SET request_count=59,canonical_bytes=359999,query_request_count=20,query_canonical_bytes=120000');
        if (barrier === 'run_expiry') await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()+interval '500 milliseconds'");
        if (barrier === 'job_expiry') await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()+interval '500 milliseconds'");
        await m.query('BEGIN'); await m.query('SELECT FROM embedding_private.control FOR UPDATE'); await m.query(`SELECT FROM ${table} FOR UPDATE`);
        const calls = jobs.slice(0,barrier.endsWith('expiry') ? 1 : 2).map((j) => runtime.database.withUserTransactionAnonymous(async (c) => {
          await c.query(`SET LOCAL ROLE ${isPublic ? 'embedding_worker' : 'postgres'}`); await c.query("SET LOCAL statement_timeout='3s'"); return (await c.query(isPublic ? "SELECT * FROM public.embedding_admit_request('drain',1,$1,$2)" : "SELECT * FROM embedding_private.reserve_request('drain',1,NULL,$1,$2)", [j.job_id,j.claim_token])).rows[0];
        }));
        const result = Promise.all(calls); void result.catch(() => {});
        try {
          await expect.poll(async () => { await m.query('SELECT pg_stat_clear_snapshot()'); return (await m.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND (query LIKE 'SELECT * FROM embedding_private.reserve_request%' OR query LIKE 'SELECT * FROM public.embedding_admit_request%')")).rows[0].n; }).toBe(calls.length);
          if (barrier.endsWith('expiry')) await expect.poll(async () => (await m.query(barrier === 'run_expiry' ? 'SELECT run_until<=clock_timestamp() AS expired FROM embedding_private.control' : 'SELECT bool_and(lease_until<=clock_timestamp()) AS expired FROM embedding_private.jobs')).rows[0].expired).toBe(true);
        } finally { await m.query('COMMIT'); }
        const rows = await result; expect(rows.filter((r) => r.status === 'admitted')).toHaveLength(barrier.endsWith('expiry') ? 0 : 1);
        expect(rows.filter((r) => r.status === 'deferred')).toHaveLength(1);
        expect((await m.query('SELECT request_count FROM embedding_private.control')).rows[0].request_count).toBe(barrier === 'slot' ? 2 : barrier === 'budget' ? 60 : 0);
      }
    } finally { await m.query('ROLLBACK'); await runtime.cleanup(); }
  }, 30_000);

  it('U2.3b2 rejects hostile contexts, unsupported roles/scopes and private/worker authority without charges', async () => {
    const m = fixture.migration;
    const { job } = await selected('fact');
    const before = await capacitySnapshot();
    for (const role of ['postgres','embedding_worker','service_role','anon','authenticated','embedding_probe_public']) {
      if (!(await m.query('SELECT FROM pg_roles WHERE rolname=$1', [role])).rowCount) await m.query(`CREATE ROLE ${role} NOLOGIN`);
      await m.query("SELECT set_config('app.user_id',$1,true)", [job.owner_id]);
      await expect(roleQuery(role,admissionSql,['query',1,null,null])).rejects.toMatchObject({ code: '42501' });
    }
    for (const owner of ['', 'not-a-uuid', randomUUID()]) {
      await m.query("SELECT set_config('app.user_id',$1,true)", [owner]);
      await expect(roleQuery('recipient_app',admissionSql,['query',1,null,null])).rejects.toMatchObject({ code: '42501' });
    }
    await m.query("SELECT set_config('app.user_id',$1,true)", [job.owner_id]);
    for (const args of [['other',1,null,null],[null,1,null,null],['query',0,null,null],['query',6001,null,null],['query',null,null,null],['query',1,job.job_id,job.claim_token]])
      await expect(roleQuery('recipient_app',admissionSql,args)).rejects.toMatchObject({ code: '22023' });
    await expect(roleQuery('recipient_app',admissionSql,['drain',1,job.job_id,job.claim_token])).rejects.toMatchObject({ code: '42501' });
    await expect(roleQuery('embedding_worker',admissionSql,['drain',1,null,null])).rejects.toMatchObject({ code: '22023' });
    for (const sql of ['SELECT * FROM embedding_private.reservations','SELECT * FROM embedding_private.owner_minutes',
      "SELECT embedding_private.reserve_request('query',1,gen_random_uuid(),NULL,NULL)", 'SELECT * FROM public.embedding_begin_drain()',
      'SELECT * FROM public.embedding_claim_jobs(NULL,4)', "SELECT public.embedding_retry('fact',NULL,NULL,1)"])
      await expect(roleQuery('recipient_app',sql)).rejects.toMatchObject({ code: '42501' });
    await m.query('SAVEPOINT untrusted_login');
    try {
      await m.query('SET LOCAL SESSION AUTHORIZATION embedding_worker');
      await expect(m.query('SET LOCAL ROLE recipient_app')).rejects.toMatchObject({ code: '42501' });
    } finally { await m.query('ROLLBACK TO untrusted_login'); }
    expect(await capacitySnapshot()).toEqual(before);
    for (const change of ["activated=false","claims_enabled=false","pause_code='provider_auth'"]) {
      await m.query('SAVEPOINT gated');
      await m.query(`UPDATE embedding_private.control SET ${change}`);
      const state = await capacitySnapshot();
      expect((await roleQuery('recipient_app',admissionSql,['query',1,null,null]))[0]).toEqual(deferred);
      expect((await worker(admissionSql,['drain',1,job.job_id,job.claim_token]))[0]).toEqual(deferred);
      expect(await capacitySnapshot()).toEqual(state);
      await m.query('ROLLBACK TO gated');
    }
    const [config] = (await m.query(`SELECT prosecdef,proconfig,r.rolsuper OR r.rolbypassrls AS bypass,
      EXISTS(SELECT FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS public_execute FROM pg_proc p JOIN pg_roles r ON r.oid=p.proowner WHERE proname='embedding_admit_request'`)).rows;
    expect(config).toEqual({ prosecdef: true, proconfig: ['search_path=pg_catalog, extensions','row_security=off'], bypass: true, public_execute: false });
    expect((await m.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname='embedding_admit_request'")).rows[0].n).toBe(1);
    await m.query("SELECT set_config('app.user_id',$1,true)", [randomUUID()]);
    const admitted = (await roleQuery('service_role',admissionSql,['drain',1,job.job_id,job.claim_token]))[0];
    expect(admitted.status).toBe('admitted');
    expect((await m.query('SELECT owner_id FROM embedding_private.reservations WHERE id=$1', [admitted.reservation_id])).rows[0].owner_id).toBe(job.owner_id);
    const charged = await capacitySnapshot();
    expect((await worker(admissionSql,['drain',1,job.job_id,job.claim_token]))[0]).toEqual(deferred);
    expect(await capacitySnapshot()).toEqual(charged);
    expect(await readFile(`supabase/migrations/${admissionNames.supabase}`, 'utf8')).toBe(await readFile(`src/db/migrations/${admissionNames.mirror}`, 'utf8'));
  });

  it.each(['recipient','fact'])('U2.3b2 %s: real owner transactions isolate quotas, serialize last owner request and roll back admission', async (kind) => {
    const runtime = await embeddingDatabase(chain);
    const m = runtime.migration;
    const owners = [randomUUID(),randomUUID()];
    try {
      await runtime.applyFoundation();
      await runtime.applyOutbox();
      await runtime.applyLifecycle();
      await runtime.applyProtection();
      await runtime.applyClaims();
      await runtime.applyCompletion();
      await runtime.applyRecovery();
      await runtime.applyCapacity();
      await runtime.applyAdmission();
      await m.query('SELECT embedding_private.activate()');
      await m.query('UPDATE embedding_private.control SET claims_enabled=true');
      for (const owner of owners) {
        await m.query('INSERT INTO users(id,privy_did) VALUES($1,$2)', [owner,owner]);
        await m.query(kind === 'recipient' ? "INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES($1,'Ana','ana','fixture',now())" : "INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES($1,'Ana es mi hija',now())", [owner]);
      }
      const table = kind === 'recipient' ? 'recipients' : 'user_memories';
      const sources = (await m.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`)).rows;
      const state = async () => (await m.query('SELECT (SELECT request_count FROM embedding_private.control) AS requests,(SELECT count(*)::int FROM embedding_private.reservations) AS reservations,(SELECT count(*)::int FROM embedding_private.owner_minutes) AS owners')).rows;
      const query = (owner: string) => runtime.database.withUserTransaction(owner, async c => {
        expect((await c.query('SELECT current_user AS role')).rows[0].role).toBe('recipient_app');
        expect((await c.query(`SELECT user_id FROM ${table}`)).rows).toEqual([{ user_id: owner }]);
        return (await c.query(admissionSql,['query',6000,null,null])).rows[0];
      });
      await expect(runtime.database.withUserTransactionAnonymous(c => c.query(admissionSql,['query',1,null,null]))).rejects.toMatchObject({ code: '42501' });
      await expect(runtime.database.query(admissionSql,['query',1,null,null])).rejects.toMatchObject({ code: '42501' });
      const before = await state();
      await expect(runtime.database.withUserTransaction(owners[0],async c => {
        expect((await c.query(admissionSql,['query',1,null,null])).rows[0].status).toBe('admitted');
        throw new Error('fixture rollback');
      })).rejects.toThrow('fixture rollback');
      expect(await state()).toEqual(before);
      for (let n=0;n<5;n++) {
        expect((await query(owners[0])).status).toBe('admitted');
        await m.query("UPDATE embedding_private.reservations SET expires_at=clock_timestamp()-interval '1 second'");
      }
      const race = await Promise.all([query(owners[0]),query(owners[0])]);
      expect(race.filter(r => r.status==='admitted')).toHaveLength(1);
      expect(race.filter(r => r.status==='deferred')).toEqual([deferred]);
      for (let n=0;n<6;n++) {
        await m.query("UPDATE embedding_private.reservations SET expires_at=clock_timestamp()-interval '1 second'");
        expect((await query(owners[1])).status).toBe('admitted');
      }
      const full = await state();
      expect(await query(owners[0])).toEqual(deferred);
      expect(await query(owners[1])).toEqual(deferred);
      expect(await state()).toEqual(full);
      expect((await m.query('SELECT owner_id,request_count FROM embedding_private.owner_minutes ORDER BY owner_id')).rows).toEqual(owners.sort().map(owner_id => ({ owner_id,request_count: 6 })));
      expect((await m.query("SELECT count(*)::int AS n FROM embedding_private.reservations WHERE scope='query' AND state='reserved' AND started_at IS NULL AND job_id IS NULL AND claim_token IS NULL AND run_token IS NULL")).rows[0].n).toBe(12);
      expect((await m.query('SELECT request_count,canonical_bytes FROM embedding_private.control')).rows[0]).toEqual({ request_count: 12,canonical_bytes: 72000 });
      expect((await m.query('SELECT DISTINCT attempts FROM embedding_private.jobs')).rows).toEqual([{ attempts: 0 }]);
      expect((await m.query(`SELECT to_jsonb(t) AS data FROM ${table} t ORDER BY id`)).rows).toEqual(sources);
    } finally { await runtime.cleanup(); }
  }, 30_000);

  // U2.3c: count provider permissions from real starts, never external inference calls.
  const startSql = 'SELECT * FROM public.embedding_start_attempt($1,$2,$3)';
  const queryStartSql = 'SELECT * FROM public.embedding_start_query($1,$2)';
  const staleStart = { status: 'stale',attempt: null,expires_at: null };
  const admitStart = async (j: Record<string, unknown>) => (await worker(admissionSql,['drain',6000,j.job_id,j.claim_token]))[0];
  const start = (j: Record<string, unknown>, id: unknown) => worker(startSql,[j.job_id,j.claim_token,id]);

  it.each(['recipient','fact'])('U2.3c %s: full binding, current source, rollback and once-only start', async (kind) => {
    const { job } = await selected(kind); const m = fixture.migration; const table = kind === 'recipient' ? 'recipients' : 'user_memories';
    const reservation = await admitStart(job); expect(reservation.status).toBe('admitted');
    const before = await snapshot(); const capacity = await capacitySnapshot();
    for (const j of [{ ...job,job_id: randomUUID() },{ ...job,claim_token: randomUUID() }]) expect(await start(j,reservation.reservation_id)).toEqual([staleStart]);
    for (const id of [null,randomUUID()]) expect(await start(job,id)).toEqual([staleStart]);
    for (const [column,value] of [['owner_id',randomUUID()],['kind',kind === 'fact' ? 'recipient' : 'fact'],['source_id',randomUUID()],['incarnation',randomUUID()],['generation',99],['revision','forged'],['run_token',randomUUID()],['claim_token',randomUUID()],['job_id',randomUUID()]]) {
      await m.query('SAVEPOINT binding'); await m.query(`UPDATE embedding_private.reservations SET ${column}=$2 WHERE id=$1`,[reservation.reservation_id,value]);
      expect(await start(job,reservation.reservation_id)).toEqual([staleStart]); await m.query('ROLLBACK TO binding');
    }
    for (const change of ["activated=false","claims_enabled=false","pause_code='provider_auth'","run_token=gen_random_uuid()","run_until=clock_timestamp()-interval '1 second'"]) {
      await m.query('SAVEPOINT control'); await m.query(`UPDATE embedding_private.control SET ${change}`);
      expect(await start(job,reservation.reservation_id)).toEqual([staleStart]); await m.query('ROLLBACK TO control');
    }
    for (const change of ["claim_token=gen_random_uuid()","run_token=gen_random_uuid()","lease_until=clock_timestamp()-interval '1 second'"]) {
      await m.query('SAVEPOINT job'); await m.query(`UPDATE embedding_private.jobs SET ${change} WHERE id=$1`,[job.job_id]);
      expect(await start(job,reservation.reservation_id)).toEqual([staleStart]); await m.query('ROLLBACK TO job');
    }
    for (const change of ["status='inactive'",kind === 'fact' ? "fact='changed'" : "description='changed'",'DELETE','REINSERT']) {
      await m.query('SAVEPOINT source');
      if (change === 'DELETE' || change === 'REINSERT') {
        await m.query(`DELETE FROM ${table} WHERE id=$1`,[job.source_id]);
        if (change === 'REINSERT') await m.query(kind === 'fact' ? "INSERT INTO user_memories(id,user_id,fact,confirmed_at) VALUES($1,$2,'new',now())" : "INSERT INTO recipients(id,user_id,name,normalized_name,address,address_confirmed_at) VALUES($1,$2,'new','new','fixture',now())",[job.source_id,job.owner_id]);
      } else await m.query(`UPDATE ${table} SET ${change} WHERE id=$1`,[job.source_id]);
      expect(await start(job,reservation.reservation_id)).toEqual([staleStart]); await m.query('ROLLBACK TO source');
    }
    expect(await snapshot()).toEqual(before); expect(await capacitySnapshot()).toEqual(capacity);
    await m.query("ALTER TABLE embedding_private.jobs ADD CONSTRAINT fixture_no_start CHECK (attempts=0) NOT VALID");
    await expect(start(job,reservation.reservation_id)).rejects.toMatchObject({ code: '23514' });
    expect(await snapshot()).toEqual(before); expect(await capacitySnapshot()).toEqual(capacity);
    await m.query('ALTER TABLE embedding_private.jobs DROP CONSTRAINT fixture_no_start');
    await m.query('SAVEPOINT started'); await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()+interval '8 seconds'");
    const [runBound] = await start(job,reservation.reservation_id); expect(runBound).toMatchObject({ status: 'started',attempt: 1 });
    expect(runBound.expires_at).toEqual((await m.query('SELECT run_until FROM embedding_private.control')).rows[0].run_until);
    await m.query('ROLLBACK TO started'); expect(await snapshot()).toEqual(before); expect(await capacitySnapshot()).toEqual(capacity);
    await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()+interval '10 seconds' WHERE id=$1",[job.job_id]);
    const [result] = await roleQuery('service_role',startSql,[job.job_id,job.claim_token,reservation.reservation_id]);
    expect(result).toEqual({ status: 'started',attempt: 1,expires_at: expect.any(Date) });
    expect((await start(job,reservation.reservation_id))[0]).toEqual({ ...result,status: 'already_started' });
    expect((await m.query(`SELECT r.expires_at=least(r.started_at+interval '15 seconds',j.lease_until,c.run_until) AS bounded,r.state,j.attempts
      FROM embedding_private.reservations r JOIN embedding_private.jobs j ON j.id=r.job_id CROSS JOIN embedding_private.control c WHERE r.id=$1`,[reservation.reservation_id])).rows[0]).toEqual({ bounded: true,state: 'started',attempts: 1 });
    const after = await snapshot(); expect(after.slice(0,2)).toEqual(before.slice(0,2)); expect(after.slice(3)).toEqual(before.slice(3));
    expect((await m.query('SELECT count(*)::int AS n FROM embedding_private.jobs WHERE attempts<>0')).rows[0].n).toBe(1);
  });

  it('U2.3c query: ID/scope/bytes, immutable deadline, replay, rollback and narrow grants', async () => {
    const { job } = await selected('fact'); const m = fixture.migration; const drain = await admitStart(job);
    await m.query("SELECT set_config('app.user_id',$1,true)",[job.owner_id]);
    const [r] = await roleQuery('recipient_app',admissionSql,['query',42,null,null]); expect(r.status).toBe('admitted');
    for (const [id,bytes] of [[randomUUID(),42],[null,42],[drain.reservation_id,6000],[r.reservation_id,41],[r.reservation_id,0],[r.reservation_id,null]])
      expect(await worker(queryStartSql,[id,bytes])).toEqual([{ status: 'stale',expires_at: null }]);
    expect(await start(job,r.reservation_id)).toEqual([staleStart]);
    for (const role of ['recipient_app','anon','authenticated','embedding_probe_public']) {
      if (!(await m.query('SELECT FROM pg_roles WHERE rolname=$1',[role])).rowCount) await m.query(`CREATE ROLE ${role} NOLOGIN`);
      for (const [sql,args] of [[queryStartSql,[r.reservation_id,42]],[startSql,[job.job_id,job.claim_token,drain.reservation_id]]] as const)
        await expect(roleQuery(role,sql,[...args])).rejects.toMatchObject({ code: '42501' });
    }
    for (const signature of ['embedding_start_attempt(uuid,uuid,uuid)','embedding_start_query(uuid,integer)']) {
      expect((await m.query(`SELECT prosecdef,proconfig,rolsuper OR rolbypassrls AS bypass,has_function_privilege('embedding_worker',p.oid,'EXECUTE') AS worker,
        has_function_privilege('service_role',p.oid,'EXECUTE') AS service,EXISTS(SELECT FROM aclexplode(p.proacl) a WHERE a.grantee=0) AS public FROM pg_proc p JOIN pg_roles ON pg_roles.oid=p.proowner WHERE p.oid=$1::regprocedure`,[signature])).rows[0])
        .toEqual({ prosecdef: true,proconfig: ['search_path=pg_catalog, extensions','row_security=off'],bypass: true,worker: true,service: true,public: false });
    }
    expect((await m.query("SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('embedding_start_attempt','embedding_start_query')")).rows[0].n).toBe(2);
    for (const change of ["expires_at=clock_timestamp()-interval '1 second'","state='released'"]) {
      await m.query('SAVEPOINT expired'); await m.query(`UPDATE embedding_private.reservations SET ${change} WHERE id=$1`,[r.reservation_id]);
      expect(await worker(queryStartSql,[r.reservation_id,42])).toEqual([{ status: 'stale',expires_at: null }]); await m.query('ROLLBACK TO expired');
    }
    for (const change of ["activated=false","claims_enabled=false","pause_code='provider_auth'"]) {
      await m.query('SAVEPOINT gate'); await m.query(`UPDATE embedding_private.control SET ${change}`);
      expect(await worker(queryStartSql,[r.reservation_id,42])).toEqual([{ status: 'stale',expires_at: null }]); await m.query('ROLLBACK TO gate');
    }
    const before = await capacitySnapshot(); await m.query('SAVEPOINT query_start');
    expect(await worker(queryStartSql,[r.reservation_id,42])).toEqual([{ status: 'started',expires_at: r.expires_at }]);
    await m.query('ROLLBACK TO query_start'); expect(await capacitySnapshot()).toEqual(before);
    expect(await worker(queryStartSql,[r.reservation_id,42])).toEqual([{ status: 'started',expires_at: r.expires_at }]);
    expect(await worker(queryStartSql,[r.reservation_id,42])).toEqual([{ status: 'already_started',expires_at: r.expires_at }]);
    expect((await m.query("SELECT expires_at=created_at+interval '3 seconds' AS bounded FROM embedding_private.reservations WHERE id=$1",[r.reservation_id])).rows[0].bounded).toBe(true);
    expect((await m.query('SELECT DISTINCT attempts FROM embedding_private.jobs')).rows).toEqual([{ attempts: 0 }]);
    expect(await readFile(`supabase/migrations/${attemptsNames.supabase}`,'utf8')).toBe(await readFile(`src/db/migrations/${attemptsNames.mirror}`,'utf8'));
  });

  it.each(['recipient','fact'])('U2.3c %s: five actual starts through admission/failure, no sixth permission', async (kind) => {
    const { run,job: initial } = await selected(kind); const m = fixture.migration; let job = initial; const permissions = [];
    await m.query("UPDATE embedding_private.jobs SET available_at=clock_timestamp()+interval '1 hour' WHERE id<>$1",[job.job_id]);
    for (let n=1;n<=5;n++) {
      const r = await admitStart(job); expect(r.status).toBe('admitted');
      expect((await m.query('SELECT attempts FROM embedding_private.jobs WHERE id=$1',[job.job_id])).rows[0].attempts).toBe(n-1);
      const [result] = await start(job,r.reservation_id); expect(result.status).toBe('started'); permissions.push(result.attempt);
      expect((await start(job,r.reservation_id))[0].status).toBe('already_started');
      if (n<5) {
        expect(await fail(job,'provider_network')).toEqual([{ result: 'applied' }]);
        // Explicit operator fixture expiry/due time; no fake STARTED rows or attempt counts.
        await m.query("UPDATE embedding_private.reservations SET expires_at=clock_timestamp()-interval '1 second'");
        await m.query('UPDATE embedding_private.jobs SET available_at=clock_timestamp() WHERE id=$1',[job.job_id]);
        [job] = await claim(run,1); expect(job.job_id).toBe(initial.job_id);
        expect(await start(initial,r.reservation_id)).toEqual([staleStart]);
      } else {
        expect((await start(job,randomUUID()))[0]).toEqual(staleStart);
        await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",[job.job_id]);
        expect(await start(job,r.reservation_id)).toEqual([staleStart]); expect(await claim(run,1)).toEqual([]);
      }
    }
    expect(permissions).toEqual([1,2,3,4,5]);
    expect((await m.query('SELECT attempts FROM embedding_private.jobs WHERE id=$1',[job.job_id])).rows[0].attempts).toBe(5);
  });

  it.each(['recipient','fact'])('U2.3c %s: actual source/job/control/reservation waits, expiry and concurrent duplicate starts', async (kind) => {
    const runtime = await embeddingDatabase(chain); const m = runtime.migration;
    try {
      await runtime.applyFoundation(); await runtime.applyOutbox(); await runtime.applyLifecycle(); await runtime.applyProtection();
      await runtime.applyClaims(); await runtime.applyCompletion(); await runtime.applyRecovery(); await runtime.applyCapacity(); await runtime.applyAdmission(); await runtime.applyAttempts();
      await m.query('SELECT embedding_private.activate()'); await m.query('UPDATE embedding_private.control SET claims_enabled=true');
      const owner = randomUUID(); await m.query('INSERT INTO users(id,privy_did) VALUES($1,$2)',[owner,owner]);
      await m.query(kind === 'fact' ? "INSERT INTO user_memories(user_id,fact,confirmed_at) VALUES($1,'Ana',now())" : "INSERT INTO recipients(user_id,name,normalized_name,address,address_confirmed_at) VALUES($1,'Ana','ana','fixture',now())",[owner]);
      await expect.poll(async () => (await m.query('SELECT bool_and(available_at<=clock_timestamp()) AS due FROM embedding_private.jobs')).rows[0].due).toBe(true);
      const [run] = (await m.query('SELECT * FROM public.embedding_begin_drain()')).rows;
      const call = (sql: string,args: unknown[]) => runtime.database.withUserTransactionAnonymous(async c => {
        await c.query('SET LOCAL ROLE embedding_worker'); await c.query("SET LOCAL statement_timeout='3s'"); return (await c.query(sql,args)).rows[0];
      });
      for (const [lock,expiry] of [['source','reserved'],['source','run'],['source','job'],['job','reserved'],['control','reserved'],['reservation','reserved'],['duplicate','none']]) {
        // Operator fixture expires occupancy and leases between independent barriers; attempts are never assigned.
        await m.query("UPDATE embedding_private.reservations SET expires_at=clock_timestamp()-interval '1 second'");
        await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()+interval '90 seconds'");
        await m.query("UPDATE embedding_private.jobs SET lease_until=clock_timestamp()-interval '1 second' WHERE state='leased'");
        const [j] = (await m.query('SELECT * FROM public.embedding_claim_jobs($1,1)',[run.run_token])).rows;
        const r = await call(admissionSql,['drain',1,j.job_id,j.claim_token]); expect(r.status).toBe('admitted');
        const target = expiry === 'run' ? 'embedding_private.control' : expiry === 'job' ? 'embedding_private.jobs' : 'embedding_private.reservations';
        const column = expiry === 'run' ? 'run_until' : expiry === 'job' ? 'lease_until' : 'expires_at';
        if (expiry !== 'none') await m.query(`UPDATE ${target} SET ${column}=clock_timestamp()+interval '500 milliseconds'`);
        await m.query('BEGIN');
        await m.query(`SELECT FROM ${lock === 'source' || lock === 'duplicate' ? kind === 'fact' ? 'user_memories' : 'recipients' : lock === 'job' ? 'embedding_private.jobs' : lock === 'control' ? 'embedding_private.control' : 'embedding_private.reservations'} FOR UPDATE`);
        const pending = Promise.all(Array.from({ length: lock === 'duplicate' ? 2 : 1 },() => call(startSql,[j.job_id,j.claim_token,r.reservation_id]))); void pending.catch(() => {});
        try {
          await expect.poll(async () => { await m.query('SELECT pg_stat_clear_snapshot()'); return (await m.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM public.embedding_start_attempt%'")).rows[0].n; }).toBe(lock === 'duplicate' ? 2 : 1);
          if (expiry !== 'none') await expect.poll(async () => (await m.query(`SELECT bool_and(${column}<=clock_timestamp()) AS expired FROM ${target}`)).rows[0].expired).toBe(true);
        } finally { await m.query('COMMIT'); }
        const results = await pending;
        expect(results.map(r => r.status).sort()).toEqual(lock === 'duplicate' ? ['already_started','started'] : ['stale']);
        expect((await m.query('SELECT attempts FROM embedding_private.jobs')).rows[0].attempts).toBe(lock === 'duplicate' ? 1 : 0);
      }
      expect((await m.query("SELECT expires_at=started_at+interval '15 seconds' AS bounded FROM embedding_private.reservations WHERE state='started'")).rows).toEqual([{ bounded: true }]);
      const q = await runtime.database.withUserTransaction(owner,async c => (await c.query(admissionSql,['query',3,null,null])).rows[0]);
      expect(q.status).toBe('admitted');
      const replay = await Promise.all([call(queryStartSql,[q.reservation_id,3]),call(queryStartSql,[q.reservation_id,3])]);
      expect(replay.map(r => r.status).sort()).toEqual(['already_started','started']); expect(replay.map(r => r.expires_at)).toEqual([q.expires_at,q.expires_at]);
      const expired = await runtime.database.withUserTransaction(owner,async c => (await c.query(admissionSql,['query',3,null,null])).rows[0]);
      await m.query("UPDATE embedding_private.reservations SET expires_at=clock_timestamp()+interval '500 milliseconds' WHERE id=$1",[expired.reservation_id]);
      await m.query('BEGIN'); await m.query('SELECT FROM embedding_private.reservations WHERE id=$1 FOR UPDATE',[expired.reservation_id]);
      const waiting = call(queryStartSql,[expired.reservation_id,3]); void waiting.catch(() => {});
      await expect.poll(async () => { await m.query('SELECT pg_stat_clear_snapshot()'); return (await m.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock' AND query LIKE 'SELECT * FROM public.embedding_start_query%'")).rows[0].n; }).toBe(1);
      await expect.poll(async () => (await m.query('SELECT expires_at<=clock_timestamp() AS expired FROM embedding_private.reservations WHERE id=$1',[expired.reservation_id])).rows[0].expired).toBe(true);
      await m.query('COMMIT'); expect(await waiting).toEqual({ status: 'stale',expires_at: null });
    } finally { await m.query('ROLLBACK'); await runtime.cleanup(); }
  }, 30_000);

  it('uses job-only SKIP LOCKED and a unique run across real concurrent connections', async () => {
    const run = await enable(); const m = fixture.migration; await m.query('COMMIT'); await m.query('BEGIN');
    const [locked] = (await m.query('SELECT id FROM embedding_private.jobs ORDER BY available_at,id LIMIT 1 FOR UPDATE')).rows;
    await m.query('SELECT id FROM recipients FOR UPDATE');
    const concurrent = () => fixture.database.withUserTransactionAnonymous(async (c) => {
      await c.query('SET LOCAL ROLE embedding_worker'); await c.query("SET LOCAL statement_timeout='1500ms'");
      return (await c.query('SELECT * FROM public.embedding_claim_jobs($1,100)', [run])).rows;
    });
    const results = (await Promise.all([concurrent(), concurrent()])).flat();
    expect(results).toHaveLength(7); expect(new Set(results.map((j) => j.job_id)).size).toBe(7);
    expect(results.some((j) => j.job_id === locked.id)).toBe(false);
    await m.query('ROLLBACK'); await m.query("UPDATE embedding_private.control SET run_until=clock_timestamp()-interval '1 second'");
    const begin = () => fixture.database.query('SELECT * FROM public.embedding_begin_drain()');
    const runs = (await Promise.all([begin(), begin()])).flatMap((r) => r.rows); expect(runs).toHaveLength(1);
    await m.query('BEGIN');
  });
});
