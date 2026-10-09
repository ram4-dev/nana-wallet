import type { DatabaseClient } from "../db/client.js";
import type { WalletProvider } from "./provider.js";
import type { WalletChainFamilyHint } from "./chain-family.js";
import { SOLANA_DEVNET_NETWORK } from "./solana-devnet-provider.js";

export type PrivyWalletRuntimeErrorCode =
  | "wallet_not_ready"
  | "wallet_config_error"
  | "wallet_unavailable"
  | "wallet_feature_unavailable";

export class PrivyWalletRuntimeError extends Error {
  public constructor(
    public readonly code: PrivyWalletRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PrivyWalletRuntimeError";
  }
}

export type WalletForUser = (
  userId: string,
  chainFamily?: WalletChainFamilyHint,
) => Promise<WalletProvider>;

/**
 * Defers wallet discovery until a wallet method is actually called. This lets
 * an authenticated user without a wallet keep using ordinary text and voice
 * conversation while every financial read/action still fails closed.
 */
export function bindWalletForUser(
  walletForUser: WalletForUser,
  userId: string,
  chainFamily?: WalletChainFamilyHint,
): WalletProvider {
  const resolve = (override?: WalletChainFamilyHint) => {
    const family = override ?? chainFamily;
    if (family === undefined) return walletForUser(userId);
    return walletForUser(
      userId,
      typeof family === "function" ? family() : family,
    );
  };
  return {
    id: "privy-user-scoped",
    mode: "live",
    async health(context) {
      try {
        return await (await resolve()).health(context);
      } catch (error) {
        return {
          status: "unavailable",
          reason:
            error instanceof Error ? error.message : "Wallet is unavailable.",
        };
      }
    },
    async listNetworks() {
      // Multi-network balance reads (user decision 2026-10-07): the per-user
      // binding advertises EVERY chain family this resolver can serve, so the
      // definition's no-argument get_balance discovers both networks instead
      // of only the hinted family's. Deduped, order-stable.
      const hinted = await (await resolve()).listNetworks();
      const other =
        await (await resolve("solana")).listNetworks().catch(() => []);
      const union = [...hinted, ...other];
      const seen = new Set<string>();
      return union.filter(({ network }) => {
        if (seen.has(network)) return false;
        seen.add(network);
        return true;
      });
    },
    async listTokens(network) {
      return (await resolve()).listTokens(network);
    },
    async getAddress(context) {
      return (await resolve()).getAddress(context);
    },
    async getBalance(query) {
      return (await resolve()).getBalance(query);
    },
    async getHistory(query) {
      return (await resolve()).getHistory(query);
    },
    async previewTransfer(request) {
      return (await resolve()).previewTransfer(request);
    },
    async broadcastTransfer(request) {
      return (await resolve()).broadcastTransfer(request);
    },
    async waitForFinality(request, signal) {
      return (await resolve()).waitForFinality(request, signal);
    },
    async close() {},
  };
}

type UserWalletSelection = {
  privyDid: string;
  providerWalletId: string | null;
  address: string | null;
};

export function createUnavailablePrivyWalletResolver(): WalletForUser {
  return async () => {
    throw new PrivyWalletRuntimeError(
      "wallet_config_error",
      "Privy wallet reads require a configured server client.",
    );
  };
}

/**
 * Health projection for a per-user deployment.
 *
 * The provider answers the health route for a deployment whose per-user wallet
 * is resolved at request time, so it must advertise the chain that deployment
 * actually serves. This build serves Solana devnet only: it previously
 * advertised the retired Arc network, which made the unauthenticated health
 * projection disagree with the only provider the process can build.
 */
export function createPrivyWalletHealthProvider(
  configured: boolean,
): WalletProvider {
  const unavailable = () =>
    new PrivyWalletRuntimeError(
      configured ? "wallet_not_ready" : "wallet_config_error",
      configured
        ? "Privy wallet health is evaluated per authenticated user."
        : "Privy wallet reads require a configured server client.",
    );
  return {
    id: "privy-user-scoped",
    mode: "live",
    async health() {
      return {
        status: configured ? "degraded" : "unavailable",
        reason: unavailable().message,
      };
    },
    async listNetworks() {
      return [{ network: SOLANA_DEVNET_NETWORK, kind: "testnet" }];
    },
    async listTokens(network = SOLANA_DEVNET_NETWORK) {
      if (network !== SOLANA_DEVNET_NETWORK) throw unavailable();
      return [{ network: SOLANA_DEVNET_NETWORK, token: "SOL", decimals: 9 }];
    },
    async getAddress() {
      throw unavailable();
    },
    async getBalance() {
      throw unavailable();
    },
    async getHistory() {
      throw unavailable();
    },
    async previewTransfer() {
      throw unavailable();
    },
    async broadcastTransfer() {
      return {
        kind: "not_dispatched",
        reason: unavailable().message,
        cause: "provider_unavailable",
      };
    },
    async waitForFinality() {
      throw unavailable();
    },
    async close() {},
  };
}

/**
 * Reads the authenticated user's wallet binding for the chain family this
 * build serves (Solana).
 *
 * The `chain_family` predicate is load-bearing: the Solana per-user resolver
 * calls this for `privy_did`, and a Solana-only deployment must not depend on a
 * retired Arc wallet row existing to resolve its own wallet.
 */
export async function readUserWalletSelection(
  database: DatabaseClient,
  userId: string,
): Promise<UserWalletSelection> {
  return database.withUserTransaction(userId, async (client) => {
    const result = await client.query<{
      privy_did: string;
      provider_wallet_id: string | null;
      address: string | null;
    }>(
      `SELECT u.privy_did, w.provider_wallet_id, w.address
       FROM users u
       LEFT JOIN user_wallets w
         ON w.user_id = u.id
        AND w.chain_family = 'solana'
        AND w.state = 'ready'
       WHERE u.id = $1
       ORDER BY w.updated_at DESC NULLS LAST
       LIMIT 1`,
      [userId],
    );
    const row = result.rows[0];
    if (!row?.privy_did) {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "The authenticated user has no provisioned Privy identity.",
      );
    }
    return {
      privyDid: row.privy_did,
      providerWalletId: row.provider_wallet_id,
      address: row.address,
    };
  });
}
