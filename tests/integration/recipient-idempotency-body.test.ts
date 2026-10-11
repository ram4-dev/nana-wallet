/**
 * Task 3.1 — the Idempotency-Key is bound to the body that produced it
 * (design §6.1–§6.3, §15 D-A, correction C8).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The replay lookup is `(wallet_id, user_id, idempotency_key)` and the only
 * other hash on the row, `composed_hash`, is the composed-POLICY hash, so the
 * body was never bound. On the paste path that is invisible (the body IS the
 * address); on the alias path a client that asked for `maria.sns` would receive
 * a `201` describing the contact created for `juan.sns`.
 *
 * The three properties this file has to prove are properties of the STORED ROW,
 * so they are driven against the real database: the hash is persisted on the
 * intent the key produced, a mismatched replay is refused WITHOUT applying
 * anything, and a `NULL` hash falls back to the stored-result behaviour.
 *
 * The contact-mutation port is injected (the production adapter needs the
 * embedding provider), so the SQL adapter below is the documented port contract
 * over real RLS and real constraints.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
} from "../../src/db/client.js";
import { RecipientPolicyRepository } from "../../src/wallet/policy/repository.js";
import {
  RecipientContactVersionConflictError,
  RecipientPolicySeamError,
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
} from "../../src/wallet/policy/service.js";
import { createPrivyPolicyAdminClient } from "../../src/wallet/grants/privy-policy-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APPLY_REASON = "no signed apply capability in slice 1";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_C = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
const WALLET_ADDRESS = "So11111111111111111111111111111111111111112";
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
const RECIPIENT_COLUMNS = "id, name, description, address, network, version";
/** The typed conflict design §6.2 names for a mismatched replay. */
const MISMATCH_CODE = "IDEMPOTENCIA_CUERPO_DISTINTO";

suite("recipient idempotency body binding (task 3.1)", () => {
  let database: DatabaseClient;
  let repository: RecipientPolicyRepository;
  let grants: ReturnType<typeof createPrivyPolicyAdminClient>;
  const provisionedUserIds: string[] = [];

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new RecipientPolicyRepository(database);
    grants = createPrivyPolicyAdminClient({
      database,
      server: null as never,
      admin: null as never,
    });
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
      await database.query(`DELETE FROM recipients WHERE user_id = $1`, [userId]);
    }
    await database.close();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  async function provision(): Promise<{ userId: string; walletId: string }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:ridem-${randomUUID()}`, "Idempotency Body Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, WALLET_ADDRESS],
    );
    provisionedUserIds.push(userId);
    await database.query(
      `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
          allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
          rolling_window_seconds, gas_ceiling, state, signer_enrollment_snapshot)
       VALUES ($1, $2, 'policy-x', 'signer-x', 'hash-x', $3::jsonb,
               '10000000', '10000000', 3600, '1000000', 'active', '{}'::jsonb)`,
      [userId, wallet.rows[0]!.id, JSON.stringify([WALLET_ADDRESS])],
    );
    return { userId, walletId: wallet.rows[0]!.id };
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
                description = COALESCE($5, description),
                address = COALESCE($6, address),
                version = version + 1,
                updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
          RETURNING ${RECIPIENT_COLUMNS}`,
        [
          userId,
          contactId,
          input.expectedVersion,
          input.name ?? null,
          input.description ?? null,
          input.address ?? null,
        ],
      );
      if (result.rowCount === 0) throw new RecipientContactVersionConflictError();
      return mapContact(result.rows[0]!);
    },

    async archive(userId, contactId, expectedVersion, client) {
      const result = await client.query<ContactRow>(
        `UPDATE recipients SET status = 'inactive', updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 AND status = 'active'
          RETURNING ${RECIPIENT_COLUMNS}`,
        [userId, contactId, expectedVersion],
      );
      if (result.rowCount === 0) throw new RecipientContactVersionConflictError();
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

  function harness(): RecipientPolicyService {
    return new RecipientPolicyService({
      database,
      repository,
      contacts,
      listActiveGrants: grants.listActiveGrants.bind(grants),
      provider: createUnavailablePolicyApplyPort(APPLY_REASON),
    });
  }

  // -------------------------------------------------------------------------
  // Observations
  // -------------------------------------------------------------------------

  /** The `request_hash` the key's intent row carries, or `undefined` if absent. */
  async function readIntentHash(
    userId: string,
    key: string,
  ): Promise<string | null> {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{ request_hash: string | null }>(
        `SELECT request_hash FROM recipient_policy_sync_intent
          WHERE user_id = $1 AND idempotency_key = $2
          ORDER BY desired_revision DESC LIMIT 1`,
        [userId, key],
      ),
    );
    return result.rows[0]?.request_hash ?? null;
  }

  /** The stored intent row-count, the contact count and the audit count. */
  async function counts(userId: string, key: string) {
    const scalars = await database.withUserTransaction(userId, async (client) => {
      const intents = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM recipient_policy_sync_intent
          WHERE user_id = $1 AND idempotency_key = $2`,
        [userId, key],
      );
      const revisions = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM recipient_policy_sync_intent
          WHERE user_id = $1`,
        [userId],
      );
      const audit = await client.query<{ n: string }>(
        `SELECT COUNT(*)::text AS n FROM recipient_policy_audit a
           JOIN recipient_policy_sync_intent i
             ON i.wallet_id = a.wallet_id
            AND i.desired_revision = a.desired_revision
          WHERE i.user_id = $1 AND i.idempotency_key = $2
            AND a.event = 'intent_recorded' AND a.created_at >= i.created_at`,
        [userId, key],
      );
      return { intents, revisions, audit };
    });
    const recipients = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM recipients WHERE user_id = $1`,
      [userId],
    );
    const recipientsAtA = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM recipients
        WHERE user_id = $1 AND address = $2`,
      [userId, ADDRESS_A],
    );
    const recipientsAtC = await database.query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM recipients
        WHERE user_id = $1 AND address = $2`,
      [userId, ADDRESS_C],
    );
    return {
      intentsWithKey: Number(scalars.intents.rows[0]!.n),
      revisions: Number(scalars.revisions.rows[0]!.n),
      auditsForRevision: Number(scalars.audit.rows[0]!.n),
      contacts: Number(recipients.rows[0]!.n),
      contactsAtA: Number(recipientsAtA.rows[0]!.n),
      contactsAtC: Number(recipientsAtC.rows[0]!.n),
    };
  }

  /**
   * Resolve the typed code the mutation refused with. A miss throws, so a case
   * expecting a refusal cannot pass because the call quietly succeeded.
   */
  async function refusalCode(run: Promise<unknown>): Promise<string> {
    try {
      await run;
    } catch (error) {
      if (error instanceof RecipientPolicySeamError) return error.code;
      throw error;
    }
    throw new Error("expected a typed refusal, but the mutation completed");
  }

  // -------------------------------------------------------------------------
  // The stored hash (positive control for the NULL fallback below)
  // -------------------------------------------------------------------------

  it("persists the request hash on the intent the key produced", async () => {
    const { userId } = await provision();
    const service = harness();
    const key = `hash-${randomUUID()}`;

    await service.create(
      userId,
      { name: "Uno", description: "", address: ADDRESS_A },
      { idempotencyKey: key },
    );

    const hash = await readIntentHash(userId, key);
    // A NULL here would make the fallback case below a false green: the whole
    // guard is only reachable because a row written by this path HAS a hash.
    expect(typeof hash).toBe("string");
    expect(hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  // -------------------------------------------------------------------------
  // The tolerant direction: same body replays as today
  // -------------------------------------------------------------------------

  it("replays the same key with the same body: one contact, one intent, one audit row", async () => {
    const { userId } = await provision();
    const service = harness();
    const key = `same-${randomUUID()}`;
    const body = { name: "Mamá", description: "mensualidad", address: ADDRESS_A };

    const first = await service.create(userId, body, { idempotencyKey: key });
    const second = await service.create(userId, body, { idempotencyKey: key });

    expect(second.contact.id).toBe(first.contact.id);
    expect(second.contact.address).toBe(ADDRESS_A);
    expect(second.permission).toEqual(first.permission);
    expect(await counts(userId, key)).toEqual({
      intentsWithKey: 1,
      revisions: 1,
      auditsForRevision: 1,
      contacts: 1,
      contactsAtA: 1,
      contactsAtC: 0,
    });
  });

  // -------------------------------------------------------------------------
  // The strict direction: a different body is refused, not answered
  // -------------------------------------------------------------------------

  it("refuses a replay of the same key with a different destination address", async () => {
    const { userId } = await provision();
    const service = harness();
    const key = `moved-${randomUUID()}`;

    const first = await service.create(
      userId,
      { name: "Mamá", description: "", address: ADDRESS_A },
      { idempotencyKey: key },
    );
    expect(first.contact.address).toBe(ADDRESS_A);

    const code = await refusalCode(
      service.create(
        userId,
        { name: "Mamá", description: "", address: ADDRESS_C },
        { idempotencyKey: key },
      ),
    );
    expect(code).toBe(MISMATCH_CODE);

    // Nothing was applied: the second request's address is nowhere, and the
    // first request's revision is still the only one this key produced.
    const after = await counts(userId, key);
    expect(after.contactsAtC).toBe(0);
    expect(after.contactsAtA).toBe(1);
    expect(after).toEqual({
      intentsWithKey: 1,
      revisions: 1,
      auditsForRevision: 1,
      contacts: 1,
      contactsAtA: 1,
      contactsAtC: 0,
    });
  });

  it("refuses a replay of the same key with a different description", async () => {
    const { userId } = await provision();
    const service = harness();
    const key = `label-${randomUUID()}`;

    await service.create(
      userId,
      { name: "Mamá", description: "mensualidad", address: ADDRESS_A },
      { idempotencyKey: key },
    );

    const code = await refusalCode(
      service.create(
        userId,
        { name: "Mamá", description: "otra cosa", address: ADDRESS_A },
        { idempotencyKey: key },
      ),
    );
    expect(code).toBe(MISMATCH_CODE);
    expect(await counts(userId, key)).toEqual({
      intentsWithKey: 1,
      revisions: 1,
      auditsForRevision: 1,
      contacts: 1,
      contactsAtA: 1,
      contactsAtC: 0,
    });
  });

  // -------------------------------------------------------------------------
  // The additive direction: a row without a hash keeps today's behaviour
  // -------------------------------------------------------------------------

  it("falls back to the stored result when the intent row predates the column", async () => {
    const { userId } = await provision();
    const service = harness();
    const key = `legacy-${randomUUID()}`;

    const first = await service.create(
      userId,
      { name: "Mamá", description: "", address: ADDRESS_A },
      { idempotencyKey: key },
    );
    // The pre-`017` row: written before anything computed a body hash, so the
    // stored value is NULL and the pair is NOT comparable.
    await database.query(
      `UPDATE recipient_policy_sync_intent SET request_hash = NULL
        WHERE user_id = $1 AND idempotency_key = $2`,
      [userId, key],
    );
    expect(await readIntentHash(userId, key)).toBeNull();

    const second = await service.create(
      userId,
      { name: "Mamá", description: "", address: ADDRESS_C },
      { idempotencyKey: key },
    );

    // Today's behaviour, unchanged: the stored result is returned and nothing
    // new is written — a pre-existing row is never turned into a conflict.
    expect(second.contact.id).toBe(first.contact.id);
    expect(second.contact.address).toBe(ADDRESS_A);
    expect(await counts(userId, key)).toEqual({
      intentsWithKey: 1,
      revisions: 1,
      auditsForRevision: 1,
      contacts: 1,
      contactsAtA: 1,
      contactsAtC: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

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
