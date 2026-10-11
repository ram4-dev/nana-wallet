/**
 * Task 2.5 — a duplicate address is disclosed BY NAME and the add proceeds
 * (design §2.5, D13's disclosed half).
 *
 * WHY THIS ONE NEEDS THE REAL DATABASE
 * ------------------------------------
 * The requirement is not "a field is returned". It is that the disclosure is
 * TRUE and that acting on it changes NO authority:
 *
 *   1. the contact that already holds the address is found by a real query over
 *      the real `recipients` projection, with `status = 'active'`;
 *   2. the composed rule set and every `delegated_grants` row are UNCHANGED by
 *      the add, which is a statement about rows this suite has to read before
 *      and after.
 *
 * The composed allowlist is a SET (`composer.ts`), so a second label for an
 * address the user already trusts adds no authority — that is why the disclosure
 * proceeds instead of refusing. The alias path must not be stricter than the
 * paste path for the same address, and in this slice there is exactly ONE create
 * arm, so the case below is literally the same code path the alias arm (5.2)
 * enters through.
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
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import { createPrivyPolicyAdminClient } from "../../src/wallet/grants/privy-policy-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APPLY_REASON = "no signed apply capability in this suite";
const WALLET_ADDRESS = "So11111111111111111111111111111111111111112";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ADDRESS_C = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
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

suite("a duplicate address is disclosed and the add proceeds (task 2.5)", () => {
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

  async function provision(): Promise<{
    userId: string;
    walletId: string;
  }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:rdd-${randomUUID()}`, "RDD Duplicate Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, WALLET_ADDRESS],
    );
    // The enrollment consent baseline: the wallet's own retained address only.
    await database.query(
      `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
          allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
          rolling_window_seconds, gas_ceiling, state, signer_enrollment_snapshot,
          created_at)
       VALUES ($1, $2, 'policy-x', 'signer-x', 'hash-x', $3::jsonb,
               '10000000', '10000000', 3600, '1000000', 'active', '{}'::jsonb,
               now())`,
      [userId, wallet.rows[0]!.id, JSON.stringify([WALLET_ADDRESS])],
    );
    provisionedUserIds.push(userId);
    return { userId, walletId: wallet.rows[0]!.id };
  }

  /**
   * One REVOKED delegated grant. It composes no rule (only `active` grants are
   * read), which is exactly why it is here: it is a row that must survive an
   * unrelated add untouched — neither revived, nor rewritten, nor deleted — so the
   * "every `delegated_grants` row unchanged" claim below is about a real row
   * instead of an empty table.
   */
  async function provisionRevokedGrant(userId: string, walletId: string) {
    await database.query(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, expires_at, revoked_at)
       VALUES ($1, $2, 'solana', '5000000', '20000000', 3600, $3::jsonb,
               'revoked', now() + interval '30 days', now())`,
      [userId, walletId, JSON.stringify([ADDRESS_A])],
    );
  }

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

  /** The recorded composed rule set: the authority the add must not move. */
  async function composedHash(userId: string, walletId: string) {
    const state = await repository.readPolicyState(userId, walletId);
    return state?.desiredRulesHash ?? null;
  }

  async function grantRows(userId: string) {
    const result = await database.query<{
      id: string;
      state: string;
      recipients: unknown;
      provider_policy_id: string | null;
    }>(
      `SELECT id, state, recipients, provider_policy_id FROM delegated_grants
        WHERE user_id = $1 ORDER BY id ASC`,
      [userId],
    );
    return result.rows;
  }

  async function activeContacts(userId: string) {
    const result = await database.query<{ id: string; name: string; address: string }>(
      `SELECT id, name, address FROM recipients
        WHERE user_id = $1 AND status = 'active' ORDER BY id ASC`,
      [userId],
    );
    return result.rows;
  }

  // -------------------------------------------------------------------------
  // The disclosure
  // -------------------------------------------------------------------------

  it("stores a duplicate address, discloses the holder's name, and moves no authority", async () => {
    const { userId, walletId } = await provision();
    const policy = service();
    await provisionRevokedGrant(userId, walletId);

    const first = await policy.create(userId, {
      name: "Mamá",
      address: ADDRESS_A,
      description: "",
    });
    // Positive control: the first add is NEW, so the disclosure below is not
    // reported unconditionally.
    expect(first.duplicateOf).toBeNull();

    const hashBefore = await composedHash(userId, walletId);
    const grantsBefore = await grantRows(userId);
    expect(hashBefore).not.toBeNull();
    // Positive control for the grant claim: there IS a row to preserve.
    expect(grantsBefore).toHaveLength(1);
    expect(grantsBefore[0]!.state).toBe("revoked");

    const second = await policy.create(userId, {
      name: "Juan",
      address: ADDRESS_A,
      description: "el mismo lugar",
    });

    // Stored, and disclosed with the other contact's NAME — not its id alone.
    expect(second.contact.address).toBe(ADDRESS_A);
    expect(second.contact.id).not.toBe(first.contact.id);
    expect(second.duplicateOf).toEqual({
      contactId: first.contact.id,
      name: "Mamá",
    });
    // Both labels exist; the add proceeded.
    expect((await activeContacts(userId)).map((row) => row.name).sort()).toEqual([
      "Juan",
      "Mamá",
    ]);
    // No authority moved: same composed rule set, byte for byte.
    expect(await composedHash(userId, walletId)).toBe(hashBefore);
    // No grant was created and none was revoked or touched.
    expect(await grantRows(userId)).toEqual(grantsBefore);
  });

  it("behaves identically for the same address added again by the paste path", async () => {
    const { userId, walletId } = await provision();
    const policy = service();
    await provisionRevokedGrant(userId, walletId);

    const first = await policy.create(userId, {
      name: "Mamá",
      address: ADDRESS_B,
      description: "",
    });
    const hashBefore = await composedHash(userId, walletId);
    const grantsBefore = await grantRows(userId);
    expect(grantsBefore).toHaveLength(1);

    // The SAME body shape the screen's paste path posts. Slice 2 has one create
    // arm, so this is the paste path and the alias arm enters the same code: the
    // disclosure cannot be stricter on one of them.
    const again = await policy.create(userId, {
      name: "Mamá (banco)",
      address: ADDRESS_B,
      description: "pegada igual",
    });

    expect(again.duplicateOf).toEqual({
      contactId: first.contact.id,
      name: "Mamá",
    });
    expect(again.contact.address).toBe(ADDRESS_B);
    expect(await composedHash(userId, walletId)).toBe(hashBefore);
    expect(await grantRows(userId)).toEqual(grantsBefore);
  });

  it("does not disclose an address held only by an INACTIVE contact", async () => {
    const { userId, walletId } = await provision();
    const policy = service();

    const archived = await policy.create(userId, {
      name: "Vieja",
      address: ADDRESS_C,
      description: "",
    });
    // Archived directly: the removal path has its own suite, and what matters here
    // is only that the row is no longer active.
    await database.query(
      `UPDATE recipients SET status = 'inactive' WHERE user_id = $1 AND id = $2`,
      [userId, archived.contact.id],
    );
    const hashBefore = await composedHash(userId, walletId);

    const recreated = await policy.create(userId, {
      name: "Nueva",
      address: ADDRESS_C,
      description: "",
    });

    // An archived contact grants nothing and composes no rule, so reporting it as
    // the duplicate would state a fact about authority that is not true.
    expect(recreated.duplicateOf).toBeNull();
    expect(recreated.contact.address).toBe(ADDRESS_C);
    expect(await composedHash(userId, walletId)).toBe(hashBefore);

    // The positive control on the SAME user and the SAME address: now that a live
    // contact holds it, the very next add discloses it by name. So the `null`
    // above is the inactive row being excluded, not the disclosure being dead.
    const again = await policy.create(userId, {
      name: "Nueva (dos)",
      address: ADDRESS_C,
      description: "",
    });
    expect(again.duplicateOf).toEqual({
      contactId: recreated.contact.id,
      name: "Nueva",
    });
  });
});
