import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, resetSessionStore, setPendingTransfer, setSelectedRecipient, stageMemoryWrite } from '../../src/sessions/in-memory-store.js';
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
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousToken = process.env.WDK_TOKEN;
  const previousNetwork = process.env.WDK_NETWORK;
  const previousWallet = process.env.WDK_WALLET_NAME;

  beforeEach(() => {
    resetSessionStore();
    process.env.AGENT_RUNTIME = 'deterministic';
    process.env.WDK_TOKEN = 'USDT';
    process.env.WDK_NETWORK = 'sepolia';
    process.env.WDK_WALLET_NAME = 'agent-demo';
  });

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
    if (previousToken === undefined) delete process.env.WDK_TOKEN;
    else process.env.WDK_TOKEN = previousToken;
    if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
    else process.env.WDK_NETWORK = previousNetwork;
    if (previousWallet === undefined) delete process.env.WDK_WALLET_NAME;
    else process.env.WDK_WALLET_NAME = previousWallet;
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

  it('accepts an explicit transfer cancellation phrase', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session.id, 'Cancelar la transferencia.');

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

  it('previews a fixture transfer from text without calling an LLM', async () => {
    const session = createSession();
    const result = await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    expect(result.status).toBe('confirmation_required');
    if (result.status !== 'confirmation_required') return;
    expect(result.preview).toMatchObject({
      network: 'sepolia',
      token: 'USDT',
      recipient: '0x1234000000000000000000000000000000abcd',
      amount: '10',
      estimatedFee: '0.0003 ETH',
    });
  });

  it('bypasses recipient memory for an explicit address and reaches the preview', async () => {
    const session = createSession();
    const searchRecipients = vi.fn();
    const searchUserMemory = vi.fn();
    const memory = {
      userId: '11111111-1111-4111-8111-111111111111',
      service: { searchRecipients, searchUserMemory },
    } as never;

    const result = await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234567890123456789012345678901234567890',
      { recipientMemory: memory },
    );

    expect(result).toMatchObject({
      status: 'confirmation_required',
      preview: {
        amount: '10',
        recipient: '0x1234567890123456789012345678901234567890',
        estimatedFee: '0.0003 ETH',
      },
    });
    expect(searchRecipients).not.toHaveBeenCalled();
    expect(searchUserMemory).not.toHaveBeenCalled();
  });

  it('confirms the pending fixture transfer without an LLM or live broadcast', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    const result = await handleMessage(session.id, 'confirm');

    expect(result.status).toBe('sent');
    if (result.status !== 'sent') return;
    expect(result.transaction.network).toBe('sepolia');
    expect(result.transaction.transactionHash).toMatch(/^0x[0-9a-f]{64}$/u);
    expect(result.transaction.explorerUrl).toContain('sepolia.etherscan.io');
  });

  it('returns recipient revalidation failure without leaving the session uncertain', async () => {
    const session = createSession();
    const recipientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const address = '0x1234567890123456789012345678901234567890';
    setSelectedRecipient(session.id, { recipientId, version: 3 });
    setPendingTransfer(session.id, {
      ...pendingFixture,
      to: address,
      preview: { ...pendingFixture.preview, recipient: address },
      recipientId,
      recipientVersion: 3,
    });
    const memory = {
      userId: '11111111-1111-4111-8111-111111111111',
      service: { getRecipientForVersion: vi.fn().mockResolvedValue(undefined) },
    } as never;

    await expect(
      handleMessage(session.id, 'confirmar la transferencia', { recipientMemory: memory }),
    ).resolves.toMatchObject({
      status: 'error',
      code: 'recipient_revalidation_required',
    });
    expect(session.pendingTransfer).toBeUndefined();
    expect(session.recipientMemory?.selectedRecipient).toBeUndefined();
    expect(session.transferResolutionState).toBeUndefined();
  });

  it('accepts an explicit transfer confirmation phrase', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    const result = await handleMessage(session.id, 'Confirmar la transferencia.');

    expect(result.status).toBe('sent');
  });

  it.each(['confirmo', 'sí, confirmo', 'I confirm', 'yes, confirm', 'yes, I confirm'])(
    'accepts the explicit confirmation phrase %s',
    async (phrase) => {
      const session = createSession();
      await handleMessage(
        session.id,
        'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
      );

      await expect(handleMessage(session.id, phrase)).resolves.toMatchObject({
        status: 'sent',
      });
    },
  );

  it('does not treat a generic yes as a confirmation', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    await expect(handleMessage(session.id, 'yes')).resolves.toMatchObject({
      status: 'error',
      code: 'pending_confirmation',
    });
  });

  it('does not send an ambiguous instruction to the agent while confirmation is pending', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session.id, 'sí');

    expect(result).toEqual({
      status: 'error',
      message:
        'A transfer is waiting for your decision. Confirm or cancel it before sending another instruction.',
      code: 'pending_confirmation',
    });
  });

  it('answers a balance question from WDK fixtures', async () => {
    const session = createSession();
    const result = await handleMessage(session.id, 'How much USDT do I have?');

    expect(result).toEqual({
      status: 'answer',
      message: 'You have 42.5 USDT.',
    });
  });
});
