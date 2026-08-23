import { describe, expect, it, vi } from 'vitest';
import { buildGuardedTools } from '../../src/agent/wallet-agent.js';
import { createWdkToolsFixture } from '../../src/agent/wdk-tools.fixture.js';
import { createSession, resetSessionStore, setPendingTransfer, setSelectedRecipient } from '../../src/sessions/in-memory-store.js';
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

  it('refuses a dryRun:false call whose wallet does not match the pending transfer', async () => {
    resetSessionStore();
    const session = createSession();
    setPendingTransfer(session.id, pendingFixture);
    const tools = buildGuardedTools(createWdkToolsFixture(), session);

    const result = (await tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: '0x1234...abcd', amount: '10', wallet: 'other-wallet', dryRun: false },
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

  it('revalidates a selected recipient for preview and again before broadcast', async () => {
    resetSessionStore();
    const session = createSession();
    const recipientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const address = '0x1234567890123456789012345678901234567890';
    setSelectedRecipient(session.id, { recipientId, version: 3 });
    const getRecipientForVersion = vi.fn().mockResolvedValue({ id: recipientId, version: 3, address });
    const memory = { userId: '11111111-1111-4111-8111-111111111111', service: { getRecipientForVersion } } as never;
    const base = createWdkToolsFixture();
    const sendToken = vi.fn(base.send_token.execute!);
    base.send_token.execute = sendToken;
    const tools = buildGuardedTools(base, session, memory);

    await expect(tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: address, amount: '10', wallet: 'agent-demo', dryRun: true },
      toolOptions,
    )).resolves.toMatchObject({ estimatedFee: expect.any(String) });
    expect(session.recipientMemory?.previewedRecipient).toEqual({ recipientId, version: 3 });

    setPendingTransfer(session.id, { ...pendingFixture, to: address, preview: { ...pendingFixture.preview, recipient: address }, recipientId, recipientVersion: 3 });
    getRecipientForVersion.mockResolvedValue(undefined);
    sendToken.mockClear();
    await expect(tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: address, amount: '10', wallet: 'agent-demo', dryRun: false },
      toolOptions,
    )).resolves.toMatchObject({ error: 'recipient_revalidation_required' });
    expect(sendToken).not.toHaveBeenCalled();
    expect(session.pendingTransfer).toBeUndefined();
  });

  it('stops before preview when a legacy recipient record has an invalid EVM address', async () => {
    resetSessionStore();
    const session = createSession();
    const recipientId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    setSelectedRecipient(session.id, { recipientId, version: 3 });
    const sendToken = vi.fn();
    const base = createWdkToolsFixture();
    base.send_token.execute = sendToken;
    const memory = {
      userId: '11111111-1111-4111-8111-111111111111',
      service: { getRecipientForVersion: vi.fn().mockResolvedValue({ id: recipientId, version: 3, address: 'not-an-evm-address' }) },
    } as never;
    const tools = buildGuardedTools(base, session, memory);

    await expect(tools.send_token.execute!(
      { network: 'sepolia', token: 'USDT', to: 'not-an-evm-address', amount: '10', wallet: 'agent-demo', dryRun: true },
      toolOptions,
    )).resolves.toMatchObject({ error: 'recipient_revalidation_required' });
    expect(sendToken).not.toHaveBeenCalled();
  });
});
