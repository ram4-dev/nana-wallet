import { describe, expect, it } from "vitest";
import {
  ChatContext,
  DEFAULT_API_CONNECT_OPTIONS,
  initializeLogger,
} from "@livekit/agents";
import {
  lastCompletedUserTurn,
  WalletConversationLLM,
} from "../../src/livekit/wallet-conversation-llm.js";
import { createRevisionPublisher } from "../../src/livekit/revision-publisher.js";

describe("LiveKit stream boundaries", () => {
  initializeLogger({ pretty: false, level: "silent" });

  it("extracts only the latest completed user text", () => {
    expect(
      lastCompletedUserTurn([
        { role: "assistant", content: "welcome" },
        { role: "user", content: "hello" },
        { role: "assistant", content: "hi" },
      ]),
    ).toBe("hello");
  });

  it("publishes only lightweight revision events", async () => {
    const events: unknown[] = [];
    const publish = createRevisionPublisher(async (event) => {
      events.push(event);
    });
    await publish({
      type: "conversation_state_changed",
      conversationId: "c1",
      revision: 4,
    });
    expect(events).toEqual([
      { type: "conversation_state_changed", conversationId: "c1", revision: 4 },
    ]);
  });

  it("invokes the conversation service once for one completed user turn", async () => {
    const context = new ChatContext();
    context.addMessage({ role: "user", content: "Hola, ¿cómo estás?" });
    let calls = 0;
    const service = {
      handleTurnStream: async function* (input: { text: string }) {
        calls += 1;
        expect(input.text).toBe("Hola, ¿cómo estás?");
        yield {
          type: "spoken-segment" as const,
          id: "segment-1",
          text: "Estoy bien.",
          reason: "answer" as const,
        };
        yield {
          type: "turn-completed" as const,
          result: { status: "answer" as const, message: "Estoy bien." },
        };
      },
    };
    const conversationLlm = new WalletConversationLLM(service as never, {
      conversationId: "c1",
      userId: "u1",
    });
    const response = await conversationLlm
      .chat({ chatCtx: context, connOptions: DEFAULT_API_CONNECT_OPTIONS })
      .collect();
    expect(calls).toBe(1);
    expect(response.text).toBe("Estoy bien.");
  });
});
