import { describe, expect, it, vi } from "vitest";

import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { PostgresConversationRepository } from "../../src/conversations/postgres-repository.js";
import { createWalletConversationService } from "../../src/conversations/service.js";
import { FinancialTaskRegistry } from "../../src/conversations/financial-task-registry.js";

const databaseUrl = process.env.DATABASE_URL;
const userId = "22222222-2222-4222-8222-222222222222";
const recipient = "0x1234567890123456789012345678901234567890";

describe("live voice and touch decision race", () => {
  it.skipIf(!databaseUrl)("claims once and reaches one terminal state", async () => {
    process.env.AGENT_RUNTIME = "deterministic";
    process.env.WDK_TOOLS_SOURCE = "fixture";
    const database = createDatabaseClient(databaseUrl!);
    const repository = new PostgresConversationRepository(database);
    const wallet = new FixtureWalletProvider();
    const workerTasks = new FinancialTaskRegistry();
    const apiTasks = new FinancialTaskRegistry();
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const worker = createWalletConversationService({
      conversations: repository,
      wallet,
      financialTasks: workerTasks,
    });
    const api = createWalletConversationService({
      conversations: repository,
      wallet,
      financialTasks: apiTasks,
    });

    try {
      const conversation = await repository.create(userId);
      const preview = await worker.handleTurn({
        conversationId: conversation.id,
        userId,
        text: `Send 10 USDT to ${recipient}`,
      });
      expect(preview.status).toBe("confirmation_required");
      const current = await repository.get(userId, conversation.id);
      const previewId = current?.pendingTransfer?.previewId;
      expect(previewId).toBeTruthy();

      const touchEvents: unknown[] = [];
      const touchPromise = (async () => {
        for await (const event of api.resolveDecision({
          conversationId: conversation.id,
          userId,
          previewId: previewId!,
          decision: "confirm",
          waitForFinancialTask: true,
        })) touchEvents.push(event);
      })();
      const spokenPromise = worker.handleTurn({
        conversationId: conversation.id,
        userId,
        text: "confirmar la transferencia",
      });
      await Promise.all([touchPromise, spokenPromise]);
      await workerTasks.drain({ timeoutMs: 1_000 });
      await apiTasks.drain({ timeoutMs: 1_000 });

      expect(broadcast).toHaveBeenCalledOnce();
      const final = await repository.get(userId, conversation.id);
      expect(final?.pendingTransfer).toBeUndefined();
      expect(final?.progress?.phase).toBe("completed");
      expect(final?.lastTransactionHash).toMatch(/^0x[0-9a-f]{64}$/u);
      expect(touchEvents.some((event) => (event as { type?: string }).type === "turn-completed")).toBe(true);
    } finally {
      await wallet.close();
      await database.close();
    }
  });
});
