import { describe, expect, it, vi } from 'vitest';
import { createNativeLiveKitAgent } from '../../src/livekit/create-native-agent.js';
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
    revision: 0,
    language: 'en',
    generation: 1,
    messages: [],
  };
  return {
    get: async () => ({ ...snapshot, messages: [...snapshot.messages] }),
    saveSnapshot: async (_userId: string, incoming: ConversationSnapshot) => {
      snapshot = {
        ...incoming,
        revision: snapshot.revision + 1,
        pendingTransfer: incoming.pendingTransfer
          ? { ...incoming.pendingTransfer, previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
          : undefined,
      };
      return snapshot;
    },
    snapshot: () => snapshot,
  } as unknown as ConversationRepository & { snapshot(): ConversationSnapshot };
}

describe('native LiveKit preview flow', () => {
  it('converts a native send_token dry run into a canonical preview', async () => {
    const previousKey = process.env.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_GO_API_KEY = 'test-key';
    const conversations = repositoryFixture();
    const wallet = new FixtureWalletProvider();
    const preview = vi.spyOn(wallet, 'previewTransfer');
    const broadcast = vi.spyOn(wallet, 'broadcastTransfer');
    const service = createWalletConversationService({ conversations, wallet });
    const snapshot = await conversations.get(userId, conversationId);
    if (!snapshot) throw new Error('Expected fixture conversation.');
    try {
      const agent = createNativeLiveKitAgent({
        binding: { conversationId, userId },
        snapshot,
        context: {
          conversationId,
          userId,
          language: 'en',
          config: { wallet: 'agent-demo', network: 'sepolia', token: 'USDT' },
          session: { id: conversationId, messages: [] },
          wallet,
        },
        conversationService: service,
      });
      const tool = agent.toolCtx.functionTools.send_token;
      if (!tool) throw new Error('Expected native send_token tool.');

      await expect(tool.execute({
        network: 'sepolia', token: 'USDT', to: recipient, amount: '2', wallet: 'agent-demo', dryRun: true,
      }, { abortSignal: new AbortController().signal, ctx: {}, toolCallId: 'preview' } as never)).resolves.toMatchObject({
        status: 'preview_created',
        preview: { recipient, amount: '2' },
      });

      expect(preview).toHaveBeenCalledOnce();
      expect(broadcast).not.toHaveBeenCalled();
      expect(conversations.snapshot()).toMatchObject({
        pendingTransfer: { to: recipient, amount: '2', previewId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
        progress: { phase: 'awaiting_confirmation' },
      });
    } finally {
      if (previousKey === undefined) delete process.env.OPENCODE_GO_API_KEY;
      else process.env.OPENCODE_GO_API_KEY = previousKey;
    }
  });
});
