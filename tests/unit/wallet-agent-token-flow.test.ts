import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Tool } from 'ai';

import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, getSession, resetSessionStore } from '../../src/conversations/test-fixtures.js';
import { getWdkTools } from '../../src/agent/wdk-tools.js';

type SendTokenToolInput = {
  network: string;
  token: string;
  to: string;
  amount: string;
  wallet: string;
  dryRun: boolean;
  previewId?: string;
};
type SendTokenToolExecute = NonNullable<Tool['execute']>;

describe('configured token transfer flow', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousToken = process.env.WDK_TOKEN;
  const previousNetwork = process.env.WDK_NETWORK;
  const previousWallet = process.env.WDK_WALLET_NAME;

  // Production serves the fixture WDK tool source, so these cases drive the
  // real preview→confirm state machine through the same `send_token` the agent
  // now uses. The spy records every call's args and the hash each broadcast
  // produced; the no-rebroadcast cases count those broadcasts.
  let fixtureTools: Record<string, Tool>;
  let realExecute: SendTokenToolExecute;
  let sendToken: ReturnType<typeof vi.fn>;
  let broadcastHashes: string[];

  beforeAll(async () => {
    fixtureTools = await getWdkTools();
    realExecute = fixtureTools.send_token.execute!;
  });

  beforeEach(() => {
    resetSessionStore();
    process.env.AGENT_RUNTIME = 'deterministic';
    // These cases pin one canonical token across preview and broadcast plus the
    // receipt-waiter/claim semantics, not the local transfer policy. The fixture
    // address (`0x1234…abcd`) is deliberately not a well-formed EVM address.
    process.env.WDK_TOKEN = 'usdt-test';
    process.env.WDK_NETWORK = 'sepolia';
    process.env.WDK_WALLET_NAME = 'agent-demo';

    broadcastHashes = [];
    sendToken = vi.fn(async (input: SendTokenToolInput, options: unknown) => {
      const output = await realExecute(input, options as never);
      if (
        !input.dryRun &&
        output &&
        typeof output === 'object' &&
        'transactionHash' in output
      ) {
        broadcastHashes.push((output as { transactionHash: string }).transactionHash);
      }
      return output;
    });
    fixtureTools.send_token.execute = sendToken as unknown as SendTokenToolExecute;
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

  function broadcastInputs(): SendTokenToolInput[] {
    return sendToken.mock.calls
      .map(([input]) => input as SendTokenToolInput)
      .filter((input) => input.dryRun === false);
  }

  it('uses one canonical token from generic request through preview and broadcast', async () => {
    const session = createSession();
    const preview = await handleMessage(
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );

    expect(preview).toMatchObject({
      status: 'confirmation_required',
      preview: { token: 'usdt-test' },
    });
    expect(sendToken.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ token: 'usdt-test', dryRun: true }),
    ]);
    expect(getSession(session.id)?.pendingTransfer).toMatchObject({ token: 'usdt-test' });

    const sent = await handleMessage(session, 'confirmar la transferencia');

    expect(broadcastHashes).toHaveLength(1);
    expect(sent).toMatchObject({
      status: 'sent',
      message: 'Transfer confirmed.',
      transaction: { transactionHash: broadcastHashes[0] },
    });
    expect(sendToken.mock.calls.map(([input]) => input)).toEqual([
      expect.objectContaining({ token: 'usdt-test', dryRun: true }),
      expect.objectContaining({ token: 'usdt-test', dryRun: false }),
    ]);
  });

  it('persists the hash while waiting and rejects concurrent confirmation without rebroadcasting', async () => {
    const session = createSession();
    await handleMessage(
      session,
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

    const firstConfirmation = handleMessage(session, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    });
    await vi.waitFor(() => expect(transactionReceiptWaiter).toHaveBeenCalledOnce());

    await expect(handleMessage(session, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'broadcast_in_progress' });
    expect(broadcastInputs()).toHaveLength(1);

    releaseReceipt();
    await expect(firstConfirmation).resolves.toMatchObject({ status: 'sent' });
    expect(broadcastHashes).toHaveLength(1);
    expect(getSession(session.id)).toMatchObject({
      lastTransactionHash: broadcastHashes[0],
    });
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();
  });

  it('reports a mined revert as terminal and never retries send_token', async () => {
    const session = createSession();
    await handleMessage(
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    const transactionReceiptWaiter = vi.fn(async (transaction: { transactionHash: string }) => ({
      status: 'reverted' as const,
      network: 'sepolia' as const,
      transactionHash: transaction.transactionHash,
    }));

    await expect(handleMessage(session, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'transfer_reverted' });

    expect(broadcastInputs()).toHaveLength(1);
    expect(broadcastHashes).toHaveLength(1);
    expect(getSession(session.id)?.lastTransactionHash).toBe(broadcastHashes[0]);
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();
  });

  it('rejects an invalid waiter status, clears the lock and cannot rebroadcast', async () => {
    const session = createSession();
    await handleMessage(
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    const transactionReceiptWaiter = vi.fn(async (transaction: { transactionHash: string }) => ({
      status: 'pending',
      network: 'sepolia',
      transactionHash: transaction.transactionHash,
    })) as never;

    await expect(handleMessage(session, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'transaction_receipt_invalid' });

    expect(broadcastHashes).toHaveLength(1);
    expect(getSession(session.id)).toMatchObject({
      lastTransactionHash: broadcastHashes[0],
    });
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();

    await expect(handleMessage(session, 'confirmar la transferencia'))
      .resolves.toMatchObject({ status: 'error', code: 'no_pending_preview' });
    expect(broadcastInputs()).toHaveLength(1);
  });

  it('clears the lock after a terminal waiter error without rebroadcasting', async () => {
    const session = createSession();
    await handleMessage(
      session,
      'Send 10 USDT to 0x1234000000000000000000000000000000abcd',
    );
    const transactionReceiptWaiter = vi.fn(async () => {
      throw new Error('terminal receipt validation error');
    });

    await expect(handleMessage(session, 'confirmar la transferencia', {
      transactionReceiptWaiter,
    })).resolves.toMatchObject({ status: 'error', code: 'transaction_receipt_invalid' });

    expect(broadcastHashes).toHaveLength(1);
    expect(getSession(session.id)?.lastTransactionHash).toBe(broadcastHashes[0]);
    expect(getSession(session.id)?.pendingTransfer).toBeUndefined();
    expect(getSession(session.id)?.transferResolutionState).toBeUndefined();
    await expect(handleMessage(session, 'confirmar la transferencia'))
      .resolves.toMatchObject({ status: 'error', code: 'no_pending_preview' });
    expect(broadcastInputs()).toHaveLength(1);
  });
});
