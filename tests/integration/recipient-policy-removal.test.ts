/**
 * Task 1.7 — the atomic removal transaction with whole-grant revocation
 * (design §1.2/§1.3/§1.6, spec "Atomic recipient mutation with desired revision
 * and granted-scope revocation" / "Atomic revocation of affected grants on
 * last-alias removal" / "Effective status vocabulary and no premature success").
 *
 * WHY THESE CASES DRIVE REAL TABLES
 * ---------------------------------
 * Every guarantee this unit owns is a statement about rows moving together or not
 * at all:
 *
 *   1. **All-or-nothing.** The contact archive, the grant revocations, their
 *      audits, the desired revision and the durable intent commit in ONE
 *      transaction, so an injected failure after the contact write must leave
 *      every one of them untouched — asserted as a row-count comparison on both
 *      sides of the failure, never as a caught exception alone.
 *   2. **Whole-grant semantics.** A grant covering several addresses is revoked
 *      whole and its `recipients` projection is never rewritten, narrowed, or
 *      migrated to a replacement address. That is asserted by snapshotting the raw
 *      grant rows and comparing them after the removal.
 *   3. **No premature success.** A removal that revokes a grant may not report the
 *      revocation as `applied` without a signed readback.
 *
 * `W1` is the wallet's serialized writer, so the lease is exercised for real: the
 * "busy" case holds the lease from a SECOND connection and proves the removal
 * mutates nothing rather than merely throwing.
 *
 * The contact-mutation port is injected and this suite supplies a real-SQL
 * adapter (create / version-CAS update / version-CAS archive / read), the same
 * seam task 1.6 established: the production adapter over `ContactsRepository`
 * belongs to the HTTP vertical, not to this module.
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
  PolicyRuleCompositionUnprovenError,
  RecipientContactMissingError,
  RecipientContactVersionConflictError,
  RecipientPolicyNotSerializedError,
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  projectContactPermission,
  projectRevocationDisclosure,
  type ContactPermissionSnapshot,
  type RecipientContactMutationPort,
  type RecipientContactRecord,
} from "../../src/wallet/policy/service.js";
import { createPrivyPolicyAdminClient } from "../../src/wallet/grants/privy-policy-runtime.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APPLY_REASON = "no signed apply capability in slice 1";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ADDRESS_C = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

/** `recipients.embedding` is `vector(384)`; fixtures never read it back. */
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

/** One raw `delegated_grants` row, as the byte-for-byte snapshot compares it. */
type GrantSnapshot = {
  id: string;
  state: string;
  recipients: unknown;
  max_per_transfer: string;
  max_cumulative: string;
  window_seconds: number;
  expires_at: string;
  revoked_at: string | null;
};

suite("recipient policy removal (task 1.7)", () => {
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
      await database.query(
        `DELETE FROM contact_action_proposals WHERE user_id = $1`,
        [userId],
      );
      await database.query(`DELETE FROM signer_grants WHERE user_id = $1`, [userId]);
      await database.query(`DELETE FROM recipients WHERE user_id = $1`, [userId]);
      await database.query(
        `DELETE FROM recipient_policy_leases WHERE user_id = $1`,
        [userId],
      );
      // `delegated_grants` is deliberately LEFT IN PLACE: the revocations this
      // suite proves are immutable evidence — `grant_audit_log` is append-only by
      // trigger and carries a foreign key to the grant, so the rows cannot be
      // deleted by design. They are scoped to fixture wallets that no other suite
      // reads.
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
      [`did:privy:rpr-${randomUUID()}`, "RPR Removal Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    provisionedUserIds.push(userId);
    return { userId, walletId: wallet.rows[0]!.id };
  }

  /** The enrollment consent row the baseline is captured from (`006` / `010`). */
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

  /**
   * The U1 probe result recorded in `recipient_policy_state.status_detail`
   * (design §11 U1). Without it the composer refuses ordinary+grant coexistence,
   * so a case that needs a recorded revision records it exactly as the slice-2
   * reconciler will — and the case that needs the refusal simply does not.
   */
  async function recordRuleUnion(walletId: string): Promise<void> {
    const result = await database.query(
      `UPDATE recipient_policy_state
          SET status_detail = status_detail || '{"rules_union":"union"}'::jsonb
        WHERE wallet_id = $1`,
      [walletId],
    );
    // Positive control: the probe result must have landed on a real row, or every
    // composition below would be silently measuring the fail-closed default.
    expect(result.rowCount).toBe(1);
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

  /** The service wired exactly as slice 1 wires it, with a short lease budget. */
  function service(options: {
    /** Injected failure AFTER the contact write (spec's rollback scenario). */
    failAfterContactWrite?: boolean;
    /** Repository override, for racing a write against the planning read. */
    repository?: RecipientPolicyRepository;
  } = {}): { service: RecipientPolicyService; calls: { archive: number } } {
    const calls = { archive: 0 };
    const port: RecipientContactMutationPort = {
      create: contacts.create,
      update: contacts.update,
      archive: async (userId, contactId, expectedVersion, client) => {
        calls.archive += 1;
        const archived = await contacts.archive(
          userId,
          contactId,
          expectedVersion,
          client,
        );
        if (options.failAfterContactWrite) {
          throw new Error("injected failure after the contact write");
        }
        return archived;
      },
      readActive: contacts.readActive,
    };
    const service = new RecipientPolicyService({
      database,
      repository: options.repository ?? repository,
      contacts: port,
      listActiveGrants: grants.listActiveGrants.bind(grants),
      provider: createUnavailablePolicyApplyPort(APPLY_REASON),
      policyLease: { waitBudgetMs: 200, ownerId: "test" },
    });
    return { service, calls };
  }

  /**
   * A repository whose Phase A alias read is followed by an injected write, i.e.
   * a grant/alias created between the planning read and the locked re-derivation.
   *
   * The design calls the abort guard a cheap invariant assertion because grant
   * creation must hold `W1`, which the removal holds — so this is the only way to
   * exercise it, and it is exercised on the ALIAS half, which needs no new grant.
   */
  function repositoryRacingAnAlias(
    race: () => Promise<void>,
  ): RecipientPolicyRepository {
    const proxy = Object.create(repository) as RecipientPolicyRepository;
    let raced = false;
    proxy.listActiveAliases = async (userId, address, client) => {
      const rows = await repository.listActiveAliases(userId, address, client);
      if (!raced) {
        raced = true;
        await race();
      }
      return rows;
    };
    return proxy;
  }

  /**
   * A wallet with a consented baseline, one active contact for ADDRESS_A, one
   * captured revision and the U1 probe result recorded.
   *
   * The contact is created through the service so the state row, the consent
   * baseline and revision 1 are the real ones — nothing here hand-writes a
   * `recipient_policy_state` row the service would otherwise have created
   * differently.
   */
  async function scenario(options: {
    extraAlias?: boolean;
    grants?: string[][];
    recordUnion?: boolean;
    baseline?: string[];
  } = {}): Promise<{
    userId: string;
    walletId: string;
    contactId: string;
    version: number;
    grantIds: string[];
  }> {
    const { userId, walletId } = await provision();
    await provisionSignerGrant(userId, walletId, options.baseline ?? [ADDRESS_C]);
    const { service: svc } = service();
    const created = await svc.create(userId, {
      name: "Trusted One",
      description: "",
      address: ADDRESS_A,
    });
    if (options.extraAlias) {
      const alias = await svc.create(userId, {
        name: "Trusted One Alias",
        description: "",
        address: ADDRESS_A,
      });
      expect(alias.contact.address).toBe(ADDRESS_A);
    }
    const grantIds: string[] = [];
    for (const recipients of options.grants ?? []) {
      grantIds.push(await provisionActiveGrant(userId, walletId, recipients));
    }
    // Recorded LAST: every service mutation writes the wallet's status detail, so
    // the probe result has to land after the fixture's own calls — which is
    // exactly the ordering the reconciler owns in slice 2 (`recordApplyPending`
    // replaces `status_detail`, so a probe result recorded before it does not
    // survive; handed forward as an observation).
    if (options.recordUnion !== false) await recordRuleUnion(walletId);
    return {
      userId,
      walletId,
      contactId: created.contact.id,
      version: created.contact.version,
      grantIds,
    };
  }

  // -------------------------------------------------------------------------
  // Row state helpers (each has a positive control in the cases that use it)
  // -------------------------------------------------------------------------

  async function contactState(contactId: string): Promise<string> {
    const result = await database.query<{ status: string }>(
      `SELECT status FROM recipients WHERE id = $1`,
      [contactId],
    );
    return result.rows[0]!.status;
  }

  async function grantRow(grantId: string): Promise<GrantSnapshot> {
    const result = await database.query<GrantSnapshot>(
      `SELECT id, state, recipients, max_per_transfer::text, max_cumulative::text,
              window_seconds, expires_at::text, revoked_at::text
         FROM delegated_grants WHERE id = $1`,
      [grantId],
    );
    return result.rows[0]!;
  }

  async function grantRevokeAudits(grantId: string): Promise<
    Array<{ event: string; reason: string | null; detail: unknown }>
  > {
    const result = await database.query<{
      event: string;
      reason: string | null;
      detail: unknown;
    }>(
      `SELECT event, reason, detail FROM grant_audit_log
        WHERE grant_id = $1 ORDER BY id ASC`,
      [grantId],
    );
    return result.rows;
  }

  async function policyAudits(
    userId: string,
    walletId: string,
  ): Promise<Array<{ event: string; desired_revision: string | null; detail: unknown }>> {
    const result = await database.query<{
      event: string;
      desired_revision: string | null;
      detail: unknown;
    }>(
      `SELECT event, desired_revision, detail FROM recipient_policy_audit
        WHERE user_id = $1 AND wallet_id = $2 ORDER BY id ASC`,
      [userId, walletId],
    );
    return result.rows;
  }

  async function intents(
    walletId: string,
  ): Promise<Array<{ desired_revision: string; action: string | null; idempotency_key: string | null; state: string }>> {
    const result = await database.query<{
      desired_revision: string;
      action: string | null;
      idempotency_key: string | null;
      state: string;
    }>(
      `SELECT desired_revision, action, idempotency_key, state
         FROM recipient_policy_sync_intent WHERE wallet_id = $1
        ORDER BY desired_revision ASC`,
      [walletId],
    );
    return result.rows;
  }

  async function desiredRevision(userId: string, walletId: string): Promise<number> {
    const state = await repository.readPolicyState(userId, walletId);
    return state?.desiredRevision ?? 0;
  }

  // -------------------------------------------------------------------------
  // Whole-grant revocation with its audit, in one transaction
  // -------------------------------------------------------------------------

  it("revokes the affected whole grant with its audit in the same transaction as the contact", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A]],
    });
    const grantId = grantIds[0]!;
    // Positive control: the fixture really did create an ACTIVE affected grant.
    expect((await grantRow(grantId)).state).toBe("active");
    expect(await desiredRevision(userId, walletId)).toBe(1);

    const { service: svc } = service();
    const result = await svc.remove(userId, contactId, version, "idem-remove-1");

    expect(await contactState(contactId)).toBe("inactive");
    const grant = await grantRow(grantId);
    expect(grant.state).toBe("revoked");
    expect(grant.revoked_at).not.toBeNull();

    // The revocation audit is the `revoked` row, appended in the same transaction
    // as the contact archive: one row, carrying its reason and the grant scope.
    const audits = await grantRevokeAudits(grantId);
    expect(audits.map((row) => row.event)).toEqual(["revoked"]);
    expect(audits[0]!.reason).toBe("last_active_alias_removed");
    expect((audits[0]!.detail as { grantRecipients: string[] }).grantRecipients).toEqual([
      ADDRESS_A,
    ]);

    // The desired revision and the durable intent moved in the same transaction.
    expect(await desiredRevision(userId, walletId)).toBe(2);
    const recorded = await intents(walletId);
    expect(recorded).toHaveLength(2);
    const removal = recorded[1]!;
    expect(Number(removal.desired_revision)).toBe(2);
    expect(removal.action).toBe("remove");
    expect(removal.idempotency_key).toBe("idem-remove-1");

    // Both audits the design names for a removal are present, and the disclosure
    // names exactly the grant this transaction revoked.
    const events = await policyAudits(userId, walletId);
    expect(events.filter((row) => row.event === "intent_recorded")).toHaveLength(2);
    const disclosure = events.filter((row) => row.event === "revocation_disclosed");
    expect(disclosure).toHaveLength(1);
    expect((disclosure[0]!.detail as { revokedGrantIds: string[] }).revokedGrantIds).toEqual([
      grantId,
    ]);

    // The recorded revision composes the POST-mutation projection: it may not
    // carry a rule for the scope this transaction just revoked, or a recovery
    // would re-attach authority the user removed. The positive control is the
    // recorded rules being non-empty (the retained baseline still composes).
    const recordedRules = await database.query<{ composed_rules: unknown }>(
      `SELECT composed_rules FROM recipient_policy_sync_intent
        WHERE wallet_id = $1 AND desired_revision = 2`,
      [walletId],
    );
    const rules = recordedRules.rows[0]!.composed_rules as Array<{
      name?: string;
    }>;
    expect(rules.length).toBeGreaterThan(0);
    expect(rules.map((rule) => rule.name)).not.toContain(`solana-grant-${grantId}`);

    // The response names the revocation and does NOT claim it is verified.
    expect(result.revocation.grantIds).toEqual([grantId]);
    expect(result.revocation.state).not.toBe("applied");
    expect(result.policyRevision).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Another active alias prevents revocation entirely
  // -------------------------------------------------------------------------

  it("does not revoke the grant and appends no revoke audit while a second alias is active", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      extraAlias: true,
      grants: [[ADDRESS_A]],
    });
    const grantId = grantIds[0]!;

    const { service: svc } = service();
    const result = await svc.remove(userId, contactId, version, null);

    // The removed alias is gone, the other one still covers the address, so the
    // grant keeps its authority.
    expect(await contactState(contactId)).toBe("inactive");
    expect((await grantRow(grantId)).state).toBe("active");
    expect(await grantRevokeAudits(grantId)).toEqual([]);

    // The revision still recorded the removal (the address remains composed
    // through the other alias), and the disclosure names no revoked grant. The
    // fixture created two contacts through the service, so this is revision 3.
    expect(await desiredRevision(userId, walletId)).toBe(3);
    const recorded = await intents(walletId);
    expect(recorded.map((row) => row.action)).toEqual([
      "create",
      "create",
      "remove",
    ]);
    expect(result.revocation.grantIds).toEqual([]);
    const disclosure = (await policyAudits(userId, walletId)).filter(
      (row) => row.event === "revocation_disclosed",
    );
    expect(disclosure).toHaveLength(1);
    expect(
      (disclosure[0]!.detail as { affectedGrantIds: string[] }).affectedGrantIds,
    ).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Whole, never narrowed; unrelated grants byte-for-byte unchanged
  // -------------------------------------------------------------------------

  it("revokes a multi-address grant whole and rewrites no recipients projection", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A, ADDRESS_B], [ADDRESS_B, ADDRESS_C]],
    });
    const affected = grantIds[0]!;
    const unrelated = grantIds[1]!;
    const before = await grantRow(unrelated);

    const { service: svc } = service();
    const result = await svc.remove(userId, contactId, version, null);

    const revoked = await grantRow(affected);
    expect(revoked.state).toBe("revoked");
    // The whole grant, exactly as it was: never narrowed to the surviving address
    // and never migrated to a replacement one.
    expect(revoked.recipients).toEqual([ADDRESS_A, ADDRESS_B]);
    expect(result.revocation.grantIds).toEqual([affected]);

    // The unrelated grant is byte-for-byte the row it was, so no removal path can
    // have rewritten, extended or migrated it.
    expect(await grantRow(unrelated)).toEqual(before);

    // Positive control on the read path: the affected grant's audit IS visible
    // through the same helper the unrelated grant was checked with.
    expect((await grantRevokeAudits(affected)).map((row) => row.event)).toEqual([
      "revoked",
    ]);
    expect(await grantRevokeAudits(unrelated)).toEqual([]);
  });

  it("leaves every unrelated grant's recipients untouched (no replacement address is introduced)", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A], [ADDRESS_B], [ADDRESS_C]],
    });
    const [affected, second, third] = grantIds as [string, string, string];
    const beforeSecond = await grantRow(second);
    const beforeThird = await grantRow(third);

    const { service: svc } = service();
    await svc.remove(userId, contactId, version, null);

    expect((await grantRow(affected)).state).toBe("revoked");
    expect(await grantRow(second)).toEqual(beforeSecond);
    expect(await grantRow(third)).toEqual(beforeThird);
    // The positive control for the whole case: nothing in the wallet's grants
    // names ADDRESS_A any more as an ACTIVE scope, and nothing names a *new*
    // address the removal might have migrated it to.
    const active = await database.query<{ recipients: unknown }>(
      `SELECT recipients FROM delegated_grants
        WHERE wallet_id = $1 AND state = 'active'`,
      [walletId],
    );
    const activeRecipients = active.rows.flatMap((row) => row.recipients as string[]);
    expect(activeRecipients).not.toContain(ADDRESS_A);
    expect(new Set(activeRecipients)).toEqual(new Set([ADDRESS_B, ADDRESS_C]));
  });

  // -------------------------------------------------------------------------
  // All-or-nothing
  // -------------------------------------------------------------------------

  it("rolls back the contact, the revision, the revocations and the audits together after an injected failure", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A]],
    });
    const grantId = grantIds[0]!;
    const { service: svc, calls } = service({ failAfterContactWrite: true });

    await expect(svc.remove(userId, contactId, version, "idem-rollback")).rejects.toThrow(
      "injected failure after the contact write",
    );

    // Positive control first: the failure really did happen AFTER the contact
    // write ran, so the rollback assertion is about a transaction that had
    // already produced its first mutation.
    expect(calls.archive).toBeGreaterThan(0);

    // Each of the five things the transaction was supposed to do together is
    // still exactly as it was.
    expect(await contactState(contactId)).toBe("active");
    expect(await desiredRevision(userId, walletId)).toBe(1);
    expect((await grantRow(grantId)).state).toBe("active");
    expect(await grantRevokeAudits(grantId)).toEqual([]);
    expect(await intents(walletId)).toHaveLength(1);
    expect(
      (await policyAudits(userId, walletId)).filter(
        (row) => row.event === "revocation_disclosed",
      ),
    ).toEqual([]);
  });

  it("removes nothing when the contact version CAS matches no row", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A]],
    });
    const grantId = grantIds[0]!;

    const { service: svc } = service();
    await expect(
      svc.remove(userId, contactId, version + 1, null),
    ).rejects.toBeInstanceOf(RecipientContactVersionConflictError);

    expect(await contactState(contactId)).toBe("active");
    expect((await grantRow(grantId)).state).toBe("active");
    expect(await grantRevokeAudits(grantId)).toEqual([]);
    expect(await desiredRevision(userId, walletId)).toBe(1);
    expect(await intents(walletId)).toHaveLength(1);

    // The positive control: the SAME call with the version the caller actually
    // read succeeds, so the refusal above was the version CAS and not a broken
    // fixture.
    const ok = await svc.remove(userId, contactId, version, null);
    expect(ok.revocation.grantIds).toEqual([grantId]);
    expect(await contactState(contactId)).toBe("inactive");
  });

  it("refuses a contact that does not exist for this user without touching a grant", async () => {
    const { userId, version } = await scenario({ grants: [[ADDRESS_A]] });
    const { service: svc } = service();
    await expect(
      svc.remove(userId, randomUUID(), version, null),
    ).rejects.toBeInstanceOf(RecipientContactMissingError);
  });

  // -------------------------------------------------------------------------
  // W1 is the serialization point
  // -------------------------------------------------------------------------

  it("mutates nothing while another writer holds the wallet lease, then succeeds once it is released", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A]],
    });
    const grantId = grantIds[0]!;

    // A second connection takes W1 for real, for this wallet.
    const holder = await database.query<{ lease_token: string }>(
      `SELECT lease_token FROM acquire_recipient_policy_lease($1, $2, $3, 60)`,
      [walletId, userId, "other-writer"],
    );
    expect(holder.rows[0]!.lease_token).toBeTruthy();

    const { service: svc } = service();
    const refusal = await svc
      .remove(userId, contactId, version, null)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(RecipientPolicyNotSerializedError);
    expect((refusal as RecipientPolicyNotSerializedError).reason).toBe(
      "policy_lease_busy",
    );

    // Nothing moved: the lease is not a retry hint, it is the writer gate.
    expect(await contactState(contactId)).toBe("active");
    expect((await grantRow(grantId)).state).toBe("active");
    expect(await grantRevokeAudits(grantId)).toEqual([]);
    expect(await desiredRevision(userId, walletId)).toBe(1);
    expect(await intents(walletId)).toHaveLength(1);

    // Positive control: release and the very same removal goes through, so the
    // refusal above was the lease and not a failure in the removal itself.
    await database.query(`SELECT release_recipient_policy_lease($1, $2)`, [
      walletId,
      holder.rows[0]!.lease_token,
    ]);
    const done = await svc.remove(userId, contactId, version, null);
    expect(done.revocation.grantIds).toEqual([grantId]);
    expect((await grantRow(grantId)).state).toBe("revoked");
  });

  // -------------------------------------------------------------------------
  // A composition refusal is a stop, not a rollback of the revocation
  // -------------------------------------------------------------------------

  it("keeps the committed revocation when the composition stops, and records the stop with no new revision", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      // One grant is affected (revoked whole); the second stays active, so the
      // post-mutation composition is ordinary + grant rules again.
      grants: [[ADDRESS_A], [ADDRESS_B]],
      // U1 is NOT proven here: the composer must refuse that coexistence.
      recordUnion: false,
    });
    const [affected, surviving] = grantIds as [string, string];

    const { service: svc } = service();
    const refusal = await svc
      .remove(userId, contactId, version, null)
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(PolicyRuleCompositionUnprovenError);

    // The safe direction survives: authority the user revoked is still revoked.
    expect(await contactState(contactId)).toBe("inactive");
    expect((await grantRow(affected)).state).toBe("revoked");
    expect((await grantRevokeAudits(affected)).map((row) => row.event)).toEqual([
      "revoked",
    ]);
    // The surviving grant is untouched, and no new revision or intent was
    // recorded: the stop is the recorded outcome.
    expect((await grantRow(surviving)).state).toBe("active");
    expect(await desiredRevision(userId, walletId)).toBe(1);
    expect(await intents(walletId)).toHaveLength(1);
    const state = await repository.readPolicyState(userId, walletId);
    expect(state!.status).toBe("blocked_configuration");
    expect(state!.statusReason).toBe("rule_composition_semantics_unproven");
  });

  // -------------------------------------------------------------------------
  // The abort-and-restart guard (design §1.6 step 6)
  // -------------------------------------------------------------------------

  it("restarts on a stale plan instead of disclosing a revocation it did not perform", async () => {
    const { userId, walletId, contactId, version, grantIds } = await scenario({
      grants: [[ADDRESS_A]],
    });
    const grantId = grantIds[0]!;

    // The race: a second active alias for ADDRESS_A appears AFTER Phase A has
    // read the alias set but BEFORE the transaction locks it.
    let raced = 0;
    const racing = repositoryRacingAnAlias(async () => {
      raced += 1;
      await database.withUserTransaction(userId, (client) =>
        contacts.create(
          userId,
          {
            name: "Raced Alias",
            description: "",
            address: ADDRESS_A,
            network: "solana-devnet",
          },
          client,
        ),
      );
    });
    const { service: svc } = service({ repository: racing });

    const result = await svc.remove(userId, contactId, version, null);

    // Positive control: the race really did run, exactly once.
    expect(raced).toBe(1);
    expect(await contactState(contactId)).toBe("inactive");

    // The removal restarted and re-planned: the address is still covered by the
    // raced alias, so the grant keeps its authority and no revoke audit exists.
    expect((await grantRow(grantId)).state).toBe("active");
    expect(await grantRevokeAudits(grantId)).toEqual([]);
    expect(result.revocation.grantIds).toEqual([]);

    // And the disclosure is the RE-planned one: it names no affected grant. A
    // removal that skipped the abort check would disclose the stale plan (the
    // grant it never revoked) while performing nothing.
    const disclosure = (await policyAudits(userId, walletId)).filter(
      (row) => row.event === "revocation_disclosed",
    );
    expect(disclosure).toHaveLength(1);
    const detail = disclosure[0]!.detail as {
      affectedGrantIds: string[];
      revokedGrantIds: string[];
    };
    expect(detail.affectedGrantIds).toEqual([]);
    expect(detail.revokedGrantIds).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Wallet without a ready permission
  // -------------------------------------------------------------------------

  it("archives the contact and records no revision when the wallet has no ready permission", async () => {
    const { userId, walletId } = await provision();
    await provisionSignerGrant(userId, walletId, [ADDRESS_C]);
    const { service: svc } = service();
    const created = await svc.create(userId, {
      name: "Trusted No Wallet",
      description: "",
      address: ADDRESS_A,
    });
    // The wallet is no longer ready, so there is no policy to serialize.
    await database.query(
      `UPDATE user_wallets SET state = 'unavailable' WHERE id = $1`,
      [walletId],
    );

    const result = await svc.remove(userId, created.contact.id, created.contact.version, null);

    expect(await contactState(created.contact.id)).toBe("inactive");
    expect(result.policyRevision).toBe(0);
    expect(result.permission.state).toBe("saved_not_configured");
    expect(result.revocation).toEqual({ grantIds: [], state: "pending" });
  });
});

/**
 * The disclosure projection's decision table (design §9.2, §12, spec "A pending
 * removal is not announced as a verified revocation").
 *
 * The `applied` row is reachable ONLY through the already-fail-closed
 * `projectContactPermission`, which is why a state row claiming `applied` with no
 * `verified_at`, or one whose applied revision is behind the desired one, can
 * never produce a verified-revocation claim.
 */
describe("projectRevocationDisclosure (task 1.7)", () => {
  const stateRow = (
    overrides: Partial<PolicyStateRecord> = {},
  ): PolicyStateRecord => ({
    walletId: "00000000-0000-0000-0000-000000000001",
    userId: "00000000-0000-0000-0000-000000000002",
    desiredRevision: 4,
    appliedRevision: 4,
    desiredRulesHash: "sha256:new",
    appliedRulesHash: "sha256:applied",
    appliedPolicyId: "pol-1",
    appliedSignerId: "signer-1",
    appliedSignerIds: ["signer-1"],
    appliedRecipients: [],
    consentBaseline: [],
    consentProvenance: {},
    emptyComposition: "unproven",
    status: "applied",
    statusReason: null,
    statusDetail: {},
    attemptCount: 0,
    nextAttemptAt: null,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  });

  const applied: ContactPermissionSnapshot = {
    state: "applied",
    desiredRevision: 4,
    appliedRevision: 4,
    retryable: false,
  };

  it("reports applied only when the permission projection itself is verified", () => {
    expect(projectRevocationDisclosure(["g1"], applied)).toEqual({
      grantIds: ["g1"],
      state: "applied",
    });
  });

  it("reports pending when no readback has verified the removed scope", () => {
    expect(
      projectRevocationDisclosure(["g1"], {
        state: "pending",
        desiredRevision: 5,
        appliedRevision: 4,
        retryable: true,
      }),
    ).toEqual({ grantIds: ["g1"], state: "pending" });
  });

  it("reports a retryable failure as retryable, never as applied", () => {
    expect(
      projectRevocationDisclosure(["g1"], {
        state: "retryable_failure",
        desiredRevision: 5,
        appliedRevision: 4,
        retryable: true,
      }),
    ).toEqual({ grantIds: ["g1"], state: "retryable_failure" });
  });

  it("cannot be driven to applied by a state row that claims it without a verified readback", () => {
    // The row claims `applied`; `projectContactPermission` collapses it because
    // `verified_at` is missing, so the disclosure can only be pending.
    expect(
      projectRevocationDisclosure(
        ["g1"],
        projectContactPermission(stateRow({ verifiedAt: null })),
      ),
    ).toEqual({ grantIds: ["g1"], state: "pending" });
  });

  it("cannot be driven to applied by a state row whose applied revision is behind the desired one", () => {
    expect(
      projectRevocationDisclosure(
        ["g1"],
        projectContactPermission(
          stateRow({ appliedRevision: 3, desiredRevision: 4 }),
        ),
      ),
    ).toEqual({ grantIds: ["g1"], state: "pending" });
  });

  it("discloses no grant ids when nothing was affected", () => {
    expect(projectRevocationDisclosure([], applied)).toEqual({
      grantIds: [],
      state: "applied",
    });
  });
});
