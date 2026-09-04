import { describe, expect, it, vi } from "vitest";

import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { createDatabaseClient } from "../../src/db/client.js";
import { PostgresConversationRepository } from "../../src/conversations/postgres-repository.js";
import { createWalletConversationService, type PreviewTransferInput } from "../../src/conversations/service.js";
import { FinancialTaskRegistry } from "../../src/conversations/financial-task-registry.js";

const databaseUrl = process.env.DATABASE_URL;
const userId = "33333333-3333-4333-8333-333333333333";
const recipient = "0x1234567890123456789012345678901234567890";
const recipientId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const conversationId = "99999999-9999-4999-8999-999999999999";

/**
 * REAL claim semantics (V8.5): the atomicity lives in the postgres
 * `claimPendingTransfer` UPDATE ... WHERE status='previewed' row count, not in any
 * mock. Two concurrent confirms must arbitrate to exactly one broadcast. Requires a
 * real DATABASE_URL — skipped otherwise so the unit suite stays green without a DB.
 */
describe("previewTransfer real claim semantics", () => {
  it.skipIf(!databaseUrl)("two simultaneous confirms broadcast exactly once (V8.5)", async () => {
    const previousSource = process.env.WDK_TOOLS_SOURCE;
    process.env.WDK_TOOLS_SOURCE = "fixture";
    const database = createDatabaseClient(databaseUrl!);
    const repository = new PostgresConversationRepository(database);
    const wallet = new FixtureWalletProvider();
    try {
      const broadcast = vi.spyOn(wallet, "broadcastTransfer");
      const voiceTasks = new FinancialTaskRegistry();
      const touchTasks = new FinancialTaskRegistry();
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
            status: "active",
            embeddingModelRevision: "rev",
          }),
        },
      };
      const voiceService = createWalletConversationService({
        conversations: repository,
        wallet,
        memory: memory as never,
        financialTasks: voiceTasks,
      });
      const touchService = createWalletConversationService({
        conversations: repository,
        wallet,
        memory: memory as never,
        financialTasks: touchTasks,
      });

      const conversation = await repository.create(userId);
      const preview: PreviewTransferInput = {
        conversationId: conversation.id,
        userId,
        amount: "10",
        recipientId,
        recipientVersion: 1,
      };
      const previewResult = await voiceService.previewTransfer(preview);
      expect(previewResult.status).toBe("confirmation_required");
      const current = await repository.get(userId, conversation.id);
      const previewId = current?.pendingTransfer?.previewId;
      expect(previewId).toBeTruthy();

      const confirmation = {
        conversationId: conversation.id,
        userId,
        previewId: previewId!,
        decision: "confirm" as const,
        waitForFinancialTask: true,
      };
      const voice = await (async () => {
        const events: unknown[] = [];
        for await (const event of voiceService.resolveDecision(confirmation)) events.push(event);
        return events;
      })();
      const touch = await (async () => {
        const events: unknown[] = [];
        for await (const event of touchService.resolveDecision(confirmation)) events.push(event);
        return events;
      })();

      await voiceTasks.drain({ timeoutMs: 1_000 });
      await touchTasks.drain({ timeoutMs: 1_000 });

      expect(broadcast).toHaveBeenCalledOnce();
      const finalSnapshot = await repository.get(userId, conversation.id);
      expect(finalSnapshot?.pendingTransfer).toBeUndefined();
      expect(finalSnapshot?.progress?.phase).toBe("completed");
      expect(finalSnapshot?.lastTransactionHash).toMatch(/^0x[0-9a-f]{64}$/u);
    } finally {
      await wallet.close();
      await database.close();
      if (previousSource === undefined) delete process.env.WDK_TOOLS_SOURCE;
      else process.env.WDK_TOOLS_SOURCE = previousSource;
    }
  });
});
