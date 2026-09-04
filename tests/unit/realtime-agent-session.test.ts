import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  class MockAgentSession {
    options: Record<string, unknown>;
    static instances: MockAgentSession[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockAgentSession.instances.push(this);
    }
    on() {
      return this;
    }
    once() {
      return this;
    }
    start() {}
    interrupt() {}
    close() {}
  }

  class MockAgent {
    options: Record<string, unknown>;
    static instances: MockAgent[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockAgent.instances.push(this);
    }
  }

  class MockLLM {
    constructor(..._args: unknown[]) {}
  }

  class MockLLMStream {
    constructor(..._args: unknown[]) {}
  }

  class MockChatContext {
    constructor(..._args: unknown[]) {}
  }

  class MockRealtimeModel {
    options: Record<string, unknown>;
    static instances: MockRealtimeModel[] = [];
    constructor(options: Record<string, unknown>) {
      this.options = options;
      MockRealtimeModel.instances.push(this);
    }
    session() {
      return {};
    }
    close() {}
  }

  return {
    MockAgentSession,
    MockAgent,
    MockLLM,
    MockLLMStream,
    MockChatContext,
    MockRealtimeModel,
  };
});

vi.mock("@livekit/agents", () => ({
  AgentSession: h.MockAgentSession,
  Agent: h.MockAgent,
  llm: { LLM: h.MockLLM, LLMStream: h.MockLLMStream },
  ChatContext: h.MockChatContext,
  initializeLogger: () => {},
  tool: (def: Record<string, unknown>) => ({ type: "function", ...def }),
  AgentSessionEventTypes: {
    UserInputTranscribed: "user_input_transcribed",
    FunctionToolsExecuted: "function_tools_executed",
    ConversationItemAdded: "conversation_item_added",
  },
}));

vi.mock("@livekit/agents-plugin-openai", () => ({
  realtime: { RealtimeModel: h.MockRealtimeModel },
}));

import { createAgentSession } from "../../src/livekit/create-agent-session.js";

describe("OpenAI realtime agent session composition", () => {
  beforeEach(() => {
    h.MockAgentSession.instances = [];
    h.MockAgent.instances = [];
    h.MockRealtimeModel.instances = [];
    vi.clearAllMocks();
    delete process.env.OPENAI_REALTIME_MODEL;
    delete process.env.OPENAI_REALTIME_VOICE;
    delete process.env.OPENAI_API_KEY;
  });

  it("composes a realtime session without STT/TTS and injects the provided tools", () => {
    process.env.OPENAI_REALTIME_MODEL = "gpt-realtime-custom";
    process.env.OPENAI_REALTIME_VOICE = "cedar";
    process.env.OPENAI_API_KEY = "test-openai-key";

    const tools = [
      { type: "function", name: "get_balance", execute: async () => ({}) },
      { type: "function", name: "search_contacts", execute: async () => ({}) },
    ] as never;

    createAgentSession({ tools });

    const realtimeModel = h.MockRealtimeModel.instances[0];
    expect(realtimeModel.options).toMatchObject({
      model: "gpt-realtime-custom",
      voice: "cedar",
      apiKey: "test-openai-key",
    });

    const sessionOptions = h.MockAgentSession.instances[0].options;
    expect(sessionOptions.llm).toBe(realtimeModel);
    expect(sessionOptions.stt).toBeUndefined();
    expect(sessionOptions.tts).toBeUndefined();
    expect(sessionOptions.vad).toBeUndefined();
    expect(sessionOptions.turnHandling).toBeUndefined();

    const agentOptions = h.MockAgent.instances[0].options;
    expect(agentOptions.llm).toBe(realtimeModel);
    const toolNames = (agentOptions.tools as Array<{ name: string }>)
      .map((toolItem) => toolItem.name)
      .sort();
    expect(toolNames).toEqual(["get_balance", "search_contacts"]);
    expect(String(agentOptions.instructions)).toContain("Nani");
  });

  it("uses the default realtime model and voice when env is unset", () => {
    process.env.OPENAI_API_KEY = "test-key";
    createAgentSession({ tools: [] });

    expect(h.MockRealtimeModel.instances[0].options).toMatchObject({
      model: "gpt-realtime-2.1-mini",
      voice: "marin",
      apiKey: "test-key",
    });
  });

  it("requires an api key", () => {
    expect(() => createAgentSession({ tools: [] })).toThrow(
      "OPENAI_API_KEY is required",
    );
  });
});
