import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { ingestNotificationEventWithDatabase } from "../../src/notifications/notification-repository.js";
import type { NotificationEvent } from "../../src/notifications/ingestion.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// GREEN contract for the canonical ingestion service: real owner-scoped
// PostgreSQL inserts against the unique (user_id, dedupe_key) identity, with
// RLS applied and fan-out only after the winning insert commits.
suite("notification ingestion service (database-backed)", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  async function provisionUser(): Promise<string> {
    const result = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:slice5-ingest-${randomUUID()}`, "Slice 5 Ingestion"],
    );
    return result.rows[0]!.id;
  }

  function assistantEvent(
    userId: string,
    dedupeKey: string,
  ): NotificationEvent {
    return {
      kind: "assistant_transfer",
      userId,
      category: "assistant_transfer",
      status: "confirmed",
      dedupeKey,
      title: "Transfer confirmed",
      explanation: "Your transfer was confirmed by the network.",
      resolved: true,
      projection: { status: "confirmed", amountLabel: "10 USDT" },
    };
  }

  it("inserts one canonical row inside the owner's transaction and reports inserted", async () => {
    const userA = await provisionUser();
    const dedupeKey = `assistant-transfer:${randomUUID()}:confirmed`;
    const publishInvalidation = vi.fn(async (): Promise<void> => undefined);

    const result = await ingestNotificationEventWithDatabase(
      assistantEvent(userA, dedupeKey),
      { database, publishInvalidation },
    );

    expect(result.outcome).toBe("inserted");
    expect(publishInvalidation).toHaveBeenCalledTimes(1);

    const rows = await database.withUserTransaction(userA, (client) =>
      client.query<{ dedupe_key: string; title: string; user_id: string }>(
        `SELECT dedupe_key, title, user_id FROM wallet_notifications WHERE user_id = $1`,
        [userA],
      ),
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.dedupe_key).toBe(dedupeKey);
  });

  it("treats a replayed (user_id, dedupe_key) as already canonical without fan-out", async () => {
    const userA = await provisionUser();
    const dedupeKey = `assistant-transfer:${randomUUID()}:confirmed`;
    await ingestNotificationEventWithDatabase(
      assistantEvent(userA, dedupeKey),
      {
        database,
      },
    );

    const publishInvalidation = vi.fn(async (): Promise<void> => undefined);
    const replay = await ingestNotificationEventWithDatabase(
      assistantEvent(userA, dedupeKey),
      { database, publishInvalidation },
    );

    expect(replay.outcome).toBe("already_canonical");
    expect(publishInvalidation).not.toHaveBeenCalled();

    const rows = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM wallet_notifications WHERE user_id = $1 AND dedupe_key = $2`,
        [userA, dedupeKey],
      ),
    );
    expect(rows.rows).toHaveLength(1);
  });

  it("never lets the insert lose owner scoping: B replaying A's key inserts under B", async () => {
    const userA = await provisionUser();
    const userB = await provisionUser();
    const dedupeKey = `assistant-transfer:${randomUUID()}:confirmed`;

    await ingestNotificationEventWithDatabase(
      assistantEvent(userA, dedupeKey),
      {
        database,
      },
    );
    // B ingesting the same payload (its own user scope) creates its own row,
    // proving the unique identity is per-user rather than global.
    const resultB = await ingestNotificationEventWithDatabase(
      assistantEvent(userB, dedupeKey),
      { database },
    );
    expect(resultB.outcome).toBe("inserted");

    const rowsA = await database.withUserTransaction(userA, (client) =>
      client.query<{ id: string }>(
        `SELECT id FROM wallet_notifications WHERE user_id = $1`,
        [userA],
      ),
    );
    expect(rowsA.rows).toHaveLength(1);
  });
});
