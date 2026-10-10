import { describe, expect, it } from 'vitest';
import type { DatabaseClient, Queryable } from '../../src/db/client.js';
import {
  isValidRecipientAddress,
  resolveRecipientNetwork,
} from '../../src/memory/address.js';
import { ContactsRepository } from '../../src/memory/contacts-repository.js';
import { RecipientMemoryRepository } from '../../src/memory/repository.js';
import type { Embedding } from '../../src/memory/types.js';

/**
 * RAM-009: the recipient WRITE path must validate for the configured chain.
 *
 * A create body that omits `network` used to fall through to the EVM regex,
 * because the shared validator treats "no network" as "legacy EVM". On this
 * deployment the configured chain is Solana devnet, so omitting the field must
 * resolve that chain — never accept an `0x`-shaped address.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';

type Recorded = { text: string; values: unknown[] };

const VECTOR: Embedding = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));

function databaseWith(row: Record<string, unknown> | undefined) {
  const recorded: Recorded[] = [];
  const database = {
    withUserTransaction: async <T>(
      _userId: string,
      run: (client: Queryable) => Promise<T>,
    ): Promise<T> =>
      run({
        query: async (text: string, values: unknown[] = []) => {
          recorded.push({ text, values });
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        },
      } as unknown as Queryable),
  } as unknown as DatabaseClient;
  return { database, recorded };
}

const CONTACT_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Lucas',
  description: 'mi nieto',
  address: SOLANA_ADDRESS,
  network: 'solana-devnet',
  version: 1,
  status: 'active',
  created_at: '2026-01-01T00:00:00.000Z',
  updated_at: '2026-01-01T00:00:00.000Z',
};

const MEMORY_ROW = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  user_id: USER_ID,
  name: 'Lucas',
  normalized_name: 'lucas',
  description: 'mi nieto',
  address: SOLANA_ADDRESS,
  network: 'solana-devnet',
  version: '1',
  status: 'active',
  embedding_model_revision: 'test',
};

function wroteARecipient(recorded: Recorded[]): boolean {
  return recorded.some((entry) => entry.text.includes('INSERT INTO recipients'));
}

describe('recipient write path resolves the configured chain (RAM-009)', () => {
  it('resolves the configured chain when the body carries no network', () => {
    // The configured chain is Solana devnet, and an absent network resolves it
    // instead of the legacy EVM regex.
    expect(resolveRecipientNetwork(undefined)).toBe('solana-devnet');
    expect(resolveRecipientNetwork(null)).toBe('solana-devnet');
    expect(resolveRecipientNetwork('solana-devnet')).toBe('solana-devnet');
    expect(isValidRecipientAddress(EVM_ADDRESS, resolveRecipientNetwork(undefined))).toBe(false);
    expect(isValidRecipientAddress(SOLANA_ADDRESS, resolveRecipientNetwork(null))).toBe(true);
  });

  it('accepts a canonical base58 key and persists it as the configured chain', async () => {
    const { database, recorded } = databaseWith(CONTACT_ROW);
    const contacts = new ContactsRepository(database);

    const created = await contacts.create(
      USER_ID,
      { name: 'Lucas', description: 'mi nieto', address: SOLANA_ADDRESS },
      VECTOR,
      'test',
    );

    expect(created.network).toBe('solana-devnet');
    expect(created.address).toBe(SOLANA_ADDRESS);
    const insert = recorded.find((entry) => entry.text.includes('INSERT INTO recipients'));
    expect(insert, 'the contact write must reach the database').toBeDefined();
    // The stored network is the RESOLVED chain, not the absent body field.
    expect(insert!.values[5]).toBe('solana-devnet');
  });

  it('fails closed on an EVM-shaped address and persists nothing', async () => {
    const { database, recorded } = databaseWith(CONTACT_ROW);
    const contacts = new ContactsRepository(database);

    await expect(
      contacts.create(
        USER_ID,
        { name: 'Lucas', description: 'mi nieto', address: EVM_ADDRESS },
        VECTOR,
        'test',
      ),
    ).rejects.toThrow(/address must match the selected network/);
    expect(wroteARecipient(recorded)).toBe(false);
  });

  it('fails closed on a malformed value and persists nothing', async () => {
    const { database, recorded } = databaseWith(CONTACT_ROW);
    const contacts = new ContactsRepository(database);

    await expect(
      contacts.create(
        USER_ID,
        { name: 'Lucas', description: 'mi nieto', address: 'not-an-address' },
        VECTOR,
        'test',
      ),
    ).rejects.toThrow(/address must match the selected network/);
    expect(wroteARecipient(recorded)).toBe(false);
  });

  it('refuses an EVM-shaped address on the recipient edit path', async () => {
    const { database, recorded } = databaseWith({
      ...CONTACT_ROW,
      network: 'solana-devnet',
    });
    const contacts = new ContactsRepository(database);

    await expect(
      contacts.update(
        USER_ID,
        CONTACT_ROW.id,
        { address: EVM_ADDRESS, expectedVersion: 1 },
        VECTOR,
        'test',
      ),
    ).rejects.toThrow(/address must match the selected network/);
    expect(recorded.some((entry) => entry.text.includes('UPDATE recipients'))).toBe(false);
  });

  it('fails closed on the agent memory write path too', async () => {
    const { database, recorded } = databaseWith(MEMORY_ROW);
    const repository = new RecipientMemoryRepository(database);

    await expect(
      repository.insertRecipient(
        USER_ID,
        { name: 'Lucas', description: 'mi nieto', address: EVM_ADDRESS },
        VECTOR,
        'test',
      ),
    ).rejects.toThrow(/canonical Solana/);
    expect(wroteARecipient(recorded)).toBe(false);

    const accepted = await repository.insertRecipient(
      USER_ID,
      { name: 'Lucas', description: 'mi nieto', address: SOLANA_ADDRESS },
      VECTOR,
      'test',
    );
    expect(accepted.network).toBe('solana-devnet');
    const insert = recorded.find((entry) => entry.text.includes('INSERT INTO recipients'));
    expect(insert!.values[5]).toBe('solana-devnet');
  });
});
