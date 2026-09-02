import { describe, expect, it, vi } from 'vitest';
import { createWalletConversationService } from '../../src/conversations/service.js';
import type { ConversationRepository } from '../../src/conversations/repository.js';
import type { ConversationSnapshot } from '../../src/conversations/types.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';

const userId = '11111111-1111-4111-8111-111111111111';
const conversationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const recipient = '0x1234567890123456789012345678901234567890';

function repositoryFixture() {
  let snapshot: ConversationSnapshot = {
    id: conversationId,
    userId,
    mode: 'live',
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 4,
    language: 'en',
    generation: 1,
    messages: [],
  };
  const saveSnapshot = vi.fn(async (_userId: string, incoming: ConversationSnapshot) => {
    snapshot = {
      ...incoming,
      revision: snapshot.revision + 1,
      pendingTransfer: incoming.pendingTransfer
        ? { ...incoming.pendingTransfer, previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
        : undefined,
    };
    return snapshot;
  });
  return {
    repository: {
      get: async () => ({ ...snapshot, messages: [...snapshot.messages] }),
      saveSnapshot,
    } as unknown as ConversationRepository,
    snapshot: () => snapshot,
    saveSnapshot,
  };
}

describe('native preview command', () => {
  it('normalizes and persists a preview without any broadcast capability', async () => {
    const fixture = repositoryFixture();
    const wallet = new FixtureWalletProvider();
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({
      conversations: fixture.repository,
      wallet,
    });
    const session = { id: conversationId, messages: [] };

    const result = await service.persistNativePreview({
      conversationId,
      userId,
      session,
      input: {
        network: 'sepolia', token: 'USDT', to: recipient, amount: '1', wallet: 'agent-demo', dryRun: true,
      },
      output: {
        preview: true,
        estimatedFee: '0.0003 ETH',
      },
    });

    expect(result).toMatchObject({
      status: 'preview_created',
      preview: { recipient, amount: '1', token: 'USDT' },
      previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      revision: 5,
    });
    expect(fixture.snapshot()).toMatchObject({
      progress: { phase: 'awaiting_confirmation' },
      pendingTransfer: {
        to: recipient,
      },
    });
    expect(fixture.saveSnapshot).toHaveBeenCalledOnce();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects malformed tool output without changing durable state', async () => {
    const fixture = repositoryFixture();
    const service = createWalletConversationService({
      conversations: fixture.repository,
      wallet: new FixtureWalletProvider(),
    });

    await expect(service.persistNativePreview({
      conversationId,
      userId,
      session: { id: conversationId, messages: [] },
      input: {
        network: 'sepolia', token: 'USDT', to: recipient, amount: '1', wallet: 'agent-demo', dryRun: true,
      },
      output: { preview: true },
    })).resolves.toMatchObject({ error: 'invalid_tool_result' });
    expect(fixture.saveSnapshot).not.toHaveBeenCalled();
  });
});
