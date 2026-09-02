import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueLiveVoiceBinding } from "../../src/auth/live-binding.js";
import { RoomConversation } from "../../src/livekit/room-conversation.js";

describe("room conversation binding", () => {
  it("does not process transcripts before binding, then invokes the service once", async () => {
    const keys = generateKeyPairSync("ed25519");
    const conversation = {
      id: "conversation-1",
      userId: "user-1",
      mode: "typed" as const,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      revision: 3,
      language: "es" as const,
      generation: 1,
      messages: [],
    };
    const service = {
      handleTurnStream: vi.fn(async function* () {
        yield { type: "turn-completed" as const, result: { status: "answer" as const, message: "ok" } };
      }),
    };
    const conversations = { get: vi.fn(async () => conversation) };
    const room = new RoomConversation({
      publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
      conversations: conversations as never,
      service: service as never,
    });

    const beforeBinding = [];
    for await (const event of room.handleFinalTranscript("hola")) beforeBinding.push(event);
    expect(beforeBinding).toEqual([{ ok: false, code: "not_bound" }]);
    expect(service.handleTurnStream).not.toHaveBeenCalled();

    const token = await issueLiveVoiceBinding({ userId: "user-1", conversationId: "conversation-1", privateKey: keys.privateKey });
    await expect(room.bind({ token, participantUserId: "user-1" })).resolves.toMatchObject({ ok: true, revision: 3 });
    const afterBinding = [];
    for await (const event of room.handleFinalTranscript("hola")) afterBinding.push(event);
    expect(afterBinding).toHaveLength(1);
    expect(service.handleTurnStream).toHaveBeenCalledTimes(1);
  });
});
