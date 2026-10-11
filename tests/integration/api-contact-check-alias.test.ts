/**
 * Task 7.1 — `POST /v1/contacts/:id/check-alias` against the REAL database and
 * the REAL route (design §5.2/§5.3, spec "A name that later resolves elsewhere
 * is drift, never an update").
 *
 * WHY THIS ONE NEEDS THE DATABASE
 * -------------------------------
 * The drift guarantee is not a response body, it is a set of ROWS that must stay
 * exactly as they were:
 *
 *   1. `recipients.provenance.drift` records what was observed;
 *   2. `recipients.address`, `applied_rules_hash` (`recipient_policy_state`) and
 *      `desired_revision` are UNTOUCHED by the report — the name is never followed;
 *   3. every `delegated_grants` row is untouched — no grant is revoked or created;
 *   4. exactly ONE append-only `alias_destination_changed` audit row is appended,
 *      and `drift_repaired` is never used (it asserts the opposite fact);
 *   5. a concurrent address edit makes the drift write a NO-OP rather than
 *      attaching a stale claim to a contact it no longer describes.
 *
 * So this suite reads the tables before and after each call. The resolver is
 * injected (no RPC: a live test would be flaky by construction) but the route,
 * the strict schemas, the service and the SQL are all production.
 *
 * POSITIVE CONTROL FIRST: the unchanged case at the top proves the harness can
 * reach the route and answer 200, so the refusals below are not a suite that
 * passes because nothing is wired.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer } from "../fixtures/test-server.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import type { SnsResolver, SnsResolveFailure } from "../../src/wallet/sns/resolver.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const SOPHIE_NAME = "sophie.sns";
const SOPHIE_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const MOVED_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const LEASE_CONTENTION_CODES = ["policy_lease_busy", "policy_lease_unavailable"];

type ResolverBehaviour =
  | { kind: "resolves"; address: string }
  | { kind: "not_found" }
  | { kind: "unreachable" };

/** The injected resolver: one answer, chosen per case. Never contacts an RPC. */
function stubResolver(behaviour: ResolverBehaviour): SnsResolver {
  return {
    async resolve(name: string) {
      if (behaviour.kind === "not_found") {
        return {
          ok: false as const,
          failure: { kind: "not_found" as const } satisfies SnsResolveFailure,
        };
      }
      if (behaviour.kind === "unreachable") {
        return {
          ok: false as const,
          failure: {
            kind: "unreachable" as const,
            retryable: true as const,
            cause: "rpc_throttled" as const,
          } satisfies SnsResolveFailure,
        };
      }
      return {
        ok: true as const,
        value: {
          name,
          address: behaviour.address,
          nameAccount: NAME_ACCOUNT,
          observedOwner: behaviour.address,
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

async function createAliasContact(app: ReturnType<typeof buildTestServer>) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { "content-type": "application/json" },
      payload: {
        name: `Sofía drift ${randomUUID().slice(0, 8)}`,
        description: "",
        source: "sns",
        snsName: SOPHIE_NAME,
        expectedAddress: SOPHIE_ADDRESS,
      },
    });
    const code = response.json()?.error?.code;
    if (response.statusCode !== 409 || !LEASE_CONTENTION_CODES.includes(code)) {
      expect(response.statusCode, response.body).toBe(201);
      return response.json().data as { id: string; address: string };
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error("policy lease stayed busy for the whole bounded retry");
}

function check(app: ReturnType<typeof buildTestServer>, contactId: string) {
  return app.inject({
    method: "POST",
    url: `/v1/contacts/${contactId}/check-alias`,
  });
}

/**
 * The suite works on its OWN users, provisioned here and removed afterwards.
 *
 * WHY: `recipient_policy_state` and `delegated_grants` are per-USER rows, and the
 * shared test database is read by every other suite in the same run. A "desired
 * revision was not advanced" assertion made against another suite's user is a
 * flake waiting to happen; against a user nobody else can see it is a fact. A
 * private user also lets the no-ready-wallet boundary below be exercised at all.
 */
async function provisionUser(database: DatabaseClient, input: { wallet: boolean }) {
  const userId = randomUUID();
  await database.query(`INSERT INTO users (id, privy_did) VALUES ($1, $2)`, [
    userId,
    `did:synthetic:${userId}`,
  ]);
  if (input.wallet) {
    await database.query(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready')`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
  }
  return userId;
}

suite("the explicit drift check (task 7.1)", () => {
  let database: DatabaseClient;
  const createdContactIds: string[] = [];
  const userIds: string[] = [];
  /** The user every case below acts as. It has a ready Solana wallet. */
  let userId = "";
  /** A second user with NO wallet: the design's stated audit boundary. */
  let walletlessUserId = "";

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    userId = await provisionUser(database, { wallet: true });
    walletlessUserId = await provisionUser(database, { wallet: false });
    userIds.push(userId, walletlessUserId);

    // NON-VACUITY: "no grant row was touched" is only a fact if a grant row
    // exists to be touched. The suite provisions one on the acting user, so the
    // `grantRows()` comparisons below are statements about a real row instead of
    // about an empty set. `provider_policy_id` is set because the drift path must
    // not touch it (task 7.1).
    const wallet = await database.query<{ id: string }>(
      `SELECT id FROM user_wallets WHERE user_id = $1`,
      [userId],
    );
    await database.query(
      `INSERT INTO delegated_grants
         (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
          window_seconds, recipients, state, provider_policy_id, expires_at)
       VALUES ($1, $2, 'transfer', 'solana-devnet', 1000, 10000, 86400,
               '[]'::jsonb, 'active', $3, now() + interval '1 day')`,
      [userId, wallet.rows[0]!.id, `fixture-policy-${randomUUID()}`],
    );
  });

  afterAll(async () => {
    // A shared database: remove exactly the rows this suite created. The audit
    // table is append-only by trigger, so audit evidence is scoped by contact id
    // instead of being deleted.
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

  const auditRows = async (contactId: string) => {
    const result = await database.query<{ event: string }>(
      `SELECT event FROM recipient_policy_audit
        WHERE user_id = $1 AND detail->>'contactId' = $2`,
      [userId, contactId],
    );
    return result.rows.map((row) => row.event);
  };

  const contactRow = async (contactId: string) => {
    const result = await database.query<{
      address: string;
      version: string;
      provenance: Record<string, unknown>;
    }>(
      `SELECT address, version::text AS version, provenance
         FROM recipients WHERE user_id = $1 AND id = $2`,
      [userId, contactId],
    );
    return result.rows[0]!;
  };

  const stateRows = async () => {
    const result = await database.query<{ desired_revision: string; applied_rules_hash: string | null }>(
      `SELECT desired_revision::text AS desired_revision, applied_rules_hash
         FROM recipient_policy_state WHERE user_id = $1`,
      [userId],
    );
    return result.rows;
  };

  const grantRows = async () => {
    const result = await database.query<{ id: string; provider_policy_id: string | null }>(
      `SELECT id, provider_policy_id FROM delegated_grants WHERE user_id = $1 ORDER BY id`,
      [userId],
    );
    return result.rows;
  };

  it("positive control: an unchanged name answers 200 and writes nothing at all", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });
    const contact = await createAliasContact(app);
    createdContactIds.push(contact.id);

    const before = await contactRow(contact.id);
    const response = await check(app, contact.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      data: { state: "unchanged", storedAddress: SOPHIE_ADDRESS },
    });

    const after = await contactRow(contact.id);
    expect(after.provenance).toEqual(before.provenance);
    expect(after.provenance).not.toHaveProperty("drift");
    expect(await auditRows(contact.id)).toEqual([]);
  });

  it("a moved name records the drift, one audit row, and changes nothing else", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });
    const contact = await createAliasContact(app);
    createdContactIds.push(contact.id);

    const before = await contactRow(contact.id);
    const beforeState = await stateRows();
    const beforeGrants = await grantRows();

    const moving = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: MOVED_ADDRESS }) });
    const response = await check(moving, contact.id);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json().data;
    expect(body.state).toBe("changed");
    expect(body.storedAddress).toBe(SOPHIE_ADDRESS);
    expect(body.observedAddress).toBe(MOVED_ADDRESS);
    expect(body.reason).toBe("destination_moved");

    // NON-VACUITY for the two "nothing else moved" comparisons below.
    expect(beforeState).toHaveLength(1);
    expect(beforeGrants.length).toBeGreaterThan(0);

    const after = await contactRow(contact.id);
    // 1. the stored destination is STILL the frozen one (never followed)...
    expect(after.address).toBe(SOPHIE_ADDRESS);
    expect(after.version).toBe(before.version);
    // 2. ...and the drift record is exactly the bounded three-key object.
    const drift = (after.provenance as { drift: Record<string, unknown> }).drift;
    expect(Object.keys(drift).sort()).toEqual(["observedAddress", "observedAt", "resolver"]);
    expect(drift.observedAddress).toBe(MOVED_ADDRESS);
    expect(drift.resolver).toBe("sns/solana-devnet/v3");
    expect(typeof drift.observedAt).toBe("string");
    // 3. the alias claim itself survives byte-for-byte: a drift report is not an
    //    address edit and must not clear the provenance.
    expect((after.provenance as { name: string }).name).toBe(SOPHIE_NAME);

    // 4. no recomposition, no revision advance, no grant touched.
    expect(await stateRows()).toEqual(beforeState);
    expect(await grantRows()).toEqual(beforeGrants);

    // 5. exactly one append-only row, with the drift event and NOT `drift_repaired`.
    const events = await auditRows(contact.id);
    expect(events).toEqual(["alias_destination_changed"]);
    expect(events).not.toContain("drift_repaired");
  });

  it("a name that no longer exists is reported honestly as changed", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });
    const contact = await createAliasContact(app);
    createdContactIds.push(contact.id);

    const missing = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "not_found" }) });
    const response = await check(missing, contact.id);

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json().data;
    expect(body.state).toBe("changed");
    expect(body.reason).toBe("name_no_longer_exists");
    // Nothing was observed, so no address is reported: absent is honest, invented
    // is not.
    expect(body).not.toHaveProperty("observedAddress");

    const after = await contactRow(contact.id);
    expect(after.address).toBe(SOPHIE_ADDRESS);
    expect((after.provenance as { drift: { observedAddress: unknown } }).drift.observedAddress).toBeNull();
    expect(await auditRows(contact.id)).toEqual(["alias_destination_changed"]);
  });

  it("an unreachable resolver is unavailable, never changed and never 'still fine'", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });
    const contact = await createAliasContact(app);
    createdContactIds.push(contact.id);

    const before = await contactRow(contact.id);
    const down = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "unreachable" }) });
    const response = await check(down, contact.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({
      state: "unavailable",
      storedAddress: SOPHIE_ADDRESS,
      reason: "unreachable",
    });

    // Neither claim may be written on a check that established nothing.
    const after = await contactRow(contact.id);
    expect(after.provenance).toEqual(before.provenance);
    expect(await auditRows(contact.id)).toEqual([]);
  });

  it("an unwired deployment answers unavailable instead of emulating a check", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });
    const contact = await createAliasContact(app);
    createdContactIds.push(contact.id);

    const unwired = buildTestServer({ userId, recipientAliases: null });
    const response = await check(unwired, contact.id);

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().data).toEqual({
      state: "unavailable",
      storedAddress: SOPHIE_ADDRESS,
      reason: "resolver_unavailable",
    });
    expect(await auditRows(contact.id)).toEqual([]);
  });

  it("refuses a contact with no alias claim, and reports a missing contact as missing", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });

    const pasted = await (async () => {
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/contacts",
          headers: { "content-type": "application/json" },
          payload: {
            name: `Pegado ${randomUUID().slice(0, 8)}`,
            address: MOVED_ADDRESS,
            network: "solana-devnet",
          },
        });
        const code = response.json()?.error?.code;
        if (response.statusCode !== 409 || !LEASE_CONTENTION_CODES.includes(code)) return response;
        await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
      }
      throw new Error("policy lease stayed busy for the whole bounded retry");
    })();
    expect(pasted.statusCode, pasted.body).toBe(201);
    const pastedId = pasted.json().data.id as string;
    createdContactIds.push(pastedId);

    const noAlias = await check(app, pastedId);
    expect(noAlias.statusCode, noAlias.body).toBe(409);
    expect(noAlias.json().error.code).toBe("CONTACTO_SIN_ALIAS");
    // The refusal is not an `unchanged`: that word reports a comparison, and none
    // was made. Nothing was written, including no drift record.
    expect((await contactRow(pastedId)).provenance).not.toHaveProperty("drift");

    const missing = await check(app, randomUUID());
    expect(missing.statusCode, missing.body).toBe(404);
    expect(missing.json().error.code).toBe("CONTACTO_NO_ENCONTRADO");
  });

  it("with no ready wallet the drift record is still written and no audit row is attempted", async () => {
    // The design §5.2 boundary, exercised instead of narrated:
    // `recipient_policy_audit.wallet_id` is NOT NULL, so an alias-origin contact
    // for a user with no Solana wallet can carry the drift record but not the
    // append-only trail. The state is still returned honestly.
    const walletless = buildTestServer({
      userId: walletlessUserId,
      recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }),
    });
    const response = await walletless.inject({
      method: "POST",
      url: "/v1/contacts",
      headers: { "content-type": "application/json" },
      payload: {
        name: `Sofía sin wallet ${randomUUID().slice(0, 8)}`,
        description: "",
        source: "sns",
        snsName: SOPHIE_NAME,
        expectedAddress: SOPHIE_ADDRESS,
      },
    });
    expect(response.statusCode, response.body).toBe(201);
    const contact = response.json().data as { id: string };
    createdContactIds.push(contact.id);

    const moved = buildTestServer({
      userId: walletlessUserId,
      recipientAliases: stubResolver({ kind: "resolves", address: MOVED_ADDRESS }),
    });
    const checkResponse = await moved.inject({
      method: "POST",
      url: `/v1/contacts/${contact.id}/check-alias`,
    });
    expect(checkResponse.statusCode, checkResponse.body).toBe(200);
    expect(checkResponse.json().data.state).toBe("changed");

    const result = await database.query<{ provenance: Record<string, unknown> }>(
      `SELECT provenance FROM recipients WHERE user_id = $1 AND id = $2`,
      [walletlessUserId, contact.id],
    );
    expect(result.rows[0]!.provenance).toHaveProperty("drift");

    const audits = await database.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM recipient_policy_audit
        WHERE user_id = $1 AND detail->>'contactId' = $2`,
      [walletlessUserId, contact.id],
    );
    expect(Number(audits.rows[0]!.count)).toBe(0);
  });

  it("is never consulted by a payment: the composed allowlist still carries the frozen address", async () => {
    const app = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: SOPHIE_ADDRESS }) });
    const contact = await createAliasContact(app);
    createdContactIds.push(contact.id);

    const moved = buildTestServer({ userId, recipientAliases: stubResolver({ kind: "resolves", address: MOVED_ADDRESS }) });
    const beforeGrants = await grantRows();
    const beforeState = await stateRows();
    expect((await check(moved, contact.id)).json().data.state).toBe("changed");

    // The compositor still reads `recipients.address`: the drift is a record, and
    // the recipient the user trusted is unchanged and still usable.
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM recipients
        WHERE user_id = $1 AND id = $2 AND status = 'active' AND address = $3`,
      [userId, contact.id, SOPHIE_ADDRESS],
    );
    expect(rows.rows).toHaveLength(1);
    expect(await grantRows()).toEqual(beforeGrants);
    expect(await stateRows()).toEqual(beforeState);
  });
});
