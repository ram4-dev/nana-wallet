import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestServer } from "../fixtures/test-server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  EmbeddedWalletService,
  WalletOwnershipError,
} from "../../src/wallet/embedded.js";
import {
  createPrivyWalletApiClient,
  type FixturePrivyClientOptions,
} from "../../src/wallet/privy-client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const USER_A = "00000000-0000-4000-8000-000000000001";

async function provisionUser(
  database: DatabaseClient,
  did: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    "SELECT users_ensure_for_privy_did($1, $2) AS id",
    [did, did],
  );
  return result.rows[0]!.id;
}

suite("/v1/wallets sync + embedded wallet service (PEW-002/003/005)", () => {
  let database: DatabaseClient;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    process.env.WDK_TOOLS_SOURCE = "fixture";
    process.env.DEMO_USER_ID = USER_A;
  });

  afterAll(async () => {
    await database.close();
    process.env.DEMO_USER_ID = previousEnv.DEMO_USER_ID;
    if (previousEnv.WDK_TOOLS_SOURCE === undefined)
      delete process.env.WDK_TOOLS_SOURCE;
    else process.env.WDK_TOOLS_SOURCE = previousEnv.WDK_TOOLS_SOURCE;
  });

  it("syncs the same wallet idempotently (created=false on repeat) with a stable address", {
    timeout: 60_000,
  }, async () => {
    const userId = await provisionUser(
      database,
      `did:privy:sync-${randomUUID()}`,
    );
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
    );
    const first = await service.syncWallet(userId);
    const second = await service.syncWallet(userId);
    expect(first.state).toBe("ready");
    expect(first.created).toBe(true);
    expect(first.address).toMatch(/^0x[0-9a-f]{40}$/u);
    expect(second.created).toBe(false);
    expect(second.address).toBe(first.address);
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1",
      [userId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("provisions one wallet for concurrent first logins", {
    timeout: 60_000,
  }, async () => {
    const userId = await provisionUser(
      database,
      `did:privy:concurrent-${randomUUID()}`,
    );
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
    );
    const [a, b, c] = await Promise.all([
      service.syncWallet(userId),
      service.syncWallet(userId),
      service.syncWallet(userId),
    ]);
    expect(new Set([a.address, b.address, c.address]).size).toBe(1);
    expect(a.state).toBe("ready");
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1",
      [userId],
    );
    expect(rows.rows[0]?.count).toBe("1");
  });

  it("enters conflict when multiple eligible wallets are owned", {
    timeout: 60_000,
  }, async () => {
    const userId = await provisionUser(
      database,
      `did:privy:conflict-${randomUUID()}`,
    );
    const options: FixturePrivyClientOptions = {
      extraWallets: {
        [userId]: [
          {
            providerWalletId: `privy_extra_${randomUUID()}`,
            address: "0x1111111111111111111111111111111111111111",
            chainFamily: "arc",
            state: "ready",
          },
        ],
      },
    };
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, options),
    );
    const result = await service.syncWallet(userId);
    expect(result.state).toBe("conflict");
  });

  it("rejects a forged client-supplied address and never creates a binding", {
    timeout: 60_000,
  }, async () => {
    const userId = await provisionUser(
      database,
      `did:privy:forged-${randomUUID()}`,
    );
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
    );
    await expect(
      service.syncWallet(userId, {
        claimedAddress: "0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
      }),
    ).rejects.toBeInstanceOf(WalletOwnershipError);
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1",
      [userId],
    );
    expect(rows.rows[0]?.count).toBe("0");
  });

  it("authenticated GET /v1/wallets/current reflects the synced readiness + address", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer();
    try {
      const synced = await app.inject({
        method: "POST",
        url: "/v1/wallets/sync",
      });
      expect(synced.statusCode).toBe(200);
      expect(synced.json().data.state).toBe("ready");
      const current = await app.inject({
        method: "GET",
        url: "/v1/wallets/current",
      });
      expect(current.statusCode).toBe(200);
      expect(current.json().data.state).toBe("ready");
      expect(current.json().data.address).toBe(synced.json().data.address);
      // Never expose keys/credentials.
      expect(JSON.stringify(current.json())).not.toContain("signedTx");
      expect(JSON.stringify(current.json())).not.toContain("signed_tx");
    } finally {
      await app.close();
    }
  });

  it("PEW-013: explicit activation with read-back; empty allowlist rejected (422)", {
    timeout: 60_000,
  }, async () => {
    const app = buildTestServer();
    try {
      await app.inject({ method: "POST", url: "/v1/wallets/sync" });
      const empty = await app.inject({
        method: "POST",
        url: "/v1/wallets/current/permission",
        payload: { recipients: [] },
      });
      expect(empty.statusCode).toBe(422);

      const activated = await app.inject({
        method: "POST",
        url: "/v1/wallets/current/permission",
        payload: { recipients: ["0x9999999999999999999999999999999999999999"] },
      });
      expect(activated.statusCode).toBe(200);
      const data = activated.json().data;
      expect(data.state).toBe("active");
      expect(data.perTransferUsdc).toBe("10");
      expect(data.rollingTotalUsdc).toBe("50");
      expect(data.rollingWindowSeconds).toBe(3600);
      expect(data.aggregateOvershootCaveat).toBe(true);
      expect(data.recipients).toContain(
        "0x9999999999999999999999999999999999999999",
      );
      expect(JSON.stringify(data)).not.toContain("signed");
    } finally {
      await app.close();
    }
  });
});
