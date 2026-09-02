import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { issueLiveVoiceBinding } from "../../src/auth/live-binding.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";
import {
  createBindingRpcHandler,
  createRoomConversationGate,
  RoomConversation,
} from "../../src/livekit/room-conversation.js";

class FakeLiveKitRoom {
  private bindingHandler:
    | ((data: { payload: string; callerIdentity: string }) => Promise<string>)
    | undefined;
  private transcriptHandler:
    ((text: string) => AsyncIterable<unknown>) | undefined;

  public registerBindingHandler(
    handler: (data: {
      payload: string;
      callerIdentity: string;
    }) => Promise<string>,
  ) {
    this.bindingHandler = handler;
  }

  public async bind(payload: string, callerIdentity: string): Promise<string> {
    if (!this.bindingHandler)
      throw new Error("binding handler is not registered");
    return this.bindingHandler({ payload, callerIdentity });
  }

  public registerTranscriptHandler(
    handler: (text: string) => AsyncIterable<unknown>,
  ) {
    this.transcriptHandler = handler;
  }

  public async transcript(text: string): Promise<unknown[]> {
    if (!this.transcriptHandler)
      throw new Error("transcript handler is not registered");
    const events: unknown[] = [];
    for await (const event of this.transcriptHandler(text)) events.push(event);
    return events;
  }
}

class FakeAgentSession {
  public started = false;

  public async start() {
    this.started = true;
  }
}

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
    messages: [],
  };
}

function createFakeWorker() {
  const keys = generateKeyPairSync("ed25519");
  const publicKey = String(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  let serviceCalls = 0;
  let lastText: string | undefined;
  const service = {
    handleTurnStream: async function* (input: { text: string }) {
      serviceCalls += 1;
      lastText = input.text;
      yield {
        type: "spoken-segment" as const,
        id: `segment-${serviceCalls}`,
        text: "La respuesta esta lista.",
        reason: "answer" as const,
      };
      yield {
        type: "turn-completed" as const,
        result: {
          status: "answer" as const,
          message: "La respuesta esta lista.",
        },
      };
    },
  };
  const conversations = { get: async () => snapshot() };
  const conversation = new RoomConversation({
    publicKey,
    conversations: conversations as never,
    service: service as never,
  });
  const session = new FakeAgentSession();
  const gate = createRoomConversationGate({
    conversation,
    startSession: async () => session.start(),
  });
  const bindingResults: unknown[] = [];
  const room = new FakeLiveKitRoom();
  room.registerBindingHandler(
    createBindingRpcHandler({
      gate,
      workerId: "fake-worker",
      onResult: (result) => bindingResults.push(result),
    }),
  );
  room.registerTranscriptHandler((text) => gate.handleFinalTranscript(text));
  return {
    keys,
    room,
    session,
    conversation,
    bindingResults,
    serviceCalls: () => serviceCalls,
    lastText: () => lastText,
  };
}

describe("fake LiveKit worker end-to-end", () => {
  it("binds before accepting a transcript and commits one turn once", async () => {
    const worker = createFakeWorker();
    const beforeBinding: unknown[] = [];
    beforeBinding.push(...(await worker.room.transcript("antes")));
    expect(beforeBinding).toEqual([{ ok: false, code: "not_bound" }]);
    expect(worker.serviceCalls()).toBe(0);
    expect(worker.session.started).toBe(false);

    const token = await issueLiveVoiceBinding({
      userId: "user-1",
      conversationId: "conversation-1",
      privateKey: worker.keys.privateKey,
    });
    const response = JSON.parse(
      await worker.room.bind(JSON.stringify({ bindingToken: token }), "user-1"),
    ) as {
      ok: boolean;
      conversationId?: string;
      revision?: number;
    };
    expect(response).toMatchObject({
      ok: true,
      conversationId: "conversation-1",
      revision: 3,
    });
    expect(worker.session.started).toBe(true);
    expect(worker.bindingResults).toHaveLength(1);

    const events = await worker.room.transcript("dime el saldo");
    expect(events).toHaveLength(2);
    expect(worker.serviceCalls()).toBe(1);
    expect(worker.lastText()).toBe("dime el saldo");
  });

  it.each([
    ["malformed", "not-json", "invalid_binding"],
    ["expired", "expired-token", "expired_binding"],
  ] as const)("fails closed for %s binding", async (kind, payload, code) => {
    const worker = createFakeWorker();
    const token =
      kind === "expired"
        ? await issueLiveVoiceBinding({
            userId: "user-1",
            conversationId: "conversation-1",
            privateKey: worker.keys.privateKey,
            now: Math.floor(Date.now() / 1000) - 120,
          })
        : payload;
    const response = JSON.parse(
      await worker.room.bind(
        kind === "expired" ? JSON.stringify({ bindingToken: token }) : token,
        "user-1",
      ),
    ) as {
      ok: boolean;
      code?: string;
    };
    expect(response).toEqual({ ok: false, code });
    expect(worker.session.started).toBe(false);
    expect(worker.serviceCalls()).toBe(0);
  });
});
