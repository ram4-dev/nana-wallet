import type { DatabaseClient } from "../db/client.js";
import type { AuthorizationContext } from "@privy-io/node";
import {
  signerAuthorizationContext,
  type PayloadSigner,
} from "./signer/index.js";
import type {
  BroadcastOutcome,
  FinalityOutcome,
  FinalityRequest,
  TransferRequest,
  WalletAddress,
  WalletBalance,
  WalletHistory,
  WalletNetwork,
  WalletProvider,
  WalletProviderHealth,
  WalletToken,
} from "./provider.js";
import type { TransferPreview } from "../contracts/http.js";
import {
  PrivyServerClient,
  PrivyServerError,
  type PrivyWalletRecord,
} from "./privy-server-client.js";

export const PRIVY_ARC_NETWORK = "arc-testnet";
export const PRIVY_ARC_CHAIN_ID = 5_042_002n;
export const PRIVY_ARC_RPC_URL = "https://rpc.testnet.arc.io";
export const PRIVY_ARC_USDC = "0x3600000000000000000000000000000000000000";
export const PRIVY_ARC_USDC_DECIMALS = 6;

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/u;
const HEX_QUANTITY = /^0x[0-9a-fA-F]+$/u;
const BALANCE_OF_SELECTOR = "70a08231";
const DECIMALS_SELECTOR = "0x313ce567";
const RPC_TIMEOUT_MS = 10_000;

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

export type WalletChainFamily = "ethereum" | "solana";
export type WalletChainFamilyHint =
  WalletChainFamily | (() => WalletChainFamily);

export type WalletForUser = (
  userId: string,
  chainFamily?: WalletChainFamilyHint,
) => Promise<WalletProvider>;

export function walletChainFamilyForNetwork(
  network: string | undefined,
): WalletChainFamily {
  switch (network) {
    case "arc-testnet":
    case "sepolia":
      return "ethereum";
    case "solana-devnet":
      return "solana";
    default:
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        `Unsupported wallet network: ${network ?? "(missing)"}.`,
      );
  }
}

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

export type PrivyWalletRpc = (
  method: string,
  params?: unknown[],
) => Promise<unknown>;

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
      return [{ network: PRIVY_ARC_NETWORK, kind: "testnet" }];
    },
    async listTokens(network = PRIVY_ARC_NETWORK) {
      if (network !== PRIVY_ARC_NETWORK) throw unavailable();
      return [
        {
          network: PRIVY_ARC_NETWORK,
          token: "USDC",
          decimals: PRIVY_ARC_USDC_DECIMALS,
        },
      ];
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
      return { kind: "not_dispatched", reason: unavailable().message };
    },
    async waitForFinality() {
      throw unavailable();
    },
    async close() {},
  };
}

/**
 * Resolves a fresh provider for the authenticated user. Privy's server-side
 * user filter is the ownership boundary; a ready local binding is used only to
 * select one wallet when Privy returns more than one eligible EVM wallet.
 *
 * `authorizationSigner` (S2a) is the worker's local signing-sidecar client. The
 * provider builds the Privy authorization context from it, so this wallet path
 * never requires the authorization private key in-process.
 */
export function createPrivyWalletForUserResolver(input: {
  database: DatabaseClient;
  privy: PrivyServerClient;
  rpcUrl?: string;
  rpc?: PrivyWalletRpc;
  authorizationSigner?: PayloadSigner;
}): WalletForUser {
  return async (userId) => {
    const selection = await readUserWalletSelection(input.database, userId);
    let wallets: PrivyWalletRecord[];
    try {
      wallets = await input.privy.listWalletsForUser(selection.privyDid);
    } catch (error) {
      throw new PrivyWalletRuntimeError(
        "wallet_unavailable",
        error instanceof PrivyServerError
          ? "Privy could not verify the user's wallet."
          : "The user's wallet could not be resolved.",
      );
    }

    const eligible = wallets.filter(isEligibleEvmWallet);
    const selected = selectWallet(eligible, selection);
    return new PrivyUserWalletProvider(selected, {
      rpcUrl: input.rpcUrl,
      rpc: input.rpc,
      ...(input.authorizationSigner
        ? { authorizationSigner: input.authorizationSigner }
        : {}),
    });
  };
}

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
        AND w.chain_family = 'arc'
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

function isEligibleEvmWallet(wallet: PrivyWalletRecord): boolean {
  return (
    wallet.chain_type === "ethereum" &&
    typeof wallet.id === "string" &&
    wallet.id.length > 0 &&
    EVM_ADDRESS.test(wallet.address)
  );
}

function selectWallet(
  wallets: PrivyWalletRecord[],
  local: UserWalletSelection,
): PrivyWalletRecord {
  if (wallets.length === 0) {
    throw new PrivyWalletRuntimeError(
      "wallet_not_ready",
      "No eligible Arc wallet is available for this user.",
    );
  }

  if (wallets.length > 1) {
    throw new PrivyWalletRuntimeError(
      "wallet_not_ready",
      "Multiple eligible wallets require an explicit verified selection.",
    );
  }

  if (local.providerWalletId) {
    const matches = wallets.filter(
      (wallet) => wallet.id === local.providerWalletId,
    );
    if (matches.length !== 1) {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "The user's selected wallet could not be verified with Privy.",
      );
    }
    const selected = matches[0]!;
    if (
      local.address &&
      selected.address.toLocaleLowerCase("en-US") !==
        local.address.toLocaleLowerCase("en-US")
    ) {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "The user's selected wallet address does not match Privy.",
      );
    }
    return selected;
  }

  return wallets[0]!;
}

export class PrivyUserWalletProvider implements WalletProvider {
  public readonly id = "privy-user";
  public readonly mode = "live" as const;

  /**
   * S2a: the key-free Privy authorization context (SDK `sign_fns`) for this
   * wallet's signing path, built from the injected local-sidecar signer. It is
   * `undefined` when no signer is configured, and the key never enters this
   * process. The transfer calls that consume it are S2b; until they are wired,
   * `previewTransfer`/`broadcastTransfer`/`waitForFinality` stay fail-closed.
   */
  public readonly authorizationContext: AuthorizationContext | undefined;

  private readonly rpc: PrivyWalletRpc;

  public constructor(
    private readonly wallet: Pick<PrivyWalletRecord, "id" | "address">,
    options: {
      rpcUrl?: string;
      rpc?: PrivyWalletRpc;
      authorizationSigner?: PayloadSigner;
    } = {},
  ) {
    if (!EVM_ADDRESS.test(wallet.address)) {
      throw new PrivyWalletRuntimeError(
        "wallet_not_ready",
        "Privy returned an invalid wallet address.",
      );
    }
    const rpcUrl = options.rpcUrl ?? PRIVY_ARC_RPC_URL;
    this.rpc =
      options.rpc ??
      ((method, params = []) => privyArcRpcCall(rpcUrl, method, params));
    this.authorizationContext = options.authorizationSigner
      ? signerAuthorizationContext(options.authorizationSigner)
      : undefined;
  }

  public async health(): Promise<WalletProviderHealth> {
    try {
      await this.assertArcChain();
      return { status: "healthy" };
    } catch (error) {
      return {
        status: "unavailable",
        reason:
          error instanceof Error
            ? error.message
            : "Arc wallet RPC is unavailable.",
      };
    }
  }

  public async listNetworks(): Promise<WalletNetwork[]> {
    return [{ network: PRIVY_ARC_NETWORK, kind: "testnet" }];
  }

  public async listTokens(network = PRIVY_ARC_NETWORK): Promise<WalletToken[]> {
    this.assertNetwork(network);
    return [
      {
        network: PRIVY_ARC_NETWORK,
        token: "USDC",
        decimals: PRIVY_ARC_USDC_DECIMALS,
      },
    ];
  }

  public async getAddress(context: {
    wallet: string;
    network: string;
  }): Promise<WalletAddress> {
    this.assertNetwork(context.network);
    return { network: PRIVY_ARC_NETWORK, address: this.wallet.address };
  }

  public async getBalance(query: {
    wallet: string;
    network: string;
    token?: string;
  }): Promise<WalletBalance> {
    this.assertNetwork(query.network);
    if (query.token && query.token.toUpperCase() !== "USDC") {
      throw new PrivyWalletRuntimeError(
        "wallet_feature_unavailable",
        "The Privy Arc wallet currently supports USDC balance reads only.",
      );
    }
    await this.assertArcChain();
    const decimals = await this.rpc("eth_call", [
      { to: PRIVY_ARC_USDC, data: DECIMALS_SELECTOR },
      "latest",
    ]);
    if (
      typeof decimals !== "string" ||
      !HEX_QUANTITY.test(decimals) ||
      BigInt(decimals) !== BigInt(PRIVY_ARC_USDC_DECIMALS)
    ) {
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        "The configured Arc USDC contract did not report six decimals.",
      );
    }
    const data = `0x${BALANCE_OF_SELECTOR}${this.wallet.address
      .slice(2)
      .toLocaleLowerCase("en-US")
      .padStart(64, "0")}`;
    const raw = await this.rpc("eth_call", [
      { to: PRIVY_ARC_USDC, data },
      "latest",
    ]);
    if (typeof raw !== "string" || !HEX_QUANTITY.test(raw)) {
      throw new PrivyWalletRuntimeError(
        "wallet_unavailable",
        "Arc RPC returned an invalid USDC balance.",
      );
    }
    return {
      network: PRIVY_ARC_NETWORK,
      token: "USDC",
      address: this.wallet.address,
      balance: formatUnits(BigInt(raw), PRIVY_ARC_USDC_DECIMALS),
    };
  }

  public async getHistory(query: {
    wallet: string;
    network: string;
    token?: string;
  }): Promise<WalletHistory> {
    this.assertNetwork(query.network);
    throw new PrivyWalletRuntimeError(
      "wallet_feature_unavailable",
      "Verified transaction history is not configured for Privy Arc wallets.",
    );
  }

  public async previewTransfer(
    _request: TransferRequest,
  ): Promise<TransferPreview> {
    throw this.signingUnavailable();
  }

  public async broadcastTransfer(
    _request: TransferRequest,
  ): Promise<BroadcastOutcome> {
    return {
      kind: "not_dispatched",
      reason: this.signingUnavailable().message,
    };
  }

  public async waitForFinality(
    _request: FinalityRequest,
    _signal?: AbortSignal,
  ): Promise<FinalityOutcome> {
    throw this.signingUnavailable();
  }

  public async close(): Promise<void> {}

  private assertNetwork(network: string): void {
    if (network !== PRIVY_ARC_NETWORK) {
      throw new PrivyWalletRuntimeError(
        "wallet_feature_unavailable",
        `Privy user wallets only support ${PRIVY_ARC_NETWORK}.`,
      );
    }
  }

  private async assertArcChain(): Promise<void> {
    let raw: unknown;
    try {
      raw = await this.rpc("eth_chainId");
    } catch {
      throw new PrivyWalletRuntimeError(
        "wallet_unavailable",
        "Arc RPC is unavailable.",
      );
    }
    if (typeof raw !== "string" || !HEX_QUANTITY.test(raw)) {
      throw new PrivyWalletRuntimeError(
        "wallet_unavailable",
        "Arc RPC returned an invalid chain id.",
      );
    }
    if (BigInt(raw) !== PRIVY_ARC_CHAIN_ID) {
      throw new PrivyWalletRuntimeError(
        "wallet_config_error",
        "Wallet RPC is not connected to Arc Testnet.",
      );
    }
  }

  private signingUnavailable(): PrivyWalletRuntimeError {
    return new PrivyWalletRuntimeError(
      "wallet_unavailable",
      "Privy wallet signing is disabled until the provider spending limits are verified.",
    );
  }
}

function formatUnits(value: bigint, decimals: number): string {
  const digits = value.toString().padStart(decimals + 1, "0");
  const whole = digits.slice(0, -decimals);
  const fraction = digits.slice(-decimals).replace(/0+$/u, "");
  return fraction ? `${whole}.${fraction}` : whole;
}

async function privyArcRpcCall(
  rpcUrl: string,
  method: string,
  params: unknown[],
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(rpcUrl, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(RPC_TIMEOUT_MS),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method,
        params,
      }),
    });
  } catch {
    throw new PrivyWalletRuntimeError(
      "wallet_unavailable",
      "Arc RPC is unavailable.",
    );
  }
  if (!response.ok) {
    throw new PrivyWalletRuntimeError(
      "wallet_unavailable",
      `Arc RPC failed (${response.status}).`,
    );
  }
  const body = (await response.json()) as {
    result?: unknown;
    error?: unknown;
  };
  if (body.error !== undefined || !("result" in body)) {
    throw new PrivyWalletRuntimeError(
      "wallet_unavailable",
      "Arc RPC returned an error.",
    );
  }
  return body.result;
}
