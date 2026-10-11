/**
 * Task 7.1 — the drift write itself (design §5.2, catch: the guarded `UPDATE`).
 *
 * WHY THIS ONE NEEDS THE DATABASE
 * -------------------------------
 * The guard is SQL. Its whole reason to exist is the window between the read
 * (`SELECT`) and the write (`UPDATE`), and no double can reproduce it: a port
 * stub that returns `false` asserts only that the caller handles a boolean, not
 * that a concurrent edit actually produces zero rows.
 *
 * So the resolver here IS the racing writer: it edits the contact's own row
 * (address, then provenance name) after the service has read it and before the
 * service writes. If the `address` / `provenance->>'name'` predicates were
 * removed, the drift claim would land on a row it no longer describes and these
 * tests fail.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer } from "../fixtures/test-server.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import type { SnsResolver } from "../../src/wallet/sns/resolver.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const SOPHIE_NAME = "sophie.sns";
const SOPHIE_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const MOVED_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const LEASE_CONTENTION_CODES = ["policy_lease_busy", "policy_lease_unavailable"];

/**
 * A resolver that resolves elsewhere AND performs the concurrent edit first, so
 * the edit lands exactly inside the window the guard covers.
 */
function racingResolver(input: {
  database: DatabaseClient;
  contactId: () => string;
  edit: (contactId: string) => Promise<void>;
}): SnsResolver {
  return {
    async resolve(name: string) {
      await input.edit(input.contactId());
      return {
        ok: true as const,
        value: {
          name,
          address: MOVED_ADDRESS,
          nameAccount: NAME_ACCOUNT,
          observedOwner: MOVED_ADDRESS,
          observedParent: DEVNET_ROOT,
          slot: 455_410_529,
          resolvedAt: "2026-10-10T18:04:11.482Z",
          resolver: "sns/solana-devnet/v3",
          reverseDomain: null,
          reverseDomainState: "none" as const,
        },
      };
    },
    async reverseLookup() {
      return { ok: true as const, value: { name: null, unknown: false } };
    },
  };
}

function stableResolver(): SnsResolver {
  return {
    async resolve(name: string) {
      return {
        ok: true as const,
        value: {
          name,
          address: SOPHIE_ADDRESS,
          nameAccount: NAME_ACCOUNT,
          observedOwner: SOPHIE_ADDRESS,
          observedParent: DEVNET_ROOT,
          slot: 455_410_529,
          resolvedAt: "2026-10-10T18:04:11.482Z",
          resolver: "sns/solana-devnet/v3",
          reverseDomain: null,
          reverseDomainState: "none" as const,
        },
      };
    },
    async reverseLookup() {
      return { ok: true as const, value: { name: null, unknown: false } };
    },
  };
}

suite("the guarded drift write (task 7.1)", () => {
  let database: DatabaseClient;
  const createdContactIds: string[] = [];
  const userIds: string[] = [];
  /**
   * A private user: the guard tests compare rows for ONE user, and a user another
   * suite can write to would make that comparison a flake rather than a fact.
   */
  let userId = "";
  let currentContactId = "";

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    userId = randomUUID();
    await database.query(`INSERT INTO users (id, privy_did) VALUES ($1, $2)`, [
      userId,
      `did:synthetic:${userId}`,
    ]);
    await database.query(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready')`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    userIds.push(userId);
  });

  afterAll(async () => {
    for (const contactId of createdContactIds) {
      await database.query(`DELETE FROM recipient_policy_sync_intent WHERE contact_id = $1`, [
        contactId,
      ]);
      await database.query(`DELETE FROM recipient_versions WHERE recipient_id = $1`, [contactId]);
      await database.query(`DELETE FROM recipients WHERE id = $1`, [contactId]);
    }
    for (const id of userIds) {
      // An audit row is append-only by trigger and references BOTH the wallet and
      // the user, so a user whose check wrote evidence cannot be removed. The
      // synthetic identity is left in place instead of failing cleanup; it holds
      // no contact and no grant.
      const audits = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM recipient_policy_audit WHERE user_id = $1`,
        [id],
      );
      if (Number(audits.rows[0]!.count) > 0) continue;
      await database.query(`DELETE FROM delegated_grants WHERE user_id = $1`, [id]);
      await database.query(`DELETE FROM recipient_policy_state WHERE user_id = $1`, [id]);
      await database.query(`DELETE FROM user_wallets WHERE user_id = $1`, [id]);
      await database.query(`DELETE FROM users WHERE id = $1`, [id]);
    }
  });

  async function createAliasContact(app: ReturnType<typeof buildTestServer>) {
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: { "content-type": "application/json" },
        payload: {
          name: `Sofía guard ${randomUUID().slice(0, 8)}`,
          description: "",
          source: "sns",
          snsName: SOPHIE_NAME,
          expectedAddress: SOPHIE_ADDRESS,
        },
      });
      const code = response.json()?.error?.code;
      if (response.statusCode !== 409 || !LEASE_CONTENTION_CODES.includes(code)) {
        expect(response.statusCode, response.body).toBe(201);
        const contact = response.json().data as { id: string };
        createdContactIds.push(contact.id);
        currentContactId = contact.id;
        return contact;
      }
      await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
    }
    throw new Error("policy lease stayed busy for the whole bounded retry");
  }

  const provenanceOf = async (contactId: string) => {
    const result = await database.query<{ provenance: Record<string, unknown>; address: string }>(
      `SELECT provenance, address FROM recipients WHERE user_id = $1 AND id = $2`,
      [userId, contactId],
    );
    return result.rows[0]!;
  };

  const auditCount = async (contactId: string) => {
    const result = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recipient_policy_audit
        WHERE user_id = $1 AND detail->>'contactId' = $2`,
      [userId, contactId],
    );
    return Number(result.rows[0]!.count);
  };

  it("a concurrent address edit makes the drift write a no-op, reported as unavailable", async () => {
    const seeding = buildTestServer({ userId, recipientAliases: stableResolver() });
    const contact = await createAliasContact(seeding);
    const before = await provenanceOf(contact.id);

    // The race: the user replaces the address after the check read the row.
    const racing = buildTestServer({
      userId,
      recipientAliases: racingResolver({
        database,
        contactId: () => currentContactId,
        edit: async (contactId) => {
          await database.query(
            `UPDATE recipients SET address = $3 WHERE user_id = $1 AND id = $2`,
            [userId, contactId, MOVED_ADDRESS],
          );
        },
      }),
    });

    const response = await racing.inject({
      method: "POST",
      url: `/v1/contacts/${currentContactId}/check-alias`,
    });

    expect(response.statusCode, response.body).toBe(200);
    // Never `changed`: the comparison no longer describes the row that exists.
    expect(response.json().data.state).toBe("unavailable");
    expect(response.json().data.reason).toBe("contact_changed");

    const after = await provenanceOf(contact.id);
    expect(after.provenance).not.toHaveProperty("drift");
    expect(after.address).toBe(MOVED_ADDRESS);
    expect(await auditCount(contact.id)).toBe(0);
    expect(before.provenance).not.toHaveProperty("drift");
  });

  it("a concurrent provenance rewrite makes the drift write a no-op too", async () => {
    const seeding = buildTestServer({ userId, recipientAliases: stableResolver() });
    const contact = await createAliasContact(seeding);

    // The other half of the guard: the row is no longer about THIS alias, so the
    // claim must be skipped rather than attached to a different name claim.
    const racing = buildTestServer({
      userId,
      recipientAliases: racingResolver({
        database,
        contactId: () => currentContactId,
        edit: async (contactId) => {
          await database.query(
            `UPDATE recipients
                SET provenance = jsonb_set(provenance, '{name}', '"otro.sns"'::jsonb, true)
              WHERE user_id = $1 AND id = $2`,
            [userId, contactId],
          );
        },
      }),
    });

    const response = await racing.inject({
      method: "POST",
      url: `/v1/contacts/${currentContactId}/check-alias`,
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data.state).toBe("unavailable");
    expect(response.json().data.reason).toBe("contact_changed");

    const after = await provenanceOf(contact.id);
    expect(after.provenance).not.toHaveProperty("drift");
    expect((after.provenance as { name: string }).name).toBe("otro.sns");
    expect(await auditCount(contact.id)).toBe(0);
  });
});
