import type { PendingTransfer, TransactionResult, TransferPreview } from '../contracts/http.js';

export type WalletContext = { wallet: string; network: string };
export type WalletProviderHealth = {
  status: 'healthy' | 'degraded' | 'unavailable';
  reason?: string;
};
export type WalletNetwork = { network: string; kind: 'mainnet' | 'testnet' };
export type WalletToken = { network: string; token: string; decimals: number };
export type WalletAddress = { network: string; address: string };
export type WalletBalance = { network: string; token?: string; address: string; balance: string };
export type WalletHistory = { network: string; transactions: Array<Record<string, string>> };
export type WalletBalanceQuery = WalletContext & { token?: string };
export type WalletHistoryQuery = WalletContext & { token?: string };
export type BroadcastOutcome =
  | { kind: 'submitted'; transaction: TransactionResult }
  | { kind: 'uncertain'; reason: string }
  | { kind: 'not_dispatched'; reason: string };
export type FinalityOutcome = {
  status: 'confirmed' | 'reverted' | 'receipt_invalid';
  transactionHash: string;
  network: 'sepolia';
  reason?: string;
};
export type FinalityRequest =
  | TransactionResult
  | { transaction: TransactionResult; signal?: AbortSignal };
export type TransferRequest = Omit<PendingTransfer, 'preview'>;

export interface WalletProvider {
  readonly id: string;
  readonly mode: 'fixture' | 'live';
  health(context: WalletContext): Promise<WalletProviderHealth>;
  listNetworks(): Promise<WalletNetwork[]>;
  listTokens(network?: string): Promise<WalletToken[]>;
  getAddress(context: WalletContext): Promise<WalletAddress>;
  getBalance(query: WalletBalanceQuery): Promise<WalletBalance>;
  getHistory(query: WalletHistoryQuery): Promise<WalletHistory>;
  previewTransfer(request: TransferRequest): Promise<TransferPreview>;
  broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome>;
  waitForFinality(request: FinalityRequest, signal?: AbortSignal): Promise<FinalityOutcome>;
  close(): Promise<void>;
}
