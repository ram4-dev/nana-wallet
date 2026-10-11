/**
 * Task 2.2 (integration half) — the provenance write, clear and read, against a
 * real database.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The point of per-contact provenance is that "where did this address come from"
 * has exactly one answer, and that the answer is never a stale claim. Two ways
 * it could be wrong, both real in this codebase before this task:
 *
 *   * `ContactsRepository.create` hardcoded `{origin:'user'}` (`:132`) and
 *     ignored the caller, so an alias create would have written the alias
 *     evidence and silently discarded it (C1).
 *   * `ContactsRepository.update` never wrote `provenance` at all (C2), so
 *     replacing the address of an alias-created contact would leave the row
 *     claiming `juan.sns -> <old address>`, and a later drift check would report
 *     "no drift" for a name with nothing to do with the destination.
 *
 * Every assertion here is backed by a positive control, because a negative
 * assertion that passes because a column or fixture is missing is a false green:
 * the address edit case asserts the new address was stored, and the clearing case
 * asserts the pre-edit claim was actually persisted first.
 *
 * `recipient_versions` is deliberately NOT extended (design §11 Q7: settling
 * that is task 2.6). The snapshot assertions below pin the current behaviour —
 * the old ADDRESS is kept, and no provenance is snapshotted — so that a later
 * decision there becomes a visible, deliberate test change.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { ContactsRepository } from "../../src/memory/contacts-repository.js";

const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const REPLACEMENT = "So11111111111111111111111111111111111111112";
const EMBEDDING = Array(384).fill(0.1);
const MODEL = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";

const ALIAS_PROVENANCE = {
  source: "sns",
  name: "sophie.sns",
  resolvedAt: "2026-10-10T18:04:11.482Z",
  resolver: "sns/solana-devnet/v3",
  reverify: "verified",
  nameAccount: "HxGRNnMkuvHRhXnqfPWZ7RJQ3UFtXzF7Czoj1K1Q3D1f",
  observedOwner: ADDRESS,
  observedParent: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
  slot: 509688088,
  reverseDomain: null,
  reverseDomainState: "none",
};

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("contacts provenance (task 2.2, real database)", () => {
  let database: DatabaseClient;
  let repository: ContactsRepository;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new ContactsRepository(database);
  });

  afterAll(async () => {
    await database.close();
  });

  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:cp-${randomUUID()}`, "Contact Provenance"],
    );
    return user.rows[0]!.id;
  }

  async function createContact(
    userId: string,
    provenance?: Record<string, unknown>,
  ) {
    return database.withUserTransaction(userId, (client) =>
      repository.create(
        userId,
        {
          name: "Sofía",
          description: "amiga",
          address: ADDRESS,
          network: "solana-devnet",
          ...(provenance === undefined ? {} : { provenance }),
        },
        EMBEDDING,
        MODEL,
        client,
      ),
    );
  }

  /** The raw column, read outside the record mapping. */
  async function rawProvenance(
    userId: string,
    contactId: string,
  ): Promise<Record<string, unknown>> {
    const rows = await database.withUserTransaction(userId, (client) =>
      client.query<{ provenance: Record<string, unknown> }>(
        `SELECT provenance FROM recipients WHERE user_id = $1 AND id = $2`,
        [userId, contactId],
      ),
    );
    return rows.rows[0]!.provenance;
  }

  it("persists the alias provenance object and reads the whole object back", async () => {
    const userId = await provisionUser();
    const created = await createContact(userId, ALIAS_PROVENANCE);

    // Positive control: the row exists with the address, so the provenance
    // assertions below are about the write and not about a missing contact.
    expect(created.address).toBe(ADDRESS);
    expect(created.provenance).toEqual(ALIAS_PROVENANCE);
    expect(await rawProvenance(userId, created.id)).toEqual(ALIAS_PROVENANCE);

    // And the read paths the rest of this change will use carry it too.
    const read = await database.withUserTransaction(userId, (client) =>
      repository.read(userId, created.id, client),
    );
    expect(read?.provenance).toEqual(ALIAS_PROVENANCE);
    const listed = await repository.listActive(userId);
    expect(listed.find((contact) => contact.id === created.id)?.provenance).toEqual(
      ALIAS_PROVENANCE,
    );
  });

  it("keeps the paste/scan default and honours an explicit paste provenance", async () => {
    const userId = await provisionUser();

    // C1's default: a caller that supplies nothing still stores the vocabulary
    // the feature relies on, so an absent provenance is never a missing row.
    const bare = await createContact(userId);
    expect(await rawProvenance(userId, bare.id)).toEqual({ origin: "user" });

    // Design §3.1: the paste path records `{origin:'user', source:'pasted'}`, so
    // "where did this address come from" has one vocabulary.
    const pasted = await createContact(userId, { origin: "user", source: "pasted" });
    expect(await rawProvenance(userId, pasted.id)).toEqual({
      origin: "user",
      source: "pasted",
    });
  });

  it("clears a stale alias claim on an address edit while recipient_versions keeps the old address", async () => {
    const userId = await provisionUser();
    const created = await createContact(userId, ALIAS_PROVENANCE);
    expect(await rawProvenance(userId, created.id)).toEqual(ALIAS_PROVENANCE);

    const edited = await database.withUserTransaction(userId, (client) =>
      repository.update(
        userId,
        created.id,
        { address: REPLACEMENT, expectedVersion: created.version },
        EMBEDDING,
        MODEL,
        client,
      ),
    );

    // Positive control: the edit really replaced the address and advanced the
    // version, so the cleared provenance is a decision and not a no-op write.
    expect(edited.address).toBe(REPLACEMENT);
    expect(edited.version).toBe(created.version + 1);
    // The alias claim is GONE: `juan.sns -> <old address>` would otherwise
    // survive an edit that has nothing to do with that name.
    expect(edited.provenance).toEqual({});
    expect(await rawProvenance(userId, created.id)).toEqual({});

    // The snapshot keeps the history: the old address is still readable there.
    const versions = await database.withUserTransaction(userId, (client) =>
      client.query<{ version: string; address: string }>(
        `SELECT version, address FROM recipient_versions
          WHERE recipient_id = $1 ORDER BY version`,
        [created.id],
      ),
    );
    expect(versions.rows).toHaveLength(1);
    expect(versions.rows[0]!.address).toBe(ADDRESS);
  });

  it("preserves provenance byte-for-byte on a metadata-only edit", async () => {
    const userId = await provisionUser();
    const created = await createContact(userId, ALIAS_PROVENANCE);

    const renamed = await database.withUserTransaction(userId, (client) =>
      repository.update(
        userId,
        created.id,
        { name: "Sofía Ríos", expectedVersion: created.version },
        EMBEDDING,
        MODEL,
        client,
      ),
    );

    // Positive control: the rename landed.
    expect(renamed.name).toBe("Sofía Ríos");
    expect(renamed.address).toBe(ADDRESS);
    expect(renamed.provenance).toEqual(ALIAS_PROVENANCE);
    expect(await rawProvenance(userId, created.id)).toEqual(ALIAS_PROVENANCE);
  });

  it("honours an explicit provenance on an address edit instead of clearing it", async () => {
    const userId = await provisionUser();
    const created = await createContact(userId, ALIAS_PROVENANCE);
    const replacementClaim = { source: "sns", name: "maria.sns", resolver: "sns/solana-devnet/v3" };

    const edited = await database.withUserTransaction(userId, (client) =>
      repository.update(
        userId,
        created.id,
        { address: REPLACEMENT, expectedVersion: created.version, provenance: replacementClaim },
        EMBEDDING,
        MODEL,
        client,
      ),
    );

    expect(edited.address).toBe(REPLACEMENT);
    expect(await rawProvenance(userId, created.id)).toEqual(replacementClaim);
  });

  it("clears the claim when an address edit re-sends the same address (fail-safe clear)", async () => {
    // The patch's own vocabulary decides: `service.ts` calls a patch
    // "metadata-only" exactly when it carries no address, so a patch that carries
    // one IS an address edit. Re-sending the stored value therefore still clears:
    // clearing loses a claim, while keeping a stale one states something false.
    const userId = await provisionUser();
    const created = await createContact(userId, ALIAS_PROVENANCE);

    const edited = await database.withUserTransaction(userId, (client) =>
      repository.update(
        userId,
        created.id,
        { address: ADDRESS, expectedVersion: created.version },
        EMBEDDING,
        MODEL,
        client,
      ),
    );

    expect(edited.address).toBe(ADDRESS);
    expect(edited.provenance).toEqual({});
  });
});
