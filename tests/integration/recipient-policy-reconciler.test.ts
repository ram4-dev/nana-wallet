/**
 * Task 2.9 — the reconciler against the real database (design §5.2, §5.3, §10(d)).
 *
 * WHY THIS SUITE DRIVES REAL TABLES
 * ---------------------------------
 * Four guarantees of this unit exist only in the database:
 *
 *   1. **The lease is the serializer.** "A second connection reclaims after the
 *      TTL" IS a row conflict on `recipient_policy_leases`, so a repository double
 *      would prove nothing.
 *   2. **Restart recovery is structural.** The recovery read is the due scan
 *      against a row left in flight by a dead holder, plus the `lease_reclaimed`
 *      audit and the cleared marker in one owner transaction.
 *   3. **No transaction is open across provider I/O.** Measured with a counting
 *      client at the moment of the PATCH — an implementation that wrapped the
 *      provider call in a transaction fails BY NAME instead of by review.
 *   4. **The retry schedule is durable.** `next_attempt_at`/`attempt_count` are
 *      columns the next pass reads, so a backoff that only lived in memory would
 *      not survive the restart it exists for.
 *
 * The apply capability is the fake-transport adapter (no signer sidecar exists in
 * this environment, so the live path stays recorded as a pending live step).
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
  RecipientPolicyService,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import {
  createSignedPolicyApplyPort,
  type PolicyApplyTransport,
} from "../../src/wallet/policy/apply.js";
import {
  createPolicyReconciler,
  isRecipientPolicyReconcilerEnabled,
  reconcilerBackoffMs,
  RECONCILER_ATTEMPT_CAP,
  RECONCILER_BACKOFF_BASE_MS,
  RECONCILER_BACKOFF_MAX_MS,
  type PolicyReconcileOutcome,
  type PolicyReconcilePass,
  type PolicyReconciler,
} from "../../src/wallet/policy/reconciler.js";
import { composedRulesHash } from "../../src/wallet/policy/composer.js";
import { acquirePolicyLease, releasePolicyLease } from "../../src/wallet/policy/lease.js";
import {
  allowRule,
  createFakeApplyTransport,
  createTestAuthorizationSigner,
  policyWallet,
} from "../unit/helpers/policy-apply-fakes.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** The wrapped-SOL mint: a canonical base58 public key, used as a contact. */
const SOL_CONTACT = "So11111111111111111111111111111111111111112";
const ORDINARY_RULE_NAME = "Solana transfer allowlist";
const POLICY_ID = "pol_reconcile_integration";
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
const RECIPIENT_COLUMNS = "id, name, description, address, network, version";

suite("recipient policy reconciler (task 2.9)", () => {
  let database: DatabaseClient;
  let repository: RecipientPolicyRepository;
  const provisionedUserIds: string[] = [];
  let openTransactions = 0;

  /** The counting client: `openTransactions` is read at the moment of the PATCH. */
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

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    repository = new RecipientPolicyRepository(database);
    // The due scan is a CROSS-WALLET scan by design, and the shared local
    // database keeps every earlier run's rows, so residue would decide which
    // intents a pass examines. These four tables are written only by this
    // feature's suites (the 015 migration introduces them); the audit table is
    // append-only by trigger and cannot affect the scan.
    // Age-bounded: a suite running in parallel owns rows younger than this, and
    // deleting those would make this suite the cause of another suite's failure.
    await database.query(
      "DELETE FROM recipient_policy_leases WHERE expires_at < now() - interval '2 minutes'",
    );
    for (const table of [
      "recipient_policy_sync_intent",
      "recipient_policy_state",
      "contact_action_proposals",
    ]) {
      await database.query(
        `DELETE FROM ${table} WHERE created_at < now() - interval '2 minutes'`,
      );
    }
  });

  afterAll(async () => {
    for (const userId of provisionedUserIds) {
      await database.query("DELETE FROM recipient_policy_leases WHERE wallet_id IN (SELECT id FROM user_wallets WHERE user_id = $1)", [userId]);
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
      [`did:privy:rpr-${randomUUID()}`, "RPR Reconciler Test"],
    );
    const userId = user.rows[0]!.id;
    const providerWalletId = `privy-wallet-reconcile-${randomUUID()}`;
    const providerSignerId = `privy-signer-reconcile-${randomUUID()}`;
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

  /**
   * The revision that was applied BEFORE the ambiguous write: the ordinary rule
   * carrying only the enrollment baseline address. It is a legitimate readback —
   * known rule name, an address with consent provenance — so the retry branch is
   * reached on its own merits instead of tripping §5.1 (c)/(d) first.
   */
  function previousAppliedRules(stored: ReturnType<typeof allowRule>[]) {
    // Same SHAPE as the composition, one address narrower: a hand-built rule would
    // be refused by §5.1's shape check for the wrong reason.
    const rule = JSON.parse(JSON.stringify(stored.find((r) => r.name === ORDINARY_RULE_NAME)!)) as ReturnType<typeof allowRule>;
    for (const condition of rule.conditions as Array<{ field?: string; value?: unknown }>) {
      if (condition.field === "Transfer.to") condition.value = [ADDRESS_A];
    }
    return [rule];
  }

  type HarnessOptions = {
    providerWalletId: string;
    providerSignerId: string;
    attachedPolicyId?: string | null;
    policyRules?: Record<string, readonly ReturnType<typeof allowRule>[]>;
    readbackErrors?: Record<string, Error>;
    mutationError?: Error;
    listingError?: Error;
    onPatch?: () => Promise<void>;
    random?: () => number;
    lease?: { waitBudgetMs?: number; ownerId?: string };
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
      readbackErrors: options.readbackErrors,
      mutationError: options.mutationError,
      listingError: options.listingError,
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
    const reconciler: PolicyReconciler = createPolicyReconciler({
      database: counting,
      repository,
      service,
      transport: transport as PolicyApplyTransport,
      random: options.random ?? (() => 0.5),
      ...(options.lease ? { lease: options.lease } : {}),
    });
    return { service, reconciler, calls, transport, signer };
  }

  /**
   * This suite's own outcome. `listDueIntents` is a cross-wallet scan (it must
   * be, that is the reconciler's job), and the shared local database carries
   * other suites' residue, so an assertion on the whole pass would be an
   * assertion about the database's history instead of about this wallet.
   */
  function mine(pass: PolicyReconcilePass, walletId: string): PolicyReconcileOutcome {
    const rows = pass.outcomes.filter((outcome) => outcome.walletId === walletId);
    expect(rows).toHaveLength(1);
    return rows[0]!;
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

  /** The newest audit row's detail for an event, as the durable record. */
  async function auditDetail(
    userId: string,
    event: string,
  ): Promise<Record<string, unknown>> {
    const rows = await database.query<{ detail: Record<string, unknown> }>(
      `SELECT detail FROM recipient_policy_audit
        WHERE user_id = $1 AND event = $2 ORDER BY created_at DESC LIMIT 1`,
      [userId, event],
    );
    return rows.rows[0]!.detail;
  }

  async function intents(userId: string) {
    const rows = await database.query<{
      state: string;
      desired_revision: string;
      attempt_count: number;
      next_attempt_at: string | null;
      applied_at: string | null;
      composed_rules: unknown;
    }>(
      `SELECT state, desired_revision, attempt_count, next_attempt_at, applied_at, composed_rules
         FROM recipient_policy_sync_intent WHERE user_id = $1`,
      [userId],
    );
    return rows.rows;
  }

  /** A contact + a recorded revision, with the apply left pending (no capability). */
  async function recordPendingRevision(
    userId: string,
    walletId: string,
    address = ADDRESS_A,
  ) {
    const unavailable = new RecipientPolicyService({
      database: counting,
      repository,
      contacts,
      listActiveGrants: async () => [],
      provider: { kind: "unavailable", reason: "provider_unavailable" },
    } as RecipientPolicyServiceDependencies);
    await unavailable.create(userId, {
      name: "Mamá",
      description: "mensualidad",
      address,
    });
    return { userId, walletId };
  }

  // -------------------------------------------------------------------------
  // The schedule, the cap and the switch (pure)
  // -------------------------------------------------------------------------

  describe("schedule, cap and switch", () => {
    it("publishes min(5s x 2^n, 5min) with a bounded +/-20% jitter", () => {
      // Positive controls across the whole ladder, with the jitter pinned to its
      // two bounds and its centre by injecting `random`.
      expect(reconcilerBackoffMs(0, () => 0.5)).toBe(RECONCILER_BACKOFF_BASE_MS);
      expect(reconcilerBackoffMs(1, () => 0.5)).toBe(10_000);
      expect(reconcilerBackoffMs(2, () => 0.5)).toBe(20_000);
      // The ceiling bites at 5 s × 2^6 = 320 s, which is already past 5 min.
      expect(reconcilerBackoffMs(6, () => 0.5)).toBe(RECONCILER_BACKOFF_MAX_MS);
      // 5 s × 2^7 = 640 s would exceed 5 min too.
      expect(reconcilerBackoffMs(7, () => 0.5)).toBe(RECONCILER_BACKOFF_MAX_MS);
      expect(reconcilerBackoffMs(20, () => 0.5)).toBe(RECONCILER_BACKOFF_MAX_MS);
      // Jitter bounds on a 20 s step: [16 s, 24 s).
      expect(reconcilerBackoffMs(2, () => 0)).toBe(16_000);
      expect(reconcilerBackoffMs(2, () => 1)).toBe(24_000);
      // And the schedule is a real function of the count, not a constant.
      expect(reconcilerBackoffMs(0, () => 0.5)).not.toBe(reconcilerBackoffMs(1, () => 0.5));
    });

    it("enables the loop by default and only an explicit `disabled` turns it off", () => {
      expect(isRecipientPolicyReconcilerEnabled({})).toBe(true);
      expect(isRecipientPolicyReconcilerEnabled({ RECIPIENT_POLICY_RECONCILER: "enabled" })).toBe(true);
      expect(isRecipientPolicyReconcilerEnabled({ RECIPIENT_POLICY_RECONCILER: "disabled" })).toBe(false);
      expect(() => {
        isRecipientPolicyReconcilerEnabled({});
        expect(RECONCILER_ATTEMPT_CAP).toBe(12);
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // Due-intent selection, the single apply path, and duplicate events
  // -------------------------------------------------------------------------

  it("claims the due intent, applies it through the service seam, and marks the intent applied", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);
    expect((await intents(userId))[0]!.state).toBe("pending");

    const { reconciler, calls } = harness({ providerWalletId, providerSignerId });
    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toEqual({
      walletId,
      desiredRevision: 1,
      status: "applied",
      reclaimed: false,
    });
    expect(calls.patchPolicy).toHaveLength(1);
    const state = await readState(userId, walletId);
    expect(state).toMatchObject({ status: "applied", appliedRevision: 1 });
    const rows = await intents(userId);
    expect(rows[0]!.state).toBe("applied");
    expect(rows[0]!.applied_at).not.toBeNull();
  });

  it("applies the STORED composed_rules for the recorded revision", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);

    const stored = (await intents(userId))[0]!.composed_rules as ReturnType<
      typeof allowRule
    >[];
    const { reconciler, calls } = harness({ providerWalletId, providerSignerId });
    await reconciler.reconcileOnce();

    // The PATCH body IS the recorded compilation of that revision (not a
    // re-derivation from anything the worker held in memory), and its hash is the
    // hash the intent recorded, so the durable intent is what the retry applied.
    expect(calls.patchPolicy[0]!.rules).toEqual(stored);
    const state = await readState(userId, walletId);
    expect(state!.appliedRulesHash).toBe(composedRulesHash(stored));
    expect(state!.desiredRulesHash).toBe(composedRulesHash(stored));
  });

  it("does not double-apply a duplicate event: a second pass finds nothing due", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);
    const { reconciler, calls } = harness({ providerWalletId, providerSignerId });

    const first = await reconciler.reconcileOnce();
    const second = await reconciler.reconcileOnce();

    expect(mine(first, walletId).status).toBe("applied");
    expect(second.outcomes.filter((outcome) => outcome.walletId === walletId)).toEqual([]);
    expect(calls.patchPolicy).toHaveLength(1);
    expect(await audits(userId)).not.toContain("superseded");
  });

  it("returns WITHOUT touching state when another holder owns the wallet", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);
    const held = await acquirePolicyLease({
      database,
      walletId,
      userId,
      ownerId: "other-process",
      leaseSeconds: 60,
    });
    expect(held.status).toBe("acquired");
    const before = await readState(userId, walletId);
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      lease: { waitBudgetMs: 0 },
    });

    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toEqual({
      walletId,
      desiredRevision: 1,
      status: "busy",
      reclaimed: false,
    });
    expect(calls.patchPolicy).toEqual([]);
    expect(await readState(userId, walletId)).toEqual(before);
    await releasePolicyLease(
      { database },
      { walletId, token: (held as { token: string }).token },
    );
  });

  // -------------------------------------------------------------------------
  // Restart recovery
  // -------------------------------------------------------------------------

  it("reclaims an expired holder's in-flight intent, audits lease_reclaimed, and resumes it", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);
    // Simulate the dead holder: the intent is in flight and the lease that
    // guarded it expired (a 1 s TTL acquired by another process, then abandoned).
    await database.query("UPDATE recipient_policy_sync_intent SET state = 'applying' WHERE user_id = $1", [userId]);
    const dead = await acquirePolicyLease({
      database,
      walletId,
      userId,
      ownerId: "crashed-process",
      leaseSeconds: 1,
    });
    expect(dead.status).toBe("acquired");
    await database.query(
      "UPDATE recipient_policy_leases SET expires_at = now() - interval '1 second' WHERE wallet_id = $1",
      [walletId],
    );

    const { reconciler, calls } = harness({ providerWalletId, providerSignerId });
    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toEqual({
      walletId,
      desiredRevision: 1,
      status: "applied",
      reclaimed: true,
    });
    // The reclaim is recorded where an owner-scoped reader can see it, and the
    // marker it explains is gone in the same transaction.
    expect(await audits(userId)).toContain("lease_reclaimed");
    expect(calls.patchPolicy).toHaveLength(1);
    const row = (await intents(userId))[0]!;
    expect(row.state).toBe("applied");
    expect(row.applied_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // The UNVERIFIED-outcome table (design §5.3)
  // -------------------------------------------------------------------------

  /** A wallet whose last attempt is an UNVERIFIED write, ready for a GET-before-retry. */
  async function seedUnverifiedAttempt(options: {
    previousAppliedRules?: (stored: ReturnType<typeof allowRule>[]) => ReturnType<typeof allowRule>[];
  } = {}) {
    const provisioned = await provision();
    const { userId, walletId, providerWalletId, providerSignerId } = provisioned;
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId, SOL_CONTACT);
    const composed = await repository.listComposerContacts(userId);
    const state = (await readState(userId, walletId))!;
    const storedRules = (await intents(userId))[0]!.composed_rules as ReturnType<
      typeof allowRule
    >[];
    // The recorded evidence of an ambiguous PATCH: an UNVERIFIED provider code,
    // the targeted policy, and the previously applied rule hash.
    await database.query(
      `UPDATE recipient_policy_state
          SET status = 'pending',
              status_reason = 'patch_unverified',
              status_detail = COALESCE(status_detail, '{}'::jsonb)
                              || jsonb_build_object('code', 'provider_timeout',
                                                    'operation', 'patchPolicy',
                                                    'policyId', $2::text),
              applied_policy_id = $2,
              applied_rules_hash = $3,
              consent_baseline = $4::jsonb,
              consent_provenance = $5::jsonb
        WHERE wallet_id = $1`,
      [
        walletId,
        POLICY_ID,
        composedRulesHash(
          options.previousAppliedRules
            ? options.previousAppliedRules(storedRules)
            : storedRules,
        ),
        JSON.stringify([ADDRESS_A]),
        // The recorded consent map §5.1(d) compares a remote address against.
        JSON.stringify({ [ADDRESS_A]: "baseline" }),
      ],
    );
    // The intent is in flight because the process died at the timeout.
    await database.query(
      "UPDATE recipient_policy_sync_intent SET state = 'applying' WHERE user_id = $1",
      [userId],
    );
    return {
      ...provisioned,
      composed,
      state,
      storedRules,
      contactIds: composed.map((contact) => contact.id),
    };
  }

  it("treats a readback equal to the composed rules as applied with confirmedBy=get_after_timeout", async () => {
    const { userId, walletId, providerWalletId, providerSignerId, storedRules } =
      await seedUnverifiedAttempt({
        previousAppliedRules: (rules) => previousAppliedRules(rules),
      });
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      policyRules: { [POLICY_ID]: storedRules },
    });

    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toMatchObject({ status: "applied", reclaimed: true });
    // No BLIND retry: the reconciler's gate is what decided, and the promotion is
    // recorded as readback-driven rather than write-driven.
    expect(calls.patchPolicy.length).toBeLessThanOrEqual(1);
    const state = await readState(userId, walletId);
    expect(state).toMatchObject({ status: "applied", appliedRevision: 1 });
    // The promotion is recorded by name: the applied write did not observe the
    // PATCH, the readback is what proves it landed (design §5.3).
    const applied = await auditDetail(userId, "applied");
    expect(applied.confirmedBy).toBe("get_after_timeout");
    expect((await intents(userId))[0]!.state).toBe("applied");
  });

  it("retries the same revision when the readback equals the previously applied rules", async () => {
    const seed = await seedUnverifiedAttempt();
    const { userId, walletId, providerWalletId, providerSignerId } = seed;
    const previous = previousAppliedRules(seed.storedRules);
    await database.query("UPDATE recipient_policy_state SET applied_rules_hash = $2 WHERE wallet_id = $1", [walletId, composedRulesHash(previous)]);
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      policyRules: { [POLICY_ID]: previous },
    });

    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toMatchObject({ status: "applied" });
    // The ambiguous write did NOT land, so the same revision is retried.
    expect(calls.patchPolicy).toHaveLength(1);
    const state = await readState(userId, walletId);
    expect(state).toMatchObject({ status: "applied", appliedRevision: 1 });
    expect((state!.statusDetail as { confirmedBy?: string }).confirmedBy).toBeUndefined();
  });

  it("blocks on a third, unexplained rule set without writing anything", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } =
      await seedUnverifiedAttempt();
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      policyRules: { [POLICY_ID]: [allowRule("nobody-composed-this", [ADDRESS_A])] },
    });

    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toMatchObject({
      status: "blocked_conflict",
      reason: "unexplained_readback_rules",
    });
    expect(calls.patchPolicy).toEqual([]);
    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      status: "blocked_conflict",
      statusReason: "unexplained_readback_rules",
      appliedRevision: 0,
    });
    expect(await audits(userId)).toContain("blocked_conflict");
    // The auto loop does not keep retrying a proven divergence.
    expect((await intents(userId))[0]!.state).toBe("failed");
  });

  it("stays syncing with no blind retry when the GET itself fails", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } =
      await seedUnverifiedAttempt();
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      readbackErrors: { [POLICY_ID]: Object.assign(new Error("gateway timeout"), { name: "AbortError" }) },
    });

    const pass = await reconciler.reconcileOnce();

    expect(mine(pass, walletId)).toMatchObject({
      status: "syncing",
      reason: "readback_unavailable",
    });
    // "No retry of the PATCH until a GET succeeds" — the PATCH count is the proof.
    expect(calls.patchPolicy).toEqual([]);
    const state = await readState(userId, walletId);
    expect(state!.status).toBe("syncing");
    const row = (await intents(userId))[0]!;
    expect(row.state).toBe("pending");
    expect(row.attempt_count).toBe(1);
    expect(row.next_attempt_at).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Retryable failure, backoff, and the attempt cap
  // -------------------------------------------------------------------------

  it("schedules a retryable failure with the published backoff and stops at the cap", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);
    // First attempt: the provider is unreachable, which sends no request and so
    // is a retryable failure rather than an ambiguity.
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      attachedPolicyId: null,
      listingError: Object.assign(new Error("listing timed out"), { name: "AbortError" }),
      random: () => 0.5,
    });

    const first = await reconciler.reconcileOnce();

    expect(mine(first, walletId)).toMatchObject({ status: "retry_scheduled" });
    expect(calls.patchPolicy).toEqual([]);
    const afterFirst = (await intents(userId))[0]!;
    expect(afterFirst.state).toBe("pending");
    expect(afterFirst.attempt_count).toBe(1);
    // The schedule is stamped from the INCREMENTED attempt count (design §5.2
    // step 5), so the first retry is the 5 s × 2^1 step, not the base.
    const expectedDelay = reconcilerBackoffMs(1, () => 0.5);
    const deadline = new Date(afterFirst.next_attempt_at!).getTime();
    expect(deadline).toBeGreaterThan(Date.now() + expectedDelay - 1_000);
    expect(deadline).toBeLessThan(Date.now() + expectedDelay + 1_000);

    // The schedule is durable, so the NEXT pass leaves it alone until it is due.
    const immediate = await reconciler.reconcileOnce();
    expect(immediate.outcomes.filter((outcome) => outcome.walletId === walletId)).toEqual([]);
    expect(calls.patchPolicy).toEqual([]);

    // Cap: one attempt below the cap, the next one exhausts the budget and the
    // loop stops auto-retrying (the user-visible retry endpoint is a separate path).
    await database.query(
      `UPDATE recipient_policy_sync_intent
          SET attempt_count = $2, next_attempt_at = NULL
        WHERE user_id = $1`,
      [userId, RECONCILER_ATTEMPT_CAP - 1],
    );
    const capped = await reconciler.reconcileOnce();

    expect(mine(capped, walletId)).toMatchObject({
      status: "retry_scheduled",
      reason: "owner_listing_unavailable",
    });
    const state = await readState(userId, walletId);
    expect(state).toMatchObject({
      status: "retryable_failure",
      statusReason: "attempt_budget_exhausted",
    });
    const exhausted = (await intents(userId))[0]!;
    expect(exhausted.state).toBe("failed");
    expect(exhausted.attempt_count).toBe(RECONCILER_ATTEMPT_CAP);
    // Nothing more is due, so no later pass can silently resume the capped loop.
    expect(
      (await reconciler.reconcileOnce()).outcomes.filter(
        (outcome) => outcome.walletId === walletId,
      ),
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // The lock/transaction contract, measured instead of promised
  // -------------------------------------------------------------------------

  it("holds NO transaction and no row lock across the provider PATCH, while holding W1", async () => {
    const { userId, walletId, providerWalletId, providerSignerId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_A]);
    await recordPendingRevision(userId, walletId);
    const observed: Array<{ openTransactions: number; leaseHeld: boolean; rowLockFree: boolean }> = [];
    const { reconciler, calls } = harness({
      providerWalletId,
      providerSignerId,
      onPatch: async () => {
        // A second connection touching the wallet's state row proves no L1..L5 row
        // lock is held by the holder: if step 10's transaction were open across the
        // PATCH, this UPDATE would block and time out instead of succeeding.
        await database.query("SET statement_timeout = '2s'");
        const other = await database.query(
          "UPDATE recipient_policy_state SET updated_at = now() WHERE wallet_id = $1 RETURNING wallet_id",
          [walletId],
        );
        const lease = await database.query<{ lease_token: string | null }>(
          "SELECT lease_token FROM recipient_policy_leases WHERE wallet_id = $1 AND expires_at > now()",
          [walletId],
        );
        observed.push({
          openTransactions,
          leaseHeld: lease.rows.length === 1,
          rowLockFree: other.rowCount === 1,
        });
      },
    });

    await reconciler.reconcileOnce();

    expect(calls.patchPolicy).toHaveLength(1);
    expect(observed).toEqual([
      { openTransactions: 0, leaseHeld: true, rowLockFree: true },
    ]);
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
