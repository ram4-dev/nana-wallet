import { llm } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import {
  createLiveKitModel,
  READ_ONLY_TOOL_NAMES,
} from "../../src/agent/livekit-adapter.js";
import { getOpenCodeGoModelConfig } from "../../src/agent/model.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { createNativeLiveKitAgent } from "../../src/livekit/create-native-agent.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";

function snapshot(): ConversationSnapshot {
  return {
    id: "conversation-1",
    userId: "user-1",
    mode: "live",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 3,
    language: "es",
    generation: 1,
    messages: [
      { role: "user", content: "Hola" },
      { role: "tool", content: [{ type: "tool-result", toolCallId: "call-1", toolName: "get_balance", output: { type: "text", value: "ignored" } }] },
      { role: "assistant", content: "¿En qué te ayudo?" },
    ],
  };
}

describe("native LiveKit wallet agent factory", () => {
  it("hydrates only durable user and assistant messages and exposes read tools", () => {
    const source = snapshot();
    const agent = withOpenCodeCredentials(() => createNativeLiveKitAgent({
      binding: { conversationId: source.id, userId: source.userId },
      snapshot: source,
      context: {
        conversationId: source.id,
        userId: source.userId,
        language: source.language,
        config: { wallet: "agent-demo", network: "sepolia", token: "USDT" },
        session: { id: source.id, messages: [...source.messages] },
        wallet: new FixtureWalletProvider(),
      },
    }));

    expect(agent.instructions).toContain("Respond in Spanish");
    expect(agent.chatCtx.items).toHaveLength(2);
    expect(agent.chatCtx.items.map((item) => item.type === "message" ? item.role : item.type)).toEqual([
      "user",
      "assistant",
    ]);
    expect(Object.keys(agent.toolCtx.functionTools).sort()).toEqual([...READ_ONLY_TOOL_NAMES].sort());
    expect(agent.toolCtx.functionTools.get_balance?.flags).toBe(llm.ToolFlag.CANCELLABLE);
    expect(agent.toolCtx.functionTools.send_token).toBeUndefined();
  });

  it("uses the same OpenCode Go endpoint and model settings as typed turns", () => {
    const environment = {
      OPENCODE_GO_API_KEY: "test-key",
      OPENCODE_GO_BASE_URL: "https://models.example/v1",
      OPENCODE_GO_MODEL: "deepseek-test",
    };
    const config = getOpenCodeGoModelConfig(environment);
    const previous = {
      apiKey: process.env.OPENCODE_GO_API_KEY,
      baseURL: process.env.OPENCODE_GO_BASE_URL,
      model: process.env.OPENCODE_GO_MODEL,
    };
    process.env.OPENCODE_GO_API_KEY = environment.OPENCODE_GO_API_KEY;
    process.env.OPENCODE_GO_BASE_URL = environment.OPENCODE_GO_BASE_URL;
    process.env.OPENCODE_GO_MODEL = environment.OPENCODE_GO_MODEL;
    try {
      expect(createLiveKitModel().model).toBe(config.model);
    } finally {
      restoreEnvironment("OPENCODE_GO_API_KEY", previous.apiKey);
      restoreEnvironment("OPENCODE_GO_BASE_URL", previous.baseURL);
      restoreEnvironment("OPENCODE_GO_MODEL", previous.model);
    }
  });

  it("rejects a snapshot that does not match the verified binding", () => {
    const source = snapshot();
    expect(() => withOpenCodeCredentials(() => createNativeLiveKitAgent({
      binding: { conversationId: "other", userId: source.userId },
      snapshot: source,
      context: {
        conversationId: "other",
        userId: source.userId,
        language: source.language,
        config: { wallet: "agent-demo", network: "sepolia", token: "USDT" },
        session: { id: source.id, messages: [] },
        wallet: new FixtureWalletProvider(),
      },
    }))).toThrow("Native LiveKit agent must use the bound conversation snapshot.");
  });
});

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function withOpenCodeCredentials<T>(callback: () => T): T {
  const previous = process.env.OPENCODE_GO_API_KEY;
  process.env.OPENCODE_GO_API_KEY = "test-key";
  try {
    return callback();
  } finally {
    restoreEnvironment("OPENCODE_GO_API_KEY", previous);
  }
}
