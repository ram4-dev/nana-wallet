/**
 * Task 1.6 — `RecipientPolicyService` against the real database
 * (design §3.1, §3.5, §1.6, §11 U1, spec "Single recipient management service and
 * single policy composer" / "Consent provenance for the retained baseline" /
 * "Metadata edits never broaden permission").
 *
 * WHY THIS SUITE DRIVES REAL TABLES
 * ---------------------------------
 * Three of this unit's guarantees exist only in the database and cannot be
 * faked:
 *
 *   1. **Identity is derived server-side.** The wallet is resolved from
 *      `user_wallets` for the acting user, so a body cannot name one, and the
 *      chain scope is the resolved wallet's — proven by the non-Solana wallet
 *      case.
 *   2. **The consent baseline is captured once.** "Written once from the newest
 *      active `signer_grants` row and never re-derived" is a property of the
 *      recorded row, so it is asserted by changing the enrollment AFTER the
 *      capture and observing that the recorded value did not move.
 *   3. **A rejected mutation persists nothing.** That is a row-count statement
 *      over four tables, each with a positive control in the same case.
 *
 * The contact-mutation port is injected, and this suite supplies a real-SQL
 * adapter with the documented contract (create / version-CAS update / read) so
 * the service is exercised against real RLS, real constraints and a real
 * transaction. Its production adapter (over `ContactsRepository` plus the
 * embedding provider) is the HTTP vertical's unit; the seam itself is this
 * unit's.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
  type Queryable,
} from "../../src/db/client.js";
import {
  PolicyConsentRecordUnreadableError,
  RecipientPolicyRepository,
  type PolicyStateRecord,
} from "../../src/wallet/policy/repository.js";
import {
  PolicyRuleCompositionUnprovenError,
  RecipientContactMissingError,
  RecipientContactVersionConflictError,
  RecipientPolicyConflictError,
  RecipientPolicyRevisionConflictError,
  RecipientPolicyService,
  RecipientPolicyValidationError,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
  type RecipientPolicyServiceDependencies,
} from "../../src/wallet/policy/service.js";
import { createPrivyPolicyAdminClient } from "../../src/wallet/grants/privy-policy-runtime.js";
import type { GrantPolicyRule } from "../../src/wallet/grants/solana-policy-provisioner.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APPLY_REASON = "no signed apply capability in slice 1";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ADDRESS_C = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";
/**
 * The wallet's own Solana address. The retained baseline is the wallet's own
 * consented address and nothing else: design r1 "Base rule recipients = active,
 * explicitly confirmed Solana trusted addresses plus any explicitly consented
 * retained baseline address (current self address must not disappear
 * accidentally)", outline slice 1 "retained self comes only from the active
 * signer_grants enrollment consent snapshot", and the spec scenario "the
 * enrollment consent snapshot contains only the wallet's own retained address".
 * A fixture therefore has to enroll ITS OWN address, not a contact address.
 */
const WALLET_ADDRESS = "So11111111111111111111111111111111111111112";

/** `recipients.embedding` is `vector(384)`; fixtures never read it back. */
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;
const RECIPIENT_COLUMNS = "id, name, description, address, network, version";

suite("recipient policy service (task 1.6)", () => {
  let database: DatabaseClient;
  let repository: RecipientPolicyRepository;
  let grants: ReturnType<typeof createPrivyPolicyAdminClient>;
  /**
   * The users this suite provisioned, so it can clean up after itself.
   *
   * The intents it writes are due-now, and `listDueIntents({ limit })` is a
   * windowed scan: leaving them behind is what fills the window that task 1.3's
   * "claims a due intent from the system context" case needs for its own fresh
   * row. This suite therefore removes its own policy state instead of
   * contributing to that cross-suite fragility. Audit rows stay: the table is
   * append-only by trigger, which is the behaviour task 1.1 proved.
   */
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
      await database.query(
        `DELETE FROM contact_action_proposals WHERE user_id = $1`,
        [userId],
      );
      await database.query(`DELETE FROM signer_grants WHERE user_id = $1`, [userId]);
      await database.query(
        `DELETE FROM delegated_grants WHERE user_id = $1`,
        [userId],
      );
      await database.query(`DELETE FROM recipients WHERE user_id = $1`, [userId]);
    }
    await database.close();
  });

  // -------------------------------------------------------------------------
  // Fixtures
  // -------------------------------------------------------------------------

  /** user + one `ready` wallet for the requested chain family. */
  async function provision(
    chainFamily: "solana" | "ethereum" = "solana",
  ): Promise<{ userId: string; walletId: string }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:rps-${randomUUID()}`, "RPS Service Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, $3, $4, 'ready') RETURNING id`,
      [
        userId,
        `fixture-${randomUUID()}`,
        chainFamily,
        chainFamily === "solana" ? WALLET_ADDRESS : `${randomUUID()}.sol`,
      ],
    );
    provisionedUserIds.push(userId);
    return { userId, walletId: wallet.rows[0]!.id };
  }

  /** The enrollment consent row (columns from 006 / 010). */
  async function provisionSignerGrant(
    userId: string,
    walletId: string,
    input: {
      allowlisted: string[];
      snapshot?: unknown;
      state?: "active" | "revoked";
      /** Negative values create a NEWER row, so "newest active" is explicit. */
      ageMinutes?: number;
    },
  ): Promise<string> {
    const grant = await database.query<{ id: string }>(
      `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
          allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
          rolling_window_seconds, gas_ceiling, state, signer_enrollment_snapshot,
          created_at)
       VALUES ($1, $2, 'policy-x', 'signer-x', 'hash-x', $3::jsonb,
               '10000000', '10000000', 3600, '1000000', $4, $5::jsonb,
               now() - make_interval(mins => $6::int))
       RETURNING id`,
      [
        userId,
        walletId,
        JSON.stringify(input.allowlisted),
        input.state ?? "active",
        JSON.stringify(input.snapshot ?? {}),
        input.ageMinutes ?? 0,
      ],
    );
    return grant.rows[0]!.id;
  }

  /** One active delegated grant (turns the composition into two rule families). */
  async function provisionActiveGrant(
    userId: string,
    walletId: string,
    recipients: string[],
  ): Promise<string> {
    const grant = await database.query<{ id: string }>(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, expires_at)
       VALUES ($1, $2, 'solana', '5000000', '20000000', 3600, $3::jsonb,
               'active', now() + interval '30 days')
       RETURNING id`,
      [userId, walletId, JSON.stringify(recipients)],
    );
    return grant.rows[0]!.id;
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
      if (existing.rowCount === 0) throw new RecipientContactMissingError();
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
      if (result.rowCount === 0) throw new RecipientContactVersionConflictError();
      return mapContact(result.rows[0]!);
    },

    async archive(userId, contactId, expectedVersion, client): Promise<RecipientContactRecord> {
      const result = await client.query<ContactRow>(
        `UPDATE recipients
            SET status = 'inactive', updated_at = now()
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

  /**
   * The REAL ledger read (`createPrivyPolicyAdminClient(...).listActiveGrants`):
   * it reads only `user_wallets` and `delegated_grants` through `database`, so
   * the production grant read is what the service composes from while the
   * provider surfaces are never touched.
   */
  const unavailableProvider = createUnavailablePolicyApplyPort(APPLY_REASON);

  interface Harness {
    service: RecipientPolicyService;
    calls: { create: number; update: number };
  }

  /** A service wired to the real adapter, counting port invocations. */
  function harness(
    provider: RecipientPolicyServiceDependencies["provider"] = unavailableProvider,
  ): Harness {
    const calls = { create: 0, update: 0 };
    const port: RecipientContactMutationPort = {
      create: (userId, input, client) => {
        calls.create += 1;
        return contacts.create(userId, input, client);
      },
      update: (userId, contactId, input, client) => {
        calls.update += 1;
        return contacts.update(userId, contactId, input, client);
      },
      readActive: contacts.readActive,
      archive: contacts.archive,
    };
    const service = new RecipientPolicyService({
      database,
      repository,
      contacts: port,
      listActiveGrants: grants.listActiveGrants.bind(grants),
      provider,
    });
    return { service, calls };
  }

  /** Row counts over the four tables a rejected mutation must not touch. */
  async function counts(userId: string, walletId: string) {
    const one = async (
      sql: string,
      values: unknown[] = [userId, walletId],
    ): Promise<number> => {
      const result = await database.query<{ n: number }>(sql, values);
      return Number(result.rows[0]!.n);
    };
    return {
      contacts: await one(
        `SELECT COUNT(*)::int AS n FROM recipients WHERE user_id = $1`,
        [userId],
      ),
      states: await one(
        `SELECT COUNT(*)::int AS n FROM recipient_policy_state
          WHERE user_id = $1 AND wallet_id = $2`,
      ),
      intents: await one(
        `SELECT COUNT(*)::int AS n FROM recipient_policy_sync_intent
          WHERE user_id = $1 AND wallet_id = $2`,
      ),
      audits: await one(
        `SELECT COUNT(*)::int AS n FROM recipient_policy_audit
          WHERE user_id = $1 AND wallet_id = $2`,
      ),
    };
  }

  async function readState(
    userId: string,
    walletId: string,
  ): Promise<PolicyStateRecord | null> {
    return repository.readPolicyState(userId, walletId);
  }

  async function readIntents(userId: string) {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{
        desired_revision: string;
        origin: string;
        action: string | null;
        composed_rules: GrantPolicyRule[];
        composed_hash: string;
        state: string;
        idempotency_key: string | null;
      }>(
        `SELECT desired_revision, origin, action, composed_rules, composed_hash,
                state, idempotency_key
           FROM recipient_policy_sync_intent
          WHERE user_id = $1 ORDER BY desired_revision ASC`,
        [userId],
      ),
    );
    return result.rows;
  }

  async function readAuditEvents(userId: string): Promise<string[]> {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string; reason: string | null }>(
        `SELECT event, reason FROM recipient_policy_audit WHERE user_id = $1`,
        [userId],
      ),
    );
    return result.rows
      .map((row) => (row.reason ? `${row.event}:${row.reason}` : row.event))
      .sort();
  }

  async function readContacts(userId: string) {
    const result = await database.withUserTransaction(userId, (client) =>
      client.query<ContactRow>(
        `SELECT ${RECIPIENT_COLUMNS} FROM recipients
          WHERE user_id = $1 ORDER BY created_at ASC, id ASC`,
        [userId],
      ),
    );
    return result.rows.map(mapContact);
  }

  /** The `Transfer.to` allowlist of the composed ordinary rule. */
  function allowlistOf(rules: GrantPolicyRule[]): string[] {
    return rules
      .filter((rule) => rule.name === "Solana transfer allowlist")
      .flatMap((rule) =>
        rule.conditions
          .filter((condition) => condition.field === "Transfer.to")
          .flatMap((condition) => condition.value as string[]),
      );
  }

  /** The per-transfer lamport ceiling of the composed ordinary rule. */
  function capOf(rules: GrantPolicyRule[]): unknown {
    return rules
      .filter((rule) => rule.name === "Solana transfer allowlist")
      .flatMap((rule) =>
        rule.conditions.filter(
          (condition) => condition.field === "Transfer.lamports",
        ),
      )[0]?.value;
  }

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  describe("create", () => {
    it("persists the contact, records the first revision and composes from consent", async () => {
      const { userId, walletId } = await provision();
      // The enrollment carries the wallet's own address AND a contact address:
      // only the self address is retained consent, so the contact address must
      // NOT survive in the baseline (the regression this suite pins).
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS, ADDRESS_B],
        snapshot: { recipientIds: ["retained"] },
      });
      const { service } = harness();

      const result = await service.create(userId, {
        name: "Mamá",
        description: "mensualidad",
        address: ADDRESS_A,
      });

      // The contact is persisted, Solana-scoped and versioned from 1.
      expect(result.contact.address).toBe(ADDRESS_A);
      expect(result.contact.version).toBe(1);
      expect(result.contact.network).toBe("solana-devnet");

      // The wallet's first revision is recorded and nothing is claimed applied.
      expect(result.policyRevision).toBe(1);
      expect(result.permission).toEqual({
        state: "pending",
        desiredRevision: 1,
        appliedRevision: 0,
        retryable: true,
        reason: APPLY_REASON,
      });

      const state = (await readState(userId, walletId))!;
      expect(state.desiredRevision).toBe(1);
      expect(state.appliedRevision).toBe(0);
      expect(state.status).toBe("pending");
      // Consent provenance is the enrollment snapshot, not a remote GET, and
      // only the wallet's own enrolled address is retained from it.
      expect(state.consentBaseline).toEqual([WALLET_ADDRESS]);
      expect(state.consentProvenance).toEqual({ recipientIds: ["retained"] });

      const intents = await readIntents(userId);
      expect(intents).toHaveLength(1);
      expect(intents[0]!.desired_revision).toBe("1");
      expect(intents[0]!.origin).toBe("screen");
      expect(intents[0]!.action).toBe("create");
      expect(intents[0]!.state).toBe("pending");
      expect(intents[0]!.composed_hash).toBe(state.desiredRulesHash);
      // The composed rule is the ordinary allowlist: baseline ∪ the new contact,
      // capped at exactly the single lamport constant.
      expect(allowlistOf(intents[0]!.composed_rules).sort()).toEqual(
        [ADDRESS_A, WALLET_ADDRESS].sort(),
      );
      expect(capOf(intents[0]!.composed_rules)).toBe("10000000");

      expect(await readAuditEvents(userId)).toEqual(["intent_recorded"]);
    });

    it("derives the wallet and network server-side, never from the body", async () => {
      // This user's only ready wallet is not a Solana wallet, so no policy can be
      // composed for them.
      const { userId, walletId } = await provision("ethereum");
      const { service } = harness();

      const result = await service.create(userId, {
        name: "Papá",
        description: "",
        address: ADDRESS_C,
      });

      // The contact is still saved, and it is saved as Solana-scoped even though
      // the body never said so: the chain scope is the product's, not a client's.
      expect(result.contact.network).toBe("solana-devnet");
      expect(result.permission).toEqual({
        state: "saved_not_configured",
        desiredRevision: 0,
        appliedRevision: 0,
        retryable: false,
      });
      expect(await readState(userId, walletId)).toBeNull();
      expect(await readIntents(userId)).toHaveLength(0);
      expect(await readAuditEvents(userId)).toHaveLength(0);
    });

    it("rejects a body carrying a forbidden field with a typed error and persists nothing", async () => {
      const { userId, walletId } = await provision();
      const { service, calls } = harness();

      // Positive control: the same wallet and the same service DO persist a full
      // mutation when the body is the documented one, so the zeros below are the
      // rejection and not an unprovisioned fixture.
      await service.create(userId, {
        name: "Mamá",
        description: "",
        address: ADDRESS_A,
      });
      const afterValid = await counts(userId, walletId);
      expect(afterValid).toEqual({ contacts: 1, states: 1, intents: 1, audits: 1 });
      expect(calls.create).toBe(1);

      const forbidden = [
        { policyId: "pol_01HZYX00000000000000000001" },
        { signerId: "signer_01HZYX00000000000000000001" },
        { maxPerTransfer: "10000000" },
        { network: "ethereum" },
      ];
      for (const extra of forbidden) {
        let rejection: unknown;
        try {
          await service.create(userId, {
            name: "Intruso",
            description: "",
            address: ADDRESS_B,
            ...extra,
          });
        } catch (error) {
          rejection = error;
        }
        expect(rejection).toBeInstanceOf(RecipientPolicyValidationError);
        expect((rejection as RecipientPolicyValidationError).code).toBe(
          "DATOS_INVALIDOS",
        );
      }

      // Nothing new landed in any of the four tables, and the injected port was
      // never asked to write.
      expect(await counts(userId, walletId)).toEqual(afterValid);
      expect(calls.create).toBe(1);
    });

    it("captures the consent baseline once and never re-derives it", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      const { service } = harness();

      await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      expect((await readState(userId, walletId))!.consentBaseline).toEqual([
        WALLET_ADDRESS,
      ]);

      // The enrollment moves on. A baseline derived from "whatever the current
      // enrollment says" would follow it; the recorded consent must not.
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [ADDRESS_C],
        ageMinutes: -10,
      });
      await service.create(userId, {
        name: "Dos",
        description: "",
        address: ADDRESS_A,
      });

      const second = (await readState(userId, walletId))!;
      expect(second.desiredRevision).toBe(2);
      expect(second.consentBaseline).toEqual([WALLET_ADDRESS]);
    });

    it("does not re-capture the baseline after a stop that recorded no revision", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      // An active grant plus a contact is the unproven two-family composition, so
      // the first create stops with revision 0 — the state row is no longer
      // pristine even though no revision exists.
      await provisionActiveGrant(userId, walletId, [ADDRESS_C]);
      const { service } = harness();

      await expect(
        service.create(userId, {
          name: "Uno",
          description: "",
          address: ADDRESS_A,
        }),
      ).rejects.toThrow(PolicyRuleCompositionUnprovenError);

      const stopped = (await readState(userId, walletId))!;
      expect(stopped.desiredRevision).toBe(0);
      expect(stopped.consentBaseline).toEqual([WALLET_ADDRESS]);

      await provisionSignerGrant(userId, walletId, {
        allowlisted: [ADDRESS_C],
        ageMinutes: -20,
      });
      await expect(
        service.create(userId, {
          name: "Dos",
          description: "",
          address: ADDRESS_A,
        }),
      ).rejects.toThrow(PolicyRuleCompositionUnprovenError);

      const after = (await readState(userId, walletId))!;
      expect(after.desiredRevision).toBe(0);
      // The recorded baseline is still the first observation, not the newer
      // enrollment: "captured once" survives a stop that never composed.
      expect(after.consentBaseline).toEqual([WALLET_ADDRESS]);
    });

    it("stops as blocked configuration, keeping the contact saved and not enabled", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      await provisionActiveGrant(userId, walletId, [ADDRESS_C]);
      const { service } = harness();

      await expect(
        service.create(userId, {
          name: "Uno",
          description: "",
          address: ADDRESS_A,
        }),
      ).rejects.toThrow(PolicyRuleCompositionUnprovenError);

      const state = (await readState(userId, walletId))!;
      expect(state.status).toBe("blocked_configuration");
      expect(state.statusReason).toBe("rule_composition_semantics_unproven");
      expect(state.desiredRevision).toBe(0);
      expect(state.desiredRulesHash).toBeNull();

      // The recipient change is persisted as saved-not-enabled (design §11 U1),
      // with no intent and a recorded stop.
      expect((await readContacts(userId)).map((row) => row.address)).toEqual([
        ADDRESS_A,
      ]);
      expect(await readIntents(userId)).toHaveLength(0);
      expect(await readAuditEvents(userId)).toEqual([
        "blocked_configuration:rule_composition_semantics_unproven",
      ]);

      // ... and the recorded stop is what the permission surface reports.
      const permission = await service.readContactPermission(userId, walletId);
      expect(permission.state).toBe("blocked_configuration");
      expect(permission.reason).toBe("rule_composition_semantics_unproven");
      expect(permission.retryable).toBe(false);
    });

    it("refuses to compose from an enrollment consent record it cannot read", async () => {
      const { userId, walletId } = await provision();
      await database.query(
        `INSERT INTO signer_grants
           (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
            allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
            rolling_window_seconds, gas_ceiling, state)
         VALUES ($1, $2, 'policy-x', 'signer-x', 'hash-x', '"not-an-array"'::jsonb,
                 '10000000', '10000000', 3600, '1000000', 'active')`,
        [userId, walletId],
      );
      const { service } = harness();

      await expect(
        service.create(userId, {
          name: "Uno",
          description: "",
          address: ADDRESS_A,
        }),
      ).rejects.toThrow(PolicyConsentRecordUnreadableError);

      // Fail closed: nothing was composed, persisted or claimed from a consent
      // record we cannot read.
      expect(await readIntents(userId)).toHaveLength(0);
      expect(await readContacts(userId)).toHaveLength(0);
      expect(await readState(userId, walletId)).toBeNull();

      // Positive control on the SAME wallet: make the consent readable and the
      // same call composes normally.
      await database.query(
        `UPDATE signer_grants SET allowlisted_recipients = $2::jsonb
          WHERE wallet_id = $1`,
        [walletId, JSON.stringify([WALLET_ADDRESS])],
      );
      const accepted = await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      expect(accepted.policyRevision).toBe(1);
      expect((await readState(userId, walletId))!.consentBaseline).toEqual([
        WALLET_ADDRESS,
      ]);

      // Triangulation: once the baseline is durable, a later BROKEN enrollment
      // record cannot break the wallet — the consent is already recorded, so
      // there is nothing left to derive from the enrollment row.
      await database.query(
        `UPDATE signer_grants SET allowlisted_recipients = '"broken"'::jsonb
          WHERE wallet_id = $1`,
        [walletId],
      );
      const stillWorks = await service.create(userId, {
        name: "Dos",
        description: "",
        address: ADDRESS_A,
      });
      expect(stillWorks.policyRevision).toBe(2);
      expect((await readState(userId, walletId))!.consentBaseline).toEqual([
        WALLET_ADDRESS,
      ]);
    });

    it("supersedes the in-flight intent so a second mutation records its own revision", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      const { service } = harness();

      await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      const second = await service.create(userId, {
        name: "Dos",
        description: "",
        address: ADDRESS_C,
      });

      expect(second.policyRevision).toBe(2);
      const intents = await readIntents(userId);
      expect(intents.map((row) => row.state)).toEqual(["superseded", "pending"]);
      expect(intents[1]!.composed_hash).not.toBe(intents[0]!.composed_hash);
      expect(allowlistOf(intents[1]!.composed_rules).sort()).toEqual(
        [ADDRESS_A, ADDRESS_C, WALLET_ADDRESS].sort(),
      );
    });
  });

    it("records the origin and the idempotency key the calling surface supplied", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();

      await service.create(
        userId,
        { name: "Uno", description: "", address: ADDRESS_A },
        { origin: "voice", idempotencyKey: "idem-voice-1" },
      );

      const intents = await readIntents(userId);
      expect(intents[0]!.origin).toBe("voice");
      expect(intents[0]!.idempotency_key).toBe("idem-voice-1");

      // The default surface is the screen, not a value a caller may omit into
      // ambiguity.
      await service.create(userId, {
        name: "Dos",
        description: "",
        address: ADDRESS_C,
      });
      expect((await readIntents(userId))[1]!.origin).toBe("screen");
      expect((await readIntents(userId))[1]!.idempotency_key).toBeNull();
    });

    it("serializes two concurrent mutations for the same wallet", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      const { service } = harness();

      const [first, second] = await Promise.all([
        service.create(userId, { name: "Uno", description: "", address: ADDRESS_A }),
        service.create(userId, { name: "Dos", description: "", address: ADDRESS_C }),
      ]);

      // The W0 lock is what makes these two revisions rather than one overwritten
      // by the other or a rejected duplicate.
      expect([first.policyRevision, second.policyRevision].sort()).toEqual([1, 2]);
      const intents = await readIntents(userId);
      expect(intents.map((row) => row.state)).toEqual(["superseded", "pending"]);
      expect(allowlistOf(intents[1]!.composed_rules).sort()).toEqual(
        [ADDRESS_A, ADDRESS_C, WALLET_ADDRESS].sort(),
      );
    });

    it("composes both rule families once the U1 probe recorded a union", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      await provisionActiveGrant(userId, walletId, [ADDRESS_C]);
      const { service } = harness();

      // Positive control for the refusal asserted in the blocked-configuration
      // case: the same wallet refuses while nothing recorded the probe.
      await expect(
        service.create(userId, { name: "Uno", description: "", address: ADDRESS_A }),
      ).rejects.toThrow(PolicyRuleCompositionUnprovenError);

      await database.withUserTransaction(userId, async (client) => {
        await repository.lockPolicyState(userId, walletId, client);
      });
      await repository.setPolicyStatus(userId, {
        walletId,
        status: "saved_not_configured",
        detail: { rules_union: "union" },
      });

      await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });

      const intents = await readIntents(userId);
      expect(intents).toHaveLength(1);
      const rules = intents[0]!.composed_rules;
      expect(rules).toHaveLength(2);
      expect(rules.filter((rule) => rule.name === "Solana transfer allowlist")).toHaveLength(1);
      expect(rules.filter((rule) => rule.name.startsWith("solana-grant-"))).toHaveLength(1);
      // The grant's own approved ceiling, never the ordinary one.
      expect(
        rules
          .find((rule) => rule.name.startsWith("solana-grant-"))!
          .conditions.find((condition) => condition.field === "Transfer.lamports")!
          .value,
      ).toBe("5000000");
    });

  // -------------------------------------------------------------------------
  // edit
  // -------------------------------------------------------------------------

  describe("edit", () => {
    it("renames a contact without changing the composed rule set", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      const { service } = harness();
      const created = await service.create(userId, {
        name: "Uno",
        description: "antes",
        address: ADDRESS_A,
      });

      const edited = await service.edit(userId, created.contact.id, {
        name: "Uno (casa)",
        expectedVersion: created.contact.version,
      });

      expect(edited.contact.name).toBe("Uno (casa)");
      expect(edited.contact.version).toBe(2);
      expect(edited.contact.address).toBe(ADDRESS_A);
      // The chain scope is re-derived server-side: a metadata edit that dropped
      // it would push the contact out of the composed set.
      expect(edited.contact.network).toBe("solana-devnet");
      expect(edited.policyRevision).toBe(2);

      const intents = await readIntents(userId);
      expect(intents[1]!.action).toBe("rename");
      expect(intents[1]!.composed_hash).toBe(intents[0]!.composed_hash);
      expect(allowlistOf(intents[1]!.composed_rules).sort()).toEqual(
        [ADDRESS_A, WALLET_ADDRESS].sort(),
      );
      expect((await readState(userId, walletId))!.status).toBe("pending");
    });

    it("blocks a metadata edit whose recomposition would change the recorded rule set", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      const created = await service.create(userId, {
        name: "Uno",
        description: "antes",
        address: ADDRESS_A,
      });

      // A contact lands outside this edit: the wallet's recorded rule set no
      // longer matches what the tables would compose.
      await database.withUserTransaction(userId, (client) =>
        contacts.create(
          userId,
          {
            name: "Ajeno",
            description: "",
            address: ADDRESS_C,
            network: "solana-devnet",
          },
          client,
        ),
      );
      const before = await counts(userId, walletId);

      let conflict: unknown;
      try {
        await service.edit(userId, created.contact.id, {
          name: "Uno (casa)",
          expectedVersion: created.contact.version,
        });
      } catch (error) {
        conflict = error;
      }

      expect(conflict).toBeInstanceOf(RecipientPolicyConflictError);
      const typed = conflict as RecipientPolicyConflictError;
      expect(typed.code).toBe("CONFLICTO_POLITICA");
      expect(typed.failureClass).toBe("blocked_conflict");
      expect(typed.reason).toBe("metadata_edit_changes_rules");

      // Nothing was applied silently: the contact, the revision and the intent
      // are all unchanged, and the only new row is the recorded stop (spec
      // "Stops are recorded, not silently assumed").
      const after = await counts(userId, walletId);
      expect(after.contacts).toBe(before.contacts);
      expect(after.states).toBe(before.states);
      expect(after.intents).toBe(before.intents);
      expect(after.audits).toBe(before.audits + 1);
      expect((await readContacts(userId))[0]).toMatchObject({
        name: "Uno",
        description: "antes",
        version: 1,
      });

      const state = (await readState(userId, walletId))!;
      expect(state.desiredRevision).toBe(1);
      expect(state.status).toBe("blocked_conflict");
      expect(state.statusReason).toBe("metadata_edit_changes_rules");
      expect(await readAuditEvents(userId)).toEqual([
        "blocked_conflict:metadata_edit_changes_rules",
        "intent_recorded",
      ]);
    });

    it("compares a settled wallet's metadata edit against its APPLIED rule set", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      const created = await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      const settled = (await readState(userId, walletId))!;

      // Positive control: with the applied hash equal to the composition, the
      // settled wallet accepts the rename (spec "Renaming an existing contact
      // changes no rule").
      expect(
        await repository.commitAppliedRevision(userId, {
          walletId,
          desiredRevision: settled.desiredRevision,
          appliedRulesHash: settled.desiredRulesHash!,
          appliedPolicyId: "pol_01HZYX00000000000000000001",
          appliedSignerId: "signer_01HZYX00000000000000000001",
          appliedSignerIds: ["signer_01HZYX00000000000000000001"],
          appliedRecipients: [ADDRESS_A, ADDRESS_B],
        }),
      ).toBe(true);
      const renamed = await service.edit(userId, created.contact.id, {
        name: "Uno (casa)",
        expectedVersion: created.contact.version,
      });
      expect(renamed.contact.name).toBe("Uno (casa)");

      // The settled applied rule set is the reference even when it DISAGREES with
      // what the tables would compose: a rename must not silently fold in a
      // drift the reconciler owns (spec "Denying permission broadening is a
      // validation failure, not a merge").
      const { userId: driftedUser, walletId: driftedWallet } = await provision();
      await provisionSignerGrant(driftedUser, driftedWallet, {
        allowlisted: [ADDRESS_B],
      });
      const drifted = await service.create(driftedUser, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      const driftedState = (await readState(driftedUser, driftedWallet))!;
      expect(
        await repository.commitAppliedRevision(driftedUser, {
          walletId: driftedWallet,
          desiredRevision: driftedState.desiredRevision,
          appliedRulesHash: "sha256:drifted-remote-rule-set",
          appliedPolicyId: "pol_01HZYX00000000000000000001",
          appliedSignerId: "signer_01HZYX00000000000000000001",
          appliedSignerIds: ["signer_01HZYX00000000000000000001"],
          appliedRecipients: [ADDRESS_A],
        }),
      ).toBe(true);

      let conflict: unknown;
      try {
        await service.edit(driftedUser, drifted.contact.id, {
          name: "Uno (casa)",
          expectedVersion: drifted.contact.version,
        });
      } catch (error) {
        conflict = error;
      }

      expect(conflict).toBeInstanceOf(RecipientPolicyConflictError);
      expect((conflict as RecipientPolicyConflictError).detail).toMatchObject({
        reference: "applied_revision",
        referenceHash: "sha256:drifted-remote-rule-set",
        composedHash: driftedState.desiredRulesHash,
      });
    });

    it("recomposes the address change and drops the replaced address", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      const { service } = harness();
      const created = await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });

      const edited = await service.edit(userId, created.contact.id, {
        address: ADDRESS_C,
        expectedVersion: created.contact.version,
      });

      expect(edited.contact.address).toBe(ADDRESS_C);
      const intents = await readIntents(userId);
      expect(intents[1]!.action).toBe("address_change");
      expect(intents[1]!.composed_hash).not.toBe(intents[0]!.composed_hash);
      expect(allowlistOf(intents[1]!.composed_rules).sort()).toEqual(
        [ADDRESS_C, WALLET_ADDRESS].sort(),
      );
    });

    it("aborts the whole transaction when the contact version is stale", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      const created = await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      const before = await counts(userId, walletId);

      await expect(
        service.edit(userId, created.contact.id, {
          name: "Uno (casa)",
          expectedVersion: created.contact.version + 1,
        }),
      ).rejects.toThrow(RecipientContactVersionConflictError);

      // A failure inside the transaction leaves no partial state: the contact,
      // the revision, the intent and the audit are all unchanged.
      expect(await counts(userId, walletId)).toEqual(before);
      expect((await readState(userId, walletId))!.desiredRevision).toBe(1);
      expect((await readContacts(userId))[0]).toMatchObject({
        name: "Uno",
        version: 1,
      });
    });

    it("refuses to compose over a policy revision the caller has not seen", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      const created = await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });
      const before = await counts(userId, walletId);

      await expect(
        service.edit(userId, created.contact.id, {
          name: "Uno (casa)",
          expectedVersion: created.contact.version,
          expectedPolicyRevision: 99,
        }),
      ).rejects.toThrow(RecipientPolicyRevisionConflictError);

      expect(await counts(userId, walletId)).toEqual(before);

      // The same edit carrying the revision the server actually holds is
      // accepted, so the refusal above is the revision and not the body shape.
      const accepted = await service.edit(userId, created.contact.id, {
        name: "Uno (casa)",
        expectedVersion: created.contact.version,
        expectedPolicyRevision: created.policyRevision,
      });
      expect(accepted.contact.name).toBe("Uno (casa)");
    });
  });

  // -------------------------------------------------------------------------
  // the capture predicate (the repository's atomic write authority)
  // -------------------------------------------------------------------------

  describe("the consent capture predicate", () => {
    it("refuses to capture the baseline again once a revision is recorded", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, {
        allowlisted: [WALLET_ADDRESS],
      });
      const consent = (await repository.readActiveEnrollmentConsent(
        userId,
        walletId,
      ))!;
      expect(consent.baseline).toEqual([WALLET_ADDRESS]);

      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );

      // Positive control: a pristine row accepts the capture, and the statement
      // reports that IT wrote it.
      expect(
        await repository.captureConsentBaselineOnce(userId, walletId, consent),
      ).toBe(true);
      expect((await readState(userId, walletId))!.consentBaseline).toEqual([
        WALLET_ADDRESS,
      ]);

      // Once a revision exists, a second capture with a DIFFERENT candidate must
      // be refused by the statement itself — independent of any caller's
      // pre-check, which is what makes the predicate the write authority.
      await repository.bumpDesiredRevision(userId, {
        walletId,
        desiredRulesHash: "sha256:first-revision",
      });
      expect(
        await repository.captureConsentBaselineOnce(userId, walletId, {
          baseline: [ADDRESS_C],
          provenance: { recipientIds: ["later"] },
        }),
      ).toBe(false);
      const state = (await readState(userId, walletId))!;
      expect(state.consentBaseline).toEqual([WALLET_ADDRESS]);
      expect(state.consentProvenance).toEqual({});
    });
  });

  // -------------------------------------------------------------------------
  // readContactPermission
  // -------------------------------------------------------------------------

  describe("readContactPermission", () => {
    it("reports applied only behind a verified readback", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });

      // The apply path is slice 2; here a recorded applied revision stands in
      // for a verified readback so the projection can be exercised.
      const state = (await readState(userId, walletId))!;
      expect(
        await repository.commitAppliedRevision(userId, {
          walletId,
          desiredRevision: state.desiredRevision,
          appliedRulesHash: state.desiredRulesHash!,
          appliedPolicyId: "pol_01HZYX00000000000000000001",
          appliedSignerId: "signer_01HZYX00000000000000000001",
          appliedSignerIds: ["signer_01HZYX00000000000000000001"],
          appliedRecipients: [ADDRESS_A, ADDRESS_B],
        }),
      ).toBe(true);

      expect(await service.readContactPermission(userId, walletId)).toEqual({
        state: "applied",
        desiredRevision: 1,
        appliedRevision: 1,
        retryable: false,
      });

      // The verification timestamp is the evidence a successful call must not be
      // able to fake: without it the same row may not report `applied`.
      await database.query(
        `UPDATE recipient_policy_state SET verified_at = NULL WHERE wallet_id = $1`,
        [walletId],
      );

      const unverified = await service.readContactPermission(userId, walletId);
      expect(unverified.state).toBe("pending");
      expect(unverified.reason).toBe("unverified_applied_readback");
      expect(unverified.retryable).toBe(true);
    });

    it("answers saved-not-configured for an identifier the database cannot hold", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });

      // Positive control: a real identifier reads the recorded revision.
      expect((await service.readContactPermission(userId, walletId)).state).toBe(
        "pending",
      );

      // A malformed identifier is not a driver error and not a leak: there is no
      // such wallet, which is the same answer a stranger gets.
      expect(await service.readContactPermission(userId, "not-an-identifier")).toEqual({
        state: "saved_not_configured",
        desiredRevision: 0,
        appliedRevision: 0,
        retryable: false,
      });
    });

    it("reports saved-not-configured for a wallet the caller does not own", async () => {
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const { service } = harness();
      await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });

      // Positive control: the owner reads the recorded revision.
      expect((await service.readContactPermission(userId, walletId)).state).toBe(
        "pending",
      );

      const { userId: strangerId } = await provision();
      const stranger = harness();

      // Row isolation hides the foreign wallet: the honest answer is "nothing
      // configured", never a leaked revision or a fabricated success.
      expect(
        await stranger.service.readContactPermission(strangerId, walletId),
      ).toEqual({
        state: "saved_not_configured",
        desiredRevision: 0,
        appliedRevision: 0,
        retryable: false,
      });
    });
  });

  // -------------------------------------------------------------------------
  // the apply seam
  // -------------------------------------------------------------------------

  describe("the apply seam", () => {
    it("accepts a signed capability and still refuses to apply without a verified signer binding", async () => {
      /**
       * Task 2.8 CHANGED THIS CASE. It asserted that constructing the service with
       * a signed arm THREW `PolicyApplyCapabilityUnwiredError` and persisted
       * nothing. That class is deleted (the implementation is
       * `src/wallet/policy/apply.ts`), so the case now drives the signed arm to its
       * first real guard instead: the fixture wallet has a `ready` row but NO
       * verified `provider_signer_id`, so there is no policy target and the
       * provider must not be consulted at all. The stop is recorded, typed, and
       * carries no applied revision — never an inferred binding (design §0 C5).
       */
      const { userId, walletId } = await provision();
      await provisionSignerGrant(userId, walletId, { allowlisted: [ADDRESS_B] });
      const apply = vi.fn(async () => ({
        kind: "retryable_failure" as const,
        reason: "never called",
        detail: { code: "never_called" },
      }));

      const { service } = harness({ kind: "signed", apply });
      const created = await service.create(userId, {
        name: "Uno",
        description: "",
        address: ADDRESS_A,
      });

      // Positive control: the mutation itself happened and recorded its revision.
      expect(created.policyRevision).toBe(1);
      expect(await readState(userId, walletId)).not.toBeNull();
      // ...and the apply step refused to guess a binding.
      expect(apply).not.toHaveBeenCalled();
      const state = await readState(userId, walletId);
      expect(state!.status).toBe("pending");
      expect(state!.statusReason).toBe("signer_binding_unavailable");
      expect(state!.appliedRevision).toBe(0);
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
