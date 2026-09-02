import type { TransactionResult, TransferPreview } from '../contracts/http.js';
import { immediateTransactionReceiptWaiter } from '../wdk/transaction-receipt.js';
import type {
  BroadcastOutcome,
  FinalityOutcome,
  FinalityRequest,
  WalletAddress,
  WalletBalance,
  WalletHistory,
  WalletNetwork,
  WalletProvider,
  WalletProviderHealth,
  WalletToken,
  TransferRequest,
} from './provider.js';

const HASH_PREFIX = '0x';
let fixtureTxCounter = 0;

export class FixtureWalletProvider implements WalletProvider {
  public readonly id = 'fixture';
  public readonly mode = 'fixture' as const;

  public async health(): Promise<WalletProviderHealth> {
    return { status: 'healthy' };
  }

  public async listNetworks(): Promise<WalletNetwork[]> {
    return [{ network: 'sepolia', kind: 'testnet' }];
  }

  public async listTokens(network = 'sepolia'): Promise<WalletToken[]> {
    return [{ network, token: 'USDT', decimals: 6 }];
  }

  public async getAddress(context: WalletContext): Promise<WalletAddress> {
    return { network: context.network, address: '0x1234000000000000000000000000000000abcd' };
  }

  public async getBalance(query: { network: string; token?: string; wallet: string }): Promise<WalletBalance> {
    return { network: query.network, token: query.token ?? 'USDT', address: '0x1234000000000000000000000000000000abcd', balance: '42.5' };
  }

  public async getHistory(query: { network: string; token?: string; wallet: string }): Promise<WalletHistory> {
    return {
      network: query.network,
      transactions: [{
        hash: '0xfixturehistory0000000000000000000000000000000000000000000001',
        direction: 'in',
        counterparty: '0xsender00000000000000000000000000000000',
        amount: '5',
        token: query.token ?? 'USDT',
        timestamp: new Date(0).toISOString(),
      }],
    };
  }

  public async previewTransfer(request: TransferRequest): Promise<TransferPreview> {
    return {
      network: request.network,
      token: request.token,
      recipient: request.to,
      amount: request.amount,
      estimatedFee: '0.0003 ETH',
    };
  }

  public async broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome> {
    fixtureTxCounter += 1;
    const transactionHash = `${HASH_PREFIX}${fixtureTxCounter.toString(16).padStart(64, '0')}`;
    const transaction: TransactionResult = {
      network: request.network,
      transactionHash,
      explorerUrl: `https://sepolia.etherscan.io/tx/${transactionHash}`,
    };
    return { kind: 'submitted', transaction };
  }

  public async waitForFinality(request: FinalityRequest, signal?: AbortSignal): Promise<FinalityOutcome> {
    const transaction = 'transaction' in request ? request.transaction : request;
    const receipt = await immediateTransactionReceiptWaiter(transaction, {
      signal: 'transaction' in request ? request.signal ?? signal : signal,
    });
    return { ...receipt };
  }

  public async close(): Promise<void> {}
}

type WalletContext = { wallet: string; network: string };
