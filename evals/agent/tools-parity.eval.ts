import 'dotenv/config';
import { evalite } from 'evalite';
import { z } from 'zod';
import {
  createWalletAgentDefinition,
  VOICE_ONLY_TOOLS,
  type WalletAgentContext,
} from '../../src/agent/definition.js';
import { toAiSdkTools } from '../../src/agent/ai-sdk-adapter.js';
import { toLivekitRealtimeTools } from '../../src/agent/livekit-realtime-adapter.js';

/**
 * Tools-parity eval (spec: unified-agent-tools, D5/D6): the text (AI SDK) and
 * voice (LiveKit realtime) agents must expose the same shared tool surface.
 * Any name, description, or schema-shape divergence outside VOICE_ONLY_TOOLS
 * fails this eval. Deterministic — no network, no model.
 */

function textContext(): WalletAgentContext {
  return {
    conversationId: 'conv-1',
    userId: 'user-1',
    language: 'es',
    config: { wallet: 'wallet', network: 'arc-testnet', token: 'USDC' },
    session: { id: 'conv-1', messages: [] },
    wallet: new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
    recipientMemory: {
      userId: 'user-1',
      service: {
        getRecipientForVersion: async () => undefined,
        searchRecipients: async () => ({ status: 'no_match', candidates: [] }),
      } as never,
    },
  };
}

function shape(schema: unknown): unknown {
  return z.toJSONSchema(schema as z.ZodType);
}

evalite('Tools parity: text vs voice surface', {
  data: [{ input: 'compare' }],
  task: () => {
    const definition = createWalletAgentDefinition();
    const textNames = Object.keys(
      toAiSdkTools(definition, textContext()),
    ).sort();
    const voiceTools = toLivekitRealtimeTools(
      definition,
      { ...textContext(), language: 'en' },
    ) as unknown as Array<{ name: string; description: string; parameters: unknown }>;
    const voiceNames = voiceTools.map((t) => t.name).sort();

    const expectedVoice = textNames
      .filter((name) => !VOICE_ONLY_TOOLS.includes(name as never))
      .sort();

    const nameParity =
      JSON.stringify(voiceNames) === JSON.stringify(expectedVoice.sort());

    let shapeParity = true;
    for (const shared of definition.tools(textContext())) {
      if (VOICE_ONLY_TOOLS.includes(shared.name as never)) continue;
      const voiceTool = voiceTools.find((t) => t.name === shared.name);
      if (!voiceTool) { shapeParity = false; break; }
      if (
        voiceTool.description !== shared.description ||
        JSON.stringify(shape(voiceTool.parameters)) !==
          JSON.stringify(shape(shared.inputSchema))
      ) {
        shapeParity = false;
        break;
      }
    }

    return {
      textNames,
      voiceNames,
      nameParity,
      shapeParity,
      voiceOnlyDeviations: voiceNames.filter(
        (name) => !textNames.includes(name),
      ),
    };
  },
  scorers: [
    {
      name: 'surface_parity',
      scorer: ({ output }) =>
        output.nameParity && output.shapeParity
          ? { score: 1 }
          : { score: 0 },
    },
    {
      name: 'voice_only_deviations_declared',
      scorer: ({ output }) =>
        output.voiceOnlyDeviations.every((name: string) =>
          VOICE_ONLY_TOOLS.includes(name as never),
        )
          ? { score: 1 }
          : { score: 0 },
    },
  ],
});
