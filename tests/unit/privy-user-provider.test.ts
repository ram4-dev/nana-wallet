import { describe, expect, it, vi } from "vitest";
import type { DatabaseClient } from "../../src/db/client.js";
import {
  PrivyServerClient,
  type PrivySdkClient,
  type PrivyWalletPage,
  type PrivyWalletRecord,
} from "../../src/wallet/privy-server-client.js";
import {
  PRIVY_ARC_CHAIN_ID,
  PRIVY_ARC_USDC,
  PrivyUserWalletProvider,
  PrivyWalletRuntimeError,
  bindWalletForUser,
  createPrivyWalletForUserResolver,
  walletChainFamilyForNetwork,
} from "../../src/wallet/privy-user-provider.js";
import type { PayloadSigner } from "../../src/wallet/signer/port.js";

const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "22222222-2222-4222-8222-222222222222";
const ADDRESS_A = "0x1111111111111111111111111111111111111111";
const ADDRESS_B = "0x2222222222222222222222222222222222222222";

function wallet(id: string, address: string) {
  return {
    id,
    address,
    chain_type: "ethereum",
    policy_ids: [],
    owner_id: null,
    additional_signers: [],
    archived_at: null,
  };
}

function databaseFixture(
  rows: Record<
    string,
    {
      privy_did: string;
      provider_wallet_id: string | null;
      address: string | null;
    }
  >,
): DatabaseClient {
  return {
    async withUserTransaction(
      userId: string,
      operation: (client: unknown) => Promise<unknown>,
    ) {
      return operation({
        query: async () => ({ rows: rows[userId] ? [rows[userId]] : [] }),
      });
    },
  } as unknown as DatabaseClient;
}

function listPage(records: readonly PrivyWalletRecord[]): PrivyWalletPage {
  return {
    data: [...records],
    hasNextPage: () => false,
    getNextPage: async () => listPage([]),
  };
}

function privyFixture(
  walletsByDid: Record<string, ReturnType<typeof wallet>[]>,
) {
  const list = vi.fn(async ({ user_id }: { user_id: string }) =>
    listPage(walletsByDid[user_id] ?? []),
  );
  return new PrivyServerClient({
    appId: "app-test",
    appSecret: "secret-test",
    client: {
      wallets: () => ({ list, get: vi.fn(), update: vi.fn() }),
      policies: () => ({ create: vi.fn(), get: vi.fn(), update: vi.fn() }),
    } as unknown as PrivySdkClient,
  });
}

describe("Privy per-user wallet runtime", () => {
  it("maps provider networks to their ledger family and rejects unknown networks", () => {
    expect(walletChainFamilyForNetwork("solana-devnet")).toBe("solana");
    expect(walletChainFamilyForNetwork("arc-testnet")).toBe("ethereum");
    expect(walletChainFamilyForNetwork("sepolia")).toBe("ethereum");
    expect(() => walletChainFamilyForNetwork("unknown-net")).toThrowError(
      expect.objectContaining({ code: "wallet_config_error" }),
    );
    expect(() => walletChainFamilyForNetwork(undefined)).toThrowError(
      expect.objectContaining({ code: "wallet_config_error" }),
    );
  });

  it("selects the wallet from Privy's trusted user filter for each user", async () => {
    const database = databaseFixture({
      [USER_A]: {
        privy_did: "did:privy:user-a",
        provider_wallet_id: null,
        address: null,
      },
      [USER_B]: {
        privy_did: "did:privy:user-b",
        provider_wallet_id: null,
        address: null,
      },
    });
    const resolve = createPrivyWalletForUserResolver({
      database,
      privy: privyFixture({
        "did:privy:user-a": [wallet("wallet-a", ADDRESS_A)],
        "did:privy:user-b": [wallet("wallet-b", ADDRESS_B)],
      }),
      rpc: vi.fn(),
    });

    await expect(
      (await resolve(USER_A)).getAddress({
        network: "arc-testnet",
        wallet: USER_A,
      }),
    ).resolves.toMatchObject({ address: ADDRESS_A });
    await expect(
      (await resolve(USER_B)).getAddress({
        network: "arc-testnet",
        wallet: USER_B,
      }),
    ).resolves.toMatchObject({ address: ADDRESS_B });
  });

  it("fails explicitly when there is no wallet or no verified selection among multiple wallets", async () => {
    const database = databaseFixture({
      [USER_A]: {
        privy_did: "did:privy:user-a",
        provider_wallet_id: null,
        address: null,
      },
    });
    const none = createPrivyWalletForUserResolver({
      database,
      privy: privyFixture({ "did:privy:user-a": [] }),
    });
    const multiple = createPrivyWalletForUserResolver({
      database,
      privy: privyFixture({
        "did:privy:user-a": [
          wallet("wallet-a", ADDRESS_A),
          wallet("wallet-b", ADDRESS_B),
        ],
      }),
    });

    await expect(none(USER_A)).rejects.toMatchObject({
      code: "wallet_not_ready",
    });
    await expect(multiple(USER_A)).rejects.toMatchObject({
      code: "wallet_not_ready",
    });
  });

  it("rejects multiple wallets even when an older auto-synced binding is ready", async () => {
    const database = databaseFixture({
      [USER_A]: {
        privy_did: "did:privy:user-a",
        provider_wallet_id: "wallet-b",
        address: ADDRESS_B,
      },
    });
    const resolve = createPrivyWalletForUserResolver({
      database,
      privy: privyFixture({
        "did:privy:user-a": [
          wallet("wallet-a", ADDRESS_A),
          wallet("wallet-b", ADDRESS_B),
        ],
      }),
    });

    await expect(resolve(USER_A)).rejects.toMatchObject({
      code: "wallet_not_ready",
    });
  });

  it("reads the selected address USDC balance from Arc with six decimals", async () => {
    const calls: Array<{ method: string; params?: unknown[] }> = [];
    const provider = new PrivyUserWalletProvider(
      { id: "wallet-a", address: ADDRESS_A },
      {
        rpc: async (method, params) => {
          calls.push({ method, params });
          if (method === "eth_chainId")
            return `0x${PRIVY_ARC_CHAIN_ID.toString(16)}`;
          if (
            method === "eth_call" &&
            (params?.[0] as { data?: string } | undefined)?.data ===
              "0x313ce567"
          )
            return "0x6";
          if (method === "eth_call") return "0x0288cdc0";
          throw new Error("unexpected RPC method");
        },
      },
    );

    await expect(
      provider.getBalance({
        network: "arc-testnet",
        token: "USDC",
        wallet: USER_A,
      }),
    ).resolves.toEqual({
      network: "arc-testnet",
      token: "USDC",
      address: ADDRESS_A,
      balance: "42.52",
    });
    expect(calls[1]).toMatchObject({
      method: "eth_call",
      params: [{ to: PRIVY_ARC_USDC, data: "0x313ce567" }, "latest"],
    });
    expect(calls[2]).toMatchObject({
      method: "eth_call",
      params: [
        {
          to: PRIVY_ARC_USDC,
          data: `0x70a08231${ADDRESS_A.slice(2).padStart(64, "0")}`,
        },
        "latest",
      ],
    });
  });

  it("rejects a configured token contract whose decimals do not match Arc USDC", async () => {
    const provider = new PrivyUserWalletProvider(
      { id: "wallet-a", address: ADDRESS_A },
      {
        rpc: async (method) =>
          method === "eth_chainId"
            ? `0x${PRIVY_ARC_CHAIN_ID.toString(16)}`
            : "0x12",
      },
    );

    await expect(
      provider.getBalance({
        network: "arc-testnet",
        token: "USDC",
        wallet: USER_A,
      }),
    ).rejects.toMatchObject({ code: "wallet_config_error" });
  });

  it("keeps discovery lazy so walletless users can enter a conversation", async () => {
    const resolve = vi.fn(async () => {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "No wallet for this user.",
      );
    });
    const scoped = bindWalletForUser(resolve, USER_A);

    expect(resolve).not.toHaveBeenCalled();
    await expect(
      scoped.getBalance({
        network: "arc-testnet",
        token: "USDC",
        wallet: USER_A,
      }),
    ).rejects.toMatchObject({ code: "wallet_not_ready" });
    expect(resolve).toHaveBeenCalledWith(USER_A);
  });

  it("preserves the selected ledger chain through deferred wallet binding", async () => {
    const resolve = vi.fn(async () => {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "No Solana wallet for this user.",
      );
    });
    const scoped = bindWalletForUser(resolve, USER_A, "solana");

    await expect(
      scoped.getBalance({
        network: "solana-devnet",
        token: "SOL",
        wallet: USER_A,
      }),
    ).rejects.toMatchObject({ code: "wallet_not_ready" });
    expect(resolve).toHaveBeenCalledWith(USER_A, "solana");
  });

  it("never previews or dispatches while provider policy limits are unproven", async () => {
    const provider = new PrivyUserWalletProvider({
      id: "wallet-a",
      address: ADDRESS_A,
    });
    const request = {
      network: "arc-testnet",
      token: "USDC",
      to: ADDRESS_B,
      amount: "1",
      wallet: USER_A,
    };

    await expect(provider.previewTransfer(request)).rejects.toMatchObject({
      code: "wallet_unavailable",
    });
    await expect(provider.broadcastTransfer(request)).resolves.toMatchObject({
      kind: "not_dispatched",
    });
  });

  // S2a: the worker wallet path builds the Privy authorization context from the
  // local signing sidecar instead of a private key held by this process.
  it("builds the authorization context from the injected signer, never from a key", async () => {
    const signer: PayloadSigner = async () => "signature";
    const provider = new PrivyUserWalletProvider(
      { id: "wallet-a", address: ADDRESS_A },
      { authorizationSigner: signer },
    );

    expect(provider.authorizationContext).toEqual({ sign_fns: [signer] });
    expect(provider.authorizationContext?.sign_fns).toHaveLength(1);
    expect(
      (provider.authorizationContext as { authorization_private_keys?: unknown })
        .authorization_private_keys,
    ).toBeUndefined();
  });

  it("stays fail-closed without a signer even when the key variable is set", () => {
    const savedKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = "a-key-this-process-must-not-use";
    try {
      const provider = new PrivyUserWalletProvider({
        id: "wallet-a",
        address: ADDRESS_A,
      });
      expect(provider.authorizationContext).toBeUndefined();
    } finally {
      if (savedKey === undefined) delete process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
      else process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = savedKey;
    }
  });

  it("threads the signer through the per-user resolver into the provider context", async () => {
    const signer: PayloadSigner = async () => "signature";
    const database = databaseFixture({
      [USER_A]: {
        privy_did: "did:privy:user-a",
        provider_wallet_id: "wallet-a",
        address: ADDRESS_A,
      },
    });
    const resolve = createPrivyWalletForUserResolver({
      database,
      privy: privyFixture({
        "did:privy:user-a": [wallet("wallet-a", ADDRESS_A)],
      }),
      rpc: vi.fn(),
      authorizationSigner: signer,
    });

    const provider = (await resolve(
      USER_A,
      "ethereum",
    )) as PrivyUserWalletProvider;
    expect(provider.authorizationContext).toEqual({ sign_fns: [signer] });
  });
});
