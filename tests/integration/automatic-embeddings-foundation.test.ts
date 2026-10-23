import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { embeddingDatabase, chains } from './helpers/embedding-database.js';

describe('U1.1 fresh-chain foundation parity (L6a/T12)', () => {
  const fixtures: Awaited<ReturnType<typeof embeddingDatabase>>[] = [];
  beforeAll(async () => {
    for (const chain of chains) {
      const fixture = await embeddingDatabase(chain);
      fixtures.push(fixture);
      await fixture.applyFoundation();
    }
  }, 30_000);
  afterAll(async () => { for (const fixture of fixtures) await fixture.cleanup(); });

  it('migrates through CI psql and the actual mirror runner under their default search paths', async () => {
    for (const [index, fixture] of fixtures.entries()) {
      expect(fixture.migrationSearchPath()).toBe('"$user", public');
      expect((await fixture.database.query(`SELECT n.nspname FROM pg_extension e
        JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='vector'`)).rows)
        .toEqual([{ nspname: chains[index] === 'supabase' ? 'extensions' : 'public' }]);
    }
  });

  it('keeps both chains equivalent, required legacy fields and forced RLS intact', async () => {
    const snapshots = [];
    for (const { database } of fixtures) {
      const columns = await database.query(`SELECT table_name, column_name, data_type, is_nullable, column_default
        FROM information_schema.columns WHERE table_schema='public' AND table_name IN ('recipients','user_memories')
        AND column_name IN ('embedding','embedding_model_revision','embedding_generation','embedding_incarnation','desired_embedding_revision','embedding_state')
        ORDER BY table_name, column_name`);
      expect(columns.rows).toHaveLength(12);
      for (const row of columns.rows) expect(row.is_nullable).toBe(row.column_name === 'desired_embedding_revision' ? 'YES' : 'NO');
      const constraints = await database.query(`SELECT conrelid::regclass::text AS source, pg_get_constraintdef(oid) AS definition
        FROM pg_constraint WHERE conrelid IN ('recipients'::regclass,'user_memories'::regclass)
        AND conname LIKE '%embedding%' ORDER BY source, definition`);
      expect(constraints.rows).toHaveLength(6);
      snapshots.push({ columns: columns.rows, constraints: constraints.rows });
      expect((await database.query(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE oid IN ('recipients'::regclass,'user_memories'::regclass)`)).rows)
        .toEqual([{ relrowsecurity: true, relforcerowsecurity: true }, { relrowsecurity: true, relforcerowsecurity: true }]);
    }
    expect(snapshots[0]).toEqual(snapshots[1]);
  });

  it('creates one disabled private control with a fixed target and no jobs or source triggers', async () => {
    for (const { database } of fixtures) {
      expect((await database.query(`SELECT activated, claims_enabled, semantic_enabled, target_revision,
        run_token, run_until, pause_code, request_count, canonical_bytes FROM embedding_private.control`)).rows)
        .toEqual([{ activated: false, claims_enabled: false, semantic_enabled: false,
          target_revision: 'openai:text-embedding-3-small:384:nana-text-v1:l2:epoch1',
          run_token: null, run_until: null, pause_code: null, request_count: 0, canonical_bytes: 0 }]);
      expect((await database.query(`SELECT to_regclass('embedding_private.jobs') AS jobs,
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid IN ('recipients'::regclass,'user_memories'::regclass) AND NOT tgisinternal) AS triggers`)).rows)
        .toEqual([{ jobs: null, triggers: 0 }]);
      await expect(database.withUserTransaction('00000000-0000-0000-0000-000000000001', (client) =>
        client.query('SELECT * FROM embedding_private.control'))).rejects.toMatchObject({ code: '42501' });
      await expect(database.query('INSERT INTO embedding_private.control(singleton) VALUES(false)')).rejects.toMatchObject({ code: '23514' });
    }
  });

  it('rejects invalid metadata and ready vectors without weakening legacy NOT NULL', async () => {
    for (const { database } of fixtures) {
      await database.query("INSERT INTO users(id,privy_did) VALUES('00000000-0000-0000-0000-000000000001','did:privy:foundation')");
      for (const table of ['recipients', 'user_memories']) {
        const fields = table === 'recipients' ? "name,normalized_name,address,address_confirmed_at" : 'fact,confirmed_at';
        const values = table === 'recipients' ? "'Sofía','sofía','fixture',now()" : "'Sofía es mi hija',now()";
        const insert = `INSERT INTO ${table}(user_id,${fields},embedding,embedding_model_revision)
          VALUES('00000000-0000-0000-0000-000000000001',${values},$1::vector,'legacy') RETURNING id`;
        await expect(database.query(insert, [null])).rejects.toMatchObject({ code: '23502' });
        const { rows: [row] } = await database.query(insert, [JSON.stringify([1, ...Array(383).fill(0)])]);
        for (const mutation of ["embedding_generation=-1", "embedding_state='unknown'", "embedding_state='ready'",
          "embedding_state='ready',desired_embedding_revision='other'", "embedding_state='ready',desired_embedding_revision='legacy',embedding=$1::vector"]) {
          await expect(database.query(`UPDATE ${table} SET ${mutation} WHERE id='${row.id}'`,
            mutation.includes('$1') ? [JSON.stringify(Array(384).fill(0))] : [])).rejects.toMatchObject({ code: '23514' });
        }
        await database.query(`UPDATE ${table} SET embedding_state='ready',desired_embedding_revision='legacy' WHERE id=$1`, [row.id]);
        // In this scratch database, remove the typmod to exercise the CHECK's dimension rule itself.
        await database.query(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector`);
        await expect(database.query(`UPDATE ${table} SET embedding='[1,0]' WHERE id=$1`, [row.id])).rejects.toMatchObject({ code: '23514' });
        await database.query(`ALTER TABLE ${table} ALTER COLUMN embedding TYPE vector(384)`);
      }
    }
  });
});
