import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRecipientMemoryTools } from '../../src/memory/tools.js';
import { appendMessageById as appendMessage, confirmMemoryWrite, createSession, getSession, resetSessionStore } from '../../src/conversations/test-fixtures.js';
import type { RecipientMemoryService } from '../../src/memory/service.js';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const RECIPIENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ADDRESS = '0x1234567890123456789012345678901234567890';

function service(overrides: Partial<RecipientMemoryService> = {}): RecipientMemoryService {
  const unsafeCandidate = {
    id: RECIPIENT_ID,
    name: 'Lucas',
    normalizedName: 'lucas',
    description: 'my grandson',
    version: 3,
    status: 'active' as const,
    embeddingModelRevision: 'test',
    evidence: 'Lucas',
    score: 0.99,
    address: ADDRESS,
  };
  return {
    searchRecipients: vi.fn().mockResolvedValue({
      status: 'resolved',
      candidates: [unsafeCandidate],
      recipient: unsafeCandidate,
    }),
    searchUserMemory: vi.fn().mockResolvedValue({ status: 'ok', facts: [] }),
    getRecipientForVersion: vi.fn().mockResolvedValue({ id: RECIPIENT_ID, version: 3, address: ADDRESS }),
    writeConfirmed: vi.fn().mockResolvedValue({ kind: 'recipient', id: RECIPIENT_ID, version: 1, name: 'Lucas' }),
    ...overrides,
  } as unknown as RecipientMemoryService;
}

describe('recipient memory tool contracts', () => {
  beforeEach(() => resetSessionStore());

  it('RED: binds a resolved recipient to the session and never returns an address from search', async () => {
    const session = createSession();
    const tools = createRecipientMemoryTools({ userId: USER_ID, session, service: service() });

    const result = await tools.search_recipients({ query: 'Lucas' });
    expect(result).toMatchObject({ status: 'resolved' });
    expect(JSON.stringify(result)).not.toContain(ADDRESS);
    expect(getSession(session.id)?.recipientMemory?.selectedRecipient).toEqual({ recipientId: RECIPIENT_ID, version: 3 });
  });

  it('RED: refuses unselected or stale IDs and clears stale selections without leaking an address', async () => {
    const session = createSession();
    const staleService = service({ getRecipientForVersion: vi.fn().mockResolvedValue(undefined) });
    const tools = createRecipientMemoryTools({ userId: USER_ID, session, service: staleService });

    await expect(tools.get_recipient_address({ recipientId: RECIPIENT_ID, expectedVersion: 3 })).resolves.toEqual({ status: 'selection_required' });
    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({ status: 'selection_required' });
    await tools.search_recipients({ query: 'Lucas' });
    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({ status: 'stale_selection' });
    expect(getSession(session.id)?.recipientMemory?.selectedRecipient).toBeUndefined();
  });

  it('blocks a selected recipient when the stored version no longer matches', async () => {
    const session = createSession();
    const tools = createRecipientMemoryTools({
      userId: USER_ID,
      session,
      service: service({
        getRecipientForVersion: vi.fn().mockResolvedValue({
          id: RECIPIENT_ID,
          version: 4,
          address: ADDRESS,
        }),
      }),
    });

    await tools.search_recipients({ query: 'Lucas' });
    await expect(tools.get_selected_recipient_address({})).resolves.toEqual({ status: 'stale_selection' });
    expect(getSession(session.id)?.recipientMemory?.selectedRecipient).toBeUndefined();
  });

  it('RED: contains model/database failures and returns no preview or address', async () => {
    const session = createSession();
    const tools = createRecipientMemoryTools({ userId: USER_ID, session, service: service({ searchRecipients: vi.fn().mockResolvedValue({ status: 'unavailable', candidates: [] }) }) });

    await expect(tools.search_recipients({ query: 'Lucas' })).resolves.toEqual({ status: 'unavailable', candidates: [] });
    await expect(tools.get_recipient_address({ recipientId: RECIPIENT_ID, expectedVersion: 3 })).resolves.toEqual({ status: 'selection_required' });
  });

  it('RED: refuses a model-only stage token and persists only after a later session/user-bound confirmation event', async () => {
    const session = createSession();
    const memoryService = service();
    let now = 10_000;
    const tools = createRecipientMemoryTools({ userId: USER_ID, session, service: memoryService, confirmationTtlMs: 1_000, now: () => now });

    await expect(tools.write_user_memory({ confirmationId: 'missing' })).resolves.toEqual({ status: 'confirmation_required' });
    const staged = await tools.stage_user_memory({ kind: 'recipient', name: 'Lucas', description: 'my grandson', address: ADDRESS });
    expect(staged).toMatchObject({ status: 'confirmation_required', draft: { address: ADDRESS } });
    if (staged.status !== 'confirmation_required') throw new Error('Expected a staged write.');

    await expect(tools.write_user_memory({ confirmationId: staged.confirmationId })).resolves.toEqual({ status: 'confirmation_required' });
    expect(memoryService.writeConfirmed).not.toHaveBeenCalled();
    appendMessage(session.id, { role: 'user', content: 'confirm' });
    expect(confirmMemoryWrite(session.id, '22222222-2222-4222-8222-222222222222', staged.confirmationId, now)).toEqual({ status: 'confirmation_required' });
    expect(confirmMemoryWrite(session.id, USER_ID, staged.confirmationId, now)).toEqual({ status: 'confirmed' });
    await expect(tools.write_user_memory({ confirmationId: staged.confirmationId })).resolves.toMatchObject({ status: 'written', kind: 'recipient', id: RECIPIENT_ID });
    expect(memoryService.writeConfirmed).toHaveBeenCalledWith(USER_ID, { kind: 'recipient', name: 'Lucas', description: 'my grandson', address: ADDRESS });
    await expect(tools.write_user_memory({ confirmationId: staged.confirmationId })).resolves.toEqual({ status: 'confirmation_used' });

    const expiring = await tools.stage_user_memory({ kind: 'fact', fact: 'Lucas is my grandson' });
    if (expiring.status !== 'confirmation_required') throw new Error('Expected a staged fact.');
    now += 1_001;
    appendMessage(session.id, { role: 'user', content: 'confirm' });
    expect(confirmMemoryWrite(session.id, USER_ID, expiring.confirmationId, now)).toEqual({ status: 'confirmation_expired' });
    await expect(tools.write_user_memory({ confirmationId: expiring.confirmationId })).resolves.toEqual({ status: 'confirmation_expired' });
  });

  it('RED: rejects invalid EVM addresses before staging and invalid stored values before resolution', async () => {
    const session = createSession();
    const invalid = 'not-an-evm-address';
    const memoryService = service({ getRecipientForVersion: vi.fn().mockResolvedValue({ id: RECIPIENT_ID, version: 3, address: invalid }) });
    const tools = createRecipientMemoryTools({ userId: USER_ID, session, service: memoryService });

    await expect(tools.stage_user_memory({ kind: 'recipient', name: 'Lucas', description: 'my grandson', address: invalid }))
      .resolves.toEqual({ status: 'invalid_draft' });
    expect(memoryService.writeConfirmed).not.toHaveBeenCalled();
    await tools.search_recipients({ query: 'Lucas' });
    await expect(tools.get_recipient_address({ recipientId: RECIPIENT_ID, expectedVersion: 3 })).resolves.toEqual({ status: 'stale_selection' });
  });
});
