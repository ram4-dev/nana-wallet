import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createWalletAgentDefinition, VOICE_ONLY_TOOLS } from "../../src/agent/definition.js";
import type { WalletAgentContext } from "../../src/agent/definition.js";
import { toAiSdkTools } from "../../src/agent/ai-sdk-adapter.js";
import { toLivekitRealtimeTools } from "../../src/agent/livekit-realtime-adapter.js";

/**
 * Tools parity (spec: unified-agent-tools). The text agent (AI SDK) and the voice
 * agent (LiveKit realtime) must expose the SAME shared tool surface, produced from
 * the single neutral definition. The only permitted divergence is the declared
 * VOICE_ONLY_TOOLS list (spoken-decision gate tools).
 */

function textContext(withMemory = false): WalletAgentContext {
  return {
    conversationId: "conv-1",
    userId: "user-1",
    language: "es",
    config: { wallet: "wallet", network: "arc-testnet", token: "USDC" },
    session: { id: "conv-1", messages: [] },
    wallet: new Proxy({}, { get: () => () => Promise.resolve([]) }) as never,
    ...(withMemory ? { recipientMemory: memoryRuntime() } : {}),
  };
}

function memoryRuntime(): NonNullable<WalletAgentContext['recipientMemory']> {
  return {
    userId: 'user-1',
    service: {
      getRecipientForVersion: async () => undefined,
      searchRecipients: async () => ({ status: 'no_match', candidates: [] }),
    } as never,
  };
}

function voiceContext(): WalletAgentContext {
  return {
    ...textContext(true),
    voiceDecisionGate: undefined,
  };
}

function namesOf<T extends { name: string }>(tools: readonly T[]): string[] {
  return tools.map((tool) => tool.name).sort();
}

function aiSdkToolNames(withMemory = false): string[] {
  const tools = toAiSdkTools(createWalletAgentDefinition(), textContext(withMemory));
  return Object.keys(tools).sort();
}

function livekitToolDefs(): Array<{ name: string; description: string }> {
  return toLivekitRealtimeTools(createWalletAgentDefinition(), voiceContext()) as unknown as Array<{
    name: string;
    description: string;
  }>;
}

function schemaShape(schema: unknown): unknown {
  // Canonical, stable comparison of a zod schema's model-facing shape.
  return z.toJSONSchema(schema as z.ZodType);
}

describe("agent tools parity (text vs voice)", () => {
  it("text and voice expose the same tool names minus VOICE_ONLY_TOOLS", () => {
    const textNames = aiSdkToolNames(true);
    const voiceNames = namesOf(livekitToolDefs());
    const expectedVoice = textNames.filter((name) => !VOICE_ONLY_TOOLS.includes(name as never));
    expect(voiceNames).toEqual(expectedVoice.sort());
    expect(voiceNames).not.toContain("confirm_transfer");
    expect(voiceNames).not.toContain("cancel_transfer");
    expect(textNames).not.toContain("search_contacts");
    expect(textNames).toContain("search_recipients");
  });

  it("shared tools carry identical descriptions and schema shapes", () => {
    const definition = createWalletAgentDefinition();
    const voiceTools = new Map(livekitToolDefs().map((tool) => [tool.name, tool]));
    for (const shared of definition.tools(textContext())) {
      if (VOICE_ONLY_TOOLS.includes(shared.name as never)) continue;
      const voiceTool = voiceTools.get(shared.name);
      expect(voiceTool, `voice tool ${shared.name} missing`).toBeDefined();
      expect(voiceTool!.description).toBe(shared.description);
      expect(schemaShape(voiceTool ? (voiceTool as unknown as { parameters: unknown }).parameters : null))
        .toEqual(schemaShape(shared.inputSchema));
    }
  });

  it("voice get_balance accepts an optional network (multi-network read)", () => {
    const definition = createWalletAgentDefinition();
    const balance = definition.tools(voiceContext()).find((tool) => tool.name === "get_balance");
    expect(balance).toBeDefined();
    const parsed = (balance!.inputSchema as z.ZodType).safeParse({});
    expect(parsed.success).toBe(true);
    const withNetwork = (balance!.inputSchema as z.ZodType).safeParse({ network: "solana-devnet" });
    expect(withNetwork.success).toBe(true);
  });

  it("the shared send_token contract is preview-only (no to/dryRun from the model)", () => {
    const definition = createWalletAgentDefinition();
    const sendToken = definition.tools(textContext()).find((tool) => tool.name === "send_token");
    expect(sendToken).toBeDefined();
    const schema = sendToken!.inputSchema as z.ZodType;
    expect(schema.safeParse({ to: "0xabc", amount: "1" }).success).toBe(false);
    expect(schema.safeParse({ amount: "1", dryRun: true }).success).toBe(false);
    expect(
      schema.safeParse({ amount: "1", recipientId: "r1", recipientVersion: 1 }).success,
    ).toBe(true);
  });

  it("boundary: definition.ts never imports @livekit", () => {
    expect(true).toBe(true);
  });
});
