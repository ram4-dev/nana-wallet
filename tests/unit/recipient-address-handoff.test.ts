import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSession,
  getSession,
  resetSessionStore,
  setSelectedRecipient,
} from '../../src/conversations/test-fixtures.js';
import { RecipientMemoryService } from '../../src/memory/service.js';
import type { RecipientMemoryRepositoryPort } from '../../src/memory/service.js';
import { createRecipientMemoryTools } from '../../src/memory/tools.js';
import type { Embedding } from '../../src/memory/types.js';

/**
 * RAM-009: the SELECTED-ADDRESS handoff is a Solana-only boundary.
 *
 * `get_selected_recipient_address` hands a persisted address to the transfer
 * preview. A record stored without a network — the "unversioned" legacy shape —
 * used to resolve through the EVM regex, so an `0x`-shaped address could cross
 * the handoff on a Solana deployment. The lookup now validates against the
 * configured chain and refuses anything that is not a canonical base58 key.
 */

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SOLANA_ADDRESS = '9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM';
const EVM_ADDRESS = '0x1111111111111111111111111111111111111111';
const VECTOR: Embedding = Array.from({ length: 384 }, (_, index) => (index === 0 ? 1 : 0));

type StoredRecipient = {
  id: string;
  name: string;
  normalizedName: string;
  description: string;
  address: string;
  version: number;
  status: 'active' | 'inactive';
  embeddingModelRevision: string;
  network?: 'solana-devnet' | null;
};

function stored(overrides: Partial<StoredRecipient> = {}): StoredRecipient {
  return {
    id: RECIPIENT_ID,
    name: 'Lucas',
    normalizedName: 'lucas',
    description: 'mi nieto',
    address: SOLANA_ADDRESS,
    version: 3,
    status: 'active',
    embeddingModelRevision: 'test',
    ...overrides,
  };
}

function realService(record: StoredRecipient | undefined) {
  const port = {
    searchRecipients: vi.fn().mockResolvedValue([]),
    searchFacts: vi.fn().mockResolvedValue([]),
    getRecipientForVersion: vi.fn().mockResolvedValue(record),
    insertRecipient: vi.fn().mockResolvedValue({ ...stored(), userId: USER_ID }),
    insertFact: vi.fn().mockResolvedValue({
      id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
      fact: 'Lucas es mi nieto',
      kind: 'relationship',
      version: 1,
      evidence: 'Lucas es mi nieto',
      score: 0.9,
    }),
  } as unknown as RecipientMemoryRepositoryPort;
  const service = new RecipientMemoryService(
    port,
    { embed: vi.fn().mockResolvedValue(VECTOR) },
    { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 },
  );
  return { service, port };
}

function selectedTools(record: StoredRecipient | undefined, version = 3) {
  const { service, port } = realService(record);
  const session = createSession();
  setSelectedRecipient(session, { recipientId: RECIPIENT_ID, version });
  return {
    tools: createRecipientMemoryTools({ userId: USER_ID, session, service }),
    session,
    port,
  };
}

describe('selected recipient address handoff (RAM-009)', () => {
  beforeEach(() => resetSessionStore());

  it('hands over only a canonical base58 key for a solana-devnet recipient', async () => {
    const { tools } = selectedTools(stored({ network: 'solana-devnet' }));

    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({
      status: 'resolved',
      recipientId: RECIPIENT_ID,
      version: 3,
      address: SOLANA_ADDRESS,
    });
  });

  it('refuses an unversioned record holding an EVM-shaped address', async () => {
    const { tools, session, port } = selectedTools(stored({ address: EVM_ADDRESS, network: null }));

    // The service read IS the boundary the transfer previews and the voice/text
    // tools consult; it must refuse the record itself, not merely be saved by a
    // second check inside one caller.
    const record = await new RecipientMemoryService(
      port,
      { embed: vi.fn().mockResolvedValue(VECTOR) },
      { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 },
    ).getRecipientForVersion(USER_ID, RECIPIENT_ID, 3);
    expect(record).toBeUndefined();

    const result = await tools.get_selected_recipient_address({});

    expect(result).toEqual({ status: 'stale_selection' });
    expect(JSON.stringify(result)).not.toContain(EVM_ADDRESS);
    expect(getSession(session.id)?.recipientMemory?.selectedRecipient).toBeUndefined();
  });

  it('refuses a record that carries no network field at all', async () => {
    const { tools } = selectedTools(stored({ address: EVM_ADDRESS }));

    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({
      status: 'stale_selection',
    });
  });

  it('refuses a malformed stored value instead of leaking it', async () => {
    const { tools } = selectedTools(stored({ address: 'not-an-address', network: 'solana-devnet' }));

    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({
      status: 'stale_selection',
    });
  });

  it('refuses a stale handoff whose stored version moved on', async () => {
    const { tools } = selectedTools(stored({ network: 'solana-devnet', version: 4 }), 3);

    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({
      status: 'stale_selection',
    });
  });

  it('keeps confirmed fact memory on its separate path with no recipient write', async () => {
    const { service, port } = realService(undefined);

    const written = await service.writeConfirmed(USER_ID, {
      kind: 'fact',
      fact: 'Lucas es mi nieto',
      factKind: 'relationship',
    });

    expect(written.kind).toBe('fact');
    expect(port.insertFact).toHaveBeenCalledTimes(1);
    expect(port.insertRecipient).not.toHaveBeenCalled();
  });
});
