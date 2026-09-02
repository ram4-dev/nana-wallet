import type { Tool } from 'ai';
import type { PendingTransfer, TransactionResult, TransferPreview } from '../contracts/http.js';
import { defaultTransactionReceiptWaiter } from '../wdk/transaction-receipt.js';
import type { BroadcastOutcome, FinalityOutcome, WalletBalance, WalletHistory, WalletProvider, TransferRequest } from './provider.js';

type ToolSource = () => Promise<Record<string, Tool>>;

function textResult(value: unknown): Record<string, unknown> {
  if (typeof value === 'string') {
    try { return textResult(JSON.parse(value) as unknown); } catch { return {}; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const object = value as Record<string, unknown>;
  for (const key of ['output', 'result', 'data'] as const) {
    if (key in object) {
      const nested = textResult(object[key]);
      if (Object.keys(nested).length > 0) return nested;
    }
  }
  return object;
}

export class WdkWalletProvider implements WalletProvider {
  public readonly id = 'wdk-mcp';
  public readonly mode = 'live' as const;
  public constructor(private readonly source: ToolSource) {}

  private async call(name: string, input: unknown): Promise<unknown> {
    const tool = (await this.source())[name];
    if (!tool?.execute) throw new Error(`Wallet provider tool unavailable: ${name}`);
    return tool.execute(input, {} as never);
  }

  public async getBalance(query: { network: string; token?: string; wallet: string }): Promise<WalletBalance> {
    return (await this.call('get_balance', query)) as WalletBalance;
  }

  public async getHistory(query: { network: string; token?: string; wallet: string }): Promise<WalletHistory> {
    return (await this.call('get_history', query)) as WalletHistory;
  }

  public async previewTransfer(request: TransferRequest): Promise<TransferPreview> {
    const result = textResult(await this.call('send_token', { ...request, dryRun: true }));
    const estimatedFee = result.estimatedFeeFormatted ?? result.estimatedFee;
    if (typeof estimatedFee !== 'string') throw new Error('Wallet provider returned no fee evidence.');
    return { network: request.network, token: request.token, recipient: request.to, amount: request.amount, estimatedFee };
  }

  public async broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome> {
    try {
      const result = textResult(await this.call('send_token', { ...request, dryRun: false }));
      const rawHash = result.transactionHash ?? result.txHash ?? result.hash;
      if (typeof rawHash !== 'string' || !/^0x[0-9a-f]{64}$/iu.test(rawHash)) return { kind: 'uncertain', reason: 'Wallet provider returned no trustworthy transaction hash.' };
      const transaction: TransactionResult = { network: request.network, transactionHash: rawHash, explorerUrl: `https://sepolia.etherscan.io/tx/${rawHash}` };
      return { kind: 'submitted', transaction };
    } catch (error) {
      return { kind: 'uncertain', reason: error instanceof Error ? error.message : 'Wallet provider failed.' };
    }
  }

  public async waitForFinality(transaction: TransactionResult, signal?: AbortSignal): Promise<FinalityOutcome> {
    return defaultTransactionReceiptWaiter(transaction, { signal });
  }

  public async close(): Promise<void> {}
}
