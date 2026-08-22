import { describe, expect, it } from 'vitest';
import { buildGuardedTools } from '../../src/agent/wallet-agent.js';
import { createWdkToolsFixture } from '../../src/agent/wdk-tools.fixture.js';
import { createSession, resetSessionStore, setPendingTransfer } from '../../src/sessions/in-memory-store.js';
import type { PendingTransfer } from '../../src/contracts/http.js';

const toolOptions = {
  toolCallId: 'test-call',
  messages: [],
  abortSignal: new AbortController().signal,
} as never;

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

describe('guarded send_token tool', () => {
  it('always allows a dryRun:true preview call', async () => {
    resetSessionStore();
    const session = createSession();
    const tools = buildGuardedTools(createWdkToolsFixture(), session);

    const result = (await tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: '0x1234...abcd', amount: '10', wallet: 'agent-demo', dryRun: true },
      toolOptions,
    )) as { estimatedFee: string };

    expect(result.estimatedFee).toBeDefined();
  });

  it('refuses a dryRun:false call with no pending transfer', async () => {
    resetSessionStore();
    const session = createSession();
    const tools = buildGuardedTools(createWdkToolsFixture(), session);

    const result = (await tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: '0x1234...abcd', amount: '10', wallet: 'agent-demo', dryRun: false },
      toolOptions,
    )) as { error?: string };

    expect(result.error).toBe('confirmation_required');
  });

  it('refuses a dryRun:false call whose params do not match the pending transfer', async () => {
    resetSessionStore();
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);
    const tools = buildGuardedTools(createWdkToolsFixture(), session);

    const result = (await tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: '0xdeadbeef', amount: '10', wallet: 'agent-demo', dryRun: false },
      toolOptions,
    )) as { error?: string };

    expect(result.error).toBe('confirmation_required');
  });

  it('allows a dryRun:false call that matches the pending transfer', async () => {
    resetSessionStore();
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);
    const tools = buildGuardedTools(createWdkToolsFixture(), session);

    const result = (await tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: '0x1234...abcd', amount: '10', wallet: 'agent-demo', dryRun: false },
      toolOptions,
    )) as { transactionHash?: string };

    expect(result.transactionHash).toBeDefined();
  });
});
