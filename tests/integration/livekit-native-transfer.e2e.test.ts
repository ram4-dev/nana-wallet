import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueLiveVoiceBinding } from "../../src/auth/live-binding.js";
import { FinancialTaskRegistry } from "../../src/conversations/financial-task-registry.js";
import { createWalletConversationService } from "../../src/conversations/service.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";
import type { ConversationSnapshot, WalletProgress } from "../../src/conversations/types.js";
import { RoomConversation } from "../../src/livekit/room-conversation.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";

const userId = "11111111-1111-4111-8111-111111111111";
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const previewId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const recipient = "0x1234567890123456789012345678901234567890";
const recipientId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function repositoryFixture() {
  let snapshot: ConversationSnapshot = {
    id: conversationId,
    userId,
    mode: "live",
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: "en",
    generation: 1,
    messages: [],
    pendingTransfer: {
      previewId,
      network: "sepolia",
      token: "USDT",
      to: recipient,
      amount: "2",
      wallet: "agent-demo",
      recipientId,
      recipientVersion: 1,
      preview: {
        network: "sepolia",
        token: "USDT",
        recipient,
        amount: "2",
        estimatedFee: "0.0003 ETH",
      },
    },
  };
  let transferStatus: "previewed" | "broadcasting" | "submitted" | "confirmed" = "previewed";
  const repository = {
    get: async (requestUserId: string, id: string) =>
      requestUserId === userId && id === conversationId
        ? { ...snapshot, messages: [...snapshot.messages] }
        : undefined,
    appendMessage: async (_requestUserId: string, _id: string, message: ConversationSnapshot["messages"][number]) => {
      snapshot.messages.push(message);
    },
    setProgress: async (_requestUserId: string, _id: string, progress: WalletProgress) => {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    claimPendingTransfer: async () => {
      if (!snapshot.pendingTransfer) return { status: "missing" as const };
      if (transferStatus === "broadcasting") return { status: "broadcasting" as const };
      transferStatus = "broadcasting";
      snapshot = { ...snapshot, transferResolutionState: "broadcasting", revision: snapshot.revision + 1 };
      return { status: "claimed" as const, transfer: snapshot.pendingTransfer };
    },
    releasePendingTransferClaim: async () => undefined,
    markPendingTransferUncertain: async () => undefined,
    markTransferSubmitted: async (_requestUserId: string, _id: string, hash: string) => {
      transferStatus = "submitted";
      snapshot = { ...snapshot, lastTransactionHash: hash, revision: snapshot.revision + 1 };
    },
    finalizeTransfer: async (_requestUserId: string, _id: string, result: { transactionHash: string }) => {
      transferStatus = "confirmed";
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        transferResolutionState: undefined,
        lastTransactionHash: result.transactionHash,
        revision: snapshot.revision + 1,
      };
    },
    snapshot: () => snapshot,
  } as unknown as ConversationRepository & { snapshot(): ConversationSnapshot };
  return repository;
}

describe("native LiveKit transfer", () => {
  it("completes a voice confirmation through the durable decision path", async () => {
    const keys = generateKeyPairSync("ed25519");
    const conversations = repositoryFixture();
    const wallet = new FixtureWalletProvider();
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const financialTasks = new FinancialTaskRegistry();
    const service = createWalletConversationService({
      conversations,
      wallet,
      financialTasks,
      memory: {
        userId,
        service: {
          getRecipientForVersion: vi.fn().mockResolvedValue({
            id: recipientId,
            version: 1,
            address: recipient,
          }),
        },
      } as never,
    });
    const room = new RoomConversation({
      publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
      conversations,
      service,
    });
    const token = await issueLiveVoiceBinding({
      userId,
      conversationId,
      privateKey: keys.privateKey,
    });
    await expect(room.bind({ token, participantUserId: userId })).resolves.toMatchObject({ ok: true });

    const decision = await room.resolvePendingDecision("confirmar la transferencia");
    const events = [];
    if (decision) {
      for await (const event of decision) events.push(event);
    }
    await financialTasks.drain({ timeoutMs: 1_000 });

    expect(events).toContainEqual(expect.objectContaining({ type: "turn-completed" }));
    expect(broadcast).toHaveBeenCalledOnce();
    expect(conversations.snapshot()).toMatchObject({
      pendingTransfer: undefined,
      progress: { phase: "completed" },
      lastTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
    });
  });

  it("persists an uncertain fixture broadcast without allowing a second dispatch", async () => {
    const keys = generateKeyPairSync("ed25519");
    const conversations = repositoryFixture();
    const wallet = new FixtureWalletProvider({ forcedBroadcastOutcome: "uncertain" });
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const financialTasks = new FinancialTaskRegistry();
    const service = createWalletConversationService({
      conversations,
      wallet,
      financialTasks,
      memory: {
        userId,
        service: {
          getRecipientForVersion: vi.fn().mockResolvedValue({
            id: recipientId,
            version: 1,
            address: recipient,
          }),
        },
      } as never,
    });
    const room = new RoomConversation({
      publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
      conversations,
      service,
    });
    const token = await issueLiveVoiceBinding({
      userId,
      conversationId,
      privateKey: keys.privateKey,
    });
    await expect(room.bind({ token, participantUserId: userId })).resolves.toMatchObject({ ok: true });

    const decision = await room.resolvePendingDecision("confirmar la transferencia");
    if (!decision) throw new Error("Expected the native confirmation to resolve.");
    for await (const _event of decision) {
      // The event stream starts the durable financial task.
    }
    await financialTasks.drain({ timeoutMs: 1_000 });

    expect(broadcast).toHaveBeenCalledOnce();
    expect(conversations.snapshot()).toMatchObject({
      pendingTransfer: expect.objectContaining({ previewId }),
      progress: { phase: "uncertain" },
    });

    const repeated = await room.resolvePendingDecision("confirmar la transferencia");
    if (repeated) {
      for await (const _event of repeated) {
        // The second decision must observe durable uncertainty instead of broadcasting.
      }
    }
    expect(broadcast).toHaveBeenCalledOnce();
  });
});
