import type { DatabaseClient } from "../db/client.js";
import {
  PrivyServerError,
  type PrivyWalletRecord,
  type PrivyServerClient,
} from "./privy-server-client.js";
import {
  PrivyWalletRuntimeError,
  readUserWalletSelection,
  type WalletForUser,
} from "./user-wallet.js";
import {
  SolanaDevnetProvider,
  SOLANA_DEVNET_NETWORK,
  SOLANA_DEVNET_RPC_URL,
  solanaDevnetRpc,
  privySignAndSendFromEnvironment,
  type SolanaRpc,
} from "./solana-devnet-provider.js";
import { Connection } from "@solana/web3.js";
import type { PayloadSigner } from "./signer/index.js";

export type SolanaUserWalletResolverInput = {
  database: DatabaseClient;
  privy: PrivyServerClient;
  environment?: NodeJS.ProcessEnv;
  /**
   * S2a/S4: the worker's sidecar-backed authorization signer. The dispatch
   * client signs every Privy wallet RPC through this port; when it is absent the
   * resolver falls back to the sidecar configuration in `environment`, so the
   * authorization key is never read by the worker process either way.
   */
  authorizationSigner?: PayloadSigner;
  /** Read-only RPC surface; injected in tests so no live devnet read happens. */
  rpc?: SolanaRpc;
};

function isEligibleSolanaWallet(wallet: PrivyWalletRecord): boolean {
  return wallet.chain_type === "solana" && wallet.archived_at == null;
}

/**
 * Per-user Solana devnet wallet resolver: discovers the user's single
 * embedded Privy Solana wallet and binds a SolanaDevnetProvider to it.
 * Fail-closed: zero or multiple eligible wallets, or a missing local
 * binding, throw (never a global/fixed sender address).
 */
export function createSolanaWalletForUser(
  input: SolanaUserWalletResolverInput,
): WalletForUser {
  return async (userId) => {
    // Readiness gate: exactly one ready local wallet binding for this user.
    // Schema (006_embedded_wallets): user_wallets(id, user_id,
    // provider, provider_wallet_id UNIQUE, chain_family, address NOT NULL,
    // state CHECK in ('unprovisioned','provisioning','ready',
    // 'recovery_required','conflict','unavailable')) with a unique
    // one-active-per-(user, chain_family) index. Read by that contract.
    const readiness = await input.database.withUserTransaction(
      userId,
      async (client) => {
        const result = await client.query<{
          id: string;
          provider_wallet_id: string;
          state: string;
          address: string | null;
        }>(
          `SELECT id, provider_wallet_id, state, address FROM user_wallets
         WHERE user_id = $1 AND chain_family = 'solana' AND state = 'ready'
         ORDER BY created_at DESC`,
          [userId],
        );
        return result.rows;
      },
    );
    if (readiness.length === 0) {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "The user has no ready Solana wallet binding.",
      );
    }
    // The one-active-per-(user, chain_family) unique index makes >1 ready an
    // integrity anomaly; refuse rather than guess.
    if (readiness.length > 1) {
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        "The user has more than one ready Solana wallet binding; refusing to guess.",
      );
    }
    const binding = readiness[0];
    if (typeof binding.address !== "string" || binding.address.length === 0) {
      // A ready binding without an address is a local configuration anomaly:
      // never fall back to an empty or placeholder sender address.
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        "The user's ready Solana wallet binding has no address.",
      );
    }
    // Narrows the DB-nullable address for the provider construction below;
    // the closure captures this non-null const, never the raw row value.
    const senderAddress: string = binding.address;

    const selection = await readUserWalletSelection(input.database, userId);
    let wallets: PrivyWalletRecord[];
    try {
      wallets = await input.privy.listWalletsForChain(
        selection.privyDid,
        "solana",
      );
    } catch (error) {
      throw new PrivyWalletRuntimeError(
        "wallet_unavailable",
        error instanceof PrivyServerError
          ? "Privy could not verify the user's Solana wallet."
          : "The user's Solana wallet could not be resolved.",
      );
    }
    const eligible = wallets.filter(isEligibleSolanaWallet);
    if (eligible.length !== 1) {
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        `Exactly one embedded Solana wallet is required; found ${eligible.length}.`,
      );
    }
    const wallet = eligible[0];
    // The binding is asserted against Privy on BOTH axes independently: the
    // wallet id must be the bound provider_wallet_id (never the local UUID
    // primary key) and the Privy address must equal the bound address.
    if (wallet.id !== binding.provider_wallet_id) {
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        "The Privy Solana wallet id does not match the bound provider_wallet_id.",
      );
    }
    if (wallet.address !== binding.address) {
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        "The Privy Solana wallet address does not match the bound address.",
      );
    }

    return new SolanaDevnetProvider(
      { walletId: wallet.id, senderAddress },
      {
        rpc:
          input.rpc ??
          solanaDevnetRpc(
            new Connection(SOLANA_DEVNET_RPC_URL, "confirmed"),
            async () => senderAddress,
          ),
        signAndSend: privySignAndSendFromEnvironment(
          input.environment ?? process.env,
          input.authorizationSigner,
        ),
      },
    );
  };
}
