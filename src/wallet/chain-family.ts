import { PrivyWalletRuntimeError } from "./user-wallet.js";

/**
 * The chain family a wallet request is resolved for.
 *
 * `"ethereum"` is still part of the union on purpose, even though this build
 * has no EVM factory: `src/contracts/http.ts` mirrors the same union on the
 * wire, and that HTTP contract is owned by a later unit together with the
 * frontend. Removing it here would silently break the mirrored contract.
 */
export type WalletChainFamily = "ethereum" | "solana";
export type WalletChainFamilyHint =
  WalletChainFamily | (() => WalletChainFamily);

/**
 * Maps a provider network to its wallet chain family.
 *
 * Solana devnet is the ONLY network this build serves, so every other network
 * — including the retired Arc/Sepolia EVM networks — fails closed with
 * `wallet_config_error` instead of resolving a provider that cannot serve it.
 * A missing network is a configuration gap, never a default.
 */
export function walletChainFamilyForNetwork(
  network: string | undefined,
): WalletChainFamily {
  switch (network) {
    case "solana-devnet":
      return "solana";
    default:
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        `Unsupported wallet network: ${network ?? "(missing)"}.`,
      );
  }
}
