import { llm } from '@livekit/agents';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  NATIVE_PREVIEW_TOOL_NAMES,
  toLiveKitTools,
} from '../../src/agent/livekit-adapter.js';
import { createWalletAgentDefinition, type WalletAgentContext, type WalletAgentDefinition } from '../../src/agent/definition.js';
import { createSession } from '../../src/conversations/test-fixtures.js';
import { FixtureWalletProvider } from '../../src/wallet/fixture-provider.js';

const recipient = '0x1234567890123456789012345678901234567890';

function context(): WalletAgentContext {
  const session = createSession();
  return {
    conversationId: session.id,
    userId: '11111111-1111-4111-8111-111111111111',
    language: 'en',
    config: { wallet: 'agent-demo', network: 'sepolia', token: 'USDT' },
    session,
    wallet: new FixtureWalletProvider(),
  };
}

function execution(signal: AbortSignal) {
  return { abortSignal: signal, ctx: {}, toolCallId: 'native-tool' } as never;
}

describe('LiveKit tool adapter', () => {
  it('preserves canonical metadata and exposes no extra native tools', () => {
    const definition = createWalletAgentDefinition();
    const input = context();
    const native = toLiveKitTools(definition, input, {
      allowedTools: NATIVE_PREVIEW_TOOL_NAMES.filter((name) =>
        definition.tools(input).some((tool) => tool.name === name),
      ),
    });

    expect(native.map((tool) => tool.name).sort()).toEqual(
      definition.tools(input).map((tool) => tool.name).sort(),
    );
    for (const tool of native) {
      const canonical = definition.tools(input).find((value) => value.name === tool.name);
      expect(tool.description).toBe(canonical?.description);
      expect(tool.parameters).toBe(canonical?.inputSchema);
    }
  });

  it('propagates abort only to cancellable work', async () => {
    const readSignal = vi.fn();
    const writeSignal = vi.fn();
    const definition: WalletAgentDefinition = {
      instructions: () => 'test',
      tools: () => [
        {
          name: 'get_balance',
          description: 'read',
          inputSchema: z.object({}).strict(),
          execute: async (_input, toolContext) => {
            readSignal(toolContext.signal);
            return { ok: true };
          },
        },
        {
          name: 'write_user_memory',
          description: 'write',
          inputSchema: z.object({}).strict(),
          execute: async (_input, toolContext) => {
            writeSignal(toolContext.signal);
            return { ok: true };
          },
        },
      ],
    };
    const signal = new AbortController().signal;
    const tools = toLiveKitTools(definition, context());

    await tools.find((tool) => tool.name === 'get_balance')!.execute({}, execution(signal));
    await tools.find((tool) => tool.name === 'write_user_memory')!.execute({}, execution(signal));

    expect(readSignal).toHaveBeenCalledWith(signal);
    expect(writeSignal).toHaveBeenCalledWith(undefined);
    expect(tools.find((tool) => tool.name === 'get_balance')?.flags).toBe(llm.ToolFlag.CANCELLABLE);
    expect(tools.find((tool) => tool.name === 'write_user_memory')?.flags).toBe(llm.ToolFlag.NONE);
  });

  it('refuses dryRun false before the canonical operation can broadcast', async () => {
    const input = context();
    const broadcast = vi.spyOn(input.wallet, 'broadcastTransfer');
    const sendToken = toLiveKitTools(createWalletAgentDefinition(), input, {
      allowedTools: ['send_token'],
    })[0]!;

    await expect(sendToken.execute({
      network: 'sepolia',
      token: 'USDT',
      to: recipient,
      amount: '1',
      wallet: 'agent-demo',
      dryRun: false,
    }, execution(new AbortController().signal))).resolves.toMatchObject({
      error: 'confirmation_required',
    });
    expect(broadcast).not.toHaveBeenCalled();
  });
});
