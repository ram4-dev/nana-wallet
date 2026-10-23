import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ContactsRepository } from '../../src/memory/contacts-repository.js';
import { RecipientMemoryRepository } from '../../src/memory/repository.js';
import { chains, embeddingDatabase } from '../integration/helpers/embedding-database.js';

const vector = [1, ...Array(383).fill(0)];
const model = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';

describe.each(chains)('U1.1 dormant legacy E2E: %s', (chain) => {
  it.each(['foundation', 'outbox', 'lifecycle'])('preserves legacy data, writers/readers, role isolation and history after %s', async (stage) => {
    const fixture = await embeddingDatabase(chain);
    const { database } = fixture;
    try {
      const owner = randomUUID();
      await database.query('INSERT INTO users(id,privy_did) VALUES($1,$2)', [owner, `did:privy:${owner}`]);
      const contacts = new ContactsRepository(database);
      const memory = new RecipientMemoryRepository(database);
      const input = { name: 'Sofía', description: 'Mi hija', address: 'So11111111111111111111111111111111111111112', network: 'solana-devnet' as const };
      const first = await contacts.create(owner, input, vector, model);
      await contacts.update(owner, first.id, { description: 'Mi hija mayor', expectedVersion: 1 }, vector, model);
      const fact = await memory.insertFact(owner, { fact: 'Sofía es mi hija' }, vector, model);
      const snapshot = async () => (await database.query(`SELECT 'recipient' AS kind,
        to_jsonb(r) - ARRAY['embedding_generation','embedding_incarnation','desired_embedding_revision','embedding_state'] AS data
        FROM recipients r UNION ALL SELECT 'fact', to_jsonb(m) - ARRAY['embedding_generation','embedding_incarnation','desired_embedding_revision','embedding_state']
        FROM user_memories m UNION ALL SELECT 'history', to_jsonb(v) FROM recipient_versions v ORDER BY kind`)).rows;
      const before = await snapshot();
      await fixture.applyFoundation();
      if (stage !== 'foundation') await fixture.applyOutbox();
      if (stage === 'lifecycle') await fixture.applyLifecycle();
      expect(await snapshot()).toEqual(before);
      for (const table of ['recipients', 'user_memories']) {
        expect((await database.query(`SELECT embedding_generation, desired_embedding_revision, embedding_state,
          embedding_incarnation IS NOT NULL AS incarnation FROM ${table}`)).rows)
          .toEqual([{ embedding_generation: '0', desired_embedding_revision: null, embedding_state: 'pending', incarnation: true }]);
      }
      const created = await contacts.create(owner, { ...input, name: 'Ana' }, vector, model);
      const updated = await contacts.update(owner, created.id, { description: 'Hermana', expectedVersion: 1 }, vector, model);
      expect(updated.version).toBe(2);
      const secondFact = await memory.insertFact(owner, { fact: 'Ana es mi hermana' }, vector, model);
      await database.withUserTransaction(owner, (client) => client.query('UPDATE user_memories SET fact=$2 WHERE id=$1', [secondFact.id, 'Ana es mi hermana mayor']));
      expect((await memory.searchRecipients(owner, 'Ana', vector)).map((row) => row.id)).toContain(created.id);
      expect((await memory.searchFacts(owner, 'hermana', vector)).map((row) => row.id)).toEqual(expect.arrayContaining([fact.id, secondFact.id]));
      expect((await contacts.read(owner, created.id))?.description).toBe('Hermana');
      expect(await contacts.listActive(randomUUID())).toEqual([]);
      expect(await memory.searchFacts(randomUUID(), 'hija', vector)).toEqual([]);
      expect((await database.withUserTransaction(owner, (client) => client.query('SELECT current_user AS role'))).rows[0]?.role).toBe('recipient_app');
      for (const table of ['recipients', 'user_memories']) {
        expect((await database.query(`SELECT count(*)::int AS count FROM ${table} WHERE embedding_model_revision=$1
          AND embedding=$2::vector AND embedding_generation=0 AND embedding_state='pending' AND desired_embedding_revision IS NULL`, [model, JSON.stringify(vector)])).rows[0]?.count).toBe(2);
      }
      expect((await database.query('SELECT count(DISTINCT embedding_incarnation)::int AS count FROM (SELECT embedding_incarnation FROM recipients UNION ALL SELECT embedding_incarnation FROM user_memories) s')).rows[0]?.count).toBe(4);
      expect((await database.query('SELECT activated, claims_enabled, semantic_enabled FROM embedding_private.control')).rows[0])
        .toEqual({ activated: false, claims_enabled: false, semantic_enabled: false });
      if (stage !== 'foundation') expect((await database.query('SELECT count(*)::int AS count FROM embedding_private.jobs')).rows[0]?.count).toBe(0);
    } finally { await fixture.cleanup(); }
  }, 30_000);
});
