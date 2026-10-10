/**
 * Task 2.8 — the signed apply path against the real database
 * (design §3.5 steps 4-10, §1.5 compare-and-set, §5.3, §5.4).
 *
 * WHY THIS SUITE DRIVES REAL TABLES
 * ---------------------------------
 * Three guarantees of this unit exist only in the database:
 *
 *   1. **The §1.5 compare-and-set.** "A stale writer cannot overwrite a newer
 *      applied revision" IS the SQL predicate, so a repository double would prove
 *      nothing.
 *   2. **§5.4 bookkeeping is atomic with the CAS.** `signer_grants.policy_hash`
 *      and `allowlisted_recipients` must move in the SAME transaction as the
 *      applied revision, or the two representations of one intent disagree.
 *   3. **No transaction is open across the provider I/O.** The provider is
 *      driven through a counting database client, and the transport records the
 *      open-transaction count at the moment of the PATCH, so an edit that wraps
 *      the provider call in a transaction FAILS BY NAME instead of by review.
 *
 * The apply capability is the fake-transport adapter (this environment has no
 * signer sidecar, so the live path stays `unavailable`/pending and that live
 * step is recorded as pending in the progress artifact).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabaseClient, type DatabaseClient, type Queryable } from "../../src/db/client.js";
import { RecipientPolicyRepository } from "../../src/wallet/policy/repository.js";
import {
  RecipientPolicyService,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import { createSignedPolicyApplyPort } from "../../src/wallet/policy/apply.js";
import {
  allowRule,
  createFakeApplyTransport,
  createTestAuthorizationSigner,
  policyWallet,
} from "../unit/helpers/policy-apply-fakes.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POLICY_ID = "pol_apply_integration";
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
const RECIPIENT_COLUMNS = "id, name, description, address, network, version";

suite("recipient policy signed apply (task 2.8)", () => {
  let database: DatabaseClient;
  let repository: RecipientPolicyRepository;
  const provisionedUserIds: string[] = [];
  /** Open `withUserTransaction` frames, so provider I/O can be checked against 0. */
  let openTransactions = 0;

  /**
   * The counting client. `database` is the real pool; this wrapper is what the
   * service receives, so "no transaction is open across steps 4-9" is measured
   * instead of assumed.
   */
  const counting: DatabaseClient = {
    query: (...args: Parameters<DatabaseClient["query"]>) => database.query(...args),
    async withUserTransaction(
      userId: string,
      operation: Parameters<DatabaseClient["withUserTransaction"]>[1],
    ) {
      openTransactions += 1;
      try {
        return await database.withUserTransaction(userId, operation);
      } finally {
        openTransactions -= 1;
      }
    },
    async withSystemTransaction(
      operation: Parameters<DatabaseClient["withSystemTransaction"]>[0],
    ) {
      openTransactions += 1;
      try {
        return await database.withSystemTransaction(operation);
      } finally {
        openTransactions -= 1;
      }
    },
    close: () => database.close(),
  } as unknown as DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    repository = new RecipientPolicyRepository(database);
  });

  afterAll(async () => {
    for (const userId of provisionedUserIds) {
      await database.query("DELETE FROM recipient_policy_sync_intent WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM recipient_policy_state WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM contact_action_proposals WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM signer_grants WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM delegated_grants WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM recipients WHERE user_id = $1", [userId]);
    }
    await database.close();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** user + `ready` wallet WITH the verified provider signer binding. */
  async function provision(): Promise<{
    userId: string;
    walletId: string;
    providerWalletId: string;
    providerSignerId: string;
  }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:rpa-${randomUUID()}`, "RPA Apply Test"],
    );
    const userId = user.rows[0]!.id;
    // Per-wallet provider identities: `user_wallets.provider_wallet_id` is UNIQUE,
    // so a shared fixture would make the second case fail for a reason that has
    // nothing to do with what it asserts.
    const providerWalletId = `privy-wallet-apply-${randomUUID()}`;
    const providerSignerId = `privy-signer-apply-${randomUUID()}`;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, provider_signer_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, $3, 'solana', $4, 'ready') RETURNING id`,
      [userId, providerWalletId, providerSignerId, `${randomUUID()}.sol`],
    );
    provisionedUserIds.push(userId);
    return {
      userId,
      walletId: wallet.rows[0]!.id,
      providerWalletId,
      providerSignerId,
    };
  }

  /** The enrollment consent: the baseline the composer composes from. */
  async function provisionSignerGrant(
    userId: string,
    walletId: string,
    allowlisted: string[],
  ): Promise<void> {
    await database.query(
      `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
          allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
          rolling_window_seconds, gas_ceiling, state, signer_enrollment_snapshot)
       VALUES ($1, $2, 'policy-x', 'signer-x', 'hash-x', $3::jsonb,
               '10000000', '10000000', 3600, '1000000', 'active', '{}'::jsonb)`,
      [userId, walletId, JSON.stringify(allowlisted)],
    );
  }

  const contacts: RecipientContactMutationPort = {
    async create(userId, input, client): Promise<RecipientContactRecord> {
      const result = await client.query(
        `INSERT INTO recipients
           (user_id, name, normalized_name, description, address, network,
            embedding, embedding_model_revision, provenance, address_confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::vector, 'test', '{}'::jsonb, now())
         RETURNING ${RECIPIENT_COLUMNS}`,
        [
          userId,
          input.name,
          input.name.trim().toLowerCase(),
          input.description,
          input.address,
          input.network,
          ZERO_EMBEDDING,
        ],
      );
      return mapContact(result.rows[0]!);
    },
    async update(userId, contactId, input, client): Promise<RecipientContactRecord> {
      const result = await client.query(
        `UPDATE recipients
            SET name = COALESCE($4, name),
                description = COALESCE($5, description),
                address = COALESCE($6, address),
                network = $7,
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
          input.network ?? null,
        ],
      );
      const row = result.rows[0];
      if (!row) throw new Error("contact version conflict");
      return mapContact(row);
    },
    async archive(userId, contactId, expectedVersion, client) {
      const result = await client.query(
        `UPDATE recipients SET status = 'inactive', updated_at = now()
          WHERE user_id = $1 AND id = $2 AND version = $3 RETURNING ${RECIPIENT_COLUMNS}`,
        [userId, contactId, expectedVersion],
      );
      const row = result.rows[0];
      if (!row) throw new Error("contact version conflict");
      return mapContact(row);
    },
    async readActive(userId, contactId, client) {
      const run = async (query: Queryable) => {
        const result = await query.query(
          `SELECT ${RECIPIENT_COLUMNS} FROM recipients
            WHERE user_id = $1 AND id = $2 AND status = 'active'`,
          [userId, contactId],
        );
        return result.rows[0] ? mapContact(result.rows[0]) : null;
      };
      return client ? run(client) : database.withUserTransaction(userId, run);
    },
  };

  type HarnessOptions = {
    /** The wallet's owner-verified provider identities (from `provision`). */
    providerWalletId: string;
    providerSignerId: string;
    /** The signer carries this policy; `null` means the signer has none yet. */
    attachedPolicyId?: string | null;
    policyRules?: Record<string, readonly ReturnType<typeof allowRule>[]>;
    listingError?: Error;
    mutationError?: Error;
    onPatch?: () => Promise<void>;
  };

  function harness(options: HarnessOptions) {
    const signer = createTestAuthorizationSigner();
    const attached =
      options.attachedPolicyId === undefined ? POLICY_ID : options.attachedPolicyId;
    const { transport, calls } = createFakeApplyTransport({
      publicKey: signer.publicKey,
      ownerWallets: [
        policyWallet({
          walletId: options.providerWalletId,
          signers: [
            {
              signerId: options.providerSignerId,
              overridePolicyIds: attached ? [attached] : [],
            },
          ],
        }),
      ],
      policyRules: options.policyRules ?? {},
      listingError: options.listingError,
      mutationError: options.mutationError,
      onPatch: options.onPatch,
    });
    const service = new RecipientPolicyService({
      database: counting,
      repository,
      contacts,
      listActiveGrants: async () => [],
      provider: createSignedPolicyApplyPort({
        transport,
        signAuthorization: (payload) => signer.sign(payload),
        now: () => new Date("2026-10-10T12:00:00.000Z"),
      }),
    } as RecipientPolicyServiceDependencies);
    return { service, calls, signer };
  }

  async function readState(userId: string, walletId: string) {
    return repository.readPolicyState(userId, walletId);
  }

  async function audits(userId: string): Promise<string[]> {
    const rows = await database.query<{ event: string }>(
      "SELECT event FROM recipient_policy_audit WHERE user_id = $1 ORDER BY created_at",
      [userId],
    );
    return rows.rows.map((row) => row.event);
  }

  async function intents(userId: string) {
    const rows = await database.query<{ state: string; desired_revision: string }>(
      "SELECT state, desired_revision FROM recipient_policy_sync_intent WHERE user_id = $1",
      [userId],
    );
    return rows.rows;
  }

  // -------------------------------------------------------------------------

  it("commits the verified revision, refreshes the grant projection, and holds NO transaction across the PATCH", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    const observedOpenTransactions: number[] = [];
    const { service, calls } = harness({
      providerWalletId,
      providerSignerId,
      onPatch: async () => {
        // The whole point of the assertion: at the moment the provider is asked to
        // write, the service holds no open transaction.
        observedOpenTransactions.push(openTransactions);
      },
    });

    const created = await service.create(userId, {
      name: "Mamá",
      description: "mensualidad",
      address: ADDRESS_A,
    });

    expect(created.policyRevision).toBe(1);
    expect(calls.patchPolicy).toHaveLength(1);
    expect(observedOpenTransactions).toEqual([0]);

    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      status: "applied",
      desiredRevision: 1,
      appliedRevision: 1,
      appliedPolicyId: POLICY_ID,
      appliedSignerId: providerSignerId,
      appliedSignerIds: [providerSignerId],
      appliedRecipients: [ADDRESS_A],
      statusReason: null,
    });
    expect(state!.verifiedAt).not.toBeNull();
    expect(state!.appliedRulesHash).toMatch(/^sha256:/u);

    // §5.4: the two representations of one intent agree, in the same transaction.
    const grant = await database.query<{
      policy_hash: string;
      allowlisted_recipients: string[];
    }>(
      "SELECT policy_hash, allowlisted_recipients FROM signer_grants WHERE user_id = $1 AND state = 'active'",
      [userId],
    );
    expect(grant.rows[0]!.policy_hash).toBe(state!.appliedRulesHash);
    expect(grant.rows[0]!.allowlisted_recipients).toEqual([ADDRESS_A]);

    expect(await audits(userId)).toContain("applied");
    expect(await intents(userId)).toEqual([{ state: "pending", desired_revision: "1" }]);
  });

  it("records a stale writer's CAS as superseded and never lowers applied_revision", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    // Another mutation lands WHILE the holder is applying: the desired revision
    // moves from the composed 1 to 2, so the CAS predicate (`desired_revision = 1`)
    // matches nothing.
    const { service, calls } = harness({
      providerWalletId,
      providerSignerId,
      onPatch: async () => {
        await database.query(
          `UPDATE recipient_policy_state
              SET desired_revision = desired_revision + 1,
                  desired_rules_hash = 'sha256:newer'
            WHERE user_id = $1`,
          [userId],
        );
      },
    });

    await service.create(userId, {
      name: "Mamá",
      description: "mensualidad",
      address: ADDRESS_A,
    });

    // Positive control: the PATCH really happened, so the CAS is what refused.
    expect(calls.patchPolicy).toHaveLength(1);

    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      desiredRevision: 2,
      // The stale writer wrote NO applied revision at all.
      appliedRevision: 0,
      appliedPolicyId: null,
      status: "pending",
    });
    expect(await audits(userId)).toContain("superseded");
    // ...and it did NOT claim an apply, nor refresh the grant projection.
    expect(await audits(userId)).not.toContain("applied");
    const grant = await database.query<{ policy_hash: string }>(
      "SELECT policy_hash FROM signer_grants WHERE user_id = $1",
      [userId],
    );
    expect(grant.rows[0]!.policy_hash).toBe("hash-x");
  });

  it("records an unreachable signer as retryable and changes NO binding", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    const { service, calls } = harness({
      providerWalletId,
      providerSignerId,
      attachedPolicyId: null,
      listingError: Object.assign(new Error("listing timed out"), { name: "AbortError" }),
    });

    await service.create(userId, {
      name: "Mamá",
      description: "mensualidad",
      address: ADDRESS_A,
    });

    // Nothing was sent, so no binding may have changed.
    expect(calls.createPolicy).toEqual([]);
    expect(calls.patchPolicy).toEqual([]);
    expect(calls.attachPolicyToSigner).toEqual([]);

    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      status: "pending",
      statusReason: "owner_listing_unavailable",
      appliedRevision: 0,
      appliedPolicyId: null,
      desiredRevision: 1,
    });
    expect(await audits(userId)).toContain("apply_failed");
  });

  it("records a proven divergence as blocked_conflict with no applied write", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    const { service, calls } = harness({
      providerWalletId,
      providerSignerId,
      // An unexplained remote rule the composer never produced: §5.1 (c).
      policyRules: {
        [POLICY_ID]: [
          allowRule("remote-rule-nobody-composed", ["Test1DriftAddressxxxxxxxxxxxxxxxxxxxxxx"]),
        ],
      },
    });

    await service.create(userId, {
      name: "Mamá",
      description: "mensualidad",
      address: ADDRESS_A,
    });

    // The pristine comparison refused BEFORE any write.
    expect(calls.patchPolicy).toEqual([]);

    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      status: "blocked_conflict",
      statusReason: "unrecognized_rule",
      appliedRevision: 0,
      appliedPolicyId: null,
    });
    expect(await audits(userId)).toContain("blocked_conflict");
  });
});

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
