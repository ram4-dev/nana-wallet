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

  it("routes a bound confirmation to the durable decision service before model work", async () => {
    const keys = generateKeyPairSync("ed25519");
    const conversation = {
      id: "conversation-1",
      userId: "user-1",
      mode: "live" as const,
      createdAt: new Date(0).toISOString(),
      updatedAt: new Date(0).toISOString(),
      revision: 3,
      language: "es" as const,
      generation: 1,
      messages: [],
      pendingTransfer: {
        previewId: "preview-1",
        network: "sepolia",
        token: "USDT",
        to: "0x1234567890123456789012345678901234567890",
        amount: "2",
        wallet: "agent-demo",
        preview: {
          network: "sepolia",
          token: "USDT",
          recipient: "0x1234567890123456789012345678901234567890",
          amount: "2",
          estimatedFee: "0.0003 ETH",
        },
      },
    };
    const resolveDecision = vi.fn(async function* () {
      yield {
        type: "turn-completed" as const,
        result: { status: "answer" as const, message: "Transfer is being processed." },
      };
    });
    const room = new RoomConversation({
      publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
      conversations: { get: vi.fn(async () => conversation) } as never,
      service: { resolveDecision } as never,
    });
    const token = await issueLiveVoiceBinding({
      userId: "user-1",
      conversationId: "conversation-1",
      privateKey: keys.privateKey,
    });
    await room.bind({ token, participantUserId: "user-1" });

    const decision = await room.resolvePendingDecision("confirmar la transferencia");
    const events = [];
    if (decision) {
      for await (const event of decision) events.push(event);
    }

    expect(resolveDecision).toHaveBeenCalledWith({
      conversationId: "conversation-1",
      userId: "user-1",
      previewId: "preview-1",
      decision: "confirm",
    });
    expect(events).toHaveLength(1);
  });
});
