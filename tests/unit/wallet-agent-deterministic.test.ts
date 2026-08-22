import { describe, expect, it, beforeEach } from 'vitest';
import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, resetSessionStore, setPendingTransfer } from '../../src/sessions/in-memory-store.js';
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
});
