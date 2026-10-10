/**
 * Task 2.12 — the atomic binding-invalidation fallback (design §4.3, §4.4).
 *
 * WHY THIS SUITE DRIVES REAL TABLES
 * ---------------------------------
 * The distinction this unit exists to make is "an UNKNOWN outcome never touches a
 * binding; a PROVEN divergence clears them atomically". Both halves are database
 * facts:
 *
 *   1. **Atomicity.** The status change, the hash nulls and the grant clearing
 *      must be one transaction, or a crash between them leaves a wallet whose
 *      status says "blocked" while a sibling grant is still executable. The
 *      injected-failure case proves the rollback is the database's.
 *   2. **Non-destruction on the unknown arm.** A timeout is not a mismatch: the
 *      binding, both hashes and the grant row must be byte-for-byte unchanged, and
 *      the only way to prove "unchanged" is to observe the rows.
 *   3. **Re-binding only through a verified apply (§4.4).** Clearing is one half;
 *      the other half is that the binding comes back only from a verified
 *      readback. A repository double would make both halves assertions about the
 *      double.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
} from "../../src/db/client.js";
import {
  RecipientPolicyRepository,
  type PolicyStateRecord,
} from "../../src/wallet/policy/repository.js";
import {
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import {
  PolicyApplyTransportError,
  createSignedPolicyApplyPort,
} from "../../src/wallet/policy/apply.js";
import { RECIPIENT_POLICY_WRITER_FROZEN_REASON } from "../../src/config/recipient-policy.js";
import {
  allowRule,
  createFakeApplyTransport,
  createTestAuthorizationSigner,
  policyWallet,
} from "../unit/helpers/policy-apply-fakes.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const POLICY_ID = "pol_invalidation_integration";
const PREVIOUS_HASH = "sha256:previous-applied-rules";
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
const RECIPIENT_COLUMNS = "id, name, description, address, network, version";

suite("recipient policy binding invalidation (task 2.12)", () => {
  let database: DatabaseClient;
  let repository: RecipientPolicyRepository;
  const provisionedUserIds: string[] = [];

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    repository = new RecipientPolicyRepository(database);
  });

  afterAll(async () => {
    for (const userId of provisionedUserIds) {
      await database.query(
        "DELETE FROM recipient_policy_leases WHERE wallet_id IN (SELECT id FROM user_wallets WHERE user_id = $1)",
        [userId],
      );
      await database.query(
        "DELETE FROM recipient_policy_sync_intent WHERE user_id = $1",
        [userId],
      );
      await database.query(
        "DELETE FROM recipient_policy_state WHERE user_id = $1",
        [userId],
      );
      await database.query("DELETE FROM signer_grants WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM delegated_grants WHERE user_id = $1", [userId]);
      await database.query("DELETE FROM recipients WHERE user_id = $1", [userId]);
    }
    await database.close();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

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
      [`did:privy:rpi-${randomUUID()}`, "RPI Invalidation Test"],
    );
    const userId = user.rows[0]!.id;
    const providerWalletId = `privy-wallet-invalidate-${randomUUID()}`;
    const providerSignerId = `privy-signer-invalidate-${randomUUID()}`;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, provider_signer_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, $3, 'solana', $4, 'ready') RETURNING id`,
      [userId, providerWalletId, providerSignerId, `${randomUUID()}.sol`],
    );
    provisionedUserIds.push(userId);
    return { userId, walletId: wallet.rows[0]!.id, providerWalletId, providerSignerId };
  }

  /** The enrollment consent the composer composes the ordinary rule from. */
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

  /** An ACTIVE delegated grant, bound (or not) to a provider policy id. */
  async function provisionGrant(
    userId: string,
    walletId: string,
    providerPolicyId: string | null,
    recipients: string[],
  ): Promise<string> {
    const result = await database.query<{ id: string }>(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, provider_policy_id, expires_at)
       VALUES ($1, $2, 'solana', '5000000', '20000000', 3600, $3::jsonb,
               'active', $4, now() + interval '30 days')
       RETURNING id`,
      [userId, walletId, JSON.stringify(recipients), providerPolicyId],
    );
    return result.rows[0]!.id;
  }

  /**
   * A wallet whose last apply WAS verified: `status='applied'`, both hashes
   * present, and a bound grant. This is the positive control every negative
   * assertion in this suite is measured against — without it, "the binding was
   * cleared" and "the binding was never there" are indistinguishable.
   */
  async function seedVerifiedState(
    userId: string,
    walletId: string,
    providerSignerId: string,
    appliedRevision = 1,
  ): Promise<void> {
    await database.query(
      `INSERT INTO recipient_policy_state
         (user_id, wallet_id, status, status_detail,
          desired_revision, applied_revision, desired_rules_hash, applied_rules_hash,
          applied_policy_id, applied_signer_id, applied_signer_ids, applied_recipients,
          verified_at)
       VALUES ($1, $2, 'applied', '{}'::jsonb, $3, $3, $4, $4, $5, $6, $7::jsonb,
               '[]'::jsonb, now())`,
      [
        userId,
        walletId,
        appliedRevision,
        PREVIOUS_HASH,
        POLICY_ID,
        providerSignerId,
        JSON.stringify([providerSignerId]),
      ],
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
    providerWalletId: string;
    providerSignerId: string;
    attachedPolicyId?: string | null;
    policyRules?: Record<string, readonly ReturnType<typeof allowRule>[]>;
    mutationError?: Error;
    /** Replace the repository (used to inject a failure inside the transaction). */
    repository?: RecipientPolicyRepository;
    /** Drive the `unavailable` arm: a frozen writer has no mutation method. */
    frozen?: boolean;
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
      mutationError: options.mutationError,
    });
    const provider = options.frozen
      ? createUnavailablePolicyApplyPort(RECIPIENT_POLICY_WRITER_FROZEN_REASON)
      : createSignedPolicyApplyPort({
          transport,
          signAuthorization: (payload) => signer.sign(payload),
          now: () => new Date("2026-10-10T12:00:00.000Z"),
        });
    const service = new RecipientPolicyService({
      database,
      repository: options.repository ?? repository,
      contacts,
      listActiveGrants: async () => [],
      provider,
    } as RecipientPolicyServiceDependencies);
    return { service, calls };
  }

  async function readState(
    userId: string,
    walletId: string,
  ): Promise<PolicyStateRecord | null> {
    return repository.readPolicyState(userId, walletId);
  }

  async function readBinding(grantId: string): Promise<string | null> {
    const rows = await database.query<{ provider_policy_id: string | null }>(
      "SELECT provider_policy_id FROM delegated_grants WHERE id = $1",
      [grantId],
    );
    return rows.rows[0]!.provider_policy_id;
  }

  async function audits(
    userId: string,
  ): Promise<Array<{ event: string; detail: Record<string, unknown> | null }>> {
    const rows = await database.query<{
      event: string;
      detail: Record<string, unknown> | null;
    }>(
      "SELECT event, detail FROM recipient_policy_audit WHERE user_id = $1 ORDER BY created_at, id",
      [userId],
    );
    return rows.rows;
  }

  /** Every `delegated_grants` row of the wallet, for the "no row moved" check. */
  async function grantRows(
    walletId: string,
  ): Promise<Array<{ id: string; provider_policy_id: string | null }>> {
    const rows = await database.query<{
      id: string;
      provider_policy_id: string | null;
    }>(
      "SELECT id, provider_policy_id FROM delegated_grants WHERE wallet_id = $1 ORDER BY id",
      [walletId],
    );
    return rows.rows;
  }

  const createInput = {
    name: "Mamá",
    description: "mensualidad",
    address: ADDRESS_A,
  };

  // -------------------------------------------------------------------------
  // Proven divergence: the bindings go, atomically with the status change
  // -------------------------------------------------------------------------

  it("clears the bindings and nulls BOTH hashes atomically with the blocked status", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await seedVerifiedState(userId, walletId, providerSignerId, 1);
    const boundGrant = await provisionGrant(userId, walletId, POLICY_ID, [ADDRESS_A]);
    const untouchedGrant = await provisionGrant(userId, walletId, null, ["OtherAddress"]);

    // Positive control: the binding this case claims to destroy exists first.
    expect(await readBinding(boundGrant)).toBe(POLICY_ID);
    expect(await readState(userId, walletId)).toMatchObject({
      status: "applied",
      appliedRulesHash: PREVIOUS_HASH,
      desiredRulesHash: PREVIOUS_HASH,
    });

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

    await service.create(userId, createInput);

    // No PATCH on this branch, so the stop is about the readback, not a write.
    expect(calls.patchPolicy).toEqual([]);

    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      status: "blocked_conflict",
      statusReason: "unrecognized_rule",
      // The applied revision is NOT lowered by an invalidation.
      appliedRevision: 1,
      appliedPolicyId: POLICY_ID,
      // Both hashes are gone: the recorded rule set is no longer authoritative.
      appliedRulesHash: null,
      desiredRulesHash: null,
    });

    expect(await readBinding(boundGrant)).toBeNull();
    // A grant that was never bound is not "cleared" — it simply never moved.
    expect(await readBinding(untouchedGrant)).toBeNull();

    const events = await audits(userId);
    expect(events.map((row) => row.event)).toContain("blocked_conflict");
    const invalidations = events.filter((row) => row.event === "binding_invalidated");
    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]!.detail).toMatchObject({ grantId: boundGrant });
  });

  it("rolls the status, the hashes and the grant binding back together when the transaction fails", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await seedVerifiedState(userId, walletId, providerSignerId, 1);
    const boundGrant = await provisionGrant(userId, walletId, POLICY_ID, [ADDRESS_A]);

    // A failure AFTER the invalidation writes, still inside the transaction: the
    // database must undo the status, both hash nulls and the grant clearing.
    const exploding = new Proxy(repository, {
      get(target, property) {
        if (property === "invalidateWalletBindings") {
          return async (
            ...args: Parameters<RecipientPolicyRepository["invalidateWalletBindings"]>
          ): Promise<never> => {
            await target.invalidateWalletBindings(...args);
            throw new Error("injected failure after the invalidation writes");
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const { service } = harness({
      providerWalletId,
      providerSignerId,
      repository: exploding,
      policyRules: {
        [POLICY_ID]: [
          allowRule("remote-rule-nobody-composed", ["Test1DriftAddressxxxxxxxxxxxxxxxxxxxxxx"]),
        ],
      },
    });

    await expect(service.create(userId, createInput)).rejects.toThrow(
      "injected failure after the invalidation writes",
    );

    const state = await readState(userId, walletId);
    // Nothing from the failed transaction survives: no blocked status, no nulled
    // hash, no invalidation audit.
    expect(state!.status).not.toBe("blocked_conflict");
    expect(state!.appliedRulesHash).toBe(PREVIOUS_HASH);
    expect(state!.desiredRulesHash).not.toBeNull();
    expect(state!.appliedRevision).toBe(1);
    expect(await readBinding(boundGrant)).toBe(POLICY_ID);
    expect((await audits(userId)).map((row) => row.event)).not.toContain(
      "binding_invalidated",
    );
  });

  // -------------------------------------------------------------------------
  // Unknown outcome: nothing moves
  // -------------------------------------------------------------------------

  it("changes no binding, no hash and no grant row on a timeout", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await seedVerifiedState(userId, walletId, providerSignerId, 1);
    const boundGrant = await provisionGrant(userId, walletId, POLICY_ID, [ADDRESS_A]);
    const before = await grantRows(walletId);

    const { service, calls } = harness({
      providerWalletId,
      providerSignerId,
      // The pristine readback converges, so a PATCH IS attempted and times out:
      // the write may or may not have landed, which is the definition of unknown.
      policyRules: {},
      mutationError: timeoutError(),
    });

    await service.create(userId, createInput);

    // Positive control: the PATCH really was attempted, so "nothing changed"
    // is not "nothing happened".
    expect(calls.patchPolicy).toHaveLength(1);

    const state = await readState(userId, walletId);
    expect(state!.status).toBe("pending");
    expect(state!.statusReason).toBe("patch_unverified");
    expect(state!.appliedRulesHash).toBe(PREVIOUS_HASH);
    expect(state!.desiredRulesHash).not.toBeNull();
    expect(state!.appliedRevision).toBe(1);
    expect(await readBinding(boundGrant)).toBe(POLICY_ID);
    expect(await grantRows(walletId)).toEqual(before);
    expect((await audits(userId)).map((row) => row.event)).not.toContain(
      "binding_invalidated",
    );
  });

  it("does not classify a frozen writer as a divergence at all", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await seedVerifiedState(userId, walletId, providerSignerId, 1);
    const boundGrant = await provisionGrant(userId, walletId, POLICY_ID, [ADDRESS_A]);
    const before = await grantRows(walletId);

    const { service } = harness({
      providerWalletId,
      providerSignerId,
      frozen: true,
    });

    await service.create(userId, createInput);

    const state = await readState(userId, walletId);
    // `frozen` resolves the apply port to the `unavailable` arm, which has no
    // mutation method — so it is not a `blocked_*` class and cannot clear a
    // binding (design §13).
    expect(state!.status).toBe("pending");
    expect(state!.statusReason).toBe(RECIPIENT_POLICY_WRITER_FROZEN_REASON);
    expect(state!.appliedRulesHash).toBe(PREVIOUS_HASH);
    expect(state!.desiredRulesHash).not.toBeNull();
    expect(await readBinding(boundGrant)).toBe(POLICY_ID);
    expect(await grantRows(walletId)).toEqual(before);
    expect((await audits(userId)).map((row) => row.event)).not.toContain(
      "binding_invalidated",
    );
  });

  // -------------------------------------------------------------------------
  // §4.4 restoring automatic execution
  // -------------------------------------------------------------------------

  it("never lowers applied_revision, and re-binds the grant only through the next verified apply", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await seedVerifiedState(userId, walletId, providerSignerId, 7);
    const boundGrant = await provisionGrant(userId, walletId, POLICY_ID, [ADDRESS_A]);

    // 1. A proven divergence clears the binding and leaves applied_revision at 7.
    const diverged = harness({
      providerWalletId,
      providerSignerId,
      policyRules: {
        [POLICY_ID]: [
          allowRule("remote-rule-nobody-composed", ["Test1DriftAddressxxxxxxxxxxxxxxxxxxxxxx"]),
        ],
      },
    });
    await diverged.service.create(userId, createInput);

    expect(await readBinding(boundGrant)).toBeNull();
    expect((await readState(userId, walletId))!.appliedRevision).toBe(7);

    // 2. The next verified apply re-binds it, from the verified readback.
    const converged = harness({ providerWalletId, providerSignerId, policyRules: {} });
    await converged.service.create(userId, createInput);

    const state = await readState(userId, walletId);
    expect(state!.status).toBe("applied");
    expect(state!.appliedPolicyId).toBe(POLICY_ID);
    expect(await readBinding(boundGrant)).toBe(POLICY_ID);
  });

  it("does not re-bind on an unknown outcome either", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await seedVerifiedState(userId, walletId, providerSignerId, 1);
    const boundGrant = await provisionGrant(userId, walletId, POLICY_ID, [ADDRESS_A]);

    const diverged = harness({
      providerWalletId,
      providerSignerId,
      policyRules: {
        [POLICY_ID]: [
          allowRule("remote-rule-nobody-composed", ["Test1DriftAddressxxxxxxxxxxxxxxxxxxxxxx"]),
        ],
      },
    });
    await diverged.service.create(userId, createInput);
    expect(await readBinding(boundGrant)).toBeNull();

    // A timeout after the clearing must not resurrect the binding by accident.
    const timedOut = harness({
      providerWalletId,
      providerSignerId,
      policyRules: {},
      mutationError: timeoutError(),
    });
    await timedOut.service.create(userId, createInput);

    expect(await readBinding(boundGrant)).toBeNull();
  });
});

/** A §5.3 UNVERIFIED mutation failure: the write may or may not have landed. */
function timeoutError(): Error {
  return new PolicyApplyTransportError(
    "timeout",
    "patchPolicy",
    null,
    "gateway timeout",
  );
}

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
