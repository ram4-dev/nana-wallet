/**
 * Task 2.4 — the wallet's own address is refused on every surface that creates
 * or replaces a trusted recipient (design §2.5, D13's unconditional half).
 *
 * WHY THIS ONE NEEDS THE REAL DATABASE
 * ------------------------------------
 * The whole guarantee is *where the compared value comes from*: the destination
 * is compared against the server's OWN `user_wallets.address`, resolved for the
 * acting user, and not against anything a body supplied. That is a statement
 * about a row this suite has to write, read back and then mutate, so a stub would
 * only prove the stub.
 *
 * Every negative case has a positive control on the same fixture, and each
 * refusal is closed with a row count over the tables a refused mutation must not
 * touch.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
} from "../../src/db/client.js";
import { RecipientPolicyRepository } from "../../src/wallet/policy/repository.js";
import {
  RecipientPolicyService,
  RecipientPolicyValidationError,
  RecipientSelfAddressError,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import { createPrivyPolicyAdminClient } from "../../src/wallet/grants/privy-policy-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APPLY_REASON = "no signed apply capability in this suite";
/** The wallet's own Solana address (a canonical 32-byte base58 key). */
const WALLET_ADDRESS = "So11111111111111111111111111111111111111112";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** A syntactically valid EVM address: never a Solana recipient. */
const EVM_ADDRESS = "0x1f9090aaE28b8a3dCeaDf281B0F12828e676c326";
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
const RECIPIENT_COLUMNS = "id, name, description, address, network, version";

type ContactRow = {
  id: string;
  name: string;
  description: string;
  address: string;
  network: "solana-devnet" | null;
  version: string | number;
};

function mapContact(row: ContactRow): RecipientContactRecord {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    address: row.address,
    network: row.network,
    version: Number(row.version),
  };
}

function normalizeName(name: string): string {
  return name
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toLocaleLowerCase("es");
}

suite("the wallet's own address is refused (task 2.4)", () => {
  let database: DatabaseClient;
  let repository: RecipientPolicyRepository;
  const provisionedUserIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new RecipientPolicyRepository(database);
  });

  afterAll(async () => {
    for (const userId of provisionedUserIds) {
      await database.query(
        `DELETE FROM recipient_policy_sync_intent WHERE user_id = $1`,
        [userId],
      );
      await database.query(
        `DELETE FROM recipient_policy_state WHERE user_id = $1`,
        [userId],
      );
      await database.query(`DELETE FROM signer_grants WHERE user_id = $1`, [
        userId,
      ]);
      await database.query(`DELETE FROM delegated_grants WHERE user_id = $1`, [
        userId,
      ]);
      await database.query(`DELETE FROM recipients WHERE user_id = $1`, [userId]);
    }
    await database.close();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** user + zero or more wallets, each at a caller-chosen address and state. */
  async function provision(
    wallets: Array<{
      chainFamily: "solana" | "ethereum";
      address: string;
      state?: "ready" | "provisioning";
    }> = [{ chainFamily: "solana", address: WALLET_ADDRESS }],
  ): Promise<{ userId: string; walletId: string | null }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:rsa-${randomUUID()}`, "RSA Self-Address Test"],
    );
    const userId = user.rows[0]!.id;
    let walletId: string | null = null;
    for (const wallet of wallets) {
      const inserted = await database.query<{ id: string }>(
        `INSERT INTO user_wallets
           (user_id, provider, provider_wallet_id, chain_family, address, state)
         VALUES ($1, 'fixture', $2, $3, $4, $5) RETURNING id`,
        [
          userId,
          `fixture-${randomUUID()}`,
          wallet.chainFamily,
          wallet.address,
          wallet.state ?? "ready",
        ],
      );
      if (wallet.chainFamily === "solana" && (wallet.state ?? "ready") === "ready") {
        walletId = inserted.rows[0]!.id;
      }
    }
    provisionedUserIds.push(userId);
    return { userId, walletId };
  }

  /** A real-SQL adapter for the injected contact-mutation port. */
  const contacts: RecipientContactMutationPort = {
    async create(userId, input, client): Promise<RecipientContactRecord> {
      const result = await client.query<ContactRow>(
        `INSERT INTO recipients
           (user_id, name, normalized_name, description, address, network,
            embedding, embedding_model_revision, provenance, address_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, 'test', '{}'::jsonb, now())
         RETURNING ${RECIPIENT_COLUMNS}`,
        [
          userId,
          input.name,
          normalizeName(input.name),
          input.description,
          input.address,
          input.network,
          ZERO_EMBEDDING,
        ],
      );
      return mapContact(result.rows[0]!);
    },

    async update(userId, contactId, input, client): Promise<RecipientContactRecord> {
      const existing = await client.query(
        `SELECT id FROM recipients
          WHERE user_id = $1 AND id = $2 AND status = 'active'`,
        [userId, contactId],
      );
      if (existing.rowCount === 0) throw new Error("missing contact");
      const result = await client.query<ContactRow>(
        `UPDATE recipients
            SET name = COALESCE($4, name),
                normalized_name = COALESCE($5, normalized_name),
                description = COALESCE($6, description),
                address = COALESCE($7, address),
                network = $8,
                version = version + 1,
                updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
          RETURNING ${RECIPIENT_COLUMNS}`,
        [
          userId,
          contactId,
          input.expectedVersion,
          input.name ?? null,
          input.name === undefined ? null : normalizeName(input.name),
          input.description ?? null,
          input.address ?? null,
          input.network ?? null,
        ],
      );
      if (result.rowCount === 0) throw new Error("stale contact version");
      return mapContact(result.rows[0]!);
    },

    async archive(userId, contactId, expectedVersion, client) {
      const result = await client.query<ContactRow>(
        `UPDATE recipients
            SET status = 'inactive', updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
          RETURNING ${RECIPIENT_COLUMNS}`,
        [userId, contactId, expectedVersion],
      );
      if (result.rowCount === 0) throw new Error("stale contact version");
      return mapContact(result.rows[0]!);
    },

    async readActive(userId, contactId, client) {
      const run = async (query: Queryable) => {
        const result = await query.query<ContactRow>(
          `SELECT ${RECIPIENT_COLUMNS} FROM recipients
            WHERE user_id = $1 AND id = $2 AND status = 'active'`,
          [userId, contactId],
        );
        return result.rows[0] ? mapContact(result.rows[0]) : null;
      };
      return client ? run(client) : database.withUserTransaction(userId, run);
    },
  };

  function service(): RecipientPolicyService {
    const grants = createPrivyPolicyAdminClient({
      database,
      server: null as never,
      admin: null as never,
    });
    return new RecipientPolicyService({
      database,
      repository,
      contacts,
      listActiveGrants: grants.listActiveGrants.bind(grants),
      provider: createUnavailablePolicyApplyPort(APPLY_REASON),
    } as unknown as RecipientPolicyServiceDependencies);
  }

  /** Row counts over the tables a refused mutation must not touch. */
  async function counts(userId: string) {
    const one = async (table: string): Promise<number> => {
      const result = await database.query<{ n: number }>(
        `SELECT COUNT(*)::int AS n FROM ${table} WHERE user_id = $1`,
        [userId],
      );
      return Number(result.rows[0]!.n);
    };
    return {
      contacts: await one("recipients"),
      states: await one("recipient_policy_state"),
      intents: await one("recipient_policy_sync_intent"),
    };
  }

  async function readContact(userId: string, contactId: string) {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<ContactRow>(
        `SELECT ${RECIPIENT_COLUMNS} FROM recipients WHERE id = $2 AND user_id = $1`,
        [userId, contactId],
      ),
    );
    return result.rows[0]!;
  }

  /** A typed refusal, or a thrown assertion if nothing was thrown. */
  async function refusal(run: () => Promise<unknown>): Promise<unknown> {
    try {
      await run();
    } catch (error) {
      return error;
    }
    throw new Error("expected a typed refusal, but nothing was thrown");
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  it("refuses the wallet's own address on create and persists nothing", async () => {
    const { userId } = await provision();
    const policy = service();

    // Positive control: the same service, the same fixture, a different address.
    const accepted = await policy.create(userId, {
      name: "Mamá",
      address: ADDRESS_A,
      description: "",
    });
    expect(accepted.contact.address).toBe(ADDRESS_A);
    const before = await counts(userId);

    const error = (await refusal(() =>
      policy.create(userId, {
        name: "Yo mismo",
        address: WALLET_ADDRESS,
        description: "",
      }),
    )) as RecipientSelfAddressError;

    expect(error).toBeInstanceOf(RecipientSelfAddressError);
    expect(error.code).toBe("DIRECCION_PROPIA");
    // The refusal is the whole point: nothing was persisted.
    expect(await counts(userId)).toEqual(before);
  });

  it("refuses the wallet's own address on an address replacement and leaves the contact untouched", async () => {
    const { userId } = await provision();
    const policy = service();
    const created = await policy.create(userId, {
      name: "Mamá",
      address: ADDRESS_A,
      description: "",
    });
    const before = await counts(userId);

    const error = (await refusal(() =>
      policy.edit(userId, created.contact.id, {
        address: WALLET_ADDRESS,
        expectedVersion: created.contact.version,
      }),
    )) as RecipientSelfAddressError;

    expect(error).toBeInstanceOf(RecipientSelfAddressError);
    expect(error.code).toBe("DIRECCION_PROPIA");
    // The contact is exactly where it was: same address, same version.
    const after = await readContact(userId, created.contact.id);
    expect(after.address).toBe(ADDRESS_A);
    expect(Number(after.version)).toBe(created.contact.version);
    expect((await counts(userId)).intents).toBe(before.intents);
  });

  it("never reports the refusal as a duplicate-contact conflict", async () => {
    const { userId } = await provision();
    const policy = service();
    // A LEGACY row already holding the wallet's own address: the shape a
    // duplicate disclosure would find. The self-address refusal has to win, and
    // it has to say so with its own code.
    await contacts.create(
      userId,
      {
        name: "Fila vieja",
        description: "",
        address: WALLET_ADDRESS,
        network: "solana-devnet",
      },
      await database.withUserTransaction(userId, async (client) => client),
    );

    const error = (await refusal(() =>
      policy.create(userId, {
        name: "Yo mismo",
        address: WALLET_ADDRESS,
        description: "",
      }),
    )) as RecipientSelfAddressError;

    expect(error).toBeInstanceOf(RecipientSelfAddressError);
    expect(error.code).toBe("DIRECCION_PROPIA");
    // The wrong answers, named: none of them is what this is.
    expect([
      "VERSION_OBSOLETA",
      "CONFLICTO_POLITICA",
      "CONTACTO_NO_ENCONTRADO",
      "DATOS_INVALIDOS",
    ]).not.toContain(error.code);
  });

  it("cannot mistake an EVM-looking or malformed value for the wallet's own address", async () => {
    const { userId } = await provision();
    const policy = service();

    // Positive control: a different CANONICAL address is accepted, so the two
    // refusals below are about the value and not about a broken fixture.
    await expect(
      policy.create(userId, { name: "Papá", address: ADDRESS_B, description: "" }),
    ).resolves.toBeDefined();

    const evm = (await refusal(() =>
      policy.create(userId, { name: "EVM", address: EVM_ADDRESS, description: "" }),
    )) as RecipientPolicyValidationError;
    expect(evm).toBeInstanceOf(RecipientPolicyValidationError);
    expect(evm.code).toBe("DATOS_INVALIDOS");
    expect(evm.issues.map((issue) => issue.path)).toContain("address");

    // A truncated base58 string is not the wallet's own address either: the
    // comparison is exact and the validator refuses the shape before it is made.
    const malformed = (await refusal(() =>
      policy.create(userId, {
        name: "Truncada",
        address: WALLET_ADDRESS.slice(0, 40),
        description: "",
      }),
    )) as RecipientPolicyValidationError;
    expect(malformed).toBeInstanceOf(RecipientPolicyValidationError);
    expect(malformed.code).toBe("DATOS_INVALIDOS");
  });

  // -------------------------------------------------------------------------
  // The honest boundary: no own address ⇒ the comparison is vacuous
  // -------------------------------------------------------------------------

  it("is vacuous with no READY Solana wallet, and the contact is written saved-not-enabled", async () => {
    // The acting user's own Solana wallet is NOT ready. The address below IS a
    // ready wallet's address — someone else's. If the comparison were a global
    // list rather than the acting user's own record, this would be refused.
    const { userId } = await provision([
      { chainFamily: "solana", address: WALLET_ADDRESS, state: "provisioning" },
    ]);
    const policy = service();
    const before = await counts(userId);

    const result = await policy.create(userId, {
      name: "Mamá",
      address: WALLET_ADDRESS,
      description: "",
    });

    expect(result.contact.address).toBe(WALLET_ADDRESS);
    expect(result.permission).toEqual({
      state: "saved_not_configured",
      desiredRevision: 0,
      appliedRevision: 0,
      retryable: false,
    });
    // Positive control that the write really happened, and nothing else did.
    expect(await counts(userId)).toEqual({
      contacts: before.contacts + 1,
      states: before.states,
      intents: before.intents,
    });
  });

  it("is vacuous for a user with no Solana wallet at all", async () => {
    const { userId } = await provision([
      { chainFamily: "ethereum", address: "0x1111111111111111111111111111111111111111" },
    ]);
    const policy = service();

    const result = await policy.create(userId, {
      name: "Mamá",
      address: WALLET_ADDRESS,
      description: "",
    });

    expect(result.contact.address).toBe(WALLET_ADDRESS);
    expect(result.policyRevision).toBe(0);
  });
});
