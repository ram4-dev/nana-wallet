import { describe, expect, it } from "vitest";
import { walletChainFamilyForNetwork } from "../../src/wallet/chain-family.js";

/**
 * The chain-family mapping moved here verbatim from the provider module that
 * was deleted with the Arc/EVM wallet runtime, changing only the mapping under
 * test: `"solana-devnet"` is the single network this deployment serves, and
 * every other network fails closed with `wallet_config_error`.
 *
 * The `-> "ethereum"` assertions that used to pin `"arc-testnet"` and
 * `"sepolia"` became THROWING assertions on purpose: the EVM/Arc family was
 * removed, so the removal is pinned rather than merely absent.
 */
describe("wallet chain family mapping", () => {
  it("maps provider networks to their ledger family and rejects unknown networks", () => {
    expect(walletChainFamilyForNetwork("solana-devnet")).toBe("solana");
    expect(() => walletChainFamilyForNetwork("arc-testnet")).toThrowError(
      expect.objectContaining({ code: "wallet_config_error" }),
    );
    expect(() => walletChainFamilyForNetwork("sepolia")).toThrowError(
      expect.objectContaining({ code: "wallet_config_error" }),
    );
    expect(() => walletChainFamilyForNetwork("unknown-net")).toThrowError(
      expect.objectContaining({ code: "wallet_config_error" }),
    );
    expect(() => walletChainFamilyForNetwork(undefined)).toThrowError(
      expect.objectContaining({ code: "wallet_config_error" }),
    );
  });

  it("names the unsupported network in the failure", () => {
    for (const network of ["arc-testnet", "sepolia", "unknown-net"]) {
      expect(() => walletChainFamilyForNetwork(network)).toThrowError(
        expect.objectContaining({
          message: expect.stringContaining(network),
        }),
      );
    }
    expect(() => walletChainFamilyForNetwork(undefined)).toThrowError(
      expect.objectContaining({
        message: expect.stringContaining("(missing)"),
      }),
    );
  });
});
