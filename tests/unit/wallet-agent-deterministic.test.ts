import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';
import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, resetSessionStore, setPendingTransferById as setPendingTransfer, setSelectedRecipientById as setSelectedRecipient, stageMemoryWriteById as stageMemoryWrite } from '../../src/conversations/test-fixtures.js';
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
    // These cases pin the deterministic intent, preview, and confirm paths, not
    // the local transfer policy. The fixture address (`0x1234…abcd` with 38 hex
    // digits) is deliberately not a well-formed EVM address.
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
    const result = await handleMessage(createSession(), 'hello');
    expect(result.status).toBe('answer');
  });

  it('answers unsupported Spanish turns in Spanish', async () => {
    const result = await handleMessage(createSession(), 'Hola Nani', { language: 'es' });
    expect(result).toEqual({
      status: 'answer',
      message: 'Decime a quién querés pagar o cuánto USDT querés enviar en Sepolia.',
    });
  });

  it('cancels a pending transfer without calling the agent', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session, 'cancel');

    expect(result).toEqual({ status: 'cancelled', message: 'Transfer cancelled.' });
  });

  it('accepts an explicit transfer cancellation phrase', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session, 'Cancelar la transferencia.');

    expect(result).toEqual({ status: 'cancelled', message: 'Transfer cancelled.' });
  });

  it('errors when confirming with no pending transfer, without calling the agent', async () => {
    const session = createSession();

    const result = await handleMessage(session, 'confirm');

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

    await expect(handleMessage(session, 'confirm', { recipientMemory: memory })).resolves.toEqual({
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

    const result = await handleMessage(session, 'Mandale plata a Lucas', { recipientMemory: memory });

    expect(result).toMatchObject({ status: 'clarification_required' });
    expect(session.pendingTransfer).toBeUndefined();
  });

  it('previews a fixture transfer from text without calling an LLM', async () => {
    const session = createSession();
    const result = await handleMessage(
      session,
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
      session,
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
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    const result = await handleMessage(session, 'confirm');

    expect(result.status).toBe('sent');
    if (result.status !== 'sent') return;
    expect(result.transaction.network).toBe('sepolia');
    expect(result.transaction.transactionHash).toMatch(/^0x[0-9a-f]{64}$/u);
    // The chain fixture is the WDK fixture runtime's own synthetic network
    // (see createWdkToolsFixture), not a wallet-service selector, so only the
    // explorer base moved: Solana devnet is the only chain this deployment
    // serves, and an unrecognised network now resolves to the Solana explorer
    // instead of Sepolia's Etherscan.
    expect(result.transaction.explorerUrl).toBe(
      `https://explorer.solana.com/tx/${result.transaction.transactionHash}`,
    );
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
      handleMessage(session, 'confirmar la transferencia', { recipientMemory: memory }),
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
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    const result = await handleMessage(session, 'Confirmar la transferencia.');

    expect(result.status).toBe('sent');
  });

  it.each(['confirmo', 'sí, confirmo', 'I confirm', 'yes, confirm', 'yes, I confirm'])(
    'accepts the explicit confirmation phrase %s',
    async (phrase) => {
      const session = createSession();
      await handleMessage(
        session,
        'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
      );

      await expect(handleMessage(session, phrase)).resolves.toMatchObject({
        status: 'sent',
      });
    },
  );

  /**
   * THE SAFETY PROPERTY, over the REAL path.
   *
   * `resolution-phrases.ts` states the relationship the classifier preserves:
   * a decision carries a polarity word and NOTHING ELSE. Its own header example
   * is the one that matters — "Sí, envíale uno a Lucas, confirmo." is a NEW
   * instruction (an amount and a recipient) that happens to contain a
   * confirmation word, and authorizing a transfer from it would send money on
   * the strength of a sentence nobody reviewed.
   *
   * `handleMessage` used to get that protection from a closed list of exact
   * sentences instead. Replacing the list with the classifier had to keep it:
   * this drives `handleMessage` itself, with a real pending transfer, and asserts
   * both the refusal AND that the transfer is still pending afterwards.
   */
  it('never reads a confirmation out of a sentence that carries a new instruction', async () => {
    const session = createSession();
    await handleMessage(
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    const result = await handleMessage(session, 'Sí, envíale uno a Lucas, confirmo.');

    expect(result).toMatchObject({
      status: 'error',
      code: 'pending_confirmation',
    });
    // Refused is not enough: the preview must still be the open decision, or the
    // refusal would have consumed it and left the user with no way to confirm.
    expect(session.pendingTransfer).toBeDefined();
  });

  it('never reads a cancellation out of a sentence that carries a new instruction', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session, 'no, cancelá y mandale 5 a Lucas');

    expect(result).toMatchObject({ status: 'error', code: 'pending_confirmation' });
    expect(session.pendingTransfer).toBeDefined();
  });

  /**
   * THE BEHAVIOUR CHANGE, pinned.
   *
   * `CONFIRM_PHRASES` held 'confirm', 'confirmo', 'sí, confirmo' and 14 other
   * exact sentences, so a plain "yes" WITH a pending transfer was read as no
   * decision at all and the turn ended in `pending_confirmation`. The voice gate
   * and `service.ts` — the two surfaces that serve the product — already confirm
   * on it (`isConfirmation('yes')` is true, and `conversation-service.test.ts`
   * proves the service path sends). This module was a third, NARROWER reader, and
   * the same words behaved differently depending on which one saw them.
   */
  it.each(['yes', 'go ahead', 'ok', 'sí', 'dale', 'adelante', 'listo']) (
    'confirms a pending transfer on the plain agreement %s, as the voice and service surfaces always did',
    async (agreement) => {
      const session = createSession();
      await handleMessage(
        session,
        'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
      );

      await expect(handleMessage(session, agreement)).resolves.toMatchObject({
        status: 'sent',
      });
    },
  );

  it.each(['no', 'stop', 'dejalo', 'mejor no']) (
    'cancels a pending transfer on the plain refusal %s',
    async (refusal) => {
      const session = createSession();
      setPendingTransfer(session.id, pendingFixture);

      await expect(handleMessage(session, refusal)).resolves.toEqual({
        status: 'cancelled',
        message: 'Transfer cancelled.',
      });
    },
  );

  it('refuses an instruction turn while a confirmation is pending, without sending it on', async () => {
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);

    const result = await handleMessage(session, 'mandale 5 a Lucas');

    expect(result).toEqual({
      status: 'error',
      message:
        'A transfer is waiting for your decision. Confirm or cancel it before sending another instruction.',
      code: 'pending_confirmation',
    });
  });

  it('answers a balance question from WDK fixtures', async () => {
    const session = createSession();
    const result = await handleMessage(session, 'How much USDT do I have?');

    expect(result).toEqual({
      status: 'answer',
      message: 'You have 42.5 USDT.',
    });
  });
});
