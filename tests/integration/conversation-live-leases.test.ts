import { describe, expect, it } from "vitest";
import { createDatabaseClient } from "../../src/db/client.js";
import { PostgresConversationRepository } from "../../src/conversations/postgres-repository.js";
import type { LiveConversationLease } from "../../src/conversations/repository.js";

const userId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function lease(
  conversationId: string,
  suffix: string,
  expiresAt: string,
): LiveConversationLease {
  return {
    conversationId,
    userId,
    bindingJti: `00000000-0000-4000-8000-00000000000${suffix}`,
    participantIdentity: `browser-${suffix}`,
    workerId: `worker-${suffix}`,
    expiresAt,
  };
}

describe("conversation live leases", () => {
  it.skipIf(!process.env.DATABASE_URL)(
    "allows one active lease and rejects a second room",
    async () => {
      const database = createDatabaseClient(process.env.DATABASE_URL!);
      const repository = new PostgresConversationRepository(database);
      const conversation = await repository.create(userId);
      const first = lease(
        conversation.id,
        "1",
        new Date(Date.now() + 60_000).toISOString(),
      );
      const second = lease(
        conversation.id,
        "2",
        new Date(Date.now() + 60_000).toISOString(),
      );

      await expect(repository.acquireLiveLease(first)).resolves.toMatchObject({
        status: "acquired",
      });
      await expect(repository.acquireLiveLease(second)).resolves.toMatchObject({
        status: "already_live",
      });
      expect(await repository.renewLiveLease(first)).toBe(true);
      expect(await repository.renewLiveLease(second)).toBe(false);
      expect(await repository.releaseLiveLease(first)).toBe(true);
      await database.close();
    },
  );

  it.skipIf(!process.env.DATABASE_URL)(
    "replaces only an expired lease and blocks stale workers",
    async () => {
      const database = createDatabaseClient(process.env.DATABASE_URL!);
      const repository = new PostgresConversationRepository(database);
      const conversation = await repository.create(userId);
      const expired = lease(
        conversation.id,
        "3",
        new Date(Date.now() - 1_000).toISOString(),
      );
      const replacement = lease(
        conversation.id,
        "4",
        new Date(Date.now() + 60_000).toISOString(),
      );

      await expect(repository.acquireLiveLease(expired)).resolves.toMatchObject(
        { status: "acquired" },
      );
      await expect(
        repository.acquireLiveLease(replacement),
      ).resolves.toMatchObject({ status: "acquired" });
      expect(await repository.renewLiveLease(expired)).toBe(false);
      expect(await repository.releaseLiveLease(expired)).toBe(false);
      expect((await repository.get(userId, conversation.id))?.mode).toBe(
        "live",
      );
      expect(await repository.releaseLiveLease(replacement)).toBe(true);
      expect((await repository.get(userId, conversation.id))?.mode).toBe(
        "typed",
      );
      await database.close();
    },
  );
});
