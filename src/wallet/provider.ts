import type {
  PendingTransfer,
  TransactionResult,
  TransferPreview,
} from "../contracts/http.js";

export type WalletContext = { wallet: string; network: string };
export type WalletProviderHealth = {
  status: "healthy" | "degraded" | "unavailable";
  reason?: string;
};
export type WalletNetwork = { network: string; kind: "mainnet" | "testnet" };
export type WalletToken = { network: string; token: string; decimals: number };
export type WalletAddress = { network: string; address: string };
export type WalletBalance = {
  network: string;
  token?: string;
  address: string;
  balance: string;
};
export type WalletHistory = {
  network: string;
  transactions: Array<Record<string, string>>;
};
export type WalletBalanceQuery = WalletContext & { token?: string };
export type WalletHistoryQuery = WalletContext & { token?: string };
/**
 * Machine-readable cause for a `not_dispatched` broadcast outcome. It is
 * REQUIRED so a new producer cannot silently inherit an unrelated meaning and
 * so the conversation layer can tell a definitive refusal from a transient
 * outage (the two need opposite user-facing messages).
 *
 * - `policy_rejected`: the wallet's own policy refused the dispatch before
 *   anything left our process. Definitive: retrying the same transfer can
 *   never succeed.
 * - `invalid_request`: the request WE built was malformed (for example a
 *   missing persisted preview identity), so the provider never dispatched.
 *   Our bug, not the wallet's.
 * - `provider_unavailable`: the provider could not dispatch because it is not
 *   reachable, not configured, or otherwise temporarily unusable.
 */
export type NotDispatchedCause =
  | "policy_rejected"
  | "invalid_request"
  | "provider_unavailable";
export type BroadcastOutcome =
  | { kind: "submitted"; transaction: TransactionResult }
  | { kind: "uncertain"; reason: string }
  | { kind: "not_dispatched"; reason: string; cause: NotDispatchedCause };
export type FinalityOutcome = {
  status: "confirmed" | "reverted" | "receipt_invalid";
  transactionHash: string;
  network: string;
  reason?: string;
};
export type FinalityRequest =
  | TransactionResult
  | { transaction: TransactionResult; signal?: AbortSignal };
export type TransferRequest = Omit<PendingTransfer, "preview">;

const EXPLORER_URLS: Record<string, string> = {
  sepolia: "https://sepolia.etherscan.io/tx/",
  "arc-testnet": "https://testnet.arcscan.app/tx/",
  "solana-devnet": "https://explorer.solana.com/tx/",
};

/** Devnet explorer links carry the cluster query param AFTER the hash. */
const EXPLORER_URL_SUFFIXES: Record<string, string> = {
  "solana-devnet": "?cluster=devnet",
};

export function explorerUrlFor(
  network: string,
  transactionHash: string,
): string {
  const base = EXPLORER_URLS[network] ?? "https://sepolia.etherscan.io/tx/";
  const suffix = EXPLORER_URL_SUFFIXES[network] ?? "";
  return `${base}${transactionHash}${suffix}`;
}

export interface WalletProvider {
  readonly id: string;
  readonly mode: "fixture" | "live";
  health(context: WalletContext): Promise<WalletProviderHealth>;
  listNetworks(): Promise<WalletNetwork[]>;
  listTokens(network?: string): Promise<WalletToken[]>;
  getAddress(context: WalletContext): Promise<WalletAddress>;
  getBalance(query: WalletBalanceQuery): Promise<WalletBalance>;
  getHistory(query: WalletHistoryQuery): Promise<WalletHistory>;
  previewTransfer(request: TransferRequest): Promise<TransferPreview>;
  broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome>;
  waitForFinality(
    request: FinalityRequest,
    signal?: AbortSignal,
  ): Promise<FinalityOutcome>;
  close(): Promise<void>;
}

/**
 * Fail-closed wallet provider for a missing wallet configuration. It exists so a
 * deployment that never wired a wallet fails LOUDLY on first use instead of
 * silently serving the fixture double, whose reads answer and whose
 * "broadcasts" fabricate a synthetic transfer.
 *
 * `mode` is the type-level `"fixture"` constraint, not a claim about this
 * provider: it is neither a fixture nor a live provider, and every method
 * rejects. `id` is the distinct literal `"unavailable"` so health and shutdown
 * can tell it apart from the fixture. `close()` resolves so a shutdown path can
 * always retire it.
 */
export function createUnavailableWalletProvider(
  reason: string,
): WalletProvider {
  const unavailable = (): Promise<never> => Promise.reject(new Error(reason));
  return {
    id: "unavailable",
    mode: "fixture",
    health: unavailable,
    listNetworks: unavailable,
    listTokens: unavailable,
    getAddress: unavailable,
    getBalance: unavailable,
    getHistory: unavailable,
    previewTransfer: unavailable,
    broadcastTransfer: unavailable,
    waitForFinality: unavailable,
    async close() {},
  };
}
