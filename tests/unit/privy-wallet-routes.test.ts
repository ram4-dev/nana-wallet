import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";
import { registerWalletRoutes } from "../../src/api/wallet.js";
import { PrivyIdentityError } from "../../src/auth/privy-identity.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import {
  PRIVY_ARC_CHAIN_ID,
  PrivyUserWalletProvider,
  PrivyWalletRuntimeError,
} from "../../src/wallet/privy-user-provider.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";

function userProvider(address: string, atomicBalance: bigint) {
  return new PrivyUserWalletProvider(
    { id: `wallet-${address}`, address },
    {
      rpc: async (method, params) => {
        if (method === "eth_chainId")
          return `0x${PRIVY_ARC_CHAIN_ID.toString(16)}`;
        if (
          method === "eth_call" &&
          (params?.[0] as { data?: string } | undefined)?.data === "0x313ce567"
        )
          return "0x6";
        if (method === "eth_call") return `0x${atomicBalance.toString(16)}`;
        throw new Error("unexpected RPC method");
      },
    },
  );
}

async function createApp(
  walletForUser?: Parameters<typeof registerWalletRoutes>[1]["walletForUser"],
) {
  const app = Fastify({ logger: false });
  const fixture = new FixtureWalletProvider();
  const fixtureBalance = vi.spyOn(fixture, "getBalance");
  const providers = new Map([
    [USER_A, userProvider(ADDRESS_A, 1_250_000n)],
    [USER_B, userProvider(ADDRESS_B, 9_000_000n)],
  ]);
  const resolveWalletForUser =
    walletForUser ??
    (async (userId: string) => {
      const provider = providers.get(userId);
      if (!provider) {
        throw new PrivyWalletRuntimeError(
          "wallet_not_ready",
          "No eligible Arc wallet is available for this user.",
        );
      }
      return provider;
    });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PrivyIdentityError) {
      return reply.code(401).send({
        status: "error",
        code: "no_autenticado",
        message: "Authentication required.",
      });
    }
    throw error;
  });
  await app.register(registerWalletRoutes, {
    wallet: fixture,
    resolveUserId: async (request) => {
      const token = request.headers.authorization;
      if (token === "Bearer user-a") return USER_A;
      if (token === "Bearer user-b") return USER_B;
      if (token === "Bearer user-no-wallet") return "no-wallet";
      throw new PrivyIdentityError("unauthenticated", "Missing bearer token.");
    },
    walletForUser: resolveWalletForUser,
  });
  return { app, fixtureBalance };
}

describe("Privy user-scoped wallet HTTP routes", () => {
  it("resolves the Solana chain when a wallet request names solana-devnet", async () => {
    const provider = new FixtureWalletProvider();
    const getAddress = vi.spyOn(provider, "getAddress").mockResolvedValue({
      network: "solana-devnet",
      address: "So11111111111111111111111111111111111111112",
    });
    const resolver = vi.fn(async () => provider);
    const { app } = await createApp(resolver);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/wallet/address?network=solana-devnet",
        headers: { authorization: "Bearer user-a" },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        network: "solana-devnet",
        address: "So11111111111111111111111111111111111111112",
      });
      expect(getAddress).toHaveBeenCalledWith({
        network: "solana-devnet",
        wallet: USER_A,
      });
      expect(resolver).toHaveBeenCalledWith(USER_A, "solana");
    } finally {
      await app.close();
    }
  });

  it("fails closed on an unsupported requested network before resolving a wallet", async () => {
    const resolver = vi.fn(async () => userProvider(ADDRESS_A, 1_250_000n));
    const { app } = await createApp(resolver);
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/wallet/balance?network=unknown-net",
        headers: { authorization: "Bearer user-a" },
      });
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: "wallet_config_error" });
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("requires authentication and never reaches the shared fixture", async () => {
    const { app, fixtureBalance } = await createApp();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/wallet/balance",
      });
      expect(response.statusCode).toBe(401);
      expect(fixtureBalance).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns each authenticated user's Arc address and real RPC balance", async () => {
    const { app, fixtureBalance } = await createApp();
    try {
      // This case exists to exercise the Arc/EVM provider family, so it names
      // the network it targets instead of inheriting the configured default —
      // which is Solana and rejects these Arc wallets.
      const [addressA, balanceA, addressB, balanceB] = await Promise.all([
        app.inject({
          method: "GET",
          url: "/v1/wallet/address?network=arc-testnet",
          headers: { authorization: "Bearer user-a" },
        }),
        app.inject({
          method: "GET",
          url: "/v1/wallet/balance?network=arc-testnet",
          headers: { authorization: "Bearer user-a" },
        }),
        app.inject({
          method: "GET",
          url: "/v1/wallet/address?network=arc-testnet",
          headers: { authorization: "Bearer user-b" },
        }),
        app.inject({
          method: "GET",
          url: "/v1/wallet/balance?network=arc-testnet",
          headers: { authorization: "Bearer user-b" },
        }),
      ]);

      expect(addressA.json()).toEqual({
        network: "arc-testnet",
        address: ADDRESS_A,
      });
      expect(balanceA.json()).toEqual({
        network: "arc-testnet",
        token: "USDC",
        address: ADDRESS_A,
        balance: "1.25",
      });
      expect(addressB.json()).toEqual({
        network: "arc-testnet",
        address: ADDRESS_B,
      });
      expect(balanceB.json()).toEqual({
        network: "arc-testnet",
        token: "USDC",
        address: ADDRESS_B,
        balance: "9",
      });
      expect(fixtureBalance).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("returns explicit readiness and history capability errors without a fabricated value", async () => {
    const { app, fixtureBalance } = await createApp();
    try {
      const noWallet = await app.inject({
        method: "GET",
        url: "/v1/wallet/balance",
        headers: { authorization: "Bearer user-no-wallet" },
      });
      const noHistory = await app.inject({
        method: "GET",
        url: "/v1/wallet/history",
        headers: { authorization: "Bearer user-a" },
      });

      expect(noWallet.statusCode).toBe(409);
      expect(noWallet.json()).toMatchObject({
        status: "error",
        code: "wallet_not_ready",
      });
      expect(noWallet.body).not.toContain("42.5");
      expect(noHistory.statusCode).toBe(501);
      expect(noHistory.json()).toMatchObject({
        status: "error",
        code: "wallet_feature_unavailable",
      });
      expect(fixtureBalance).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });
});
