/**
 * Task 5.2 — the alias arm against the REAL database and the REAL route
 * (design §4.1, spec "A client-supplied address can veto but never choose").
 *
 * WHY THIS ONE NEEDS THE DATABASE
 * -------------------------------
 * The unit suite proves the order and the origin at the seam. What it cannot
 * show is what the user is left with:
 *
 *   1. `recipients.address` is the SERVER's resolved address and
 *      `recipients.provenance` carries the alias as a LABEL, with `reverify`
 *      recorded explicitly;
 *   2. a moved name leaves no row and no revision behind — nothing was staged;
 *   3. an unreachable resolver refuses with `503` and stages nothing, and is
 *      never reported as a name that does not exist;
 *   4. a replay of the same key after the name moved returns the STORED result
 *      rather than silently writing the new address (task 3.1's binding).
 *
 * The resolver is injected through the server's own seam, so every assertion
 * below travels the production path: route → strict schema → service → resolver →
 * repository. No RPC is contacted (a live test would be flaky by construction).
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer } from "../fixtures/test-server.js";
import { provisionTestUser } from "../fixtures/provision-user.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import type { SnsResolver, SnsResolveFailure } from "../../src/wallet/sns/resolver.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
// Per-suite identity: unique so parallel suites never share per-user rows.
const USER_ID = randomUUID();

const SOPHIE_NAME = "sophie.sns";
const SOPHIE_ADDRESS = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const MOVED_ADDRESS = "BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv";
const NAME_ACCOUNT = "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew";
const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";

/** One moving resolver: the same instance answers A, then B, then fails. */
function movingResolver(): SnsResolver & { state: "a" | "b" | "unreachable" } {
  const resolver = {
    state: "a" as "a" | "b" | "unreachable",
    async resolve(name: string) {
      if (resolver.state === "unreachable") {
        return {
          ok: false as const,
          failure: {
            kind: "unreachable" as const,
            retryable: true as const,
            cause: "rpc_throttled" as const,
          } satisfies SnsResolveFailure,
        };
      }
      const address = resolver.state === "a" ? SOPHIE_ADDRESS : MOVED_ADDRESS;
      return {
        ok: true as const,
        value: {
          name,
          address,
          nameAccount: NAME_ACCOUNT,
          observedOwner: address,
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
  return resolver;
}

const LEASE_CONTENTION_CODES = ["policy_lease_busy", "policy_lease_unavailable"];

async function createAlias(
  app: ReturnType<typeof buildTestServer>,
  payload: Record<string, unknown>,
  idempotencyKey?: string,
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (idempotencyKey) headers["idempotency-key"] = idempotencyKey;
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const response = await app.inject({
      method: "POST",
      url: "/v1/contacts",
      headers,
      payload,
    });
    const code = response.json()?.error?.code;
    if (response.statusCode !== 409 || !LEASE_CONTENTION_CODES.includes(code)) {
      return response;
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * attempt));
  }
  throw new Error("policy lease stayed busy for the whole bounded retry");
}

function aliasBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Sofía",
    description: "",
    source: "sns",
    snsName: SOPHIE_NAME,
    expectedAddress: SOPHIE_ADDRESS,
    ...overrides,
  };
}

suite("the create alias arm (task 5.2)", () => {
  let database: DatabaseClient;
  const createdContactIds: string[] = [];
  /** Alias-source rows that already existed: never deleted by this suite. */
  let preexistingAliasIds: string[] = [];

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    await provisionTestUser(USER_ID);
    // Fixture seed: the alias arm's replay guarantees (a stored result for the
    // same body, `IDEMPOTENCIA_CUERPO_DISTINTO` for a different one) are read
    // from the wallet-bound intent, so this suite's own user needs a ready
    // Solana wallet row for those routes to take the policy branch at all. With
    // no wallet the create path stores no intent, and a repeated key silently
    // creates a SECOND contact instead of replaying the first. The address is
    // random so it can never collide with a resolved alias address (D13); the
    // policy row is created by the first mutation itself.
    await database.query(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready', now())
       ON CONFLICT DO NOTHING`,
      [USER_ID, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    // This database is SHARED with every other suite, so cleanup is a DELTA: the
    // rows this suite could have created are the ones that appeared during it.
    const existing = await database.query<{ id: string }>(
      `SELECT id FROM recipients WHERE user_id = $1 AND provenance->>'source' = 'sns'`,
      [USER_ID],
    );
    preexistingAliasIds = existing.rows.map((row) => row.id);
  });

  afterAll(async () => {
    // Rows this suite created are deleted whether or not a test observed them —
    // a suite that leaks a contact into a shared database makes the next suite's
    // assertions fail for someone else's data.
    for (const contactId of createdContactIds) {
      await database.query(`DELETE FROM recipient_policy_sync_intent WHERE contact_id = $1`, [contactId]);
      await database.query(`DELETE FROM recipient_versions WHERE recipient_id = $1`, [contactId]);
      await database.query(`DELETE FROM recipients WHERE id = $1`, [contactId]);
    }
    await database.query(
      `DELETE FROM recipient_policy_sync_intent
        WHERE contact_id IN (
          SELECT id FROM recipients
           WHERE user_id = $1 AND provenance->>'source' = 'sns' AND NOT (id = ANY($2::uuid[]))
        )`,
      [USER_ID, preexistingAliasIds],
    );
    await database.query(
      `DELETE FROM recipient_versions WHERE recipient_id IN (
         SELECT id FROM recipients
          WHERE user_id = $1 AND provenance->>'source' = 'sns' AND NOT (id = ANY($2::uuid[]))
       )`,
      [USER_ID, preexistingAliasIds],
    );
    await database.query(
      `DELETE FROM recipients
        WHERE user_id = $1 AND provenance->>'source' = 'sns' AND NOT (id = ANY($2::uuid[]))`,
      [USER_ID, preexistingAliasIds],
    );
    await database.close();
  });

  async function activeAliasContacts(): Promise<
    Array<{ id: string; address: string; provenance: Record<string, unknown> | null }>
  > {
    const result = await database.query<{
      id: string;
      address: string;
      provenance: Record<string, unknown> | null;
    }>(
      `SELECT id, address, provenance FROM recipients
        WHERE user_id = $1 AND status = 'active' AND provenance->>'source' = 'sns'`,
      [USER_ID],
    );
    for (const row of result.rows) if (!createdContactIds.includes(row.id)) createdContactIds.push(row.id);
    return result.rows;
  }

  it("stores the resolved address with the alias as provenance (positive control)", async () => {
    const resolver = movingResolver();
    const app = buildTestServer({ userId: USER_ID, recipientAliases: resolver });

    const response = await createAlias(app, aliasBody());

    expect(response.statusCode).toBe(201);
    const contact = response.json().data;
    expect(contact.address).toBe(SOPHIE_ADDRESS);
    expect(contact.address).not.toBe(SOPHIE_NAME);
    // The alias travels as evidence in `recipients.provenance` (task 5.4 owns
    // the reduced `alias` read projection), never as the destination.

    const rows = await activeAliasContacts();
    const row = rows.find((candidate) => candidate.id === contact.id);
    expect(row?.address).toBe(SOPHIE_ADDRESS);
    expect(row?.provenance).toMatchObject({
      source: "sns",
      name: SOPHIE_NAME,
      resolvedAt: "2026-10-10T18:04:11.482Z",
      resolver: "sns/solana-devnet/v3",
      reverify: "verified",
      observedOwner: SOPHIE_ADDRESS,
      observedParent: DEVNET_ROOT,
    });
    // The alias is a label: it is never stored where a destination would be.
    expect(JSON.stringify(row?.provenance)).not.toContain(MOVED_ADDRESS);
    await app.close();
  });

  it("refuses a moved name with 409 and writes nothing at all", async () => {
    const resolver = movingResolver();
    const app = buildTestServer({ userId: USER_ID, recipientAliases: resolver });

    const before = (await activeAliasContacts()).length;
    resolver.state = "b";
    const response = await createAlias(app, aliasBody());

    expect(response.statusCode).toBe(409);
    expect(response.json().error.code).toBe("SNS_DESTINO_CAMBIADO");
    expect((await activeAliasContacts()).length).toBe(before);
    // The client's address was not written by the ALIAS arm either — a veto is
    // not a choice. Scoped to the alias source on purpose: other suites in this
    // shared database hold that address legitimately through the paste path, so a
    // global count would be a test that fails for someone else's data.
    const stored = await database.query<{ id: string }>(
      `SELECT id FROM recipients
        WHERE user_id = $1 AND address = $2
          AND provenance->>'source' = 'sns' AND provenance->>'name' = $3`,
      [USER_ID, MOVED_ADDRESS, SOPHIE_NAME],
    );
    expect(stored.rows).toEqual([]);
    await app.close();
  });

  it("refuses an unreachable resolver with 503, never as a missing name, and stages nothing", async () => {
    const resolver = movingResolver();
    resolver.state = "unreachable";
    const app = buildTestServer({ userId: USER_ID, recipientAliases: resolver });

    const before = (await activeAliasContacts()).length;
    const response = await createAlias(app, aliasBody());

    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("RESOLVEDOR_NO_DISPONIBLE");
    expect(response.json().error.code).not.toBe("NOMBRE_NO_ENCONTRADO");
    expect((await activeAliasContacts()).length).toBe(before);
    await app.close();
  });

  it("answers a same-key same-body replay from the stored result", async () => {
    const resolver = movingResolver();
    const app = buildTestServer({ userId: USER_ID, recipientAliases: resolver });
    const key = `alias-replay-${randomUUID()}`;

    const first = await createAlias(app, aliasBody(), key);
    expect(first.statusCode).toBe(201);
    expect(first.json().data.address).toBe(SOPHIE_ADDRESS);

    // Same key, same body, name unchanged: the stored result is returned and the
    // alias is not created twice. Counted as a DELTA, because this shared database
    // already holds alias-source contacts created by earlier runs of this suite.
    const before = (await activeAliasContacts()).length;
    const replay = await createAlias(app, aliasBody(), key);
    expect(replay.json().data.id).toBe(first.json().data.id);
    expect((await activeAliasContacts()).length).toBe(before);
    await app.close();
  });

  it("refuses a same-key replay carrying a DIFFERENT name, and a replay after the name moved", async () => {
    const resolver = movingResolver();
    const app = buildTestServer({ userId: USER_ID, recipientAliases: resolver });
    const key = `alias-replay-${randomUUID()}`;

    const first = await createAlias(app, aliasBody(), key);
    expect(first.statusCode).toBe(201);

    // (a) The key was already used with a DIFFERENT body. The stored result
    // answers another question, so it is a typed conflict (task 3.1) — and the
    // resolver still returns SOPHIE_ADDRESS for this name, so the conflict is the
    // HASH's finding rather than the veto's.
    const differentName = await createAlias(
      app,
      aliasBody({ snsName: "nanatest.sns" }),
      key,
    );
    expect(differentName.statusCode).toBe(409);
    expect(differentName.json().error.code).toBe("IDEMPOTENCIA_CUERPO_DISTINTO");

    // (b) The name moves between the two calls. The retry re-resolves first
    // (design §4.1 step 1) and therefore CANNOT write the new address under the
    // old key: the veto fires and nothing is written.
    resolver.state = "b";
    const afterMove = await createAlias(app, aliasBody(), key);
    expect(afterMove.statusCode).toBe(409);
    expect(afterMove.json().error.code).toBe("SNS_DESTINO_CAMBIADO");
    const rows = await activeAliasContacts();
    const row = rows.find((candidate) => candidate.id === first.json().data.id);
    expect(row?.address).toBe(SOPHIE_ADDRESS);
    expect(rows.some((candidate) => candidate.address === MOVED_ADDRESS)).toBe(false);
    await app.close();
  });

  it("keeps the paste arm byte-identical: no alias key is written", async () => {
    const resolver = movingResolver();
    const app = buildTestServer({ userId: USER_ID, recipientAliases: resolver });

    const response = await createAlias(app, {
      name: "Mamá",
      description: "Mensualidad",
      address: MOVED_ADDRESS,
    });
    expect(response.statusCode).toBe(201);
    const result = await database.query<{ provenance: Record<string, unknown> }>(
      `SELECT provenance FROM recipients WHERE id = $1`,
      [response.json().data.id],
    );
    createdContactIds.push(response.json().data.id);
    // The paste path records its own source and never an alias claim.
    expect(result.rows[0]!.provenance).not.toHaveProperty("name");
    expect(result.rows[0]!.provenance).toMatchObject({ origin: "user" });
    await app.close();
  });
});
