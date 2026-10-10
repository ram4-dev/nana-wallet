import { describe, expect, it, vi } from "vitest";

import {
  FixtureBalanceReader,
  SOLANA_DEVNET_CATALOG,
  WalletBalancesError,
  WalletBalancesService,
  createBalanceReader,
  readBalanceReadConfig,
  type BalanceReader,
} from "../../src/wallet/balances.js";
import { SOLANA_DEVNET_RPC_URL } from "../../src/wallet/solana-devnet-provider.js";
import type { CurrentWallet } from "../../src/wallet/embedded.js";

/**
 * WP-003/WP-005/WP-008/WP-009: the service resolves the caller's own binding,
 * serves every non-ready state WITHOUT calling the reader, fails closed on an
 * inconsistent ready binding, and never touches signing (there is simply no
 * signing dependency to reach).
 *
 * The surface reads the native Solana devnet asset, so the expected payload
 * pins the CAIP-2 chain identifier as a STRING (Solana has no EIP-155 chain id)
 * and lamports as the atomic unit.
 */

/** Devnet-shaped base58 address (validated by isValidSolanaAddress). */
const SOLANA_ADDRESS = "AfHaCDtRK27tYuDjUXE9Ch5QHHfiZBa3QEdDpQp8ZYGX";
const CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function wallet(overrides: Partial<CurrentWallet> = {}): CurrentWallet {
  return {
    userId: "11111111-1111-4111-8111-111111111111",
    id: "22222222-2222-4222-8222-222222222222",
    state: "ready",
    address: SOLANA_ADDRESS,
    chainFamily: "solana",
    provider: "privy",
    verifiedAt: null,
    ...overrides,
  };
}

const READY = wallet();

function readerStub(source: BalanceReader["source"] = "fixture") {
  return {
    source,
    readSolAtomic: vi.fn(async () => "1250000000"),
  } satisfies BalanceReader & { readSolAtomic: ReturnType<typeof vi.fn> };
}

const OWN_ADDRESS = READY.address;

describe("SOLANA_DEVNET_CATALOG (WP-004)", () => {
  it("is the closed native-SOL devnet catalog", () => {
    expect(SOLANA_DEVNET_CATALOG).toEqual({
      network: "solana-devnet",
      caip2: CAIP2,
      networkName: "Solana devnet",
      testnet: true,
      symbol: "SOL",
      name: "Solana",
      decimals: 9,
      // A native asset has no token contract: the CAIP-2 chain identifier is
      // what identifies it, and `contract` says so explicitly.
      tokenId: CAIP2,
      contract: "native",
    });
  });
});

describe("WalletBalancesService", () => {
  it("returns the ready shape with one SOL asset and observedAt from the clock", async () => {
    const reader = readerStub();
    const service = new WalletBalancesService({
      resolveWallet: async () => READY,
      reader,
      clock: () => new Date("2026-09-09T12:00:00Z"),
    });
    await expect(service.getBalances(READY.userId)).resolves.toEqual({
      walletState: "ready",
      address: OWN_ADDRESS,
      chainId: CAIP2,
      networkName: "Solana devnet",
      testnet: true,
      source: "fixture",
      observedAt: "2026-09-09T12:00:00.000Z",
      assets: [
        {
          tokenId: CAIP2,
          contract: "native",
          symbol: "SOL",
          name: "Solana",
          decimals: 9,
          balanceAtomic: "1250000000",
        },
      ],
    });
    expect(reader.readSolAtomic).toHaveBeenCalledWith(
      OWN_ADDRESS,
      expect.anything(),
    );
  });

  it("serves every non-ready state without calling the reader (WP-005)", async () => {
    const reader = readerStub();
    for (const state of [
      "unprovisioned",
      "provisioning",
      "recovery_required",
      "conflict",
      "unavailable",
    ] as const) {
      const scoped = new WalletBalancesService({
        resolveWallet: async () => wallet({ state, address: "" }),
        reader,
      });
      await expect(scoped.getBalances("u")).resolves.toEqual({
        walletState: state,
        chainId: CAIP2,
        networkName: "Solana devnet",
        testnet: true,
        observedAt: null,
        assets: [],
      });
    }
    expect(reader.readSolAtomic).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent ready binding with 409 and no reader call (WP-007)", async () => {
    const reader = readerStub();
    const badAddress = new WalletBalancesService({
      resolveWallet: async () => wallet({ address: "not-an-address" }),
      reader,
    });
    await expect(badAddress.getBalances("u")).rejects.toMatchObject({
      status: 409,
      code: "WALLET_DATOS_INVALIDOS",
    });
    // An EVM-shaped address is NOT a Solana address: it must fail closed.
    const evmAddress = new WalletBalancesService({
      resolveWallet: async () =>
        wallet({ address: "0x1111111111111111111111111111111111111111" }),
      reader,
    });
    await expect(evmAddress.getBalances("u")).rejects.toMatchObject({
      status: 409,
      code: "WALLET_DATOS_INVALIDOS",
    });
    const badChain = new WalletBalancesService({
      resolveWallet: async () => wallet({ chainFamily: "arc" }),
      reader,
    });
    await expect(badChain.getBalances("u")).rejects.toMatchObject({
      status: 409,
      code: "WALLET_DATOS_INVALIDOS",
    });
    expect(reader.readSolAtomic).not.toHaveBeenCalled();
  });

  it("maps reader failures to a sanitized 503 (WP-007)", async () => {
    const service = new WalletBalancesService({
      resolveWallet: async () => READY,
      reader: {
        source: "fixture",
        readSolAtomic: async () => {
          throw new Error("http://secret-node?token=abc raw failure");
        },
      },
    });
    await expect(service.getBalances("u")).rejects.toMatchObject({
      status: 503,
      code: "BALANCE_NO_DISPONIBLE",
    });
    await expect(service.getBalances("u")).rejects.not.toThrow(/secret-node/);
  });
});

describe("FixtureBalanceReader (WP-009)", () => {
  it("serves per-address balances and errors on an unconfigured address", async () => {
    const reader = new FixtureBalanceReader({
      [OWN_ADDRESS]: "42",
    });
    await expect(
      reader.readSolAtomic(OWN_ADDRESS, new AbortController().signal),
    ).resolves.toBe("42");
    await expect(
      reader.readSolAtomic(
        "AiU9AY9ibuJnCUaSESUmGqTGJyrGJ57fYDmT3eQWEafk",
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ status: 503, code: "BALANCE_NO_DISPONIBLE" });
  });
});

describe("readBalanceReadConfig (WP-009)", () => {
  it("reads the devnet RPC by default, with no configuration at all", () => {
    // The deployment is Solana-devnet only, so the node is not a deployment
    // choice: it is the same constant the wallet provider already uses.
    // Defaulting to the fixture reader left every real balance read failing.
    expect(readBalanceReadConfig({})).toEqual({
      source: "rpc",
      rpcUrl: SOLANA_DEVNET_RPC_URL,
    });
    expect(createBalanceReader(readBalanceReadConfig({})).source).toBe("rpc");
  });

  it("accepts an explicit RPC override and rejects unknown sources", () => {
    expect(
      readBalanceReadConfig({
        BALANCE_RPC_URL: "http://n",
      }).source,
    ).toBe("rpc");
    expect(
      readBalanceReadConfig({ BALANCE_RPC_URL: "http://n" }).rpcUrl,
    ).toBe("http://n");
    expect(
      readBalanceReadConfig({ BALANCE_READ_SOURCE: "rpc" }).rpcUrl,
    ).toBe(SOLANA_DEVNET_RPC_URL);
    expect(() => readBalanceReadConfig({ BALANCE_READ_SOURCE: "ws" })).toThrow(
      /fixture.*rpc/,
    );
  });

  it("normalizes fixture map keys to lowercase", () => {
    const config = readBalanceReadConfig({
      BALANCE_READ_SOURCE: "fixture",
      BALANCE_FIXTURE_BALANCES: JSON.stringify({ [OWN_ADDRESS]: "7" }),
    });
    const reader = createBalanceReader(config);
    expect(reader.source).toBe("fixture");
  });
});
