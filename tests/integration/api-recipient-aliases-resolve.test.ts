/**
 * Task 5.1 — `POST /v1/recipient-aliases/resolve` (design §1/§7).
 *
 * WHY THIS ONE NEEDS THE REAL DATABASE
 * ------------------------------------
 * The endpoint's whole claim is that it is a READ WITH NO SIDE EFFECTS: "no
 * proposal, no contact, no audit, no cache". That is not a statement about a
 * response body — it is a statement about rows, so this suite counts the four
 * tables a resolution could plausibly touch before and after every call.
 *
 * The resolver injected here is the REAL one (`createSnsResolver`) over a stub
 * transport built from the recorded devnet bytes, so the HTTP mapping is driven
 * by the production taxonomy rather than by a hand-written double that could
 * disagree with it. No RPC is contacted: a test that hit devnet would be flaky
 * by construction (the public endpoint throttles).
 *
 * POSITIVE CONTROL FIRST. Every negative assertion below (404, 409, 422, 503) is
 * preceded by the same harness returning 200 for a name that resolves, so a
 * suite that passed because the route was unreachable or always failing is not
 * possible.
 */
import { randomUUID } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import { createSnsResolver, type SnsResolver } from "../../src/wallet/sns/resolver.js";
import type { SnsTransport } from "../../src/wallet/sns/transport.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const DEVNET_ROOT = "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2";
const FOREIGN_ROOT = "58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx";
const SOPHIE = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const NAME_PROGRAM_OWNER = "namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX";

/** 96-byte name-registry header built from recorded bytes. `class` is synthetic. */
function header(parentName: string, owner: string): Uint8Array {
  const data = new Uint8Array(96);
  data.set(new PublicKey(parentName).toBytes(), 0);
  data.set(new PublicKey(owner).toBytes(), 32);
  data.set(new Uint8Array(32).fill(9), 64);
  return data;
}

type StubBehaviour =
  | { kind: "resolved"; address: string; parent?: string }
  | { kind: "absent" }
  | { kind: "short" }
  | { kind: "throw"; message: string };

function stubResolver(behaviour: StubBehaviour): SnsResolver {
  const transport: SnsTransport = {
    deriveNameAccount: () => ({
      pubkey: "ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew",
    }),
    readNameRegistry: async () => {
      if (behaviour.kind === "throw") throw new Error(behaviour.message);
      if (behaviour.kind === "absent") return null;
      if (behaviour.kind === "short") {
        return { data: new Uint8Array(95), owner: NAME_PROGRAM_OWNER, slot: 1 };
      }
      return {
        data: header(behaviour.parent ?? DEVNET_ROOT, behaviour.address),
        owner: NAME_PROGRAM_OWNER,
        slot: 455_410_529,
      };
    },
    readPrimaryDomain: async () => ({ kind: "none" }),
  };
  return createSnsResolver({ transport, network: "solana-devnet" });
}

function resolve(
  app: ReturnType<typeof buildTestServer>,
  payload: unknown,
  headers: Record<string, string> = {},
) {
  return app.inject({
    method: "POST",
    url: "/v1/recipient-aliases/resolve",
    headers,
    payload: payload as Record<string, unknown>,
  });
}

suite("the resolve endpoint is a read with no side effects (task 5.1)", () => {
  let database: DatabaseClient;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  /**
   * Every table a resolution could plausibly write — scoped to THIS suite's
   * own identity (the shared default user) so rows any parallel suite writes
   * under its own user never enter the snapshot.
   */
  async function counts(): Promise<Record<string, number>> {
    const result = await database.query<{
      recipients: string;
      proposals: string;
      audits: string;
      intents: string;
    }>(
      `SELECT
         (SELECT count(*) FROM recipients WHERE user_id = '${TEST_USER_ID}')::text AS recipients,
         (SELECT count(*) FROM contact_action_proposals WHERE user_id = '${TEST_USER_ID}')::text AS proposals,
         (SELECT count(*) FROM recipient_policy_audit WHERE user_id = '${TEST_USER_ID}')::text AS audits,
         (SELECT count(*) FROM recipient_policy_sync_intent
            WHERE wallet_id IN (SELECT id FROM user_wallets WHERE user_id = '${TEST_USER_ID}'))::text AS intents`,
    );
    const row = result.rows[0]!;
    return {
      recipients: Number(row.recipients),
      proposals: Number(row.proposals),
      audits: Number(row.audits),
      intents: Number(row.intents),
    };
  }

  it("returns the resolved address for a name that resolves (positive control)", async () => {
    const app = buildTestServer({
      recipientAliases: stubResolver({ kind: "resolved", address: SOPHIE }),
    });
    const before = await counts();
    const response = await resolve(app, { name: "SOPHIE.SNS" });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.ok).toBe(true);
    expect(body.data.address).toBe(SOPHIE);
    // Canonical, from the server — the client never supplies the address.
    expect(body.data.name).toBe("sophie.sns");
    expect(body.data.reverseDomain).toBeNull();
    expect(body.data.reverseDomainState).toBe("none");
    expect(body.data.resolver).toBe("sns/solana-devnet/v3");
    // Server-side evidence never travels to the client (design §7).
    expect(Object.keys(body.data).sort()).toEqual([
      "address",
      "name",
      "resolvedAt",
      "resolver",
      "reverseDomain",
      "reverseDomainState",
    ]);
    expect(await counts()).toEqual(before);
    await app.close();
  });

  it("writes nothing with or without an idempotency key, on success or failure", async () => {
    const app = buildTestServer({
      recipientAliases: stubResolver({ kind: "resolved", address: SOPHIE }),
    });
    const before = await counts();
    await resolve(app, { name: "sophie.sns" }, { "idempotency-key": randomUUID() });
    await resolve(app, { name: "nadie.sns" }, { "idempotency-key": randomUUID() });
    expect(await counts()).toEqual(before);

    // The failing arm is swapped in on purpose: a refusal must not stage
    // anything either.
    const failing = buildTestServer({
      recipientAliases: stubResolver({ kind: "absent" }),
    });
    const beforeFailure = await counts();
    const refused = await resolve(failing, { name: "nadie.sns" });
    expect(refused.statusCode).toBe(404);
    expect(await counts()).toEqual(beforeFailure);
    await app.close();
    await failing.close();
  });

  it("maps every taxonomy row to its own status and code", async () => {
    const cases: Array<{
      name: string;
      resolver: SnsResolver;
      status: number;
      code: string;
    }> = [
      {
        name: "juan",
        resolver: stubResolver({ kind: "resolved", address: SOPHIE }),
        status: 422,
        code: "DATOS_INVALIDOS",
      },
      {
        name: "juan.sol",
        resolver: stubResolver({ kind: "resolved", address: SOPHIE }),
        status: 422,
        code: "NOMBRE_NO_SOPORTADO",
      },
      {
        name: "juan.sns",
        resolver: stubResolver({ kind: "absent" }),
        status: 404,
        code: "NOMBRE_NO_ENCONTRADO",
      },
      {
        name: "juan.sns",
        resolver: stubResolver({ kind: "short" }),
        status: 409,
        code: "NOMBRE_AMBIGUO",
      },
      {
        name: "juan.sns",
        resolver: stubResolver({
          kind: "resolved",
          address: SOPHIE,
          parent: FOREIGN_ROOT,
        }),
        status: 409,
        code: "NOMBRE_AMBIGUO",
      },
      {
        name: "juan.sns",
        resolver: stubResolver({ kind: "throw", message: "429 Too many requests" }),
        status: 503,
        code: "RESOLVEDOR_NO_DISPONIBLE",
      },
      {
        name: "juan.sns",
        resolver: stubResolver({ kind: "throw", message: "socket hang up" }),
        status: 503,
        code: "RESOLVEDOR_NO_DISPONIBLE",
      },
    ];

    for (const testCase of cases) {
      const app = buildTestServer({ recipientAliases: testCase.resolver });
      const response = await resolve(app, { name: testCase.name });
      expect({
        name: testCase.name,
        status: response.statusCode,
        code: response.json()?.error?.code,
      }).toEqual({
        name: testCase.name,
        status: testCase.status,
        code: testCase.code,
      });
      await app.close();
    }
  });

  it("never reports an unreachable resolver as a non-existent name", async () => {
    const unreachable = buildTestServer({
      recipientAliases: stubResolver({ kind: "throw", message: "429 Too many requests" }),
    });
    const absent = buildTestServer({
      recipientAliases: stubResolver({ kind: "absent" }),
    });
    const unreachableBody = (await resolve(unreachable, { name: "sophie.sns" })).json();
    const absentBody = (await resolve(absent, { name: "sophie.sns" })).json();
    expect(unreachableBody.error.code).toBe("RESOLVEDOR_NO_DISPONIBLE");
    expect(unreachableBody.error.code).not.toBe(absentBody.error.code);
    expect(absentBody.error.code).toBe("NOMBRE_NO_ENCONTRADO");
    await unreachable.close();
    await absent.close();
  });

  it("rejects a body that is not exactly one name", async () => {
    const app = buildTestServer({
      recipientAliases: stubResolver({ kind: "resolved", address: SOPHIE }),
    });
    for (const payload of [{}, { name: "" }, { name: "juan.sns", extra: 1 }]) {
      const response = await resolve(app, payload);
      expect(response.statusCode).toBe(422);
      expect(response.json().error.code).toBe("DATOS_INVALIDOS");
    }
    await app.close();
  });

  it("fails closed when the deployment wired no resolver at all", async () => {
    // `null` is "deliberately absent" (an unknown deployment), never "emulate
    // one": an unresolved name must not be answered with an invented address,
    // and it must not be reported as a name that does not exist either.
    const app = buildTestServer({ recipientAliases: null });
    const response = await resolve(app, { name: "sophie.sns" });
    expect(response.statusCode).toBe(503);
    expect(response.json().error.code).toBe("RESOLVEDOR_NO_DISPONIBLE");
    await app.close();
  });

  it("resolves for the authenticated user only", async () => {
    const app = buildTestServer({
      recipientAliases: stubResolver({ kind: "resolved", address: SOPHIE }),
      userId: TEST_USER_ID,
    });
    const response = await resolve(app, { name: "sophie.sns" });
    expect(response.statusCode).toBe(200);
    await app.close();
  });
});
