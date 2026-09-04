import { describe, expect, it, vi } from 'vitest';
import { toAiSdkTools } from '../../src/agent/ai-sdk-adapter.js';
import {
  createWalletAgentDefinition,
  type WalletAgentContext,
} from '../../src/agent/definition.js';
import { toLiveKitTools } from '../../src/agent/livekit-adapter.js';
import { createSession } from '../../src/conversations/test-fixtures.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';

const recipient = '0x1234567890123456789012345678901234567890';

function context(wallet: FixtureWalletProvider): WalletAgentContext {
  const session = createSession();
  return {
    conversationId: session.id,
    userId: '11111111-1111-4111-8111-111111111111',
    language: 'en',
    config: { wallet: 'agent-demo', network: 'sepolia', token: 'USDT' },
    session,
    wallet,
  };
}

describe('LiveKit runtime parity', () => {
  it('uses canonical read and preview operations with equivalent fixture outcomes', async () => {
    const definition = createWalletAgentDefinition();
    const aiWallet = new FixtureWalletProvider();
    const nativeWallet = new FixtureWalletProvider();
    const aiBroadcast = vi.spyOn(aiWallet, 'broadcastTransfer');
    const nativeBroadcast = vi.spyOn(nativeWallet, 'broadcastTransfer');
    const aiContext = context(aiWallet);
    const nativeContext = context(nativeWallet);
    const aiTools = toAiSdkTools(definition, aiContext);
    const nativeTools = toLiveKitTools(definition, nativeContext);
    const nativeBalance = nativeTools.find((tool) => tool.name === 'get_balance');
    const nativePreview = nativeTools.find((tool) => tool.name === 'send_token');
    const signal = new AbortController().signal;

    const aiBalance = await aiTools.get_balance!.execute!(
      { network: 'sepolia', token: 'USDT', wallet: 'agent-demo' },
      { abortSignal: signal } as never,
    );
    const liveKitBalance = await nativeBalance!.execute(
      { network: 'sepolia', token: 'USDT', wallet: 'agent-demo' },
      { abortSignal: signal, ctx: {}, toolCallId: 'balance' } as never,
    );

    const previewInput = {
      network: 'sepolia',
      token: 'USDT',
      to: recipient,
      amount: '2',
      wallet: 'agent-demo',
      dryRun: true,
    };
    const aiPreview = await aiTools.send_token!.execute!(
      previewInput,
      { abortSignal: signal } as never,
    );
    const liveKitPreview = await nativePreview!.execute(
      previewInput,
      { abortSignal: signal, ctx: {}, toolCallId: 'preview' } as never,
    );

    expect(liveKitBalance).toEqual(aiBalance);
    expect(liveKitPreview).toEqual(aiPreview);
    expect(aiBroadcast).not.toHaveBeenCalled();
    expect(nativeBroadcast).not.toHaveBeenCalled();
  });
});
