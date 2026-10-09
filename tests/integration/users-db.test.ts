import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { runMigrations } from "../../src/db/migrate.js";

const migrationUrl = new URL(
  "../../src/db/migrations/004_users.sql",
  import.meta.url,
);
const migrationsDirectory = resolve(process.cwd(), "src/db/migrations");

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const DID_A = "did:privy:test-user-a";
const DID_B = "did:privy:test-user-b";

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

describe("users migration (static)", () => {
  it("enables and forces RLS with owner provisioning and app self-isolation policies", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql).toMatch(
      /ALTER TABLE (?:public\.)?users ENABLE ROW LEVEL SECURITY/,
    );
    expect(sql).toMatch(
      /ALTER TABLE (?:public\.)?users FORCE ROW LEVEL SECURITY/,
    );
    expect(sql).toContain("user_self_isolation");
    expect(sql).toContain("users_provisioning");
    expect(sql).toContain("SECURITY DEFINER");
    expect(sql).toContain("users_ensure_for_privy_did");
    expect(sql).toContain("REVOKE ALL ON FUNCTION");
  });

  it("does not insert a demo sentinel row", async () => {
    const sql = await readFile(migrationUrl, "utf8");
    expect(sql.toLowerCase()).not.toContain("privy_did, 'demo'");
    expect(sql.toLowerCase()).not.toContain("'demo'");
  });

  it("keeps users ordered after conversations and live-lease prerequisites", async () => {
    const files = (await readdir(migrationsDirectory))
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const usersIndex = files.findIndex((f) => f.endsWith("_users.sql"));
    const conversationsIndex = files.findIndex(
      (f) => f.includes("conversations") && !f.includes("lease"),
    );
    const leasesIndex = files.findIndex((f) => f.includes("live_lease"));
    expect(usersIndex).toBeGreaterThan(-1);
    expect(conversationsIndex).toBeGreaterThan(-1);
    expect(leasesIndex).toBeGreaterThan(-1);
    expect(conversationsIndex).toBeLessThan(usersIndex);
    expect(leasesIndex).toBeLessThan(usersIndex);
  });
});

suite("users migration (database)", () => {
  it("provisions a fresh database through the full local migration sequence", async () => {
    await withOwnerClient(async (database) => {
      // Fixed identifier: CREATE/DROP DATABASE cannot take bound parameters, so
      // the suite uses a constant database name (serial test execution only).
      await database.query('DROP DATABASE IF EXISTS "nana_wu1_fresh"');
      await database.query('CREATE DATABASE "nana_wu1_fresh"');
      const url = new URL(databaseUrl!);
      url.pathname = "/nana_wu1_fresh";
      try {
        const applied = await runMigrations(url.toString());
        const names = applied.map((a) => a.split("_").slice(1).join("_"));
        expect(names.some((n) => n.includes("users"))).toBe(true);
        const temp = createDatabaseClient(url.toString());
        try {
          const rls = await temp.query<{
            relrowsecurity: boolean;
            relforcerowsecurity: boolean;
          }>(
            "SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'users'",
          );
          expect(rls.rows[0]?.relrowsecurity).toBe(true);
          expect(rls.rows[0]?.relforcerowsecurity).toBe(true);
        } finally {
          await temp.close();
        }
      } finally {
        await database.query('DROP DATABASE IF EXISTS "nana_wu1_fresh"');
      }
    });
  });

  it("provisions the same UUID for repeated and concurrent first logins of one DID", async () => {
    await withOwnerClient(async (database) => {
      const [first, second, parallel] = await Promise.all([
        database.query<{ id: string }>(
          "SELECT users_ensure_for_privy_did($1, $2) AS id",
          [DID_A, "User A"],
        ),
        database.query<{ id: string }>(
          "SELECT users_ensure_for_privy_did($1, $2) AS id",
          [DID_A, "User A"],
        ),
        database.query<{ id: string }>(
          "SELECT users_ensure_for_privy_did($1, $2) AS id",
          [DID_A, "User A"],
        ),
      ]);
      const ids = [first.rows[0]?.id, second.rows[0]?.id, parallel.rows[0]?.id];
      expect(new Set(ids).size).toBe(1);
      const rows = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM users WHERE privy_did = $1",
        [DID_A],
      );
      expect(rows.rows[0]?.count).toBe("1");
    });
  });

  it("resolves different DIDs to different UUIDs", async () => {
    await withOwnerClient(async (database) => {
      const a = await database.query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1) AS id",
        [DID_A],
      );
      const b = await database.query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1) AS id",
        [DID_B],
      );
      expect(a.rows[0]?.id).not.toBe(b.rows[0]?.id);
    });
  });

  it("scopes the users table through RLS and blocks cross-user reads", async () => {
    await withOwnerClient(async (database) => {
      const a = await database.query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1) AS id",
        [DID_A],
      );
      const b = await database.query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1) AS id",
        [DID_B],
      );
      const idA = a.rows[0]!.id;
      const idB = b.rows[0]!.id;

      const seen = await database.withUserTransaction(idA, (client) =>
        client.query<{ id: string }>("SELECT id FROM users"),
      );
      expect(seen.rows.map((r) => r.id)).toEqual([idA]);
      expect(seen.rows.map((r) => r.id)).not.toContain(idB);
    });
  });

  it("denies recipient_app the provisioning function and role escalation", async () => {
    await withOwnerClient(async (database) => {
      const a = await database.query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1) AS id",
        [DID_A],
      );
      const idA = a.rows[0]!.id;
      await expect(
        database.withUserTransaction(idA, (client) =>
          client.query(
            "SELECT users_ensure_for_privy_did('did:privy:intruder')",
          ),
        ),
      ).rejects.toThrow(
        /permission denied|could not be found|does not exist/iu,
      );
    });
  });

  it("keeps recipient_app without BYPASSRLS and without membership of the owner role path", async () => {
    await withOwnerClient(async (database) => {
      const role = await database.query<{
        rolbypassrls: boolean;
        rolsuper: boolean;
      }>(
        "SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = 'recipient_app'",
      );
      expect(role.rows[0]?.rolbypassrls).toBe(false);
      expect(role.rows[0]?.rolsuper).toBe(false);
      const membership = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.roleid WHERE r.rolname = 'postgres' AND m.member = (SELECT oid FROM pg_roles WHERE rolname = 'recipient_app')",
      );
      expect(membership.rows[0]?.count).toBe("0");
    });
  });
});
