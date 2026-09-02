import { afterEach, describe, expect, it } from 'vitest';
import { createDatabaseClient, type DatabaseClient } from '../../src/db/client.js';
import { PostgresConversationRepository } from '../../src/conversations/postgres-repository.js';

const databaseUrl = process.env.DATABASE_URL;
const userId = '11111111-1111-4111-8111-111111111111';

describe('conversation transfer resolution', () => {
  let database: DatabaseClient | undefined;

  afterEach(async () => {
    await database?.close();
    database = undefined;
  });

  it.skipIf(!databaseUrl)('claims one preview atomically across independent repository clients', async () => {
    database = createDatabaseClient(databaseUrl!);
    const primary = new PostgresConversationRepository(database);
    const conversation = await primary.create(userId);
    const transfer = {
      network: 'sepolia', token: 'USDT', to: '0x1234000000000000000000000000000000abcd', amount: '10', wallet: 'agent-demo',
      preview: { network: 'sepolia', token: 'USDT', recipient: '0x1234000000000000000000000000000000abcd', amount: '10', estimatedFee: '0.0003 ETH' },
    };
    await primary.setPendingTransfer(userId, conversation.id, transfer);

    const otherDatabase = createDatabaseClient(databaseUrl!);
    try {
      const other = new PostgresConversationRepository(otherDatabase);
      const [first, second] = await Promise.all([
        primary.claimPendingTransfer(userId, conversation.id),
        other.claimPendingTransfer(userId, conversation.id),
      ]);
      expect([first.status, second.status].sort()).toEqual(['broadcasting', 'claimed']);
      expect([first, second].filter((result) => result.status === 'claimed')).toHaveLength(1);
    } finally {
      await otherDatabase.close();
    }
  });

  it.skipIf(!databaseUrl)('enforces tenant isolation and preserves ordered durable messages', async () => {
    database = createDatabaseClient(databaseUrl!);
    const repository = new PostgresConversationRepository(database);
    const conversation = await repository.create(userId);
    await repository.appendMessage(userId, conversation.id, { role: 'user', content: 'first' });
    await repository.appendMessage(userId, conversation.id, { role: 'assistant', content: 'second' });

    const visible = await repository.get(userId, conversation.id);
    expect(visible?.messages.map((message) => message.content)).toEqual(['first', 'second']);
    expect(await repository.get('22222222-2222-4222-8222-222222222222', conversation.id)).toBeUndefined();
  });

  it.skipIf(!databaseUrl)('allows one live lease and rejects stale worker mutations', async () => {
    database = createDatabaseClient(databaseUrl!);
    const repository = new PostgresConversationRepository(database);
    const conversation = await repository.create(userId);
    const lease = {
      conversationId: conversation.id,
      userId,
      bindingJti: '55555555-5555-4555-8555-555555555555',
      participantIdentity: 'participant-1',
      workerId: 'worker-1',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await expect(repository.acquireLiveLease(lease)).resolves.toMatchObject({ status: 'acquired' });
    await expect(repository.acquireLiveLease({ ...lease, bindingJti: '66666666-6666-4666-8666-666666666666', workerId: 'worker-2' })).resolves.toMatchObject({ status: 'already_live' });
    await expect(repository.renewLiveLease({ ...lease, workerId: 'worker-2' })).resolves.toBe(false);
    await expect(repository.releaseLiveLease({ ...lease, workerId: 'worker-2' })).resolves.toBe(false);
    await expect(repository.releaseLiveLease(lease)).resolves.toBe(true);
  });
});
