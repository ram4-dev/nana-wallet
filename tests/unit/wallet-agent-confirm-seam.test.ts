import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleMessage } from '../../src/agent/wallet-agent.js';
import { createSession, resetSessionStore } from '../../src/conversations/test-fixtures.js';
import type { ConversationSession } from '../../src/conversations/session-state.js';
import type { PendingTransfer } from '../../src/contracts/http.js';
import type {
  BroadcastOutcome,
  FinalityOutcome,
  WalletProvider,
} from '../../src/wallet/provider.js';

const RECIPIENT = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const PREVIEW_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const TX_HASH = `0x${'cc'.repeat(32)}`;

const pendingFixture: PendingTransfer = {
  network: 'arc-testnet',
  token: 'USDC',
  to: RECIPIENT,
  amount: '1',
  wallet: 'agent-demo',
  preview: {
    network: 'arc-testnet',
    token: 'USDC',
    recipient: RECIPIENT,
    amount: '1',
    estimatedFee: '0.00001 USDC',
  },
  previewId: PREVIEW_ID,
};

type ProviderCalls = {
  broadcast: Array<Record<string, unknown>>;
  finality: Array<Record<string, unknown>>;
};

function fakeWalletProvider(outcome: {
  broadcast?: () => BroadcastOutcome;
  finality?: () => FinalityOutcome;
}): { provider: WalletProvider; calls: ProviderCalls } {
  const calls: ProviderCalls = { broadcast: [], finality: [] };
  const provider = {
    id: 'solana-devnet',
    mode: 'live' as const,
    health: vi.fn(async () => ({ status: 'healthy' as const })),
    listNetworks: vi.fn(async () => []),
    listTokens: vi.fn(async () => []),
    getAddress: vi.fn(async () => ({ network: 'arc-testnet', address: '0x1' })),
    getBalance: vi.fn(async () => ({ network: 'arc-testnet', address: '0x1', balance: '0' })),
    getHistory: vi.fn(async () => ({ network: 'arc-testnet', transactions: [] })),
    previewTransfer: vi.fn(async () => {
      throw new Error('not used in confirm-path tests');
    }),
    broadcastTransfer: vi.fn(async (request: Record<string, unknown>) => {
      calls.broadcast.push(request);
      return outcome.broadcast
        ? outcome.broadcast()
        : {
          kind: 'submitted' as const,
          transaction: {
            network: 'arc-testnet',
            transactionHash: TX_HASH,
            explorerUrl: `https://testnet.arcscan.app/tx/${TX_HASH}`,
          },
        };
    }),
    waitForFinality: vi.fn(async (request: Record<string, unknown>) => {
      calls.finality.push(request);
      return outcome.finality
        ? outcome.finality()
        : { status: 'confirmed' as const, transactionHash: TX_HASH, network: 'arc-testnet' };
    }),
    close: vi.fn(async () => undefined),
  } as unknown as WalletProvider;
  return { provider, calls };
}

function broadcastCalls(calls: ProviderCalls): number {
  return calls.broadcast.length;
}

describe('confirm-path provider seam', () => {
  const previous = new Map<string, string | undefined>([
    ['WDK_NETWORK', process.env.WDK_NETWORK],
    ['WDK_TOKEN', process.env.WDK_TOKEN],
    ['WDK_WALLET_NAME', process.env.WDK_WALLET_NAME],
  ]);

  beforeEach(() => {
    resetSessionStore();
    process.env.WDK_NETWORK = 'arc-testnet';
    process.env.WDK_TOKEN = 'USDC';
    process.env.WDK_WALLET_NAME = 'agent-demo';
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  function pendingSession(): ConversationSession {
    const session = createSession();
    (session as { pendingTransfer?: PendingTransfer }).pendingTransfer = { ...pendingFixture };
    return session;
  }

  it('fails closed on a duplicate confirm while broadcasting', async () => {
    const session = pendingSession();
    session.transferResolutionState = 'broadcasting';
    const { provider, calls } = fakeWalletProvider({});

    await expect(handleMessage(session, 'confirm', { walletProvider: provider })).resolves.toMatchObject({
      status: 'error',
      code: 'broadcast_in_progress',
    });
    expect(broadcastCalls(calls)).toBe(0);
  });

  it('blocks a retry after an uncertain outcome without a second broadcast', async () => {
    const session = pendingSession();
    session.transferResolutionState = 'uncertain';
    const { provider, calls } = fakeWalletProvider({});

    await expect(handleMessage(session, 'confirm', { walletProvider: provider })).resolves.toMatchObject({
      status: 'error',
      code: 'broadcast_uncertain',
    });
    expect(broadcastCalls(calls)).toBe(0);
  });

  it('fails closed when the confirmed preview is missing', async () => {
    const session = createSession();
    const { provider, calls } = fakeWalletProvider({});

    await expect(handleMessage(session, 'confirm', { walletProvider: provider })).resolves.toMatchObject({
      status: 'error',
      code: 'no_pending_preview',
    });
    expect(broadcastCalls(calls)).toBe(0);
  });

  it('routes the confirmed broadcast through the provider seam and preserves the previewId', async () => {
    const session = pendingSession();
    const { provider, calls } = fakeWalletProvider({});

    const result = await handleMessage(session, 'confirm', { walletProvider: provider });

    expect(result).toMatchObject({ status: 'sent', message: 'Transfer confirmed.' });
    expect(broadcastCalls(calls)).toBe(1);
    expect(calls.broadcast[0]).toMatchObject({
      network: 'arc-testnet',
      token: 'USDC',
      to: RECIPIENT,
      amount: '1',
      wallet: 'agent-demo',
      previewId: PREVIEW_ID,
    });
    expect(calls.finality).toHaveLength(1);
    expect(calls.finality[0]).toMatchObject({ transaction: { transactionHash: TX_HASH } });
    expect(session.pendingTransfer).toBeUndefined();
    expect(session.lastTransactionHash).toBe(TX_HASH);
  });

  it('surfaces a reverted receipt as transfer_reverted naming the network', async () => {
    const session = pendingSession();
    const { provider } = fakeWalletProvider({
      finality: () => ({ status: 'reverted', transactionHash: TX_HASH, network: 'arc-testnet' }),
    });

    const result = await handleMessage(session, 'confirm', { walletProvider: provider });

    expect(result).toMatchObject({ status: 'error', code: 'transfer_reverted' });
    expect(result.message).toContain('reverted on arc-testnet');
    expect(result.message).toContain(TX_HASH);
  });

  it('fails closed when the provider verification throws instead of confirming', async () => {
    const session = pendingSession();
    const { provider } = fakeWalletProvider({
      finality: () => {
        throw new Error('Arc RPC returned a receipt for a different transaction.');
      },
    });

    const result = await handleMessage(session, 'confirm', { walletProvider: provider });

    expect(result).toMatchObject({ status: 'error', code: 'transaction_receipt_invalid' });
    expect(result.message).toContain('different transaction');
    expect(result.message).toContain(TX_HASH);
    expect(session.pendingTransfer).toBeUndefined();
  });
});

describe('receipt-waiter selection (D3, task 4.3)', () => {
  const previous = new Map<string, string | undefined>([
    ['WDK_NETWORK', process.env.WDK_NETWORK],
    ['WDK_TOKEN', process.env.WDK_TOKEN],
    ['WDK_WALLET_NAME', process.env.WDK_WALLET_NAME],
  ]);

  beforeEach(() => {
    // These cases pin the receipt-waiter/provider seam; enforcement itself is
    // owned by the provider policy attached to the wallet.
  });

  afterEach(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    resetSessionStore();
  });

  it('keeps the legacy provider-absent path on defaultTransactionReceiptWaiter (fixture immediate confirm)', async () => {
    resetSessionStore();
    process.env.WDK_NETWORK = 'sepolia';
    process.env.WDK_TOKEN = 'USDT';
    process.env.WDK_WALLET_NAME = 'agent-demo';

    const session = createSession();
    (session as { pendingTransfer?: PendingTransfer }).pendingTransfer = {
      ...pendingFixture,
      network: 'sepolia',
      token: 'USDT',
    };
    const { provider, calls } = fakeWalletProvider({});

    const result = await handleMessage(session, 'confirm');

    // The legacy path broadcasts through the WDK fixture tools and verifies via
    // defaultTransactionReceiptWaiter's immediate fixture outcome — no provider
    // waitForFinality call. The explorer base is the Solana explorer: this
    // deployment serves Solana devnet only and an unrecognised network no
    // longer falls back to Sepolia's Etherscan.
    expect(result).toMatchObject({
      status: 'sent',
      message: 'Transfer confirmed.',
      transaction: {
        network: 'sepolia',
        transactionHash: '0x' + '1'.padStart(64, '0'),
        explorerUrl: 'https://explorer.solana.com/tx/0x' + '1'.padStart(64, '0'),
      },
    });
    expect(broadcastCalls(calls)).toBe(0);
    expect(calls.finality).toHaveLength(0);
    expect(provider.waitForFinality).not.toHaveBeenCalled();
  });

  function pendingSession(): ConversationSession {
    const session = createSession();
    (session as { pendingTransfer?: PendingTransfer }).pendingTransfer = { ...pendingFixture };
    return session;
  }

  it('prefers an explicitly injected receipt waiter over the provider and fails closed on its error', async () => {
    const session = pendingSession();
    const { provider, calls } = fakeWalletProvider({});

    const result = await handleMessage(session, 'confirm', {
      walletProvider: provider,
      transactionReceiptWaiter: async () => {
        throw new Error('injected waiter deadline exceeded');
      },
    });

    expect(result).toMatchObject({ status: 'error', code: 'transaction_receipt_invalid' });
    expect(result.message).toContain('injected waiter deadline exceeded');
    expect(broadcastCalls(calls)).toBe(1);
    // The injected waiter is the single verification source: the provider's
    // waitForFinality must never run in parallel.
    expect(calls.finality).toHaveLength(0);
    expect(provider.waitForFinality).not.toHaveBeenCalled();
  });
});
