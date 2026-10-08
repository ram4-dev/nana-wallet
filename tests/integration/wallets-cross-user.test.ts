import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  EmbeddedWalletService,
  defaultGrantInput,
} from "../../src/wallet/embedded.js";
import { createPrivyWalletApiClient } from "../../src/wallet/privy-client.js";
import {
  PrivyServerClient,
  type PrivySdkClient,
  type PrivyWalletPage,
  type PrivyWalletRecord,
} from "../../src/wallet/privy-server-client.js";
import {
  TransferUncertainError,
  WalletTransferPipeline,
} from "../../src/wallet/transfer-pipeline.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "0x9999999999999999999999999999999999999999";
const TOKEN = "0x3600000000000000000000000000000000000000";

function es256Pair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}
const keys = es256Pair();
const verificationKeyPem = String(
  keys.publicKey.export({ type: "spki", format: "pem" }),
);

async function tokenFor(did: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuedAt(now - 5)
    .setIssuer("privy.io")
    .setAudience("test-wallet-cross-app")
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
}

const DID_A = "did:privy:wallet-cross-a";
const DID_B = "did:privy:wallet-cross-b";
const ADDRESS_A = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const ADDRESS_B = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function listPage(records: readonly PrivyWalletRecord[]): PrivyWalletPage {
  return {
    data: [...records],
    hasNextPage: () => false,
    getNextPage: async () => listPage([]),
  };
}

function userScopedPrivyServer(): PrivyServerClient {
  const walletFor = (user_id: string): PrivyWalletRecord | null => {
    const address =
      user_id === DID_A ? ADDRESS_A : user_id === DID_B ? ADDRESS_B : null;
    if (!address) return null;
    return {
      id: `wallet-${user_id === DID_A ? "a" : "b"}`,
      address,
      chain_type: "ethereum",
      policy_ids: [],
      owner_id: `owner-${user_id === DID_A ? "a" : "b"}`,
      additional_signers: [],
      archived_at: null,
    };
  };
  return new PrivyServerClient({
    appId: "test-wallet-cross-app",
    appSecret: "test-secret-never-logged",
    client: {
      wallets: () => ({
        list: async ({ user_id }: { user_id: string }) => {
          const record = walletFor(user_id);
          return listPage(record ? [record] : []);
        },
        get: async () => {
          throw new Error("unused in cross-user isolation");
        },
        update: async () => {
          throw new Error("unused in cross-user isolation");
        },
      }),
      policies: () => ({
        create: async () => {
          throw new Error("unused in cross-user isolation");
        },
        get: async () => {
          throw new Error("unused in cross-user isolation");
        },
        update: async () => {
          throw new Error("unused in cross-user isolation");
        },
      }),
    } as unknown as PrivySdkClient,
  });
}

suite("embedded wallet cross-user isolation (PEW-004/003)", () => {
  let database: DatabaseClient;
  const previousEnv = { ...process.env };

  beforeAll(() => {
    process.env.IDENTITY_PROVIDER = "privy";
    process.env.PRIVY_APP_ID = "test-wallet-cross-app";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
    process.env.WDK_TOOLS_SOURCE = "fixture";
    delete process.env.DEMO_USER_ID;
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
    for (const key of [
      "IDENTITY_PROVIDER",
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "DEMO_USER_ID",
    ]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  it("never lets A read or reconcile B wallet, grant or operation data", {
    timeout: 60_000,
  }, async () => {
    const app = buildServer({ privyServer: userScopedPrivyServer() });
    try {
      const authA = { authorization: `Bearer ${await tokenFor(DID_A)}` };
      const authB = { authorization: `Bearer ${await tokenFor(DID_B)}` };

      const meA = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: authA,
      });
      const meB = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: authB,
      });
      const userIdA = meA.json().data?.userId as string;
      const userIdB = meB.json().data?.userId as string;
      expect(userIdA).not.toBe(userIdB);

      // Each user binds their own verified wallet.
      const syncA = await app.inject({
        method: "POST",
        url: "/v1/wallets/sync",
        headers: authA,
      });
      const syncB = await app.inject({
        method: "POST",
        url: "/v1/wallets/sync",
        headers: authB,
      });
      expect(syncA.statusCode).toBe(200);
      expect(syncB.statusCode).toBe(200);
      const addrA = syncA.json().data.address as string;
      const addrB = syncB.json().data.address as string;
      expect(addrA).not.toBe(addrB);

      // A's /current must never return B's wallet.
      const currentA = await app.inject({
        method: "GET",
        url: "/v1/wallets/current",
        headers: authA,
      });
      expect(currentA.json().data.address).toBe(addrA);
      expect(currentA.json().data.address).not.toBe(addrB);

      // A grants a signing permission; B must remain untouched (no leak).
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
      );
      const walletA = await service.getCurrentWallet(userIdA);
      const grantA = await service.createGrant(
        userIdA,
        walletA.id,
        defaultGrantInput([RECIPIENT]),
      );
      expect(grantA.state).toBe("active");
      const permB = await app.inject({
        method: "GET",
        url: "/v1/wallets/current/permission",
        headers: authB,
      });
      expect(permB.statusCode).toBe(200);
      expect(permB.json().data.state).not.toBe("active");
      expect(JSON.stringify(permB.json())).not.toContain(grantA.grantId!);
      expect(JSON.stringify(permB.json())).not.toContain(RECIPIENT);

      // USER DECISION (2026-09-09): A's own active grant is reported honestly
      // (the unenforced hourly limit stays visible via aggregationReady:false);
      // its user-scoped details still never leak to B.
      const permA = await app.inject({
        method: "GET",
        url: "/v1/wallets/current/permission",
        headers: authA,
      });
      expect(permA.json().data.state).toBe("active");
      expect(permA.json().data.aggregationReady).toBe(false);
      expect(permA.json().data.recipients).toContain(RECIPIENT);

      // Operation isolation: B cannot read or reconcile A's operation.
      const pipelineA = new WalletTransferPipeline(
        database,
        createPrivyWalletApiClient(process.env, {}),
      );
      const opA = await pipelineA.execute({
        userId: userIdA,
        grantId: grantA.grantId!,
        walletId: walletA.id,
        previewId: `preview-cross-${Date.now()}`,
        idempotencyKey: `cross-${Date.now()}`,
        recipientAddress: RECIPIENT,
        amountAtomic6: "10000000",
        chainId: 5042002,
        token: TOKEN,
        walletAddress: walletA.address,
      });
      expect(opA.status).toBe("confirmed");

      // The same operation for A must be indistinguishable from a missing one for B.
      const pipelineB = new WalletTransferPipeline(
        database,
        createPrivyWalletApiClient(process.env, {}),
      );
      await expect(
        pipelineB.reconcileUncertain(userIdB, opA.id),
      ).rejects.toBeInstanceOf(TransferUncertainError);
    } finally {
      await app.close();
    }
  });
});
