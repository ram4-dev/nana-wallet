import { generateKeyPairSync, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  PrivyServerClient,
  type PrivyFetch,
  type PrivyWalletRecord,
} from "../../src/wallet/privy-server-client.js";

/**
 * WP-003..WP-009 + WP-013: personal balances over real HTTP with Postgres/RLS.
 * Two identities get their own fixture balance; a foreign query is a 400, an
 * invalid identity is 401, every non-ready state is served without the reader,
 * a revoked grant does not block the read, and nothing financial is written.
 */

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

function es256Pair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

const appKeys = es256Pair();

async function tokenFor(did: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 5)
    .setIssuer("privy.io")
    .setAudience("test-balances-app")
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(appKeys.privateKey);
}

/** Mirrors the fixture Privy client's deterministic per-user address. */
function fixtureAddress(userId: string): string {
  const digest = createHash("sha256")
    .update(`privy-fixture|${userId}`)
    .digest("hex");
  return `0x${digest.padStart(40, "0").slice(-40)}`;
}

const USER_A_DID = "did:privy:balances-user-a";
const USER_B_DID = "did:privy:balances-user-b";

/**
 * The merged per-user Privy runtime requires a trusted server client in privy
 * mode. This mock serves each test DID an embedded wallet at the SAME
 * deterministic fixture address the client-side hash function predicts, so the
 * BALANCE_FIXTURE_BALANCES map still matches without any live provider.
 */
function walletRecordFor(did: string, address: string): PrivyWalletRecord {
  return {
    id: `provider-wallet-${did.replace(/[^a-z0-9]/gi, "-")}`,
    address,
    chain_type: "ethereum",
    policy_ids: [],
    owner_id: did,
    additional_signers: [],
    archived_at: null,
  };
}

function mockServerClient(
  dids: string[],
  addresses: string[],
): PrivyServerClient {
  const byDid = new Map(
    dids.map((did, index) => [did, walletRecordFor(did, addresses[index]!)]),
  );
  const fetchMock = vi.fn<PrivyFetch>(async (url) => {
    const did = decodeURIComponent(
      (url.match(/user_id=([^&]+)/) ?? [])[1] ?? "",
    );
    const record = byDid.get(did);
    return {
      ok: Boolean(record),
      status: record ? 200 : 404,
      json: () =>
        Promise.resolve(record ? { data: [record] } : { error: "not_found" }),
    };
  });
  return new PrivyServerClient({
    appId: "test-balances-app",
    appSecret: "test-balances-secret",
    baseUrl: "https://mock.privy.test/v1",
    fetch: fetchMock,
  });
}

suite("GET /v1/wallets/current/balances (WP-003..WP-009, WP-013)", () => {
  let database: DatabaseClient;
  let app: Awaited<ReturnType<typeof buildServer>>;
  let userIdA: string;
  let userIdB: string;
  let addressA: string;
  let addressB: string;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    const ensure = async (did: string): Promise<string> => {
      const result = await database.query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1, $2) AS id",
        [did, did],
      );
      return result.rows[0]!.id;
    };
    userIdA = await ensure(USER_A_DID);
    userIdB = await ensure(USER_B_DID);
    addressA = fixtureAddress(userIdA);
    addressB = fixtureAddress(userIdB);

    process.env.DATABASE_URL = databaseUrl;
    process.env.IDENTITY_PROVIDER = "privy";
    process.env.PRIVY_APP_ID = "test-balances-app";
    process.env.PRIVY_VERIFICATION_KEY = String(
      appKeys.publicKey.export({ type: "spki", format: "pem" }),
    );
    process.env.WDK_TOOLS_SOURCE = "fixture";
    process.env.BALANCE_READ_SOURCE = "fixture";
    process.env.BALANCE_FIXTURE_BALANCES = JSON.stringify({
      [addressA]: "1250000", // 1.25 USDC
      [addressB]: "0", // real zero is a valid balance
    });
    delete process.env.DEMO_USER_ID;

    app = buildServer({
      privyServer: mockServerClient(
        [USER_A_DID, USER_B_DID, "did:privy:balances-user-c"],
        [addressA, addressB, fixtureAddress("c-unused")],
      ),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await database.close();
    for (const key of [
      "DATABASE_URL",
      "IDENTITY_PROVIDER",
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "WDK_TOOLS_SOURCE",
      "BALANCE_READ_SOURCE",
      "BALANCE_FIXTURE_BALANCES",
      "DEMO_USER_ID",
    ]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  });

  async function syncWallet(did: string): Promise<void> {
    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/sync",
      headers: { authorization: `Bearer ${await tokenFor(did)}` },
    });
    expect(response.statusCode).toBe(200);
  }

  it("returns each user's own fixture balance (WP-003/WP-004/WP-009)", async () => {
    await syncWallet(USER_A_DID);
    await syncWallet(USER_B_DID);

    const a = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/balances",
      headers: { authorization: `Bearer ${await tokenFor(USER_A_DID)}` },
    });
    expect(a.statusCode).toBe(200);
    expect(a.headers["cache-control"]).toBe("private, no-store");
    const dataA = a.json() as { ok: true; data: Record<string, unknown> };
    expect(dataA.data.walletState).toBe("ready");
    expect(dataA.data.address).toBe(addressA);
    expect(dataA.data.source).toBe("fixture");
    expect(dataA.data.observedAt).toEqual(expect.any(String));
    expect(dataA.data.assets).toEqual([
      {
        tokenId: "5042002:0x3600000000000000000000000000000000000000",
        contract: "0x3600000000000000000000000000000000000000",
        symbol: "USDC",
        name: "USD Coin",
        decimals: 6,
        balanceAtomic: "1250000",
      },
    ]);

    const b = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/balances",
      headers: { authorization: `Bearer ${await tokenFor(USER_B_DID)}` },
    });
    const dataB = b.json() as {
      ok: true;
      data: { assets: Array<{ balanceAtomic: string }> };
    };
    expect(dataB.data.assets[0]!.balanceAtomic).toBe("0");
  });

  it("rejects foreign selection in the query with 400 without touching the reader (WP-003)", async () => {
    const response = await app.inject({
      method: "GET",
      url: `/v1/wallets/current/balances?address=${addressB}`,
      headers: { authorization: `Bearer ${await tokenFor(USER_A_DID)}` },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "INVALID_QUERY" },
    });
    // B's data never leaks.
    expect(response.body).not.toContain(addressB);
  });

  it("rejects a missing token with 401 (WP-003)", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/balances",
    });
    expect(response.statusCode).toBe(401);
  });

  it("serves non-ready states without a balance and without provisioning (WP-005)", async () => {
    // A fresh user that never synced has an unprovisioned wallet binding.
    const userC = await database
      .query<{ id: string }>(
        "SELECT users_ensure_for_privy_did($1, $2) AS id",
        ["did:privy:balances-user-c", "did:privy:balances-user-c"],
      )
      .then((result) => result.rows[0]!.id);
    process.env.BALANCE_FIXTURE_BALANCES = JSON.stringify({});
    // The env map is read at boot; a fresh server is needed for a per-user
    // fixture, but the reader is never reached for a non-ready wallet, so the
    // existing server is enough.
    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/balances",
      headers: {
        authorization: `Bearer ${await tokenFor("did:privy:balances-user-c")}`,
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as { ok: true; data: Record<string, unknown> };
    expect(body.data).toMatchObject({
      walletState: "unprovisioned",
      chainId: 5042002,
      networkName: "Arc testnet",
      testnet: true,
      observedAt: null,
      assets: [],
    });
    expect(body.data).not.toHaveProperty("address");
    expect(body.data).not.toHaveProperty("source");
    void userC;
  });

  it("leaves bindings, grants and operations untouched by reads (WP-008)", async () => {
    // Counts are scoped to this test's own rows: the full suite runs workers in
    // parallel against the same database, so global counts are noisy.
    const counts = async () => {
      const wallets = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1",
        [userIdA],
      );
      const grants = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM signer_grants WHERE user_id = $1",
        [userIdA],
      );
      const operations = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM wallet_operations WHERE user_id = $1",
        [userIdA],
      );
      return {
        wallets: wallets.rows[0]!.count,
        grants: grants.rows[0]!.count,
        operations: operations.rows[0]!.count,
      };
    };

    await syncWallet(USER_A_DID);
    const before = await counts();
    for (let i = 0; i < 3; i += 1) {
      const response = await app.inject({
        method: "GET",
        url: "/v1/wallets/current/balances",
        headers: { authorization: `Bearer ${await tokenFor(USER_A_DID)}` },
      });
      expect(response.statusCode).toBe(200);
    }
    const after = await counts();
    expect(after).toEqual(before);
  });

  it("serves the balance regardless of a revoked grant (WP-008)", async () => {
    // Insert a revoked grant directly: the balance surface must not consult
    // grants at all (WP-008), so this state cannot change the outcome.
    const walletRow = await database.query<{ id: string }>(
      "SELECT id FROM user_wallets WHERE user_id = $1 AND state = 'ready' LIMIT 1",
      [userIdA],
    );
    expect(walletRow.rows.length).toBeGreaterThan(0);
    await database.query(
      `INSERT INTO signer_grants
        (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
         allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
         rolling_window_seconds, gas_ceiling, state)
       VALUES ($1, $2, 'policy-x', 'signer-x', 'hash-x', '{}', '1000000', '10000000', 3600, '1000', 'revoked')`,
      [userIdA, walletRow.rows[0]!.id],
    );
    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/balances",
      headers: { authorization: `Bearer ${await tokenFor(USER_A_DID)}` },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      ok: true;
      data: { assets: Array<{ balanceAtomic: string }> };
    };
    expect(body.data.assets[0]!.balanceAtomic).toBe("1250000");
  });
});
