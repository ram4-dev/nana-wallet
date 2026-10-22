/**
 * Contract of `provisionTestUser` — the ONE provisioning path every
 * server-based suite uses (feature: self-provisioning test suites).
 *
 * The helper must be TOTAL for the four user-row shapes a suite can meet:
 *
 *   (i)   nothing exists (fresh CI database) → insert;
 *   (ii)  same id + same did                → idempotent touch;
 *   (iii) same id, DIFFERENT did (legacy dev databases) → keep the existing
 *         row, touch it, never throw — the suites key on `id`, so the FK is
 *         satisfied by the row that is already there;
 *   (iv)  same did, different id             → no throw; a no-op is acceptable.
 *
 * Every case uses RANDOM uuids so parallel workers never share a row.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { provisionTestUser } from "../fixtures/provision-user.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("provisionTestUser is total over every users-row shape", () => {
  let database: DatabaseClient;
  /** Delta cleanup: only the rows this suite created. */
  const createdIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await database.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
    await database.close();
  });

  const rowById = async (id: string) => {
    const result = await database.query<{
      id: string;
      privy_did: string;
      display_name: string | null;
    }>(`SELECT id, privy_did, display_name FROM users WHERE id = $1`, [id]);
    return result.rows[0];
  };

  it("(i) inserts a usable row when nothing exists", async () => {
    const id = randomUUID();
    createdIds.push(id);

    await expect(provisionTestUser(id)).resolves.toBeUndefined();

    const row = await rowById(id);
    expect(row, "a users row must exist for the provisioned id").toBeDefined();
    expect(row!.privy_did).toBe(`test:${id}`);
    expect(row!.display_name).toBe("Test user");
  });

  it("(ii) same id + same did is idempotent", async () => {
    const id = randomUUID();
    createdIds.push(id);

    await provisionTestUser(id);
    await expect(provisionTestUser(id)).resolves.toBeUndefined();

    const rows = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM users WHERE id = $1`,
      [id],
    );
    expect(Number(rows.rows[0]!.count)).toBe(1);
  });

  it("(iii) same id with a DIFFERENT did keeps the existing row without throwing", async () => {
    const id = randomUUID();
    const legacyDid = `legacy:${randomUUID()}`;
    createdIds.push(id);
    await database.query(`INSERT INTO users (id, privy_did) VALUES ($1, $2)`, [
      id,
      legacyDid,
    ]);

    await expect(provisionTestUser(id)).resolves.toBeUndefined();

    const row = await rowById(id);
    expect(row, "the legacy row must still be there").toBeDefined();
    expect(row!.privy_did, "the existing did must be kept").toBe(legacyDid);
  });

  it("(iv) same did under a different id does not throw", async () => {
    const otherId = randomUUID();
    const id = randomUUID();
    createdIds.push(otherId);
    // A row already owns the did this call would claim, under another id.
    await database.query(`INSERT INTO users (id, privy_did) VALUES ($1, $2)`, [
      otherId,
      `test:${id}`,
    ]);

    await expect(provisionTestUser(id)).resolves.toBeUndefined();

    // A no-op is acceptable: the caller only needs SOME usable row for its id
    // contract, and the helper must not corrupt the row that holds the did.
    const owner = await rowById(otherId);
    expect(owner?.privy_did).toBe(`test:${id}`);
    expect((await rowById(id))?.privy_did ?? null).toBeNull();
  });
});
