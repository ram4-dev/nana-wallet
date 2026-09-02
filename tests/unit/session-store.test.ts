import { describe, expect, it, beforeEach } from 'vitest';
import {
  createSession,
  getSession,
  appendMessageById as appendMessage,
  setPendingTransferById as setPendingTransfer,
  clearPendingTransferById as clearPendingTransfer,
  claimPendingTransfer,
  markPendingTransferUncertain,
  setLastTransactionHash as setLastTransactionHashForConversation,
  resetSessionStore,
} from '../../src/conversations/test-fixtures.js';
import type { PendingTransfer } from '../../src/contracts/http.js';

const samplePending: PendingTransfer = {
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

describe('in-memory session store', () => {
  beforeEach(() => {
    resetSessionStore();
  });

  it('creates a session with empty messages and no pending transfer', () => {
    const session = createSession();
    expect(getSession(session.id)).toEqual(session);
    expect(session.messages).toEqual([]);
    expect(session.pendingTransfer).toBeUndefined();
  });

  it('returns undefined for an unknown session id', () => {
    expect(getSession('does-not-exist')).toBeUndefined();
  });

  it('appends messages to a session', () => {
    const session = createSession();
    appendMessage(session.id, { role: 'user', content: 'hi' });
    expect(getSession(session.id)?.messages).toEqual([{ role: 'user', content: 'hi' }]);
  });

  it('stores and clears a pending transfer', () => {
    const session = createSession();
    setPendingTransfer(session.id, samplePending);
    expect(getSession(session.id)?.pendingTransfer).toEqual(samplePending);

    clearPendingTransfer(session.id);
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
  });

  it('claims a pending transfer only once and preserves an uncertain lock', () => {
    const session = createSession();
    setPendingTransfer(session.id, samplePending);

    expect(claimPendingTransfer(session.id)).toEqual({ status: 'claimed', transfer: samplePending });
    expect(claimPendingTransfer(session.id)).toEqual({ status: 'broadcasting' });

    markPendingTransferUncertain(session.id);
    expect(claimPendingTransfer(session.id)).toEqual({ status: 'uncertain' });
  });

  it('records the last transaction hash', () => {
    const session = createSession();
    setLastTransactionHashForConversation(session, '0xabc');
    expect(getSession(session.id)?.lastTransactionHash).toBe('0xabc');
  });

});
