import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { chains, embeddingDatabase, outboxNames } from './helpers/embedding-database.js';

const revision = 'openai:text-embedding-3-small:384:nana-text-v1:l2:epoch1';
const insertJob = `INSERT INTO embedding_private.jobs(kind,owner_id,source_id,incarnation,generation,revision)
  VALUES($1,$2,$3,$4,$5,$6) RETURNING *`;
const sourceGrantsSql = "SELECT oid::regclass::text AS source,relacl FROM pg_class WHERE oid IN ('recipients'::regclass,'user_memories'::regclass) ORDER BY source";

describe.each(chains)('U1.2 dormant outbox: %s', (chain) => {
  let fixture: Awaited<ReturnType<typeof embeddingDatabase>>;
  let sourceGrants: unknown;
  beforeAll(async () => {
    fixture = await embeddingDatabase(chain);
    await fixture.applyFoundation();
    sourceGrants = (await fixture.database.query(sourceGrantsSql)).rows;
    await fixture.applyOutbox();
  }, 30_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it('stores only references, with due/lease/source indexes and no activation or triggers', async () => {
    const { database } = fixture;
    expect((await database.query(sourceGrantsSql)).rows).toEqual(sourceGrants);
    expect((await database.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='embedding_private' AND table_name='jobs' ORDER BY ordinal_position`)).rows.map((r) => r.column_name))
      .toEqual(['id','kind','owner_id','source_id','incarnation','generation','revision','state','attempts',
        'available_at','claim_token','lease_until','error_code','created_at','updated_at']);
    const indexes = (await database.query(`SELECT indexdef FROM pg_indexes
      WHERE schemaname='embedding_private' AND tablename='jobs' ORDER BY indexname`)).rows.map((r) => r.indexdef).join('\n');
    expect(indexes).toContain('UNIQUE INDEX');
    expect(indexes).toContain('(kind, owner_id, source_id, incarnation, generation, revision)');
    expect(indexes).toContain('(available_at, id)');
    expect(indexes).toContain('(lease_until, id)');
    expect(indexes).toContain("WHERE (state = 'pending'::text)");
    expect(indexes).toContain("WHERE (state = 'leased'::text)");
    expect((await database.query('SELECT activated, claims_enabled, semantic_enabled FROM embedding_private.control')).rows)
      .toEqual([{ activated: false, claims_enabled: false, semantic_enabled: false }]);
    expect((await database.query(`SELECT count(*)::int AS count FROM pg_trigger
      WHERE tgrelid IN ('recipients'::regclass,'user_memories'::regclass,'embedding_private.jobs'::regclass) AND NOT tgisinternal`)).rows[0]?.count).toBe(0);
    expect(fixture.migrationSearchPath()).toBe('"$user", public');
  });

  it('enforces the full unique identity while allowing each tuple component to advance', async () => {
    const identity = ['recipient', randomUUID(), randomUUID(), randomUUID(), 1, revision];
    const { database } = fixture;
    const { rows: [job] } = await database.query(insertJob, identity);
    expect(job).toMatchObject({ kind: 'recipient', state: 'pending', attempts: 0, claim_token: null, lease_until: null, error_code: null });
    expect(job.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(job.available_at).toBeInstanceOf(Date);
    expect(job.created_at).toBeInstanceOf(Date);
    expect(job.updated_at).toBeInstanceOf(Date);
    await expect(database.query(insertJob, identity)).rejects.toMatchObject({ code: '23505' });
    const alternatives = ['fact', randomUUID(), randomUUID(), randomUUID(), 2, `${revision}-next`];
    for (const [index, value] of alternatives.entries()) {
      const changed = [...identity]; changed[index] = value;
      await expect(database.query(insertJob, changed)).resolves.toMatchObject({ rowCount: 1 });
    }
    for (const mutation of ["kind='unknown'", 'generation=-1', "state='unknown'", 'attempts=-1', 'attempts=6',
      "error_code='raw text with spaces'", "state='leased'", 'claim_token=gen_random_uuid()']) {
      await expect(database.query(`UPDATE embedding_private.jobs SET ${mutation} WHERE id=$1`, [job.id])).rejects.toMatchObject({ code: '23514' });
    }
    await database.query(`UPDATE embedding_private.jobs SET state='leased',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' WHERE id=$1`, [job.id]);
  });

  it('commits and rolls back explicit source+job SQL together for both kinds without changing source data', async () => {
    const { migration } = fixture;
    for (const [kind, table, fields, values] of [
      ['recipient', 'recipients', 'name,normalized_name,address,address_confirmed_at', "'Sofía','sofía','fixture',now()"],
      ['fact', 'user_memories', 'fact,confirmed_at', "'Sofía es mi hija',now()"],
    ]) {
      const owner = randomUUID();
      await migration.query('INSERT INTO public.users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
      const sql = `INSERT INTO public.${table}(user_id,${fields},embedding,embedding_model_revision)
        VALUES($1,${values},$2,'legacy') RETURNING *`;
      for (const commit of [false, true]) {
        await migration.query('BEGIN');
        try {
          const { rows: [source] } = await migration.query(sql, [owner, JSON.stringify([1, ...Array(383).fill(0)])]);
          const { rows: [job] } = await migration.query(insertJob, [kind, owner, source.id, source.embedding_incarnation, 1, revision]);
          expect((await migration.query(`SELECT * FROM public.${table} WHERE id=$1`, [source.id])).rows).toEqual([source]);
          await migration.query(commit ? 'COMMIT' : 'ROLLBACK');
          expect((await migration.query(`SELECT * FROM public.${table} WHERE id=$1`, [source.id])).rowCount).toBe(commit ? 1 : 0);
          expect((await migration.query('SELECT * FROM embedding_private.jobs WHERE id=$1', [job.id])).rowCount).toBe(commit ? 1 : 0);
        } finally { await migration.query('ROLLBACK'); }
      }
    }
  });

  it('refuses PUBLIC and all normal roles, including table access even with temporary schema USAGE', async () => {
    const { migration } = fixture;
    // Test-only roles are transactional: never leave cluster roles behind.
    await migration.query('BEGIN');
    try {
      await migration.query(`DO $$ BEGIN
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
        IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
      END $$`);
      // Reapply the real DDL inside this rollback-only fixture with hostile pre-existing grants.
      await migration.query(`DROP TABLE embedding_private.jobs;
        GRANT ALL ON SCHEMA embedding_private TO PUBLIC,recipient_app,anon,authenticated;
        ALTER DEFAULT PRIVILEGES IN SCHEMA embedding_private GRANT ALL ON TABLES TO PUBLIC,recipient_app,anon,authenticated;
        CREATE SEQUENCE embedding_private.test_sequence;
        CREATE FUNCTION embedding_private.test_function() RETURNS integer LANGUAGE sql AS 'SELECT 1';
        GRANT ALL ON ALL TABLES IN SCHEMA embedding_private TO PUBLIC,recipient_app,anon,authenticated;
        GRANT ALL ON ALL SEQUENCES IN SCHEMA embedding_private TO PUBLIC,recipient_app,anon,authenticated;
        GRANT ALL ON ALL FUNCTIONS IN SCHEMA embedding_private TO PUBLIC,recipient_app,anon,authenticated;`);
      await migration.query(await readFile(`${chain === 'supabase' ? 'supabase' : 'src/db'}/migrations/${outboxNames[chain]}`, 'utf8'));
      expect((await migration.query(`SELECT count(*)::int AS count FROM pg_class c,
        LATERAL aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
        WHERE c.oid='embedding_private.jobs'::regclass AND a.grantee=0`)).rows[0]?.count).toBe(0);
      for (const role of ['recipient_app', 'anon', 'authenticated']) {
        expect((await migration.query("SELECT has_schema_privilege($1,'embedding_private','USAGE') AS allowed", [role])).rows[0]?.allowed).toBe(false);
        expect((await migration.query(`SELECT has_sequence_privilege($1,'embedding_private.test_sequence','USAGE') AS sequence,
          has_function_privilege($1,'embedding_private.test_function()','EXECUTE') AS function,
          has_table_privilege($1,'embedding_private.control','SELECT') AS control`, [role])).rows[0])
          .toEqual({ sequence: false, function: false, control: false });
        for (const grantUsage of [false, true]) {
          if (grantUsage) await migration.query(`GRANT USAGE ON SCHEMA embedding_private TO ${role}`);
          for (const sql of ['SELECT * FROM embedding_private.jobs', 'DELETE FROM embedding_private.jobs',
            "UPDATE embedding_private.jobs SET state='done'", 'INSERT INTO embedding_private.jobs DEFAULT VALUES', 'TRUNCATE embedding_private.jobs']) {
            await migration.query('SAVEPOINT role_refusal');
            await migration.query(`SET LOCAL ROLE ${role}`);
            await expect(migration.query(sql)).rejects.toMatchObject({ code: '42501' });
            await migration.query('ROLLBACK TO SAVEPOINT role_refusal');
          }
        }
      }
    } finally { await migration.query('ROLLBACK'); }
  });
});

const domains = [
  ['recipient', 'recipients', 'name,normalized_name,address,address_confirmed_at', "'Sofía','sofía','fixture',now()", 'description'],
  ['fact', 'user_memories', 'fact,confirmed_at', "'Sofía es mi hija',now()", 'fact'],
] as const;
const vector = JSON.stringify([1, ...Array(383).fill(0)]);

describe.each(chains)('U1.3 guarded lifecycle L1-L3/T5/T11: %s', (chain) => {
  let contracts: unknown;
  const contractsSql = `SELECT oid::regclass::text AS source,relacl,relrowsecurity,relforcerowsecurity,
    (SELECT jsonb_agg(to_jsonb(p)) FROM pg_policy p WHERE polrelid=c.oid) AS policies
    FROM pg_class c WHERE oid IN ('recipients'::regclass,'user_memories'::regclass) ORDER BY source`;
  let fixture: Awaited<ReturnType<typeof embeddingDatabase>>;
  beforeAll(async () => {
    fixture = await embeddingDatabase(chain);
    await fixture.applyFoundation(); await fixture.applyOutbox();
    contracts = (await fixture.database.query(contractsSql)).rows;
    await fixture.applyLifecycle();
  }, 30_000);
  afterAll(async () => { await fixture?.cleanup(); });

  it('keeps dormant NOT NULL, ACL/RLS contracts and rejects invalid legacy vectors/revisions after nullable fixture expansion', async () => {
    const { migration: db } = fixture;
    expect((await db.query(contractsSql)).rows).toEqual(contracts);
    expect((await db.query(sourceGrantsSql)).rows.every((r) => r.relacl.includes('recipient_app=arwd'))).toBe(true);
    expect((await db.query(`SELECT count(*)::int AS n FROM pg_class WHERE oid IN ('recipients'::regclass,'user_memories'::regclass)
      AND relrowsecurity AND relforcerowsecurity`)).rows[0].n).toBe(2);
    expect((await db.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name IN ('recipients','user_memories')
      AND column_name IN ('embedding','embedding_model_revision') AND is_nullable='NO'`)).rows[0].n).toBe(4);
    await db.query('BEGIN');
    try {
      const owner = randomUUID();
      await db.query('INSERT INTO public.users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
      for (const [, table, fields, values] of domains) {
        await db.query(`ALTER TABLE public.${table} ALTER COLUMN embedding DROP NOT NULL, ALTER COLUMN embedding_model_revision DROP NOT NULL`);
        for (const [v, rev] of [[null, 'legacy'], [vector, null], [vector, '  '], [JSON.stringify(Array(384).fill(0)), 'legacy']]) {
          await db.query('SAVEPOINT invalid_legacy');
          await expect(db.query(`INSERT INTO public.${table}(user_id,${fields},embedding,embedding_model_revision) VALUES($1,${values},$2,$3)`,
            [owner, v, rev])).rejects.toMatchObject({ code: '23514' });
          await db.query('ROLLBACK TO SAVEPOINT invalid_legacy');
        }
        await db.query(`ALTER TABLE public.${table} ALTER COLUMN embedding TYPE ${chain === 'supabase' ? 'extensions' : 'public'}.vector`);
        await db.query('SAVEPOINT invalid_dimension');
        await expect(db.query(`INSERT INTO public.${table}(user_id,${fields},embedding,embedding_model_revision) VALUES($1,${values},'[1,0]','legacy')`, [owner]))
          .rejects.toMatchObject({ code: '23514' });
        await db.query('ROLLBACK TO SAVEPOINT invalid_dimension');
      }
      expect((await db.query('SELECT count(*)::int AS n FROM embedding_private.jobs')).rows[0].n).toBe(0);
    } finally { await db.query('ROLLBACK'); }
  });

  it.each(domains.flatMap((d) => ['edit','archive','delete','completion'].map((action) => [action, ...d] as const)))
    ('%s: %s mapped T5/T11', async (action, kind, table, fields, values, text) => {
      const { migration: db } = fixture;
      await db.query('BEGIN');
      try {
        await db.query(`ALTER TABLE public.${table} ALTER COLUMN embedding DROP NOT NULL, ALTER COLUMN embedding_model_revision DROP NOT NULL`);
        const owner = randomUUID();
        await db.query('INSERT INTO public.users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
        const { rows: [source] } = await db.query(`INSERT INTO public.${table}(user_id,${fields},embedding,embedding_model_revision,embedding_generation,desired_embedding_revision)
          VALUES($1,${values},$2,'legacy',1,$3) RETURNING *`, [owner, vector, revision]);
        await db.query(insertJob, [kind, owner, source.id, source.embedding_incarnation, 1, revision]);
        await db.query(`UPDATE embedding_private.jobs SET state='leased',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds'`);
        await db.query('UPDATE embedding_private.control SET activated=true');
        if (action === 'completion') {
          await db.query(`UPDATE public.${table} SET embedding=$2,embedding_model_revision='legacy' WHERE id=$1`, [source.id, vector]);
          expect((await db.query(`SELECT * FROM public.${table} WHERE id=$1`, [source.id])).rows).toEqual([source]);
          expect((await db.query('SELECT * FROM embedding_private.jobs')).rowCount).toBe(1);
        } else {
          await db.query(action === 'delete' ? `DELETE FROM public.${table} WHERE id=$1` :
            `UPDATE public.${table} SET ${action === 'archive' ? "status='inactive'" : `${text}='Nuevo texto'`} WHERE id=$1`, [source.id]);
          expect((await db.query('SELECT state,claim_token,lease_until FROM embedding_private.jobs WHERE generation=1')).rows)
            .toEqual([{ state: 'superseded', claim_token: null, lease_until: null }]);
        }
      } finally { await db.query('ROLLBACK'); }
    });

  it.each(domains)('%s: atomically queues, fences lifecycle identity and preserves business data on metadata completion', async (kind, table, fields, values, text) => {
    const { migration: db } = fixture;
    await db.query('BEGIN');
    try {
      // U1.4 owns production nullability/activation; this expansion is rollback-only.
      await db.query(`ALTER TABLE public.${table} ALTER COLUMN embedding DROP NOT NULL, ALTER COLUMN embedding_model_revision DROP NOT NULL`);
      await db.query('UPDATE embedding_private.control SET activated=true');
      const owner = randomUUID(); const other = randomUUID();
      await db.query('INSERT INTO public.users(id,privy_did) VALUES($1,$2),($3,$4)', [owner, `did:privy:${owner}`, other, `did:privy:${other}`]);
      const insert = `INSERT INTO public.${table}(user_id,${fields}) VALUES($1,${values}) RETURNING *`;
      const { rows: [source] } = await db.query(insert, [owner]);
      const read = async () => (await db.query(`SELECT * FROM public.${table} WHERE id=$1`, [source.id])).rows[0];
      const jobs = async () => (await db.query('SELECT * FROM embedding_private.jobs WHERE source_id=$1 ORDER BY generation,created_at', [source.id])).rows;
      expect(source).toMatchObject({ embedding: null, embedding_model_revision: null, embedding_generation: '1', embedding_state: 'pending', desired_embedding_revision: revision });
      expect(await jobs()).toMatchObject([{ kind, owner_id: owner, incarnation: source.embedding_incarnation, generation: '1', revision, state: 'pending' }]);
      for (const mutation of ["id=gen_random_uuid()", `user_id='${other}'`]) {
        await db.query('SAVEPOINT immutable_identity');
        await expect(db.query(`UPDATE public.${table} SET ${mutation} WHERE id=$1`, [source.id])).rejects.toMatchObject({ code: '23514' });
        await db.query('ROLLBACK TO SAVEPOINT immutable_identity');
      }
      await db.query(`UPDATE public.${table} SET provenance='{"origin":"fixture"}' WHERE id=$1`, [source.id]);
      if (kind === 'recipient') await db.query('UPDATE public.recipients SET address=$2 WHERE id=$1', [source.id, 'new-fixture-address']);
      expect((await read()).embedding_generation).toBe('1'); expect(await jobs()).toHaveLength(1);
      const financial = async () => { const snapshots = []; for (const t of ['recipient_versions','recipient_policy_state','recipient_policy_sync_intent','contact_action_proposals',
        'recipient_policy_audit','signer_grants','delegated_grants','grant_claim_ledger','grant_audit_log']) snapshots.push((await db.query(`SELECT to_jsonb(t) AS data FROM public.${t} t`)).rows); return snapshots; };
      if (kind === 'recipient') await db.query(`INSERT INTO public.recipient_versions(recipient_id,user_id,version,name,description,address)
        SELECT id,user_id,version,name,description,address FROM public.recipients WHERE id=$1`, [source.id]);
      const before = await read(); const policyBefore = await financial();
      await db.query(`UPDATE public.${table} SET embedding=$2,embedding_model_revision=$3,embedding_state='ready' WHERE id=$1`, [source.id, vector, revision]);
      expect(await read()).toEqual({ ...before, embedding: vector, embedding_model_revision: revision, embedding_state: 'ready' });
      expect(await financial()).toEqual(policyBefore); expect(await jobs()).toHaveLength(1);
      await db.query(`UPDATE embedding_private.jobs SET state='leased',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' WHERE source_id=$1`, [source.id]);
      await db.query(`UPDATE public.${table} SET ${text}=$2 WHERE id=$1`, [source.id, 'Contenido nuevo']);
      expect(await jobs()).toMatchObject([{ generation: '1', state: 'superseded', claim_token: null, lease_until: null }, { generation: '2', state: 'pending' }]);
      expect(await read()).toMatchObject({ embedding: null, embedding_model_revision: null, embedding_generation: '2', version: source.version });
      await db.query(`UPDATE public.${table} SET status='inactive' WHERE id=$1`, [source.id]);
      expect(await read()).toMatchObject({ embedding_generation: '3', embedding_state: 'inactive', version: source.version });
      expect((await jobs()).every((j) => j.state === 'superseded')).toBe(true);
      expect(await financial()).toEqual(policyBefore);
      await db.query(`UPDATE public.${table} SET status='active' WHERE id=$1`, [source.id]);
      expect(await read()).toMatchObject({ embedding_generation: '4', embedding_state: 'pending', embedding_incarnation: source.embedding_incarnation });
      await db.query(`UPDATE public.${table} SET desired_embedding_revision='fixture-retarget' WHERE id=$1`, [source.id]);
      expect(await read()).toMatchObject({ embedding_generation: '5', desired_embedding_revision: revision });
      await db.query(`UPDATE embedding_private.jobs SET state='leased',claim_token=gen_random_uuid(),lease_until=now()+interval '90 seconds' WHERE source_id=$1 AND generation=5`, [source.id]);
      if (kind === 'recipient') await db.query('DELETE FROM public.recipient_versions WHERE recipient_id=$1', [source.id]);
      await db.query(`DELETE FROM public.${table} WHERE id=$1`, [source.id]);
      expect(await read()).toBeUndefined(); expect((await jobs()).every((j) => j.state === 'superseded' && j.claim_token === null && j.lease_until === null)).toBe(true);
      await db.query(`INSERT INTO public.${table}(id,user_id,${fields}) VALUES($1,$2,${values})`, [source.id, owner]);
      expect(await read()).toMatchObject({ embedding_generation: '1', embedding_state: 'pending', version: '1' });
      expect((await read()).embedding_incarnation).not.toBe(source.embedding_incarnation);
      expect((await jobs()).filter((j) => j.state === 'pending')).toHaveLength(1);
      await db.query('SAVEPOINT atomic_insert');
      const { rows: [rolledBack] } = await db.query(insert, [owner]);
      expect((await db.query('SELECT * FROM embedding_private.jobs WHERE source_id=$1', [rolledBack.id])).rowCount).toBe(1);
      await db.query('ROLLBACK TO SAVEPOINT atomic_insert');
      expect((await db.query(`SELECT * FROM public.${table} WHERE id=$1`, [rolledBack.id])).rowCount).toBe(0);
      expect((await db.query('SELECT * FROM embedding_private.jobs WHERE source_id=$1', [rolledBack.id])).rowCount).toBe(0);
      await db.query('SAVEPOINT atomic_update');
      const stable = await read(); const stableJobs = await jobs();
      await db.query(`UPDATE public.${table} SET ${text}=$2 WHERE id=$1`, [source.id, 'Cambio revertido']);
      await db.query('ROLLBACK TO SAVEPOINT atomic_update');
      expect(await read()).toEqual(stable); expect(await jobs()).toEqual(stableJobs);
      await db.query("ALTER TABLE embedding_private.jobs ADD CONSTRAINT fixture_queue_failure CHECK (revision <> 'openai:text-embedding-3-small:384:nana-text-v1:l2:epoch1') NOT VALID");
      await db.query('SAVEPOINT failed_outbox');
      await expect(db.query(`UPDATE public.${table} SET ${text}=$2 WHERE id=$1`, [source.id, 'No debe persistir'])).rejects.toMatchObject({ code: '23514' });
      await db.query('ROLLBACK TO SAVEPOINT failed_outbox');
      expect(await read()).toEqual(stable); expect(await jobs()).toEqual(stableJobs);
    } finally { await db.query('ROLLBACK'); }
  });

  it('L1a/L1b: publishes both domains and jobs only at COMMIT, observed from another connection', async () => {
    const runtime = await embeddingDatabase(chain);
    try {
      await runtime.applyFoundation(); await runtime.applyOutbox(); await runtime.applyLifecycle();
      const db = runtime.migration; const owner = randomUUID();
      await db.query('BEGIN');
      await db.query('UPDATE embedding_private.control SET activated=true');
      await db.query('INSERT INTO public.users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
      for (const [, table, fields, values] of domains) {
        await db.query(`ALTER TABLE public.${table} ALTER COLUMN embedding DROP NOT NULL, ALTER COLUMN embedding_model_revision DROP NOT NULL`);
        await db.query(`INSERT INTO public.${table}(user_id,${fields}) VALUES($1,${values})`, [owner]);
      }
      expect((await runtime.database.query('SELECT * FROM embedding_private.jobs')).rowCount).toBe(0);
      await db.query('COMMIT');
      expect((await runtime.database.query('SELECT kind,state FROM embedding_private.jobs ORDER BY kind')).rows)
        .toEqual([{ kind: 'fact', state: 'pending' }, { kind: 'recipient', state: 'pending' }]);
      for (const [, table] of domains) expect((await runtime.database.query(`SELECT embedding_generation,embedding FROM public.${table}`)).rows)
        .toEqual([{ embedding_generation: '1', embedding: null }]);
    } finally { await runtime.migration.query('ROLLBACK'); await runtime.cleanup(); }
  });

});
