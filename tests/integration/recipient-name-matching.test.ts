/**
 * Contact-name matching over the REAL projection: a name the user says or types
 * must identify their own contact regardless of diacritics, and the retrieval
 * fallback must not be able to add an unrelated contact to that answer.
 *
 * WHY THIS NEEDS THE REAL DATABASE
 * --------------------------------
 * The defect is not a string bug inside the classifier. It is the interaction
 * between the CLASSIFIER's comparison key and the projection the repository
 * actually returns: `recipients.normalized_name` is stored from
 * `normalizeMemoryText`, which keeps diacritics (`Sofía` -> `sofía`), so the
 * accent-less query `Sofia` (`sofia`) found no exact match at all, fell through to
 * the retrieval score path, and a near-tie there answered with the whole ranked
 * list — including a stranger. A unit test of the classifier with hand-written
 * `normalizedName` values cannot prove that, because the stored value is exactly
 * what the bug is about. This suite writes the row that the live run wrote and
 * asks the real `RecipientMemoryService` the real question.
 *
 * The embedder is a stub whose vector depends on the QUERY, so each case pins the
 * retrieval score it needs to be interesting: the rows are identical unit
 * vectors, so two candidates that both match score identically and only a name
 * rule can separate them, and a query sent a low-relevance vector scores below
 * the floor for everyone.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { vectorLiteral } from "../../src/memory/embedding.js";
import { RecipientMemoryRepository } from "../../src/memory/repository.js";
import { RecipientMemoryService } from "../../src/memory/service.js";
import type { Embedding } from "../../src/memory/types.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const EMBEDDING_DIMENSIONS = 384;
const ADDRESS_A = "So11111111111111111111111111111111111111112";
const ADDRESS_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ADDRESS_C = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** The production defaults (`src/config/env.ts`), so the ranking is the real one. */
const RANKING = { scoreThreshold: 0.78, scoreFloor: 0.55, scoreMargin: 0.08 };

function axis(index: number): number[] {
  return Array.from({ length: EMBEDDING_DIMENSIONS }, (_, position) => (position === index ? 1 : 0));
}

const RELEVANT = axis(0);
/** Orthogonal to every stored row, so it scores below the floor for all of them. */
const IRRELEVANT = axis(1);

/** Queries the stub sends an irrelevant vector for: their retrieval score is a real miss. */
const LOW_RELEVANCE_QUERIES = new Set(["sofi", "nadie", "my nephew"]);

suite("contact-name matching over the real recipients projection", () => {
  let database: DatabaseClient;
  let repository: RecipientMemoryRepository;
  const provisionedUserIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new RecipientMemoryRepository(database);
  });

  afterAll(async () => {
    for (const userId of provisionedUserIds) {
      await database.query(`DELETE FROM recipients WHERE user_id = $1`, [userId]);
      await database.query(`DELETE FROM users WHERE id = $1`, [userId]);
    }
    await database.close();
  });

  function service(): RecipientMemoryService {
    return new RecipientMemoryService(
      repository,
      { embed: async (text: string) => (LOW_RELEVANCE_QUERIES.has(text) ? IRRELEVANT : RELEVANT) },
      RANKING,
    );
  }

  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:name-match-${randomUUID()}`, "Name Matching Test"],
    );
    const userId = user.rows[0]!.id;
    provisionedUserIds.push(userId);
    return userId;
  }

  /**
   * Writes the row exactly the way the alias/paste paths write it: `name` as the
   * user sees it, `normalized_name` from the same normalization the repository
   * uses. The stored `sofía` is the whole point — it is what the live database
   * held and what the accent-less query could not match.
   */
  async function addRecipient(
    userId: string,
    name: string,
    description: string,
    address: string,
    embedding: readonly number[] = RELEVANT,
  ): Promise<void> {
    await database.withUserTransaction(userId, async (client) => {
      const stored = await client.query<{ id: string }>(
        `INSERT INTO recipients
           (user_id, name, normalized_name, description, address, network,
            embedding, embedding_model_revision, provenance, address_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, 'solana-devnet', $6::vector, 'name-match-test', '{}'::jsonb, now())
         RETURNING id`,
        [userId, name, storedNormalizedName(name), description, address, vectorLiteral(embedding)],      );
      expect(stored.rows[0]?.id).toBeTruthy();
    });
  }

  /**
   * The projection's own normalization, spelled out here so the fixture states the
   * stored value instead of importing the code under test for it. `Sofía` MUST be
   * `sofía` for this suite to be about the defect at all.
   */
  function storedNormalizedName(name: string): string {
    return name.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("es");
  }

  it("asserts the fixture stores the accented projection value the live defect had", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía", "mi vecina", ADDRESS_A);

    const row = await database.query<{ name: string; normalized_name: string }>(
      `SELECT name, normalized_name FROM recipients WHERE user_id = $1`,
      [userId],
    );
    expect(row.rows[0]).toEqual({ name: "Sofía", normalized_name: "sofía" });
  });

  it("RED: resolves `Sofia` to the accented contact and never carries the unrelated stranger", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía", "mi vecina", ADDRESS_A);
    await addRecipient(userId, "Test1", "un contacto de prueba", ADDRESS_B);

    const result = await service().searchRecipients(userId, "Sofia");

    expect(result).toMatchObject({ status: "resolved", recipient: { name: "Sofía" } });
    expect(result.candidates.map((entry) => entry.name)).toEqual(["Sofía"]);
  });

  it("RED: resolves the spoken short form `sofi` through the bounded prefix rule", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía", "mi vecina", ADDRESS_A);
    await addRecipient(userId, "Test1", "un contacto de prueba", ADDRESS_B);

    const result = await service().searchRecipients(userId, "sofi");

    expect(result).toMatchObject({ status: "resolved", recipient: { name: "Sofía" } });
    expect(result.candidates.map((entry) => entry.name)).toEqual(["Sofía"]);
  });

  it('reports an unselectable query as a miss while still returning the rows it found', async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía", "mi vecina", ADDRESS_A);
    await addRecipient(userId, "Test1", "un contacto de prueba", ADDRESS_B);

    // `Nadie` identifies nobody: nothing is selectable, and the status says so.
    // The queries above are NOT the only thing that runs, though — the store DID
    // return rows below the floor, and they travel with the miss so the surface
    // can report what it found instead of telling the user they have no contacts.
    const result = await service().searchRecipients(userId, "Nadie");

    expect(result.status).toBe("no_match");
    expect(result).not.toHaveProperty("recipient");
    expect(result.candidates.map((entry) => entry.name)).toEqual(["Sofía", "Test1"]);
    expect(result.candidates.map((entry) => entry.description)).toEqual(["mi vecina", "un contacto de prueba"]);
  });

  it("RED: resolves the contact whose DESCRIPTION is what the user said, on a total retrieval miss", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sophie", "My nephew", ADDRESS_A);
    await addRecipient(userId, "Test1", "un contacto de prueba", ADDRESS_B);

    // The stub sends an IRRELEVANT vector for this query, so the score is below
    // the floor for every row: the description rule is the only thing that can
    // answer, which is exactly the live defect. `my nephew` cannot reach the 0.78
    // threshold through the vector, because the stored embedding blends the name
    // into the description (measured live: 0.5722 against a 0.78 threshold).
    const result = await service().searchRecipients(userId, "my nephew");

    expect(result).toMatchObject({ status: "resolved", recipient: { name: "Sophie" } });
    // A literal description identifies ONE contact, so the unrelated row is not
    // offered as a candidate for it.
    expect(result.candidates.map((entry) => entry.name)).toEqual(["Sophie"]);
  });

  it("folds the description, so the accent-less spelling of it still finds the contact", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofia", "Mi nieta mayor", ADDRESS_A);

    const result = await service().searchRecipients(userId, "mi nieta mayor");

    expect(result).toMatchObject({ status: "resolved", recipient: { name: "Sofia" } });
  });

  it("asks when two contacts carry the same description instead of picking one", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sophie", "My nephew", ADDRESS_A);
    await addRecipient(userId, "Mateo", "My nephew", ADDRESS_B);

    await expect(service().searchRecipients(userId, "my nephew")).resolves.toMatchObject({
      status: "clarification_required",
    });
  });

  it("never resolves onto a contact that has no description", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Test1", "", ADDRESS_B);

    const result = await service().searchRecipients(userId, "my nephew");

    expect(result.status).toBe("no_match");
    expect(result).not.toHaveProperty("recipient");
  });

  it("still asks when two genuinely different contacts answer to the same name", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía Ríos", "del trabajo", ADDRESS_A);
    await addRecipient(userId, "Sofía Gómez", "del club", ADDRESS_B);

    // Both are a `Sofia` prefix and neither is an exact match, so the short form
    // does not identify one of them and the answer must be the question.
    await expect(service().searchRecipients(userId, "Sofia")).resolves.toMatchObject({
      status: "clarification_required",
    });
    // Control on the SAME rows: the full name is an exact match and resolves.
    await expect(service().searchRecipients(userId, "Sofia Rios")).resolves.toMatchObject({
      status: "resolved",
      recipient: { name: "Sofía Ríos" },
    });
  });

  it("treats two rows that differ only by a diacritic as the same name and asks, never picking one", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía", "la primera", ADDRESS_A);
    await addRecipient(userId, "Sofia", "la segunda", ADDRESS_B);

    const result = await service().searchRecipients(userId, "Sofia");

    // Two rows, one name once accents are ignored: the accent-only difference must
    // not be read as "a different name", and it must not silently choose the
    // unaccented row either. `clarification_required` is what both require.
    expect(result.status).toBe("clarification_required");
    expect(result.candidates.map((entry) => entry.name).sort()).toEqual(["Sofia", "Sofía"]);
  });

  it("never answers with a deactivated contact, whatever the spelling", async () => {
    const userId = await provisionUser();
    await addRecipient(userId, "Sofía", "la activa", ADDRESS_A);
    await addRecipient(userId, "Sofía", "la archivada", ADDRESS_C);
    await database.query(
      `UPDATE recipients SET status = 'inactive' WHERE user_id = $1 AND description = 'la archivada'`,
      [userId],
    );

    // The archived row is not a second candidate, so the surviving one is unique.
    const result = await service().searchRecipients(userId, "Sofia");

    expect(result).toMatchObject({ status: "resolved", recipient: { name: "Sofía", description: "la activa" } });
    expect(result.candidates).toHaveLength(1);
  });
});
