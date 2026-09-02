import type { PendingTransfer, TransactionResult, TransferPreview, WalletBalanceQuery, WalletHistoryQuery } from '../contracts/http.js';

export type WalletContext = { wallet: string; network: string };
export type WalletBalance = { network: string; token?: string; address: string; balance: string };
export type WalletHistory = { network: string; transactions: Array<Record<string, string>> };
export type BroadcastOutcome = { kind: 'submitted'; transaction: TransactionResult } | { kind: 'uncertain'; reason: string } | { kind: 'not_dispatched'; reason: string };
export type FinalityOutcome = { status: 'confirmed' | 'reverted' | 'receipt_invalid'; transactionHash: string; network: 'sepolia'; reason?: string };
export type TransferRequest = Omit<PendingTransfer, 'preview'>;

export interface WalletProvider {
  readonly id: string;
  readonly mode: 'fixture' | 'live';
  getBalance(query: WalletBalanceQuery & WalletContext): Promise<WalletBalance>;
  getHistory(query: WalletHistoryQuery & WalletContext): Promise<WalletHistory>;
  previewTransfer(request: TransferRequest): Promise<TransferPreview>;
  broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome>;
  waitForFinality(transaction: TransactionResult, signal?: AbortSignal): Promise<FinalityOutcome>;
  close(): Promise<void>;
}
