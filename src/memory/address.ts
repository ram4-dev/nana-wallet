import { PublicKey } from "@solana/web3.js";

/** EVM records remain the implicit legacy default; Solana is explicit devnet only. */
const EVM_ADDRESS = /^0x[a-fA-F0-9]{40}$/;

export function isValidEvmAddress(value: string): boolean {
  return EVM_ADDRESS.test(value.trim());
}

export function isValidSolanaAddress(value: string): boolean {
  try {
    const trimmed = value.trim();
    const key = new PublicKey(trimmed);
    return key.toBytes().length === 32 && key.toBase58() === trimmed;
  } catch {
    return false;
  }
}

/**
 * The single configuration's recipient chain (RAM-009).
 *
 * This build serves Solana devnet and nothing else, and the chain is not
 * something a request body, a query, or a stored row gets to choose (AGENTS.md).
 * `src/wallet/policy/service.ts` re-exports this same literal as
 * `SOLANA_POLICY_NETWORK`, so there is exactly one place the chain is named.
 */
export const CONFIGURED_RECIPIENT_NETWORK = "solana-devnet";

/**
 * Resolves the chain a recipient is validated for when no explicit `network`
 * travels with the request or the stored record.
 *
 * An ABSENT network is a Solana deployment saying nothing, so it resolves the
 * configured chain. It must never fall through to the EVM regex: that fallback
 * let an `0x`-shaped address cross the recipient write and lookup paths of a
 * Solana-only deployment, where a canonical base58 public key is required.
 */
export function resolveRecipientNetwork(network?: string | null): string {
  return network ?? CONFIGURED_RECIPIENT_NETWORK;
}

export function isValidRecipientAddress(value: string, network?: string | null): boolean {
  if (network === "solana-devnet") return isValidSolanaAddress(value);
  // EVM recipient syntax is chain-independent (Arc, Sepolia, mainnet, etc.);
  // transfer policy separately binds the request to its configured network.
  return isValidEvmAddress(value);
}
