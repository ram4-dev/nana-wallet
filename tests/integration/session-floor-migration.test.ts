import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const localMigration = resolve(
  process.cwd(),
  "src/db/migrations/014_session_floor.sql",
);
const supabaseMigration = resolve(
  process.cwd(),
  "supabase/migrations/20261005000300_session_floor.sql",
);

describe("session floor migration (static)", () => {
  it("adds users.session_floor_at in the local migration tree", async () => {
    const sql = await readFile(localMigration, "utf8");
    expect(sql).toMatch(/ALTER TABLE\s+users/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+session_floor_at\s+TIMESTAMPTZ/i,
    );
  });

  it("mirrors the column in the Supabase migration tree", async () => {
    const sql = await readFile(supabaseMigration, "utf8");
    expect(sql).toMatch(/ALTER TABLE\s+public\.users/i);
    expect(sql).toMatch(
      /ADD COLUMN IF NOT EXISTS\s+session_floor_at\s+TIMESTAMPTZ/i,
    );
  });
});

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const DID_A = `did:privy:floor-${RUN}-a`;
const DID_B = `did:privy:floor-${RUN}-b`;

async function withOwnerClient<T>(
  operation: (database: DatabaseClient) => Promise<T>,
): Promise<T> {
  const database = createDatabaseClient(databaseUrl!);
  try {
    return await operation(database);
  } finally {
    await database.close();
  }
}

suite("session floor migration (database)", () => {
  it("adds the column and keeps the floor owner-scoped under RLS", async () => {
    await withOwnerClient(async (database) => {
      const column = await database.query<{ column_name: string }>(
        "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'session_floor_at'",
      );
      expect(column.rows).toHaveLength(1);

      const [a, b] = await Promise.all([
        database.query<{ id: string }>(
          "SELECT users_ensure_for_privy_did($1) AS id",
          [DID_A],
        ),
        database.query<{ id: string }>(
          "SELECT users_ensure_for_privy_did($1) AS id",
          [DID_B],
        ),
      ]);
      const idA = a.rows[0]!.id;
      const idB = b.rows[0]!.id;

      // Default is NULL: a freshly provisioned user has no floor.
      const freshA = await database.withUserTransaction(idA, (client) =>
        client.query<{ session_floor_at: Date | null }>(
          "SELECT session_floor_at FROM users WHERE id = $1::uuid",
          [idA],
        ),
      );
      expect(freshA.rows[0]?.session_floor_at).toBeNull();

      // The owner sets its own floor.
      const written = await database.withUserTransaction(idA, (client) =>
        client.query<{ session_floor_at: Date }>(
          "UPDATE users SET session_floor_at = now() WHERE id = $1::uuid RETURNING session_floor_at",
          [idA],
        ),
      );
      expect(written.rows[0]?.session_floor_at).toBeInstanceOf(Date);

      const seenByA = await database.withUserTransaction(idA, (client) =>
        client.query<{ session_floor_at: Date | null }>(
          "SELECT session_floor_at FROM users WHERE id = $1::uuid",
          [idA],
        ),
      );
      expect(seenByA.rows[0]?.session_floor_at).toBeInstanceOf(Date);

      // Another user is untouched and cannot be changed cross-user.
      await database.withUserTransaction(idA, (client) =>
        client.query(
          "UPDATE users SET session_floor_at = now() WHERE id = $1::uuid",
          [idB],
        ),
      );
      const seenByB = await database.withUserTransaction(idB, (client) =>
        client.query<{ session_floor_at: Date | null }>(
          "SELECT session_floor_at FROM users WHERE id = $1::uuid",
          [idB],
        ),
      );
      expect(seenByB.rows[0]?.session_floor_at).toBeNull();
    });
  });
});
