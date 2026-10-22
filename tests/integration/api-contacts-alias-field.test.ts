/**
 * Task 5.4 — the alias on the contact read (design §3.2 correction C3).
 *
 * The mirrored type already exists in `apps/nana-wallet/src/lib/api-types.ts`
 * (`alias?: ContactAlias | null`), so this is the additive, mirrored change the
 * task's stop condition requires: the SAME unit lands the backend projection and
 * the surface that renders it.
 *
 * What is asserted here is the READ, not the write:
 *
 *   1. an alias-origin contact reads back with `alias {name, resolvedAt}`;
 *   2. a pasted or scanned contact reads back with `alias: null` — which is a
 *      FACT, not a missing field;
 *   3. a contact written before this feature exists (`provenance = {}`) is `null`
 *      too, and is never read as an alias;
 *   4. the address is never truncated, and the alias never becomes the address.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";
import { provisionTestUser } from "../fixtures/provision-user.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import type { SnsResolver } from "../../src/wallet/sns/resolver.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const ALIAS_NAME = "sophie.sns";
const ALIAS_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const PASTED_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

function stubResolver(): SnsResolver {
  return {
    async resolve(name: string) {
      return {
        ok: true as const,
        value: {
          name,
          address: ALIAS_ADDRESS,
          nameAccount: "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew",
          observedOwner: ALIAS_ADDRESS,
          observedParent: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
          slot: 1,
          resolvedAt: "2026-10-10T18:04:11.482Z",
          resolver: "sns/solana-devnet/v3",
          reverseDomain: null,
          reverseDomainState: "none" as const,
        },
      };
    },
    async reverseLookup() {
      return { ok: true as const, value: { name: null, unknown: false } };
    },
  };
}

suite("the alias a contact read reports (task 5.4)", () => {
  let database: DatabaseClient;
  const createdIds: string[] = [];

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await provisionTestUser(TEST_USER_ID);
  });

  afterAll(async () => {
    for (const id of createdIds) {
      await database.query(`DELETE FROM recipient_policy_sync_intent WHERE contact_id = $1`, [id]);
      await database.query(`DELETE FROM recipient_versions WHERE recipient_id = $1`, [id]);
      await database.query(`DELETE FROM recipients WHERE id = $1`, [id]);
    }
    await database.close();
  });

  async function readContact(
    app: ReturnType<typeof buildTestServer>,
    contactId: string,
  ): Promise<Record<string, unknown>> {
    const response = await app.inject({ method: "GET", url: "/v1/contacts" });
    expect(response.statusCode).toBe(200);
    const found = (response.json().data as Array<Record<string, unknown>>).find(
      (contact) => contact.id === contactId,
    );
    expect(found).toBeDefined();
    return found!;
  }

  it("reports the alias of an alias-origin contact and null for the paste path", async () => {
    const app = buildTestServer({ recipientAliases: stubResolver() });

    const aliased = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { "content-type": "application/json", "idempotency-key": randomUUID() },
      payload: {
        name: "Nieta",
        description: "",
        source: "sns",
        snsName: ALIAS_NAME,
        expectedAddress: ALIAS_ADDRESS,
      },
    });
    expect(aliased.statusCode).toBe(201);
    createdIds.push(aliased.json().data.id);

    const pasted = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { "content-type": "application/json" },
      payload: { name: "Mamá", description: "", address: PASTED_ADDRESS },
    });
    expect(pasted.statusCode).toBe(201);
    createdIds.push(pasted.json().data.id);

    // Positive control: the SAME read reports the alias for one and not the other.
    const aliasRead = await readContact(app, aliased.json().data.id);
    expect(aliasRead.alias).toEqual({
      name: ALIAS_NAME,
      resolvedAt: "2026-10-10T18:04:11.482Z",
    });
    // The address is what the contact IS; the alias is a label beside it.
    expect(aliasRead.address).toBe(ALIAS_ADDRESS);
    expect(aliasRead.alias).not.toBe(ALIAS_ADDRESS);
    // The evidence object does not leak into the read: only the two names the
    // client needs travel (`contactAliasSchema` is `.strict()`).
    expect(JSON.stringify(aliasRead.alias)).not.toContain("nameAccount");

    const pastedRead = await readContact(app, pasted.json().data.id);
    expect(pastedRead.alias).toBeNull();
    expect(pastedRead.address).toBe(PASTED_ADDRESS);
    await app.close();
  });

  async function insertLegacyContact(name: string, provenance: string): Promise<string> {
    const id = randomUUID();
    const zeroEmbedding = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
    await database.query(
      `INSERT INTO recipients
         (id, user_id, name, normalized_name, description, address, provenance,
          embedding, embedding_model_revision, address_confirmed_at)
       VALUES ($1, $2, $3, $4, '', $5, $6::jsonb, $7::vector, 'test', now())`,
      [id, TEST_USER_ID, name, name.toLocaleLowerCase("es-AR"), PASTED_ADDRESS, provenance, zeroEmbedding],
    );
    createdIds.push(id);
    return id;
  }

  it("never reads a pre-feature contact as an alias", async () => {
    // Row 1: written before this feature — `provenance = '{}'`, no claim at all.
    const legacyId = await insertLegacyContact("Antigua", "{}");
    // Row 2: a provenance that carries a name and a timestamp but is NOT marked
    // `source: 'sns'`. The read must key off the explicit marker, never off the
    // presence of a name-shaped key: an unmarked name is a different fact.
    const nameLikeId = await insertLegacyContact(
      "AntiguaDos",
      JSON.stringify({
        origin: "user",
        name: ALIAS_NAME,
        resolvedAt: "2026-10-10T18:04:11.482Z",
      }),
    );

    const app = buildTestServer({ recipientAliases: stubResolver() });

    // Row 3: marked `source: 'sns'` but with no usable name/resolvedAt pair — a
    // malformed claim is not a claim, and must not reach the client as one.
    const malformedId = await insertLegacyContact("AntiguaTres", '{"source":"sns"}');
    const malformedRead = await readContact(app, malformedId);
    expect(malformedRead.address).toBe(PASTED_ADDRESS);
    expect(malformedRead.alias).toBeNull();

    const legacyRead = await readContact(app, legacyId);
    // Positive control: the row was really read, so `null` is a value the
    // projection produced and not the accidental absence of a whole contact.
    expect(legacyRead.address).toBe(PASTED_ADDRESS);
    expect("alias" in legacyRead).toBe(true);
    expect(legacyRead.alias).toBeNull();

    const nameLikeRead = await readContact(app, nameLikeId);
    expect(nameLikeRead.address).toBe(PASTED_ADDRESS);
    expect(nameLikeRead.alias).toBeNull();

    await app.close();
  });
});
