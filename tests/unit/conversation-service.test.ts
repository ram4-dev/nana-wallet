import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWalletConversationService, type ConversationEvent } from '../../src/conversations/service.js';
import type { ConversationRepository } from '../../src/conversations/repository.js';
import type { ConversationSnapshot, ConversationState, WalletProgress } from '../../src/conversations/types.js';
import type { PendingTransfer } from '../../src/contracts/http.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';
import type { WalletProvider } from '../../src/wallet/provider.js';
import { FinancialTaskRegistry } from '../../src/conversations/financial-task-registry.js';

const userId = '11111111-1111-4111-8111-111111111111';
const recipient = '0x1234567890123456789012345678901234567890';

function repositoryFixture(initialTransfer?: PendingTransfer): ConversationRepository {
  let snapshot: ConversationSnapshot = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    userId,
    mode: 'typed',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: 'es',
    generation: 1,
    messages: [],
    ...(initialTransfer ? { pendingTransfer: { ...initialTransfer, previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' } } : {}),
  };
  let transferStatus: 'previewed' | 'broadcasting' | 'submitted' | 'uncertain' | 'confirmed' | 'reverted' | 'receipt_invalid' | 'cancelled' | undefined = initialTransfer ? 'previewed' : undefined;

  const repository = {
    async create() { return snapshot; },
    async get(requestUserId: string, id: string) {
      return requestUserId === userId && id === snapshot.id ? { ...snapshot, messages: [...snapshot.messages] } : undefined;
    },
    async inspect(requestUserId: string, id: string) { return this.get(requestUserId, id); },
    async appendMessage(_requestUserId: string, _id: string, message: ConversationSnapshot['messages'][number]) {
      snapshot.messages.push(message);
    },
    async saveSnapshot(_requestUserId: string, incoming: ConversationSnapshot, _count: number) {
      snapshot = {
        ...incoming,
        pendingTransfer: incoming.pendingTransfer
          ? { ...incoming.pendingTransfer, previewId: incoming.pendingTransfer.previewId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
          : undefined,
        revision: incoming.revision + 1,
      };
      transferStatus = snapshot.pendingTransfer ? 'previewed' : transferStatus;
      return snapshot;
    },
    async updateState(_requestUserId: string, _id: string, _revision: number, state: ConversationState) {
      snapshot = { ...snapshot, ...state, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setProgress(_requestUserId: string, _id: string, progress: WalletProgress) {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setPendingTransfer(_requestUserId: string, _id: string, transfer: NonNullable<ConversationSnapshot['pendingTransfer']>) {
      snapshot = { ...snapshot, pendingTransfer: { ...transfer, previewId: transfer.previewId ?? 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }, revision: snapshot.revision + 1 };
      transferStatus = 'previewed';
      return snapshot;
    },
    async clearPendingTransfer() { transferStatus = 'cancelled'; snapshot = { ...snapshot, pendingTransfer: undefined, transferResolutionState: undefined, revision: snapshot.revision + 1 }; return snapshot; },
    async cancelPendingTransfer(_requestUserId: string, _id: string, previewId: string) {
      if (transferStatus !== 'previewed' || snapshot.pendingTransfer?.previewId !== previewId) return 'stale_preview' as const;
      transferStatus = 'cancelled';
      snapshot = { ...snapshot, pendingTransfer: undefined, revision: snapshot.revision + 1 };
      return 'cancelled' as const;
    },
    async claimPendingTransfer() {
      if (!snapshot.pendingTransfer) return { status: 'missing' as const };
      if (transferStatus === 'broadcasting') return { status: 'broadcasting' as const };
      if (transferStatus === 'uncertain') return { status: 'uncertain' as const };
      transferStatus = 'broadcasting';
      snapshot = { ...snapshot, transferResolutionState: 'broadcasting', revision: snapshot.revision + 1 };
      const claimedTransfer = snapshot.pendingTransfer;
      if (!claimedTransfer) return { status: 'missing' as const };
      return { status: 'claimed' as const, transfer: { ...claimedTransfer, previewId: claimedTransfer.previewId! } };
    },
    async releasePendingTransferClaim() { transferStatus = 'previewed'; snapshot = { ...snapshot, transferResolutionState: undefined }; },
    async markPendingTransferUncertain() { transferStatus = 'uncertain'; snapshot = { ...snapshot, transferResolutionState: 'uncertain', revision: snapshot.revision + 1 }; },
    async setLastTransactionHash(_requestUserId: string, _id: string, hash: string) { snapshot = { ...snapshot, lastTransactionHash: hash }; },
    async markTransferSubmitted(_requestUserId: string, _id: string, hash: string) { transferStatus = 'submitted'; snapshot = { ...snapshot, lastTransactionHash: hash, revision: snapshot.revision + 1 }; },
    async finalizeTransfer(_requestUserId: string, _id: string, result: { status: 'confirmed' | 'reverted' | 'receipt_invalid'; transactionHash: string }) {
      transferStatus = result.status;
      snapshot = { ...snapshot, pendingTransfer: undefined, transferResolutionState: undefined, lastTransactionHash: result.transactionHash, revision: snapshot.revision + 1 };
    },
    async setMode() { return snapshot.revision + 1; },
    async acquireLiveLease() { throw new Error('not used'); },
    async renewLiveLease() { return false; },
    async releaseLiveLease() { return false; },
  };

  return repository as unknown as ConversationRepository;
}

function walletFixture(): WalletProvider {
  return new FixtureWalletProvider();
}

async function events(service: ReturnType<typeof createWalletConversationService>, input: Parameters<ReturnType<typeof createWalletConversationService>['handleTurnStream']>[0]): Promise<ConversationEvent[]> {
  const result: ConversationEvent[] = [];
  for await (const event of service.handleTurnStream(input)) result.push(event);
  return result;
}

describe('WalletConversationService', () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  const previousSource = process.env.WDK_TOOLS_SOURCE;
  const previousMaximum = process.env.WDK_MAX_TRANSFER_AMOUNT;
  const previousAllowed = process.env.WDK_ALLOWED_RECIPIENTS;

  beforeEach(() => {
    process.env.AGENT_RUNTIME = 'deterministic';
    process.env.WDK_TOOLS_SOURCE = 'fixture';
  });

  it('streams a canonical preview through the injected wallet provider', async () => {
    const repository = repositoryFixture();
    const service = createWalletConversationService({ conversations: repository, wallet: walletFixture() });
    const streamed = await events(service, { conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    expect(streamed).toContainEqual(expect.objectContaining({ type: 'spoken-segment', reason: 'started' }));
    expect(streamed).toContainEqual(expect.objectContaining({ type: 'spoken-segment', reason: 'decision' }));
    expect(streamed).toContainEqual(expect.objectContaining({ type: 'turn-completed', result: expect.objectContaining({ status: 'confirmation_required', preview: expect.objectContaining({ recipient, amount: '10', token: 'USDT' }) }) }));
  });

  it('clarifies an incomplete financial turn before invoking the provider', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const preview = vi.spyOn(wallet, 'previewTransfer');
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      clock: { now: () => 1_000 },
    });

    const result = await service.handleTurn({
      conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId,
      text: 'Send 10 to Ana',
    });

    expect(result).toMatchObject({ status: 'clarification_required' });
    expect(preview).not.toHaveBeenCalled();
  });

  it('atomically resolves a preview and persists a trustworthy terminal result', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    const preview = await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    expect(preview.status).toBe('confirmation_required');
    const resolved = await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' });
    expect(resolved).toMatchObject({ status: 'sent', transaction: { transactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u) } });
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('fails closed when the provider cannot establish broadcast evidence', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    vi.spyOn(wallet, 'broadcastTransfer').mockResolvedValue({ kind: 'uncertain', reason: 'provider detail must stay private' });
    const service = createWalletConversationService({ conversations: repository, wallet });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' })).resolves.toMatchObject({ status: 'error', code: 'broadcast_uncertain', message: expect.stringContaining('uncertain') });
  });

  it('returns a stable policy error before any provider side effect', async () => {
    process.env.WDK_TOOLS_SOURCE = 'live';
    delete process.env.WDK_MAX_TRANSFER_AMOUNT;
    delete process.env.WDK_ALLOWED_RECIPIENTS;
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const preview = vi.spyOn(wallet, 'previewTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` })).resolves.toMatchObject({ status: 'error', code: 'policy_rejected', message: expect.not.stringContaining('WDK_MAX_TRANSFER_AMOUNT') });
    expect(preview).not.toHaveBeenCalled();
  });

  it('revalidates the recipient after the atomic claim and before dispatch', async () => {
    const transfer: PendingTransfer = {
      network: 'sepolia', token: 'USDT', to: recipient, amount: '10', wallet: 'agent-demo',
      preview: { network: 'sepolia', token: 'USDT', recipient, amount: '10', estimatedFee: '0.0003 ETH' },
      recipientId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', recipientVersion: 2,
      previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    };
    const repository = repositoryFixture(transfer);
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const memory = { userId, service: { getRecipientForVersion: vi.fn().mockResolvedValue(undefined) } } as never;
    const service = createWalletConversationService({ conversations: repository, wallet, memory });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' })).resolves.toMatchObject({ status: 'error', code: 'recipient_revalidation_required' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it.each(['reverted', 'receipt_invalid'] as const)('records %s finality as terminal without rebroadcasting', async (status) => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    vi.spyOn(wallet, 'waitForFinality').mockResolvedValue({ status, network: 'sepolia', transactionHash: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' })).resolves.toMatchObject({ status: 'error', code: status === 'reverted' ? 'transfer_reverted' : 'transaction_receipt_invalid' });
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('uses the same decision path for cancellation without invoking the provider', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations: repository, wallet });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });
    await expect(service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'cancelar la transferencia' })).resolves.toEqual({ status: 'cancelled', message: 'Transfer cancelled.' });
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('allows only one spoken or touch confirmation to claim the preview', async () => {
    const repository = repositoryFixture();
    const wallet = walletFixture();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const registry = new FinancialTaskRegistry();
    const service = createWalletConversationService({ conversations: repository, wallet, financialTasks: registry });
    await service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: `Send 10 USDT to ${recipient}` });

    const [spoken, touch] = await Promise.all([
      service.handleTurn({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, text: 'confirmar la transferencia' }),
      service.resolveDecision({ conversationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', userId, previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', decision: 'confirm' }),
    ]);
    await registry.drain({ timeoutMs: 1000 });

    expect(broadcast).toHaveBeenCalledOnce();
    expect(spoken).toMatchObject({ status: 'answer' });
    const touchEvents: ConversationEvent[] = [];
    for await (const event of touch) touchEvents.push(event);
    expect(touchEvents.some((event) => event.type === 'turn-completed')).toBe(true);
    expect(registry.has('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb')).toBe(false);
  });

  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
    if (previousSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousSource;
    if (previousMaximum === undefined) delete process.env.WDK_MAX_TRANSFER_AMOUNT;
    else process.env.WDK_MAX_TRANSFER_AMOUNT = previousMaximum;
    if (previousAllowed === undefined) delete process.env.WDK_ALLOWED_RECIPIENTS;
    else process.env.WDK_ALLOWED_RECIPIENTS = previousAllowed;
  });
});
