import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type SendTokenClient = Pick<import('../../src/wdk/mcp-client.js').WdkMcpClient, 'sendToken'>;
const composed = vi.hoisted(() => ({
  client: undefined as SendTokenClient | undefined,
  mcpCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
}));

vi.mock('../../src/agent/wdk-tools.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/agent/wdk-tools.js')>();
  return {
    ...actual,
    getWdkTools: async () => actual.createLiveTools(async () => {
      if (!composed.client) throw new Error('Test WDK client is not ready.');
      return composed.client;
    }),
  };
});

import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, getSession, resetSessionStore } from '../../src/sessions/in-memory-store.js';
import { REQUIRED_WDK_TOOLS, WdkMcpClient, type McpSession } from '../../src/wdk/mcp-client.js';

describe('configured token transfer flow', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousToken = process.env.WDK_TOKEN;
  const previousNetwork = process.env.WDK_NETWORK;
  const previousWallet = process.env.WDK_WALLET_NAME;
  const previousToolsSource = process.env.WDK_TOOLS_SOURCE;
  let client: WdkMcpClient;

  beforeEach(async () => {
    resetSessionStore();
    composed.mcpCalls.length = 0;
    process.env.AGENT_RUNTIME = 'deterministic';
    process.env.WDK_TOKEN = 'usdt-test';
    process.env.WDK_NETWORK = 'sepolia';
    process.env.WDK_WALLET_NAME = 'agent-demo';
    process.env.WDK_TOOLS_SOURCE = 'fixture';
    const fakeSession: McpSession = {
      connect: async () => undefined,
      listTools: async () => ({ tools: REQUIRED_WDK_TOOLS.map((name) => ({ name })) }),
      callTool: async (name, args) => {
        composed.mcpCalls.push({ name, args });
        return args.dryRun
          ? { preview: true, network: args.network, token: args.token, to: args.to, amount: args.amount, estimatedFee: '0.0001 ETH' }
          : { network: args.network, transactionHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', explorerUrl: 'https://sepolia.etherscan.io/tx/0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' };
      },
      close: async () => undefined,
    };
    client = new WdkMcpClient({ sessionFactory: () => fakeSession });
    await client.open();
    composed.client = client;
  });

  afterEach(async () => {
    composed.client = undefined;
    await client.close();
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
    if (previousToken === undefined) delete process.env.WDK_TOKEN;
    else process.env.WDK_TOKEN = previousToken;
    if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
    else process.env.WDK_NETWORK = previousNetwork;
    if (previousWallet === undefined) delete process.env.WDK_WALLET_NAME;
    else process.env.WDK_WALLET_NAME = previousWallet;
    if (previousToolsSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousToolsSource;
  });

  it('uses one canonical token from generic request through preview and broadcast', async () => {
    const session = createSession();
    const preview = await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    expect(preview).toMatchObject({
      status: 'confirmation_required',
      preview: { token: 'usdt-test' },
    });
    expect(composed.mcpCalls).toEqual([
      { name: 'send_token', args: expect.objectContaining({ token: 'usdt-test', dryRun: true }) },
    ]);
    expect(getSession(session.id)?.pendingTransfer).toMatchObject({ token: 'usdt-test' });

    const sent = await handleMessage(session.id, 'confirmar la transferencia');

    expect(sent).toMatchObject({
      status: 'sent',
      message: 'Transfer confirmed.',
      transaction: { transactionHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc' },
    });
    expect(composed.mcpCalls).toEqual([
      { name: 'send_token', args: expect.objectContaining({ token: 'usdt-test', dryRun: true }) },
      { name: 'send_token', args: expect.objectContaining({ token: 'usdt-test', dryRun: false }) },
    ]);
  });

  it('persists the hash while waiting and rejects concurrent confirmation without rebroadcasting', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    let releaseReceipt!: () => void;
    const receiptGate = new Promise<void>((resolve) => {
      releaseReceipt = resolve;
    });
    const transactionReceiptWaiter = vi.fn(async (transaction: {
      network: string;
      transactionHash: string;
    }) => {
      expect(getSession(session.id)).toMatchObject({
        transferResolutionState: 'broadcasting',
        lastTransactionHash: transaction.transactionHash,
        pendingTransfer: expect.any(Object),
      });
      await receiptGate;
      return {
        status: 'confirmed' as const,
        network: 'sepolia' as const,
        transactionHash: transaction.transactionHash,
      };
    });

    const firstConfirmation = handleMessage(session.id, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    });
    await vi.waitFor(() => expect(transactionReceiptWaiter).toHaveBeenCalledOnce());

    await expect(handleMessage(session.id, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'broadcast_in_progress' });
    expect(composed.mcpCalls.filter((call) => call.name === 'send_token' && call.args.dryRun === false))
      .toHaveLength(1);

    releaseReceipt();
    await expect(firstConfirmation).resolves.toMatchObject({ status: 'sent' });
    expect(getSession(session.id)).toMatchObject({
      lastTransactionHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();
  });

  it('reports a mined revert as terminal and never retries send_token', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    const transactionReceiptWaiter = vi.fn(async (transaction: { transactionHash: string }) => ({
      status: 'reverted' as const,
      network: 'sepolia' as const,
      transactionHash: transaction.transactionHash,
    }));

    await expect(handleMessage(session.id, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'transfer_reverted' });

    expect(composed.mcpCalls.filter((call) => call.name === 'send_token' && call.args.dryRun === false))
      .toHaveLength(1);
    expect(getSession(session.id)?.lastTransactionHash)
      .toBe('0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();
  });

  it('rejects an invalid waiter status, clears the lock and cannot rebroadcast', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    const transactionReceiptWaiter = vi.fn(async (transaction: { transactionHash: string }) => ({
      status: 'pending',
      network: 'sepolia',
      transactionHash: transaction.transactionHash,
    })) as never;

    await expect(handleMessage(session.id, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'transaction_receipt_invalid' });

    expect(getSession(session.id)).toMatchObject({
      lastTransactionHash: '0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    });
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();

    await expect(handleMessage(session.id, 'confirmar la transferencia'))
      .resolves.toMatchObject({ status: 'error', code: 'no_pending_preview' });
    expect(composed.mcpCalls.filter((call) => call.name === 'send_token' && call.args.dryRun === false))
      .toHaveLength(1);
  });

  it('clears the lock after a terminal waiter error without rebroadcasting', async () => {
    const session = createSession();
    await handleMessage(
      session.id,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    const transactionReceiptWaiter = vi.fn(async () => {
      throw new Error('terminal receipt validation error');
    });

    await expect(handleMessage(session.id, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'transaction_receipt_invalid' });

    expect(getSession(session.id)?.lastTransactionHash)
      .toBe('0xcccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc');
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();
    await expect(handleMessage(session.id, 'confirmar la transferencia'))
      .resolves.toMatchObject({ status: 'error', code: 'no_pending_preview' });
    expect(composed.mcpCalls.filter((call) => call.name === 'send_token' && call.args.dryRun === false))
      .toHaveLength(1);
  });
});
