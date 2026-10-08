import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerWalletsRoutes } from "../../src/api/wallets.js";
import type { EmbeddedWalletService } from "../../src/wallet/embedded.js";
import type { WalletBalancesService } from "../../src/wallet/balances.js";

/**
 * HTTP chain-selector contract for the wallet lifecycle surface. The selector
 * is OPTIONAL and defaults to the legacy `arc` behaviour; a value that is
 * neither `arc` nor `solana` is rejected with the surface's existing business
 * error envelope (422 DATOS_INVALIDOS), never a 500.
 */

const USER = "11111111-1111-4111-8111-111111111111";
const WALLET_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const RECIPIENT = "0x9999999999999999999999999999999999999999";

function permissionSummary() {
  return {
    userId: USER,
    grantId: null,
    state: "unavailable" as const,
    perTransferUsdc: "",
    perTransferSol: "",
    rollingTotalUsdc: "",
    rollingWindowSeconds: 0,
    gasCeiling: "",
    recipients: [],
    aggregateOvershootCaveat: true,
    aggregationReady: false,
    aggregateBlockReason: "pending",
  };
}

function fakeWallet() {
  return {
    getCurrentWallet: vi.fn(async (userId: string, _chain?: string) => ({
      userId,
      id: WALLET_ID,
      state: "ready" as const,
      address: "0x4b1f8c9e2d7a3f5b6c0d4e1f2a3b4c5d6e7f8a9b",
      chainFamily: "arc",
      provider: "privy",
      verifiedAt: null,
    })),
    getPermission: vi.fn(async () => permissionSummary()),
    activatePermission: vi.fn(async () => permissionSummary()),
    preparePermission: vi.fn(async () => ({
      walletId: WALLET_ID,
      walletAddress: "0x4b1f8c9e2d7a3f5b6c0d4e1f2a3b4c5d6e7f8a9b",
      walletChainFamily: "arc" as const,
      policyId: "pol_1",
      quorumId: "quorum_1",
      perTransferUsdc: "10",
      perTransferSol: "",
      rollingTotalUsdc: "50",
      windowSeconds: 3600,
      aggregationReady: false as const,
      aggregateBlockReason: "pending",
    })),
    completePermission: vi.fn(async () => ({
      verified: true,
      state: "active" as const,
      permission: {
        ...permissionSummary(),
        state: "active" as const,
      },
      observed: {
        walletOwnerMatches: true,
        policyAttached: true,
        observedPolicyIds: [],
        observedSignerIds: [],
      },
    })),
    revokePermission: vi.fn(async (userId: string, _chain?: string) => ({
      userId,
      state: "revoked" as const,
      remote: "revoked" as const,
    })),
  };
}

async function buildApp(wallet: ReturnType<typeof fakeWallet>) {
  const app = Fastify({ logger: false });
  await app.register(registerWalletsRoutes, {
    resolveUserId: async () => USER,
    wallet: wallet as unknown as EmbeddedWalletService,
    balances: {} as unknown as WalletBalancesService,
  });
  await app.ready();
  return app;
}

const apps: Fastify.FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

async function appWith(wallet: ReturnType<typeof fakeWallet>) {
  const app = await buildApp(wallet);
  apps.push(app);
  return app;
}

describe("wallet chain selector: reads", () => {
  it("rejects an unknown chain without a 500 and without touching the service", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current?chain=bogus",
    });

    expect(response.statusCode).toBe(422);
    expect(response.statusCode).not.toBe(500);
    expect(response.json()).toEqual({
      ok: false,
      error: {
        code: "DATOS_INVALIDOS",
        message: expect.stringContaining("arc"),
      },
    });
    expect(wallet.getCurrentWallet).not.toHaveBeenCalled();
  });

  it("passes the solana chain through to getCurrentWallet", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current?chain=solana",
    });

    expect(response.statusCode).toBe(200);
    expect(wallet.getCurrentWallet).toHaveBeenCalledWith(USER, "solana");
  });

  it("passes the solana chain through to getPermission", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/permission?chain=solana",
    });

    expect(response.statusCode).toBe(200);
    expect(wallet.getPermission).toHaveBeenCalledWith(USER, "solana");
  });

  it("leaves the chain unset (arc default) when no selector is sent", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({ method: "GET", url: "/v1/wallets/current" });

    expect(response.statusCode).toBe(200);
    expect(wallet.getCurrentWallet.mock.calls[0]?.[0]).toBe(USER);
    expect(wallet.getCurrentWallet.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("rejects an unknown chain on the permission read without a 500", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "GET",
      url: "/v1/wallets/current/permission?chain=ethereum",
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("DATOS_INVALIDOS");
    expect(wallet.getPermission).not.toHaveBeenCalled();
  });
});

describe("wallet chain selector: mutations", () => {
  it("passes the solana chain through to revokePermission", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission/revoke",
      payload: { chain: "solana" },
    });

    expect(response.statusCode).toBe(200);
    expect(wallet.revokePermission).toHaveBeenCalledWith(USER, "solana");
  });

  it("rejects an invalid revoke chain without mutating anything", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission/revoke",
      payload: { chain: "nope" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("DATOS_INVALIDOS");
    expect(wallet.revokePermission).not.toHaveBeenCalled();
  });

  it("passes the solana chain through activation", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission",
      payload: { recipients: [RECIPIENT], chain: "solana" },
    });

    expect(response.statusCode).toBe(200);
    expect(wallet.activatePermission).toHaveBeenCalledWith(USER, [RECIPIENT], "solana");
  });

  it("passes the solana chain through enrollment completion", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission/complete",
      payload: { walletId: WALLET_ID, chain: "solana" },
    });

    expect(response.statusCode).toBe(200);
    expect(wallet.completePermission).toHaveBeenCalledWith(USER, WALLET_ID, "solana");
  });

  it("still revokes the current (arc) grant when no chain body is sent", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission/revoke",
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(wallet.revokePermission.mock.calls[0]?.[0]).toBe(USER);
    expect(wallet.revokePermission.mock.calls[0]?.[1]).toBeUndefined();
  });

  it("rejects an invalid chain on activation without a 500", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission",
      payload: { recipients: [RECIPIENT], chain: "polygon" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("DATOS_INVALIDOS");
    expect(wallet.activatePermission).not.toHaveBeenCalled();
  });

  it("rejects an invalid chain on enrollment completion without a 500", async () => {
    const wallet = fakeWallet();
    const app = await appWith(wallet);

    const response = await app.inject({
      method: "POST",
      url: "/v1/wallets/current/permission/complete",
      payload: { walletId: WALLET_ID, chain: "polygon" },
    });

    expect(response.statusCode).toBe(422);
    expect(response.json().error.code).toBe("DATOS_INVALIDOS");
    expect(wallet.completePermission).not.toHaveBeenCalled();
  });
});
