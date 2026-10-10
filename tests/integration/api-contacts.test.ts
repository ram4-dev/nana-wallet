import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// Fixture identity: the identity provider resolves every request to this user.
const USER_A = TEST_USER_ID;

suite("/v1/contacts CRUD (fixture identity, PMU-008..012)", () => {
  let database: DatabaseClient;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  it("creates a confirmed user contact, lists it, versions it, archives it and reveals it", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      // CREATE (201, user-provenance confirmed at creation).
      const created = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        payload: {
          name: "Lucas Nieto",
          description: "mi nieto",
          address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        },
      });
      expect(created.statusCode).toBe(201);
      const contact = created.json().data;
      expect(contact).toMatchObject({
        name: "Lucas Nieto",
        version: 1,
        status: "active",
      });

      // Provenance stored as user-confirmed.
      const provenance = await database.query<{
        provenance: { origin?: string };
      }>("SELECT provenance FROM recipients WHERE id = $1", [contact.id]);
      expect(provenance.rows[0]?.provenance?.origin).toBe("user");

      // LIST includes only active.
      const list = await app.inject({ method: "GET", url: "/v1/contacts" });
      expect(
        list.json().data.some((c: { id: string }) => c.id === contact.id),
      ).toBe(true);

      // PATCH creates a new version; prior snapshot retained.
      const patched = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        payload: {
          address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
          expectedVersion: 1,
        },
      });
      expect(patched.statusCode).toBe(200);
      expect(patched.json().data).toMatchObject({
        version: 2,
        address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
      });
      const versions = await database.query<{ version: number }>(
        "SELECT version FROM recipient_versions WHERE recipient_id = $1 ORDER BY version",
        [contact.id],
      );
      expect(versions.rows.map((r) => Number(r.version))).toEqual([1]);

      // Stale expectedVersion -> 409.
      const stale = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        payload: { name: "Otro", expectedVersion: 1 },
      });
      expect(stale.statusCode).toBe(409);

      // REVEAL returns the plain current address.
      const revealed = await app.inject({
        method: "POST",
        url: `/v1/contacts/${contact.id}/reveal-cbu`,
      });
      expect(revealed.statusCode).toBe(200);
      expect(revealed.json().data.address).toBe(
        "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
      );

      // DELETE soft-deletes (excluded from list, row remains). The removal is
      // preview-first: the client reads GET /v1/contacts/:id/removal-preview,
      // shows the automatic-payment revocation disclosure, and echoes the
      // disclosed grant ids back on the DELETE (spec "Revocation is disclosed
      // before mutation": "no mutation is executed before that disclosure is
      // confirmed").
      const preview = await app.inject({
        method: "GET",
        url: `/v1/contacts/${contact.id}/removal-preview?expectedVersion=2`,
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json().data).toMatchObject({
        contactId: contact.id,
        contactVersion: 2,
      });
      expect(Array.isArray(preview.json().data.revokedGrantIds)).toBe(true);

      // A DELETE that does not carry the disclosed scope is refused: that is the
      // disclosure gate, not a formatting error.
      const undisclosed = await app.inject({
        method: "DELETE",
        url: `/v1/contacts/${contact.id}?expectedVersion=2`,
      });
      expect(undisclosed.statusCode).toBe(422);

      const deleted = await app.inject({
        method: "DELETE",
        url: `/v1/contacts/${contact.id}?expectedVersion=2`,
        payload: {
          expectedRevokedGrantIds: preview.json().data.revokedGrantIds,
        },
      });
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json().data.contact.status).toBe("inactive");
      expect(deleted.json().data.revocation.grantIds).toEqual(
        preview.json().data.revokedGrantIds,
      );
      const afterList = await app.inject({
        method: "GET",
        url: "/v1/contacts",
      });
      expect(
        afterList.json().data.some((c: { id: string }) => c.id === contact.id),
      ).toBe(false);
      const row = await database.query<{ status: string }>(
        "SELECT status FROM recipients WHERE id = $1",
        [contact.id],
      );
      expect(row.rows[0]?.status).toBe("inactive");
    } finally {
      await app.close();
    }
  });

  it("returns the not-found shape for a missing id and 422 for a bad address", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const missing = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/00000000-0000-4000-8000-00000000dead`,
        payload: { name: "X", expectedVersion: 1 },
      });
      expect(missing.statusCode).toBe(404);

      const badAddress = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        payload: { name: "X", description: "", address: "not-an-address" },
      });
      expect(badAddress.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });

  it("creates and versions explicit Solana devnet contacts without changing legacy EVM defaults", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer({ userId: USER_A });
    try {
      const created = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        payload: {
          name: "Solana contact slice4",
          description: "devnet",
          address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          network: "solana-devnet",
        },
      });
      expect(created.statusCode).toBe(201);
      const contact = created.json().data;
      expect(contact).toMatchObject({ network: "solana-devnet", version: 1 });

      const changed = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${contact.id}`,
        payload: {
          address: "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq",
          expectedVersion: 1,
        },
      });
      expect(changed.statusCode).toBe(200);
      expect(changed.json().data).toMatchObject({ network: "solana-devnet", version: 2 });

      const version = await database.query<{ network: string | null }>(
        "SELECT network FROM recipient_versions WHERE recipient_id = $1 AND version = 1",
        [contact.id],
      );
      expect(version.rows[0]?.network).toBe("solana-devnet");

      const wrongNetwork = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        payload: {
          name: "Wrong network slice4",
          description: "invalid",
          address: "0x9999999999999999999999999999999999999999",
          network: "solana-devnet",
        },
      });
      expect(wrongNetwork.statusCode).toBe(422);
    } finally {
      await app.close();
    }
  });
});
