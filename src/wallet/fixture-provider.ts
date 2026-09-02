import { immediateTransactionReceiptWaiter } from '../wdk/transaction-receipt.js';
import type { PendingTransfer, TransactionResult, TransferPreview } from '../contracts/http.js';
import type { BroadcastOutcome, FinalityOutcome, WalletBalance, WalletHistory, WalletProvider, TransferRequest } from './provider.js';

const HASH = '0x0000000000000000000000000000000000000000000000000000000000000001';

export class FixtureWalletProvider implements WalletProvider {
  public readonly id = 'fixture';
  public readonly mode = 'fixture' as const;

  public async getBalance(query: { network: string; token?: string; wallet: string }): Promise<WalletBalance> {
    return { network: query.network, token: query.token ?? 'usdt-test', address: '0xfixture', balance: '42.5' };
  }

  public async getHistory(query: { network: string; token?: string; wallet: string }): Promise<WalletHistory> {
    return { network: query.network, transactions: [] };
  }

  public async previewTransfer(request: TransferRequest): Promise<TransferPreview> {
    return { network: request.network, token: request.token, recipient: request.to, amount: request.amount, estimatedFee: '0.0003 ETH' };
  }

  public async broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome> {
    const transaction: TransactionResult = {
      network: request.network,
      transactionHash: HASH,
      explorerUrl: `https://sepolia.etherscan.io/tx/${HASH}`,
    };
    return { kind: 'submitted', transaction };
  }

  public async waitForFinality(transaction: TransactionResult, signal?: AbortSignal): Promise<FinalityOutcome> {
    const receipt = await immediateTransactionReceiptWaiter(transaction, { signal });
    return { ...receipt };
  }

  public async close(): Promise<void> {}
}
