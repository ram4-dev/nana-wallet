import { describe, expect, it, vi } from 'vitest';
import { resolveTransferRecipient } from '../../src/agent/recipient-resolution.js';
import { createSession, resetSessionStore, setSelectedRecipient } from '../../src/sessions/in-memory-store.js';

const candidate = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  name: 'Lucas',
  description: 'mi nieto',
  version: 3,
  score: 0.99,
};

function tools(overrides: Record<string, unknown> = {}) {
  return {
    search_recipients: vi.fn().mockResolvedValue({ status: 'resolved', candidates: [candidate], recipient: candidate }),
    search_user_memory: vi.fn().mockResolvedValue({ status: 'ok', facts: [] }),
    ...overrides,
  };
}

describe('recipient resolution before a transfer preview', () => {
  it('RED: asks for clarification and never asks WDK for a preview on ambiguous candidates', async () => {
    resetSessionStore();
    const memory = tools({
      search_recipients: vi.fn().mockResolvedValue({ status: 'clarification_required', candidates: [candidate, { ...candidate, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', description: 'el electricista' }] }),
    });

    await expect(resolveTransferRecipient('Mandale plata a Lucas', createSession(), memory)).resolves.toMatchObject({
      status: 'clarification_required',
    });
    expect(memory.search_recipients).toHaveBeenCalledWith({ query: 'Lucas' });
  });

  it('RED: resolves my grandson through a fact, then a stable recipient candidate', async () => {
    resetSessionStore();
    const memory = tools({
      search_user_memory: vi.fn().mockResolvedValue({ status: 'ok', facts: [{ fact: 'Lucas es mi nieto', evidence: 'Lucas es mi nieto' }] }),
    });

    await expect(resolveTransferRecipient('Mandale plata a mi nieto', createSession(), memory)).resolves.toMatchObject({
      status: 'resolved',
      recipient: { recipientId: candidate.id, version: 3 },
    });
    expect(memory.search_user_memory).toHaveBeenCalledWith({ query: 'mi nieto' });
    expect(memory.search_recipients).toHaveBeenCalledWith({ query: 'Lucas' });
  });

  it('resolves a relationship after an amount and token', async () => {
    resetSessionStore();
    const memory = tools({
      search_user_memory: vi.fn().mockResolvedValue({ status: 'ok', facts: [{ fact: 'Lucas es mi nieto', evidence: 'Lucas es mi nieto' }] }),
    });

    await expect(resolveTransferRecipient('Enviá 0.01 USDT a mi nieto.', createSession(), memory)).resolves.toMatchObject({
      status: 'resolved',
      recipient: { recipientId: candidate.id, version: 3 },
    });
    expect(memory.search_user_memory).toHaveBeenCalledWith({ query: 'mi nieto' });
  });

  it('resolves a greeted, explicitly named relationship through the qualified recipient query', async () => {
    resetSessionStore();
    const memory = tools();

    await expect(resolveTransferRecipient(
      'Hey Nana, please send one USDT to my grandson Lucas.',
      createSession(),
      memory,
    )).resolves.toMatchObject({
      status: 'resolved',
      recipient: { recipientId: candidate.id, version: 3 },
    });
    expect(memory.search_recipients).toHaveBeenCalledWith({ query: 'Lucas my grandson' });
    expect(memory.search_user_memory).not.toHaveBeenCalled();
  });

  it('RED: keeps an unresolved pronoun and dependency failure ahead of address lookup or preview', async () => {
    resetSessionStore();
    await expect(resolveTransferRecipient('Send him money', createSession(), tools())).resolves.toEqual({ status: 'clarification_required', candidates: [] });
    await expect(resolveTransferRecipient('Mandale plata a Lucas', createSession(), tools({
      search_recipients: vi.fn().mockResolvedValue({ status: 'unavailable', candidates: [] }),
    }))).resolves.toEqual({ status: 'unavailable', candidates: [] });
  });

  it('RED: never promotes an irrelevant relationship fact into a recipient name', async () => {
    resetSessionStore();
    const memory = tools({
      search_user_memory: vi.fn().mockResolvedValue({ status: 'ok', facts: [{ fact: 'Alicia es mi doctora', evidence: 'Alicia es mi doctora', score: 0.99 }] }),
      search_recipients: vi.fn().mockResolvedValue({ status: 'no_match', candidates: [] }),
    });

    await expect(resolveTransferRecipient('Mandale plata a mi nieto', createSession(), memory)).resolves.toEqual({ status: 'no_match', candidates: [] });
    expect(memory.search_recipients).toHaveBeenCalledWith({ query: 'mi nieto' });
    expect(memory.search_recipients).not.toHaveBeenCalledWith({ query: 'Alicia' });
  });

  it('RED: asks before resolving when relationship facts conflict', async () => {
    resetSessionStore();
    const memory = tools({
      search_user_memory: vi.fn().mockResolvedValue({ status: 'clarification_required', facts: [] }),
    });

    await expect(resolveTransferRecipient('Mandale plata a mi nieto', createSession(), memory)).resolves.toEqual({ status: 'clarification_required', candidates: [] });
    expect(memory.search_recipients).not.toHaveBeenCalled();
  });

  it('resolves a contextual pronoun only from the prior selected stable recipient', async () => {
    resetSessionStore();
    const session = createSession();
    setSelectedRecipient(session.id, { recipientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 3 });

    await expect(resolveTransferRecipient('Mandale plata a él', session, tools())).resolves.toEqual({
      status: 'resolved', recipient: { recipientId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 3 },
    });
  });
});
