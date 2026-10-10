import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";
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
import { isValidSolanaAddress } from "../../src/memory/address.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
// Fixture identity: the identity provider resolves every request to this user.
const USER_A = TEST_USER_ID;
/** A second owned Solana wallet, distinct from the fixture's per-user wallet. */
const SECOND_SOLANA_ADDRESS =
  "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";

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

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
  });

  it("syncs the same wallet idempotently (created=false on repeat) with a stable address", {
    timeout: 60_000,
  }, async () => {
    const userId = await provisionUser(
      database,
      `did:privy:sync-${randomUUID()}`,
    );
    const privy = createPrivyWalletApiClient(process.env, {});
    const service = new EmbeddedWalletService(database, privy);
    const first = await service.syncWallet(userId);
    const second = await service.syncWallet(userId);
    expect(first.state).toBe("ready");
    expect(first.created).toBe(true);
    // The fixture now mints a real base58 Solana address and the build binds
    // Solana only, so the expectation is DERIVED from the same client instead
    // of a hand-written EVM regex that could never match again.
    const [discovered] = await privy.listWallets(userId);
    expect(first.address).toBe(discovered?.address);
    expect(isValidSolanaAddress(first.address)).toBe(true);
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
            // The extra wallet must be Solana-shaped (valid base58 address),
            // because the sync reconciles the solana family only: an EVM-shaped
            // extra wallet would be filtered out and never conflict.
            address: SECOND_SOLANA_ADDRESS,
            chainFamily: "solana",
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
    const app = buildTestServer({ userId: USER_A });
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
    const app = buildTestServer({ userId: USER_A });
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
