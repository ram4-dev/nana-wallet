import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletConversationService, type ConversationEvent } from '../../src/conversations/service.js';
import type { ConversationRepository } from '../../src/conversations/repository.js';
import type { ConversationSnapshot, ConversationState, WalletProgress } from '../../src/conversations/types.js';
import type { PendingTransfer } from '../../src/contracts/http.js';
import type {
  BroadcastOutcome,
  FinalityOutcome,
  WalletProvider,
} from '../../src/wallet/provider.js';

const userId = '11111111-1111-4111-8111-111111111111';
const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const previewId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const recipient = '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd';
const txHash = `0x${'cc'.repeat(32)}`;

const pendingFixture: PendingTransfer = {
  network: 'arc-testnet',
  token: 'USDC',
  to: recipient,
  amount: '1',
  wallet: 'agent-demo',
  preview: {
    network: 'arc-testnet',
    token: 'USDC',
    recipient,
    amount: '1',
    estimatedFee: '0.00001 USDC',
  },
  previewId,
};

function repositoryFixture(initialTransfer: PendingTransfer): ConversationRepository {
  let snapshot: ConversationSnapshot = {
    id: conversationId,
    userId,
    mode: 'typed',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: 'en',
    generation: 1,
    messages: [],
    pendingTransfer: { ...initialTransfer },
  };
  let claimed = false;

  const repository = {
    async get() {
      return { ...snapshot, messages: [...snapshot.messages] };
    },
    async inspect() {
      return snapshot;
    },
    async appendMessage(_userId: string, _id: string, message: ConversationSnapshot['messages'][number]) {
      snapshot.messages.push(message);
    },
    async saveSnapshot(_userId: string, incoming: ConversationSnapshot) {
      snapshot = incoming;
      return snapshot;
    },
    async updateState(_userId: string, _id: string, _revision: number, state: ConversationState) {
      snapshot = { ...snapshot, ...state, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setProgress(_userId: string, _id: string, progress: WalletProgress) {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async claimPendingTransfer(_userId: string, _id: string) {
      if (!snapshot.pendingTransfer || claimed) return { status: 'missing' as const };
      claimed = true;
      snapshot = { ...snapshot, transferResolutionState: 'broadcasting', revision: snapshot.revision + 1 };
      return { status: 'claimed' as const, transfer: { ...snapshot.pendingTransfer, previewId } };
    },
    async releasePendingTransferClaim() {
      claimed = false;
      snapshot = { ...snapshot, transferResolutionState: undefined };
    },
    async clearPendingTransfer() {
      snapshot = { ...snapshot, pendingTransfer: undefined, transferResolutionState: undefined, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async markPendingTransferUncertain() {
      snapshot = { ...snapshot, transferResolutionState: 'uncertain', revision: snapshot.revision + 1 };
    },
    async markTransferSubmitted(_userId: string, _id: string, hash: string) {
      snapshot = { ...snapshot, lastTransactionHash: hash, revision: snapshot.revision + 1 };
    },
    async finalizeTransfer(_userId: string, _id: string, result: { transactionHash: string }) {
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        transferResolutionState: undefined,
        lastTransactionHash: result.transactionHash,
        revision: snapshot.revision + 1,
      };
    },
    async setMode() {
      return snapshot.revision + 1;
    },
    async acquireLiveLease() {
      throw new Error('not used');
    },
    async renewLiveLease() {
      return false;
    },
    async releaseLiveLease() {
      return false;
    },
  };
  return repository as unknown as ConversationRepository;
}

describe('typed confirm flow previewId transport', () => {
  const previousSource = process.env.WDK_TOOLS_SOURCE;

  beforeEach(() => {
    delete process.env.WDK_TOOLS_SOURCE;
  });

  afterEach(() => {
    if (previousSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousSource;
  });

  function capturingWallet(): {
    wallet: WalletProvider;
    broadcastRequests: Array<Record<string, unknown>>;
  } {
    const broadcastRequests: Array<Record<string, unknown>> = [];
    const wallet = {
      id: 'solana-devnet',
      mode: 'live' as const,
      health: vi.fn(async () => ({ status: 'healthy' as const })),
      listNetworks: vi.fn(async () => []),
      listTokens: vi.fn(async () => []),
      getAddress: vi.fn(async () => ({ network: 'arc-testnet', address: '0x1' })),
      getBalance: vi.fn(async () => ({ network: 'arc-testnet', address: '0x1', balance: '0' })),
      getHistory: vi.fn(async () => ({ network: 'arc-testnet', transactions: [] })),
      previewTransfer: vi.fn(async () => {
        throw new Error('not used in this test');
      }),
      broadcastTransfer: vi.fn(async (request: Record<string, unknown>): Promise<BroadcastOutcome> => {
        broadcastRequests.push(request);
        return {
          kind: 'submitted',
          transaction: {
            network: 'arc-testnet',
            transactionHash: txHash,
            explorerUrl: `https://testnet.arcscan.app/tx/${txHash}`,
          },
        };
      }),
      waitForFinality: vi.fn(async (): Promise<FinalityOutcome> => ({
        status: 'confirmed',
        transactionHash: txHash,
        network: 'arc-testnet',
      })),
      close: vi.fn(async () => undefined),
    } as unknown as WalletProvider;
    return { wallet, broadcastRequests };
  }

  it('carries the persisted previewId from the claimed transfer into the broadcast request', async () => {
    const { wallet, broadcastRequests } = capturingWallet();
    const service = createWalletConversationService({
      conversations: repositoryFixture(pendingFixture),
      wallet,
    });

    const results: ConversationEvent[] = [];
    for await (const event of service.resolveDecision({
      conversationId,
      userId,
      previewId,
      decision: 'confirm',
    })) {
      results.push(event);
    }

    const completed = results.find((event) => event.type === 'turn-completed');
    expect(completed?.result).toMatchObject({ status: 'sent', message: 'Transfer confirmed.' });
    expect(broadcastRequests).toHaveLength(1);
    expect(broadcastRequests[0]).toMatchObject({
      network: 'arc-testnet',
      token: 'USDC',
      to: recipient,
      amount: '1',
      wallet: 'agent-demo',
      previewId,
    });
  });
});
