import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { issueLiveVoiceBinding } from "../../src/auth/live-binding.js";
import { createWalletConversationService } from "../../src/conversations/service.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";
import type {
  ConversationSnapshot,
  WalletProgress,
} from "../../src/conversations/types.js";
import { RoomConversation } from "../../src/livekit/room-conversation.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";

/**
 * Phase 5.4 (slice3-grant-execution): covered-path E2E for BOTH entry points
 * against ONE real service + ONE shared in-memory durable repository. A typed
 * turn (`service.handleTurnStream`) and a voice transcript
 * (`RoomConversation.handleFinalTranscript` with a signed Ed25519 binding)
 * each carry the original authenticated transfer intent. For each turn the
 * service consults the server-owned gate, claims the ledger, wins the
 * single-winner attempt, and resolves internally (no explicit UI confirm) —
 * each turn completes covered and broadcasts exactly once. No live
 * credentials required.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const recipientId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const recipient = "0x1234567890123456789012345678901234567890";
const INTENT_TEXT = `Send 2 USDT to ${recipient}`;

/** Shared in-memory durable repository (attempts + event sequence). */
function sharedRepository(): {
  repository: ConversationRepository;
  events: string[];
  getSnapshot(): ConversationSnapshot;
} {
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
  };
  const events: string[] = [];
  let attemptCounter = 0;
  const repository = {
    async get(requestUserId: string, id: string) {
      return requestUserId === userId && id === conversationId
        ? { ...snapshot, messages: [...snapshot.messages] }
        : undefined;
    },
    async inspect(requestUserId: string, id: string) {
      return this.get(requestUserId, id);
    },
    async create() {
      return snapshot;
    },
    async appendMessage(
      _requestUserId: string,
      _id: string,
      message: ConversationSnapshot["messages"][number],
    ) {
      snapshot.messages.push(message);
    },
    async saveSnapshot(
      _requestUserId: string,
      incoming: ConversationSnapshot,
      _count: number,
    ) {
      // Durable semantics (PostgresConversationRepository.saveSnapshot): a NEW
      // pendingTransfer (deterministic agent preview path) creates the
      // attempt row and attaches its durable id as previewId.
      let pending = incoming.pendingTransfer;
      if (pending && !pending.previewId) {
        attemptCounter += 1;
        pending = { ...pending, previewId: `attempt-${attemptCounter}` };
      }
      snapshot = {
        ...incoming,
        ...(pending ? { pendingTransfer: pending } : {}),
        revision: snapshot.revision + 1,
      };
      return snapshot;
    },
    async updateState(
      _requestUserId: string,
      _id: string,
      _revision: number,
      state: Partial<ConversationSnapshot>,
    ) {
      snapshot = { ...snapshot, ...state } as ConversationSnapshot;
      return snapshot.revision + 1;
    },
    async setProgress(
      _requestUserId: string,
      _id: string,
      progress: WalletProgress,
    ) {
      snapshot = { ...snapshot, progress, revision: snapshot.revision + 1 };
      return snapshot;
    },
    async setPendingTransfer(
      _requestUserId: string,
      _id: string,
      transfer: NonNullable<ConversationSnapshot["pendingTransfer"]>,
    ) {
      // Durable semantics (PostgresConversationRepository.setPendingTransfer):
      // the attempt row is created and its id is attached to the persisted
      // pendingTransfer as the previewId.
      attemptCounter += 1;
      const previewId = `attempt-${attemptCounter}`;
      snapshot = {
        ...snapshot,
        pendingTransfer: { ...transfer, previewId },
        revision: snapshot.revision + 1,
      };
      return snapshot;
    },
    async clearPendingTransfer() {
      snapshot = { ...snapshot, pendingTransfer: undefined };
      return snapshot;
    },
    async cancelPendingTransfer() {
      return "cancelled" as const;
    },
    async claimPendingTransfer() {
      const pending = snapshot.pendingTransfer;
      if (!pending?.previewId) return { status: "missing" as const };
      if (snapshot.transferResolutionState === "broadcasting") {
        return { status: "broadcasting" as const };
      }
      events.push(`attempt:broadcasting:${pending.previewId}`);
      snapshot = {
        ...snapshot,
        transferResolutionState: "broadcasting",
        revision: snapshot.revision + 1,
      };
      return {
        status: "claimed" as const,
        transfer: { ...pending, previewId: pending.previewId },
      };
    },
    async releasePendingTransferClaim() {
      snapshot = { ...snapshot, transferResolutionState: undefined };
    },
    async markPendingTransferUncertain() {
      snapshot = { ...snapshot, transferResolutionState: "uncertain" };
    },
    async setLastTransactionHash(
      _requestUserId: string,
      _id: string,
      hash: string,
    ) {
      snapshot.lastTransactionHash = hash;
    },
    async markTransferSubmitted(
      _requestUserId: string,
      _id: string,
      hash: string,
    ) {
      events.push(`submitted:${hash}`);
      snapshot = {
        ...snapshot,
        lastTransactionHash: hash,
        revision: snapshot.revision + 1,
      };
    },
    async finalizeTransfer(
      _requestUserId: string,
      _id: string,
      result: {
        status: "confirmed" | "reverted" | "receipt_invalid";
        transactionHash: string;
      },
    ) {
      events.push(`finalized:${result.status}`);
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        transferResolutionState: undefined,
        lastTransactionHash: result.transactionHash,
        revision: snapshot.revision + 1,
      };
    },
    async setMode() {
      return snapshot.revision + 1;
    },
    async acquireLiveLease() {
      return true;
    },
    async renewLiveLease() {
      return true;
    },
    async releaseLiveLease() {},
  };
  return {
    repository: repository as unknown as ConversationRepository,
    events,
    getSnapshot: () => snapshot,
  };
}

function buildService(repo: ConversationRepository) {
  const wallet = new FixtureWalletProvider();
  const broadcast = vi.spyOn(wallet, "broadcastTransfer");
  const gateEvaluate = vi.fn(async () => ({
    covered: true,
    source: "delegated_grant" as const,
    grantId: "g-1",
    amountSmallestUnits: "10000000",
    orderedCandidates: [{ grantId: "g-1", amountSmallestUnits: "10000000" }],
  }));
  const ledgerClaim = vi.fn(
    async (input: {
      grantId: string;
      userId: string;
      amount: string;
      idempotencyKey: string;
    }) => {
      void input;
      return { consumed: true as const };
    },
  );
  const memory = {
    userId,
    service: {
      getRecipientForVersion: vi.fn().mockResolvedValue({
        id: recipientId,
        userId,
        version: 1,
        address: recipient,
        name: "Lucas Gutiérrez",
        normalizedName: "lucas gutiérrez",
        description: "Amigo del equipo",
        evidence: "chat",
      }),
    },
  };
  const service = createWalletConversationService({
    conversations: repo,
    wallet,
    grantGate: { evaluate: gateEvaluate },
    grantLedger: { claim: ledgerClaim },
    memory: memory as never,
  });
  return { service, broadcast, gateEvaluate, ledgerClaim };
}

describe("grant-covered E2E: typed + voice entry points (phase 5.4)", () => {
  it("covered typed turn + covered voice transcript: both skip confirmation, gate/ledger/broadcast per turn", async () => {
    const previous = {
      runtime: process.env.AGENT_RUNTIME,
    };
    process.env.AGENT_RUNTIME = "deterministic";
    try {
      const { repository, events, getSnapshot } = sharedRepository();
      const { service, broadcast, gateEvaluate, ledgerClaim } =
        buildService(repository);

      // 1) TYPED original turn: the intent creates its preview and the
      // server-owned gate plus successful ledger claim resolve it internally —
      // gate consulted, ledger claimed, attempt won, broadcast once, and the
      // turn completes with the terminal result (no explicit UI confirm).
      const typedEvents: Array<{ type: string; result?: { status: string } }> =
        [];
      for await (const event of service.handleTurnStream({
        conversationId,
        userId,
        text: INTENT_TEXT,
      })) {
        typedEvents.push(
          event as { type: string; result?: { status: string } },
        );
      }
      const typedTurn = typedEvents.find((e) => e.type === "turn-completed");
      expect(typedTurn).toBeDefined();
      expect(typedTurn?.result?.status).toBe("sent");
      // The gate ran on the original turn text with the pending preview.
      expect(gateEvaluate).toHaveBeenCalledTimes(1);
      expect(ledgerClaim).toHaveBeenCalledTimes(1);
      expect(ledgerClaim.mock.calls[0][0]).toMatchObject({
        grantId: "g-1",
        userId,
        amount: "10000000",
      });
      expect(
        events.filter((e) => e.startsWith("attempt:broadcasting")).length,
      ).toBe(1);
      expect(broadcast).toHaveBeenCalledTimes(1);

      // 3) VOICE original turn: a fresh covered intent through
      // RoomConversation.handleFinalTranscript on the SAME service.
      gateEvaluate.mockClear();
      ledgerClaim.mockClear();
      broadcast.mockClear();
      events.length = 0;

      const keys = generateKeyPairSync("ed25519");
      const room = new RoomConversation({
        publicKey: String(
          keys.publicKey.export({ type: "spki", format: "pem" }),
        ),
        conversations: {
          get: async (u: string, id: string) =>
            u === userId && id === conversationId ? getSnapshot() : undefined,
        } as never,
        service: service as never,
      });
      const token = await issueLiveVoiceBinding({
        userId,
        conversationId,
        privateKey: keys.privateKey,
      });
      await room.bind({ token, participantUserId: userId });

      const voiceEvents: Array<{ type: string; result?: { status: string } }> =
        [];
      for await (const event of room.handleFinalTranscript(INTENT_TEXT)) {
        voiceEvents.push(
          event as { type: string; result?: { status: string } },
        );
      }
      const voiceTurn = voiceEvents.find((e) => e.type === "turn-completed");
      expect(voiceTurn?.result?.status).toBe("sent");
      // The voice path delegated to the SAME service seam, so the covered
      // gate ran again for this original turn.
      expect(gateEvaluate).toHaveBeenCalledTimes(1);
      expect(ledgerClaim).toHaveBeenCalledTimes(1);
      expect(
        events.filter((e) => e.startsWith("attempt:broadcasting")).length,
      ).toBe(1);
      expect(broadcast).toHaveBeenCalledTimes(1);
    } finally {
      if (previous.runtime === undefined) delete process.env.AGENT_RUNTIME;
      else process.env.AGENT_RUNTIME = previous.runtime;
    }
  });
});
