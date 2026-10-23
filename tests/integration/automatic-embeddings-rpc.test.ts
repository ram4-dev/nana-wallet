import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { chains, claimsNames, embeddingDatabase } from './helpers/embedding-database.js';

const identity = ['job_id', 'kind', 'owner_id', 'source_id', 'incarnation', 'generation', 'revision'];
const signatures = ['embedding_begin_drain()', 'embedding_claim_jobs(uuid,integer)', 'embedding_read_job(uuid,uuid)'];
describe.each(chains)('U2.1 real claim/read RPCs: %s', (chain) => {
  let fixture: Awaited<ReturnType<typeof embeddingDatabase>>;
  let serviceOwned = false;
  beforeAll(async () => {
    fixture = await embeddingDatabase(chain);
    const m = fixture.migration;
    serviceOwned = !(await m.query("SELECT FROM pg_roles WHERE rolname='service_role'")).rowCount;
    if (serviceOwned) await m.query('CREATE ROLE service_role NOLOGIN');
    await fixture.applyFoundation(); await fixture.applyOutbox(); await fixture.applyLifecycle(); await fixture.applyProtection();
    await fixture.applyClaims();
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
  afterEach(async () => { await fixture.migration.query('ROLLBACK'); });
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
