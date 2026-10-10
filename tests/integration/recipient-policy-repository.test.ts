/**
 * Task 1.3 — the recipient policy repository (design §2.1–§2.5, §1.5).
 *
 * WHY THIS SUITE DRIVES THE REAL DATABASE
 * ---------------------------------------
 * The repository's value is not "does the SELECT return my row". Three of its
 * guarantees only exist in the database and cannot be faked:
 *
 *   1. **Revision safety (§1.5).** The compare-and-set is the only reason a
 *      stale writer cannot overwrite a newer applied revision. A repository test
 *      against a double would prove nothing, because the guard IS the SQL
 *      predicate.
 *   2. **The three partial/unique intent indexes (§2.2).** "One in flight per
 *      wallet" and "one intent per (wallet, revision)" are database facts; a
 *      service that forgets to supersede must fail loudly, not silently race.
 *   3. **Exactly-once consumption (§2.3, §4.5).** The conditional consume is
 *      proven under TWO real connections, so the second consumer blocks on the
 *      row lock and then re-evaluates the predicate against the committed row.
 *
 * Every negative assertion carries a positive control that runs first, so a
 * `false`/`null`/rejected result can never be a false green caused by a missing
 * relation, a hidden row or an unprovisioned fixture.
 *
 * AUTHORITY (the carried-over trap)
 * ---------------------------------
 * Task 1.2 proved that a system-context read on `recipient_policy_state` was
 * silently blind until an additive SELECT-only policy existed. This suite
 * therefore states the repository's authority explicitly per access path:
 *
 *   * owner paths  (state, intent insert/supersede, audit, proposals, contacts,
 *     `signer_grants`) run as `recipient_app` with `app.user_id` set;
 *   * the ONLY system-context paths are the reconciler's due scan and in-flight
 *     claim on `recipient_policy_sync_intent`, which the `015` migration already
 *     grants `FOR ALL` (`recipient_policy_sync_intent_system_access`);
 *   * a system-context audit append is asserted to be REFUSED, so this unit adds
 *     no authority it cannot demonstrate. Slice 2 must add the matching policy
 *     deliberately if its `lease_reclaimed` append needs it.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  ContactActionProposalConflictError,
  PolicyIntentIdempotencyConflictError,
  PolicyIntentInFlightError,
  PolicyIntentRevisionConflictError,
  PolicyStateMissingError,
  PolicyWalletNotOwnedError,
  RecipientPolicyRepository,
} from "../../src/wallet/policy/repository.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

/** `recipients.embedding` is `vector(384)`; fixtures never read it back. */
const ZERO_EMBEDDING = `[${Array.from({ length: 384 }, () => "0").join(",")}]`;

suite("recipient policy repository (task 1.3)", () => {
  // Two real pools: contention and cross-user isolation must be exercised by two
  // actual backends, not by two calls on one connection.
  let database: DatabaseClient;
  let secondConnection: DatabaseClient;
  let repository: RecipientPolicyRepository;
  let secondRepository: RecipientPolicyRepository;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    secondConnection = createDatabaseClient(databaseUrl!);
    repository = new RecipientPolicyRepository(database);
    secondRepository = new RecipientPolicyRepository(secondConnection);
  });

  afterAll(async () => {
    await Promise.all([database.close(), secondConnection.close()]);
  });

  /** user + `ready` solana wallet, provisioned as the migration owner. */
  async function provision(): Promise<{ userId: string; walletId: string }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:rpr-${randomUUID()}`, "RPR Repository Test"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    return { userId, walletId: wallet.rows[0]!.id };
  }

  /** A saved contact. `network: null` is the legacy EVM row (migration 012). */
  async function provisionContact(
    userId: string,
    input: {
      address?: string;
      network?: "solana-devnet" | null;
      status?: "active" | "inactive";
      version?: number;
      name?: string;
    } = {},
  ): Promise<string> {
    const contact = await database.query<{ id: string }>(
      `INSERT INTO recipients
         (user_id, name, normalized_name, description, address, network, embedding,
          embedding_model_revision, provenance, address_confirmed_at, status, version)
       VALUES ($1, $2, $2, '', $3, $4, $5::vector, 'test', '{}'::jsonb, now(), $6, $7)
       RETURNING id`,
      [
        userId,
        input.name ?? "Contact",
        input.address ?? `${randomUUID()}.sol`,
        input.network === undefined ? "solana-devnet" : input.network,
        ZERO_EMBEDDING,
        input.status ?? "active",
        input.version ?? 1,
      ],
    );
    return contact.rows[0]!.id;
  }

  /** An enrollment-style `signer_grants` row (columns from migration 006). */
  async function provisionSignerGrant(
    userId: string,
    walletId: string,
    state: "active" | "revoked",
    allowlisted: string[],
    /** Explicit age in minutes, so "newest active" is unambiguous. */
    ageMinutes = 0,
  ): Promise<string> {
    const grant = await database.query<{ id: string }>(
      `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
          allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
          rolling_window_seconds, gas_ceiling, state, created_at)
       VALUES ($1, $2, 'policy-old', 'signer-old', 'hash-old', $3::jsonb,
               '10000000', '10000000', 3600, '1000000', $4,
               now() - make_interval(mins => $5::int))
       RETURNING id`,
      [userId, walletId, JSON.stringify(allowlisted), state, ageMinutes],
    );
    return grant.rows[0]!.id;
  }

  /**
   * `signer_grants` is owner-isolated (migration 006) with no system policy, so
   * a system-context read is silently blind — zero rows and no error, exactly the
   * trap task 1.2 hit on `recipient_policy_state`. Fixture readbacks therefore run
   * in owner scope.
   */
  async function readSignerGrants(
    userId: string,
    walletId: string,
  ): Promise<
    Array<{ id: string; policy_hash: string; allowlisted_recipients: string[] }>
  > {
    return database.withUserTransaction(userId, async (client) => {
      const result = await client.query<{
        id: string;
        policy_hash: string;
        allowlisted_recipients: string[];
      }>(
        `SELECT id, policy_hash, allowlisted_recipients FROM signer_grants
          WHERE wallet_id = $1 ORDER BY created_at, id`,
        [walletId],
      );
      return result.rows;
    });
  }

  describe("recipient_policy_state", () => {
    it("creates the wallet row on the W0 lock and records the desired revision with its hash", async () => {
      const { userId, walletId } = await provision();

      // Positive control for the `null` below: the row genuinely does not exist.
      expect(await repository.readPolicyState(userId, walletId)).toBeNull();

      const created = await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );
      expect(created.walletId).toBe(walletId);
      expect(created.desiredRevision).toBe(0);
      expect(created.appliedRevision).toBe(0);
      expect(created.status).toBe("saved_not_configured");

      // A second lock is a no-op on an existing row, never a second row and
      // never a reset of the revision the wallet already reached.
      const again = await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );
      expect(again.walletId).toBe(walletId);

      const desired = await repository.bumpDesiredRevision(userId, {
        walletId,
        desiredRulesHash: "hash-1",
      });
      expect(desired).toBe(1);

      const state = await repository.readPolicyState(userId, walletId);
      expect(state!.desiredRevision).toBe(1);
      expect(state!.desiredRulesHash).toBe("hash-1");
      // A new desired revision may not keep claiming `applied`: the additive
      // `recipient_policy_state_applied_complete_ck` from task 1.1 makes that
      // status lie impossible at the database level, so the bump must move the
      // status to `pending` in the same statement.
      expect(state!.status).toBe("pending");
      expect(state!.appliedRevision).toBe(0);
    });

    it("applies a revision through the compare-and-set and refuses a stale desired revision", async () => {
      const { userId, walletId } = await provision();

      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );
      expect(
        await repository.bumpDesiredRevision(userId, {
          walletId,
          desiredRulesHash: "hash-1",
        }),
      ).toBe(1);

      // Positive control: the CAS at the CURRENT desired revision succeeds, so
      // the `false` asserted later is the revision guard and not a repository
      // that never applies anything.
      const applied = await repository.commitAppliedRevision(userId, {
        walletId,
        desiredRevision: 1,
        appliedRulesHash: "hash-1",
        appliedPolicyId: "policy-1",
        appliedSignerId: "signer-1",
        appliedSignerIds: ["signer-1", "signer-sibling"],
        appliedRecipients: ["addr-one.sol"],
      });
      expect(applied).toBe(true);

      const afterApply = await repository.readPolicyState(userId, walletId);
      expect(afterApply!.appliedRevision).toBe(1);
      expect(afterApply!.status).toBe("applied");
      expect(afterApply!.appliedPolicyId).toBe("policy-1");
      expect(afterApply!.appliedSignerIds).toEqual(["signer-1", "signer-sibling"]);
      expect(afterApply!.appliedRecipients).toEqual(["addr-one.sol"]);
      expect(afterApply!.verifiedAt).not.toBeNull();

      // The intent moves on while the (now stale) holder still wants to apply 1.
      expect(
        await repository.bumpDesiredRevision(userId, {
          walletId,
          desiredRulesHash: "hash-2",
        }),
      ).toBe(2);

      const stale = await repository.commitAppliedRevision(userId, {
        walletId,
        desiredRevision: 1,
        appliedRulesHash: "hash-1",
        appliedPolicyId: "policy-stale",
        appliedSignerId: "signer-stale",
        appliedSignerIds: ["signer-stale"],
        appliedRecipients: ["addr-stale.sol"],
      });
      // Zero rows updated: the desired revision moved under the holder.
      expect(stale).toBe(false);

      const afterStale = await repository.readPolicyState(userId, walletId);
      // Nothing the stale writer carried may have landed.
      expect(afterStale!.appliedRevision).toBe(1);
      expect(afterStale!.appliedPolicyId).toBe("policy-1");
      expect(afterStale!.appliedSignerId).toBe("signer-1");
      expect(afterStale!.appliedRecipients).toEqual(["addr-one.sol"]);
      expect(afterStale!.status).toBe("pending");
      expect(afterStale!.desiredRevision).toBe(2);

      // A stale writer can never LOWER an applied revision either.
      expect(
        await repository.commitAppliedRevision(userId, {
          walletId,
          desiredRevision: 2,
          appliedRulesHash: "hash-2",
          appliedPolicyId: "policy-2",
          appliedSignerId: "signer-1",
          appliedSignerIds: ["signer-1"],
          appliedRecipients: ["addr-one.sol", "addr-two.sol"],
        }),
      ).toBe(true);
      expect(
        await repository.commitAppliedRevision(userId, {
          walletId,
          desiredRevision: 1,
          appliedRulesHash: "hash-1",
          appliedPolicyId: "policy-stale",
          appliedSignerId: "signer-stale",
          appliedSignerIds: [],
          appliedRecipients: [],
        }),
      ).toBe(false);
      const finalState = await repository.readPolicyState(userId, walletId);
      expect(finalState!.appliedRevision).toBe(2);
      expect(finalState!.appliedPolicyId).toBe("policy-2");
    });

    it("holds the W0 row lock against a second connection until the holder commits", async () => {
      const { userId, walletId } = await provision();
      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );

      // Hold W0 open on the first connection while the second one tries.
      let releaseHolder!: () => void;
      const holderHolds = new Promise<void>((resolve) => {
        releaseHolder = resolve;
      });
      const holder = database.withUserTransaction(userId, async (client) => {
        await repository.lockPolicyState(userId, walletId, client);
        await holderHolds;
      });

      try {
        // A bounded wait, so a lock that is genuinely exclusive fails fast
        // instead of hanging the suite.
        await expect(
          secondConnection.withUserTransaction(userId, async (client) => {
            await client.query(`SET LOCAL lock_timeout = '200ms'`);
            return repository.lockPolicyState(userId, walletId, client);
          }),
        ).rejects.toThrow();
      } finally {
        releaseHolder();
        await holder.catch(() => undefined);
      }

      // Positive control: once the holder commits, the same lock succeeds, so
      // the timeout above was contention and not a permanently unusable row.
      const afterRelease = await secondConnection.withUserTransaction(
        userId,
        (client) => repository.lockPolicyState(userId, walletId, client),
      );
      expect(afterRelease.walletId).toBe(walletId);
    });

    it("re-applies the CURRENT desired revision but never a stale one", async () => {
      const { userId, walletId } = await provision();
      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );
      await repository.bumpDesiredRevision(userId, {
        walletId,
        desiredRulesHash: "hash-1",
      });
      const apply = (revision: number, policyId: string) =>
        repository.commitAppliedRevision(userId, {
          walletId,
          desiredRevision: revision,
          appliedRulesHash: `hash-${revision}`,
          appliedPolicyId: policyId,
          appliedSignerId: "signer-1",
          appliedSignerIds: ["signer-1"],
          appliedRecipients: [],
        });

      expect(await apply(1, "policy-1")).toBe(true);
      // The guard is the REVISION, not "apply at most once": re-applying the
      // revision that is still current is idempotent (design §3.5 step 8 skips
      // the PATCH when the pristine readback already equals the composition).
      expect(await apply(1, "policy-1")).toBe(true);

      await repository.bumpDesiredRevision(userId, {
        walletId,
        desiredRulesHash: "hash-2",
      });
      expect(await apply(1, "policy-1-stale")).toBe(false);
      expect((await repository.readPolicyState(userId, walletId))!.appliedRevision).toBe(1);
    });

    it("records a blocked status transition with its bounded evidence and attempt bookkeeping", async () => {
      const { userId, walletId } = await provision();
      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );

      const blocked = await repository.setPolicyStatus(userId, {
        walletId,
        status: "retryable_failure",
        reason: "provider_timeout",
        detail: { code: "provider_timeout", policyId: "policy-1" },
        incrementAttempt: true,
      });
      expect(blocked!.status).toBe("retryable_failure");
      expect(blocked!.statusReason).toBe("provider_timeout");
      expect(blocked!.statusDetail).toEqual({
        code: "provider_timeout",
        policyId: "policy-1",
      });
      expect(blocked!.attemptCount).toBe(1);

      const retried = await repository.setPolicyStatus(userId, {
        walletId,
        status: "syncing",
        incrementAttempt: true,
      });
      // The increment is relative, so a second attempt must not report 1 again.
      expect(retried!.attemptCount).toBe(2);
      // ...and the transition no longer erases the stored detail: `status_detail`
      // is MERGED (jsonb `||`), because probe evidence recorded in it must survive
      // a status write (the defect task 1.7 handed forward; design §11).
      expect(retried!.statusDetail).toEqual({
        code: "provider_timeout",
        policyId: "policy-1",
      });
      expect(retried!.statusReason).toBeNull();
    });

    it("records the U1 rules_union and U4 empty_composition probe evidence so neither survives only until the next write", async () => {
      const { userId, walletId } = await provision();
      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );

      // The probe paths (design §11): `status_detail` for the U1/U2/U3 evidence
      // and the `empty_composition` column for U4.
      expect(
        await repository.mergePolicyStatusDetail(userId, walletId, {
          rules_union: "union",
          rules_union_evidence: { at: "2026-10-05T12:00:00.000Z" },
          attachment_evidence: { occurrences: 1 },
        }),
      ).toBe(true);
      expect(
        await repository.setEmptyComposition(userId, walletId, "proven_deny"),
      ).toBe(true);

      const recorded = await repository.readPolicyState(userId, walletId);
      expect(recorded!.statusDetail["rules_union"]).toBe("union");
      expect(recorded!.emptyComposition).toBe("proven_deny");

      // A foreign user can neither record nor overwrite this wallet's evidence.
      const foreign = await provision();
      expect(
        await repository.mergePolicyStatusDetail(foreign.userId, walletId, {
          rules_union: "unproven",
        }),
      ).toBe(false);
      expect(
        await repository.setEmptyComposition(
          foreign.userId,
          walletId,
          "unproven",
        ),
      ).toBe(false);

      // A later status write merges: the recorded probe evidence is still there
      // and the transition's own key overrides only its own key.
      const afterWrite = await repository.setPolicyStatus(userId, {
        walletId,
        status: "pending",
        detail: { code: "provider_unavailable" },
      });
      expect(afterWrite!.statusDetail).toEqual({
        code: "provider_unavailable",
        rules_union: "union",
        rules_union_evidence: { at: "2026-10-05T12:00:00.000Z" },
        attachment_evidence: { occurrences: 1 },
      });
      expect(afterWrite!.emptyComposition).toBe("proven_deny");
    });

    it("denies cross-user reads and writes on recipient_policy_state", async () => {
      const { userId, walletId } = await provision();
      const foreign = await provision();
      await database.withUserTransaction(userId, (client) =>
        repository.lockPolicyState(userId, walletId, client),
      );
      await repository.bumpDesiredRevision(userId, {
        walletId,
        desiredRulesHash: "hash-owner",
      });

      // Positive control: the owner sees its own row.
      expect((await repository.readPolicyState(userId, walletId))!.desiredRevision).toBe(1);

      expect(await repository.readPolicyState(foreign.userId, walletId)).toBeNull();

      // A foreign W0 lock fails closed: the wallet is not owned by this user, so
      // there is nothing to serialize and no row may be planted for it.
      await expect(
        secondConnection.withUserTransaction(foreign.userId, (client) =>
          repository.lockPolicyState(foreign.userId, walletId, client),
        ),
      ).rejects.toThrow(PolicyWalletNotOwnedError);

      await expect(
        repository.bumpDesiredRevision(foreign.userId, {
          walletId,
          desiredRulesHash: "hash-foreign",
        }),
      ).rejects.toThrow(PolicyStateMissingError);

      // Positive control for the error class above: an OWNED wallet with no state
      // row yet is `PolicyStateMissingError` ("nothing to bump"), which is a
      // different failure from "not yours".
      const ownedButEmpty = await provision();
      await expect(
        repository.bumpDesiredRevision(ownedButEmpty.userId, {
          walletId: ownedButEmpty.walletId,
          desiredRulesHash: "hash-early",
        }),
      ).rejects.toThrow(PolicyStateMissingError);

      // ...and no foreign lock could have created the row it was refused.
      expect(await repository.readPolicyState(foreign.userId, walletId)).toBeNull();

      expect(
        await repository.setPolicyStatus(foreign.userId, {
          walletId,
          status: "pending",
        }),
      ).toBeNull();

      // Row isolation is `USING` for reads/updates: a foreign UPDATE matches no
      // row at all.
      const foreignUpdate = await secondConnection.withUserTransaction(
        foreign.userId,
        (client) =>
          client.query(
            `UPDATE recipient_policy_state SET desired_revision = 99
              WHERE wallet_id = $1`,
            [walletId],
          ),
      );
      expect(foreignUpdate.rowCount).toBe(0);

      // ...and `WITH CHECK` refuses a row that would carry the owner's identity.
      await expect(
        secondConnection.withUserTransaction(foreign.userId, (client) =>
          client.query(
            `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision)
             VALUES ($1, $2, 5)`,
            [walletId, userId],
          ),
        ),
      ).rejects.toThrow();

      // The owner's row is intact: no foreign value landed in any direction.
      const ownerState = await repository.readPolicyState(userId, walletId);
      expect(ownerState!.desiredRevision).toBe(1);
      expect(ownerState!.desiredRulesHash).toBe("hash-owner");
    });
  });

  describe("recipient_policy_sync_intent", () => {
    it("keeps one intent per (wallet, revision) and one in flight, releasing the slot only on an explicit supersede", async () => {
      const { userId, walletId } = await provision();

      const first = await repository.insertIntent(userId, {
        walletId,
        desiredRevision: 1,
        origin: "screen",
        action: "create",
        composedRules: [],
        composedHash: "hash-1",
      });
      expect(first.desiredRevision).toBe(1);
      expect(first.state).toBe("pending");

      // The wallet already has an in-flight intent: a second mutation must
      // supersede it explicitly rather than race it.
      await expect(
        repository.insertIntent(userId, {
          walletId,
          desiredRevision: 2,
          origin: "screen",
          composedRules: [],
          composedHash: "hash-2",
        }),
      ).rejects.toThrow(PolicyIntentInFlightError);

      // Positive control for the supersede below: the row exists and is still in
      // the in-flight state the index is protecting.
      expect(
        (
          await database.withSystemTransaction((client) =>
            client.query<{ state: string }>(
              `SELECT state FROM recipient_policy_sync_intent WHERE id = $1`,
              [first.id],
            ),
          )
        ).rows[0]!.state,
      ).toBe("pending");

      expect(
        await repository.supersedeIntent(userId, {
          walletId,
          intentId: first.id,
        }),
      ).toBe(true);
      const superseded = await database.withSystemTransaction((client) =>
        client.query<{ state: string }>(
          `SELECT state FROM recipient_policy_sync_intent WHERE id = $1`,
          [first.id],
        ),
      );
      expect(superseded.rows[0]!.state).toBe("superseded");

      const second = await repository.insertIntent(userId, {
        walletId,
        desiredRevision: 2,
        origin: "screen",
        composedRules: [],
        composedHash: "hash-2",
      });
      expect(second.desiredRevision).toBe(2);

      // `(wallet_id, desired_revision)` is unique across ALL states: a superseded
      // revision cannot be re-recorded, so the reconciler never sees two
      // different intents claiming the same revision.
      await repository.supersedeIntent(userId, { walletId, intentId: second.id });
      await expect(
        repository.insertIntent(userId, {
          walletId,
          desiredRevision: 1,
          origin: "reconciler",
          composedRules: [],
          composedHash: "hash-1-rewritten",
        }),
      ).rejects.toThrow(PolicyIntentRevisionConflictError);

      // Superseding is not re-runnable: a terminal row stays terminal, so a
      // retried mutation cannot free a slot it never held.
      expect(
        await repository.supersedeIntent(userId, {
          walletId,
          intentId: second.id,
        }),
      ).toBe(false);

      // A second wallet is unaffected: the index is per wallet, not global.
      const other = await provision();
      const otherIntent = await repository.insertIntent(other.userId, {
        walletId: other.walletId,
        desiredRevision: 1,
        origin: "screen",
        composedRules: [],
        composedHash: "hash-1",
      });
      expect(otherIntent.walletId).toBe(other.walletId);
    });

    it("rejects a replayed idempotency key instead of recording a second mutation", async () => {
      const { userId, walletId } = await provision();
      const key = `idem-${randomUUID()}`;

      const first = await repository.insertIntent(userId, {
        walletId,
        desiredRevision: 1,
        origin: "screen",
        composedRules: [],
        composedHash: "hash-1",
        idempotencyKey: key,
      });
      expect(first.idempotencyKey).toBe(key);

      // Clear the in-flight slot so the ONLY thing the second insert can violate
      // is the idempotency index (the previous case proved the in-flight one).
      await repository.supersedeIntent(userId, { walletId, intentId: first.id });

      await expect(
        repository.insertIntent(userId, {
          walletId,
          desiredRevision: 2,
          origin: "screen",
          composedRules: [],
          composedHash: "hash-2",
          idempotencyKey: key,
        }),
      ).rejects.toThrow(PolicyIntentIdempotencyConflictError);
    });

    it("refuses to record an intent, an audit row or a proposal for a wallet the user does not own", async () => {
      const { userId } = await provision();
      const foreign = await provision();

      // Positive control: the owner records all three for its own wallet.
      await expect(
        repository.insertIntent(foreign.userId, {
          walletId: foreign.walletId,
          desiredRevision: 1,
          origin: "screen",
          composedRules: [],
          composedHash: "hash-1",
        }),
      ).resolves.toMatchObject({ walletId: foreign.walletId });

      // RLS checks `user_id = app.user_id`, which a caller satisfies trivially by
      // naming itself. It cannot know whether the wallet id it also names is
      // really that user's — so without an ownership guard a foreign wallet could
      // be planted in the owner's own scope. Each write proves ownership instead.
      await expect(
        repository.insertIntent(userId, {
          walletId: foreign.walletId,
          desiredRevision: 1,
          origin: "screen",
          composedRules: [],
          composedHash: "hash-1",
        }),
      ).rejects.toThrow(PolicyWalletNotOwnedError);

      await expect(
        repository.appendPolicyAudit(userId, {
          walletId: foreign.walletId,
          event: "intent_recorded",
          desiredRevision: 1,
        }),
      ).rejects.toThrow(PolicyWalletNotOwnedError);

      await expect(
        repository.insertProposal(userId, {
          walletId: foreign.walletId,
          conversationId: randomUUID(),
          action: "create",
          address: "ForeignWalletSo1anaAddress",
          proposalHash: "proposal-hash",
          origin: "text",
          expiresAt: new Date(Date.now() + 10 * 60_000),
        }),
      ).rejects.toThrow(PolicyWalletNotOwnedError);

      // ...and nothing was planted: the owner of that wallet sees no such row.
      expect(await repository.listDueIntents({ walletId: foreign.walletId, limit: 50 })).toHaveLength(1);
      expect(await repository.readPolicyState(userId, foreign.walletId)).toBeNull();
    });

    it("claims a due intent from the system context and leaves a foreign user unable to see it", async () => {
      const { userId, walletId } = await provision();
      const foreign = await provision();
      const intent = await repository.insertIntent(userId, {
        walletId,
        desiredRevision: 1,
        origin: "screen",
        composedRules: [],
        composedHash: "hash-1",
      });

      // The reconciler runs with no `app.user_id`, so it must be able to
      // enumerate due intents across wallets and resolve each owner. That is the
      // `recipient_policy_sync_intent_system_access` policy from `015` — this
      // unit adds no authority for it.
      const due = await repository.listDueIntents({ limit: 50 });
      const mine = due.find((row) => row.id === intent.id);
      expect(mine).toBeDefined();
      expect(mine!.userId).toBe(userId);

      const claimed = await repository.claimIntent({
        walletId,
        desiredRevision: 1,
      });
      expect(claimed!.state).toBe("applying");
      expect(claimed!.lastAttemptAt).not.toBeNull();

      // The wallet-scoped pass sees the claimed row, and the system scan is not
      // the only way to reach it.
      expect(await repository.listDueIntents({ walletId, limit: 50 })).toEqual([
        expect.objectContaining({ id: intent.id, state: "applying" }),
      ]);

      // A backed-off intent is not due: the scan must not livelock on a retry
      // deadline the reconciler itself set.
      await database.withSystemTransaction((client) =>
        client.query(
          `UPDATE recipient_policy_sync_intent
              SET next_attempt_at = now() + interval '1 hour'
            WHERE id = $1`,
          [intent.id],
        ),
      );
      expect(await repository.listDueIntents({ walletId, limit: 50 })).toEqual([]);

      // Positive control: clearing the deadline makes it due again, so the empty
      // list above is the backoff and not a broken scan.
      await database.withSystemTransaction((client) =>
        client.query(
          `UPDATE recipient_policy_sync_intent
              SET next_attempt_at = NULL
            WHERE id = $1`,
          [intent.id],
        ),
      );
      expect(await repository.listDueIntents({ walletId, limit: 50 })).toEqual([
        expect.objectContaining({ id: intent.id }),
      ]);

      // A wallet with nothing to claim is `null`, never a fabricated claim.
      expect(
        await repository.claimIntent({ walletId, desiredRevision: 99 }),
      ).toBeNull();

      expect(
        await secondConnection.withUserTransaction(foreign.userId, (client) =>
          client.query<{ id: string }>(
            `SELECT id FROM recipient_policy_sync_intent WHERE id = $1`,
            [intent.id],
          ),
        ),
      ).toMatchObject({ rowCount: 0 });

      // A foreign user cannot supersede (and therefore cannot free) the slot.
      expect(
        await secondRepository.supersedeIntent(foreign.userId, {
          walletId,
          intentId: intent.id,
        }),
      ).toBe(false);
      expect(await repository.listDueIntents({ walletId, limit: 50 })).toEqual([
        expect.objectContaining({ id: intent.id, state: "applying" }),
      ]);
    });
  });

  describe("composer contact reads", () => {
    it("returns only active chain-scoped Solana contacts with their version", async () => {
      const { userId } = await provision();
      const foreign = await provision();

      const wanted = await provisionContact(userId, {
        address: "IncludedSo1anaAddress",
        version: 3,
      });
      await provisionContact(userId, { address: "InactiveSo1anaAddress", status: "inactive" });
      await provisionContact(userId, { address: "0xLegacyEvmAddress", network: null });
      await provisionContact(foreign.userId, { address: "ForeignSo1anaAddress" });

      const contacts = await repository.listComposerContacts(userId);
      expect(contacts).toEqual([
        { id: wanted, version: 3, address: "IncludedSo1anaAddress" },
      ]);
    });
  });

  describe("recipient_policy_audit", () => {
    it("appends owner-scoped audit evidence and keeps it owner-scoped", async () => {
      const { userId, walletId } = await provision();
      const foreign = await provision();

      const auditId = await repository.appendPolicyAudit(userId, {
        walletId,
        event: "intent_recorded",
        desiredRevision: 1,
        detail: { origin: "screen" },
      });
      expect(auditId).toBeTruthy();

      const rows = await database.withUserTransaction(userId, (client) =>
        client.query<{ event: string; reason: string | null }>(
          `SELECT event, reason FROM recipient_policy_audit WHERE id = $1`,
          [auditId],
        ),
      );
      expect(rows.rows[0]!.event).toBe("intent_recorded");

      expect(
        await secondConnection.withUserTransaction(foreign.userId, (client) =>
          client.query(`SELECT id FROM recipient_policy_audit WHERE id = $1`, [
            auditId,
          ]),
        ),
      ).toMatchObject({ rowCount: 0 });

      // The append-only trigger from task 1.1 survives the repository: evidence
      // is written once and never edited.
      await expect(
        database.withUserTransaction(userId, (client) =>
          client.query(
            `UPDATE recipient_policy_audit SET reason = 'rewritten' WHERE id = $1`,
            [auditId],
          ),
        ),
      ).rejects.toThrow();
    });

    it("refuses a system-context audit append, which is why this unit adds no system write authority", async () => {
      const { userId, walletId } = await provision();

      // Positive control: the same append succeeds for the owner, so the refusal
      // below is the RLS `WITH CHECK` on `recipient_policy_audit`, not a broken
      // statement.
      const owned = await repository.appendPolicyAudit(userId, {
        walletId,
        event: "intent_recorded",
        desiredRevision: 1,
      });
      expect(owned).toBeTruthy();

      // `recipient_policy_audit` stays owner-isolated exactly as task 1.1 left
      // it. The repository therefore appends audits only from owner-scoped
      // transactions; slice 2's `lease_reclaimed` append must either re-scope to
      // the resolved owner inside its system transaction (the established
      // ingestion pattern) or add an explicit policy here — and this assertion is
      // the guard that makes that choice visible instead of accidental.
      await expect(
        database.withSystemTransaction((client) =>
          repository.appendPolicyAudit(
            userId,
            { walletId, event: "lease_reclaimed", desiredRevision: 1 },
            client,
          ),
        ),
      ).rejects.toThrow();
    });
  });

  describe("contact_action_proposals", () => {
    it("inserts an immutable versioned proposal and refuses a foreign reader", async () => {
      const { userId, walletId } = await provision();
      const foreign = await provision();
      const conversationId = randomUUID();

      const expiresAt = new Date(Date.now() + 10 * 60_000);
      const proposal = await repository.insertProposal(userId, {
        walletId,
        conversationId,
        action: "remove",
        contactId: null,
        address: "ProposalSo1anaAddress",
        revokedGrantIds: [randomUUID()],
        proposalHash: "proposal-hash",
        origin: "voice",
        expiresAt,
      });
      expect(proposal.version).toBe(1);
      expect(proposal.status).toBe("open");
      expect(proposal.origin).toBe("voice");
      expect(proposal.revokedGrantIds).toHaveLength(1);
      expect(proposal.expiresAt).toBe(expiresAt.toISOString());

      // Positive control: the owner reads exactly the row it persisted.
      const read = await repository.readProposal(userId, proposal.id);
      expect(read).toEqual(proposal);

      expect(await repository.readProposal(foreign.userId, proposal.id)).toBeNull();
      expect(
        await secondRepository.consumeProposal(foreign.userId, {
          proposalId: proposal.id,
          version: 1,
          consumedByTool: "foreign",
        }),
      ).toBeNull();
      expect((await repository.readProposal(userId, proposal.id))!.status).toBe("open");
    });

    it("consumes a proposal exactly once under two concurrent connections", async () => {
      const { userId, walletId } = await provision();
      const proposal = await repository.insertProposal(userId, {
        walletId,
        conversationId: randomUUID(),
        action: "create",
        address: "ConsumedSo1anaAddress",
        proposalHash: "proposal-hash",
        origin: "text",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });

      // Two real backends race the conditional UPDATE. The loser blocks on the
      // row lock and then re-evaluates `status='open' AND consumed_at IS NULL`
      // against the committed row, so exactly one consume can win.
      const [first, second] = await Promise.all([
        repository.consumeProposal(userId, {
          proposalId: proposal.id,
          version: 1,
          consumedByTool: "contacts_create",
          consumedBySession: "session-a",
        }),
        secondRepository.consumeProposal(userId, {
          proposalId: proposal.id,
          version: 1,
          consumedByTool: "contacts_create",
          consumedBySession: "session-b",
        }),
      ]);

      const winners = [first, second].filter((result) => result !== null);
      // Positive control: the race produced exactly one consumption, not zero...
      expect(winners).toHaveLength(1);
      expect(winners[0]!.status).toBe("consumed");
      expect(winners[0]!.consumedAt).not.toBeNull();
      // ...and exactly one refusal, not two successful consumes.
      expect([first, second].filter((result) => result === null)).toHaveLength(1);

      const persisted = await repository.readProposal(userId, proposal.id);
      expect(persisted!.status).toBe("consumed");
      expect(persisted!.consumedBySession).toBe(winners[0]!.consumedBySession);
      // A third attempt (e.g. a retried tool call) is refused for the same
      // reason: the proposal is no longer open.
      expect(
        await repository.consumeProposal(userId, {
          proposalId: proposal.id,
          version: 1,
          consumedByTool: "contacts_create",
        }),
      ).toBeNull();
    });

    it("refuses an expired, superseded or stale-version proposal", async () => {
      const { userId, walletId } = await provision();

      const expired = await repository.insertProposal(userId, {
        walletId,
        conversationId: randomUUID(),
        action: "create",
        address: "ExpiredSo1anaAddress",
        proposalHash: "proposal-hash",
        origin: "text",
        expiresAt: new Date(Date.now() - 60_000),
      });
      expect(
        await repository.consumeProposal(userId, {
          proposalId: expired.id,
          version: 1,
          consumedByTool: "contacts_create",
        }),
      ).toBeNull();
      // The refused consume wrote nothing.
      expect((await repository.readProposal(userId, expired.id))!.status).toBe("open");

      const live = await repository.insertProposal(userId, {
        walletId,
        conversationId: randomUUID(),
        action: "address_change",
        address: "LiveSo1anaAddress",
        proposalHash: "proposal-hash",
        origin: "screen",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });

      // A stale version can never consume the live row (design §4.7): the
      // identity of a consumable proposal is `(id, version)`.
      expect(
        await repository.consumeProposal(userId, {
          proposalId: live.id,
          version: 2,
          consumedByTool: "contacts_create",
        }),
      ).toBeNull();

      // Positive control: the correct version does consume it.
      expect(
        await repository.consumeProposal(userId, {
          proposalId: live.id,
          version: 1,
          consumedByTool: "contacts_create",
        }),
      ).not.toBeNull();
    });

    it("keeps one open proposal per conversation and frees the slot on consumption", async () => {
      const { userId, walletId } = await provision();
      const conversationId = randomUUID();
      const otherConversationId = randomUUID();

      const open = await repository.insertProposal(userId, {
        walletId,
        conversationId,
        action: "create",
        address: "FirstSo1anaAddress",
        proposalHash: "proposal-hash",
        origin: "text",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });

      // The cross-process "one window at a time" rule (design §2.3).
      await expect(
        repository.insertProposal(userId, {
          walletId,
          conversationId,
          action: "create",
          address: "SecondSo1anaAddress",
          proposalHash: "proposal-hash",
          origin: "text",
          expiresAt: new Date(Date.now() + 10 * 60_000),
        }),
      ).rejects.toThrow(ContactActionProposalConflictError);

      // Positive control: the index is per conversation, not global.
      const sibling = await repository.insertProposal(userId, {
        walletId,
        conversationId: otherConversationId,
        action: "create",
        address: "SiblingSo1anaAddress",
        proposalHash: "proposal-hash",
        origin: "text",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      expect(sibling.status).toBe("open");

      // Consuming the open row frees the slot for the next version.
      await repository.consumeProposal(userId, {
        proposalId: open.id,
        version: 1,
        consumedByTool: "contacts_create",
      });
      const next = await repository.insertProposal(userId, {
        walletId,
        conversationId,
        action: "address_change",
        address: "ThirdSo1anaAddress",
        previousAddress: "FirstSo1anaAddress",
        version: 2,
        supersedesId: open.id,
        proposalHash: "proposal-hash",
        origin: "text",
        expiresAt: new Date(Date.now() + 10 * 60_000),
      });
      expect(next.version).toBe(2);
      expect(next.supersedesId).toBe(open.id);
    });
  });

  describe("signer_grants projection refresh", () => {
    it("refreshes only the newest active grant, leaves every other row alone, and is a no-op without one", async () => {
      const { userId, walletId } = await provision();
      const older = await provisionSignerGrant(userId, walletId, "active", ["old.sol"], 30);
      const newer = await provisionSignerGrant(userId, walletId, "active", ["old.sol"], 1);
      const revoked = await provisionSignerGrant(userId, walletId, "revoked", ["revoked.sol"], 0);

      const refreshed = await repository.refreshSignerGrantProjection(userId, {
        walletId,
        allowlistedRecipients: ["one.sol", "two.sol"],
        policyHash: "hash-new",
      });
      expect(refreshed).toBe(newer);
      // Positive control: the refresh really wrote the newer row, so the
      // "untouched" assertions for the other two cannot pass by idleness.
      expect((await readSignerGrants(userId, walletId)).length).toBe(3);

      const rows = await readSignerGrants(userId, walletId);
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(newer)!.policy_hash).toBe("hash-new");
      expect(byId.get(newer)!.allowlisted_recipients).toEqual(["one.sol", "two.sol"]);
      // The older active row and the revoked row are untouched: the projection
      // follows the newest ACTIVE enrollment only.
      expect(byId.get(older)!.policy_hash).toBe("hash-old");
      expect(byId.get(older)!.allowlisted_recipients).toEqual(["old.sol"]);
      expect(byId.get(revoked)!.policy_hash).toBe("hash-old");
      expect(byId.get(revoked)!.allowlisted_recipients).toEqual(["revoked.sol"]);

      // A wallet with no active enrollment has nothing to refresh: the honest
      // answer is "nothing refreshed", never a fabricated row.
      const fresh = await provision();
      expect(
        await repository.refreshSignerGrantProjection(fresh.userId, {
          walletId: fresh.walletId,
          allowlistedRecipients: ["none.sol"],
          policyHash: "hash-new",
        }),
      ).toBeNull();
    });

    it("denies a foreign user the projection refresh", async () => {
      const { userId, walletId } = await provision();
      const foreign = await provision();
      const grant = await provisionSignerGrant(userId, walletId, "active", ["old.sol"]);

      // Positive control: the owner refresh really writes.
      expect(
        await repository.refreshSignerGrantProjection(userId, {
          walletId,
          allowlistedRecipients: ["owner.sol"],
          policyHash: "hash-owner",
        }),
      ).toBe(grant);

      expect(
        await secondRepository.refreshSignerGrantProjection(foreign.userId, {
          walletId,
          allowlistedRecipients: ["foreign.sol"],
          policyHash: "hash-foreign",
        }),
      ).toBeNull();

      const rows = await readSignerGrants(userId, walletId);
      expect(rows.find((row) => row.id === grant)!.policy_hash).toBe("hash-owner");
      expect(rows.find((row) => row.id === grant)!.allowlisted_recipients).toEqual([
        "owner.sol",
      ]);
    });
  });
});
