import { describe, expect, it, beforeEach, vi } from 'vitest';
import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, resetSessionStore, setPendingTransfer, stageMemoryWrite } from '../../src/sessions/in-memory-store.js';
import type { PendingTransfer } from '../../src/contracts/http.js';

const pendingFixture: PendingTransfer = {
  network: 'sepolia',
  token: 'USDT',
  to: '0x1234...abcd',
  amount: '10',
  wallet: 'agent-demo',
  preview: {
    network: 'sepolia',
    token: 'USDT',
    recipient: '0x1234...abcd',
    amount: '10',
    estimatedFee: '0.0003 ETH',
  },
};

describe('handleMessage deterministic paths (no LLM call)', () => {
  beforeEach(() => {
    resetSessionStore();
  });

  it('errors when the session does not exist', async () => {
    const result = await handleMessage('missing-session', 'hello');
    expect(result).toEqual({
      status: 'error',
      message: 'Session not found.',
      code: 'session_not_found',
    });
  });

  it('cancels a pending transfer without calling the agent', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session.id, 'cancel');

    expect(result).toEqual({ status: 'cancelled', message: 'Transfer cancelled.' });
  });

  it('errors when confirming with no pending transfer, without calling the agent', async () => {
    const session = createSession();

    const result = await handleMessage(session.id, 'confirm');

    expect(result).toEqual({
      status: 'error',
      message: 'There is no pending transfer to confirm.',
      code: 'no_pending_preview',
    });
  });

  it('persists a staged memory only when a later user confirm turn authorizes that exact session/user draft', async () => {
    const session = createSession();
    const userId = '11111111-1111-4111-8111-111111111111';
    const confirmationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const writeConfirmed = vi.fn().mockResolvedValue({ kind: 'fact', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1, fact: 'Lucas es mi nieto' });
    stageMemoryWrite(session.id, {
      confirmationId,
      userId,
      draft: { kind: 'fact', fact: 'Lucas es mi nieto' },
      expiresAt: Date.now() + 60_000,
      stagedUserTurn: 0,
    });
    const memory = { userId, service: { writeConfirmed } } as never;

    await expect(handleMessage(session.id, 'confirm', { recipientMemory: memory })).resolves.toEqual({
      status: 'answer', message: 'Recipient memory saved.',
    });
    expect(writeConfirmed).toHaveBeenCalledWith(userId, { kind: 'fact', fact: 'Lucas es mi nieto' });
  });

  it('stops before an LLM or WDK preview when recipient memory is ambiguous', async () => {
    const session = createSession();
    const memory = {
      userId: '11111111-1111-4111-8111-111111111111',
      service: {
        searchRecipients: vi.fn().mockResolvedValue({
          status: 'clarification_required',
          candidates: [
            { id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Lucas', description: 'mi nieto', version: 1, evidence: 'Lucas', score: 0.9 },
            { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', name: 'Lucas', description: 'el electricista', version: 1, evidence: 'Lucas', score: 0.89 },
          ],
        }),
      },
    } as never;

    const result = await handleMessage(session.id, 'Mandale plata a Lucas', { recipientMemory: memory });

    expect(result).toMatchObject({ status: 'clarification_required' });
    expect(session.pendingTransfer).toBeUndefined();
  });
});
