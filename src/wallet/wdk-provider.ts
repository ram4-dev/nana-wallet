import type { Tool } from 'ai';
import type { TransactionResult, TransferPreview } from '../contracts/http.js';
import { defaultTransactionReceiptWaiter } from '../wdk/transaction-receipt.js';
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

type ToolSource = () => Promise<Record<string, Tool>>;

export class WdkWalletProvider implements WalletProvider {
  public readonly id = 'wdk-mcp';
  public readonly mode = 'live' as const;

  public constructor(private readonly source: ToolSource, private readonly onClose?: () => Promise<void>) {}

  private async call(name: string, input: unknown): Promise<unknown> {
    const tool = (await this.source())[name];
    if (!tool?.execute) throw new Error(`Wallet provider tool unavailable: ${name}`);
    return tool.execute(input as never, {
      toolCallId: `provider-${name}`,
      messages: [],
      abortSignal: new AbortController().signal,
    } as never);
  }

  public async health(context: { wallet: string; network: string }): Promise<WalletProviderHealth> {
    try {
      await this.getAddress(context);
      return { status: 'healthy' };
    } catch (error) {
      return { status: 'unavailable', reason: error instanceof Error ? error.message : 'Wallet provider unavailable.' };
    }
  }

  public async listNetworks(): Promise<WalletNetwork[]> {
    const result = unwrap(await this.call('get_networks', {}));
    if (!Array.isArray(result)) throw new Error('WDK networks response is invalid.');
    return result.map((value, index) => {
      const row = record(value, `WDK network ${index}`);
      const kind = row.kind === 'mainnet' ? 'mainnet' : 'testnet';
      return { network: stringValue(row.network, `WDK network ${index}`), kind };
    });
  }

  public async listTokens(network?: string): Promise<WalletToken[]> {
    const result = unwrap(await this.call('list_tokens', network ? { network } : {}));
    if (!Array.isArray(result)) throw new Error('WDK tokens response is invalid.');
    return result.map((value, index) => {
      const row = record(value, `WDK token ${index}`);
      const decimals = row.decimals;
      if (!Number.isInteger(decimals) || (decimals as number) < 0) throw new Error(`WDK token ${index} decimals are invalid.`);
      return {
        network: stringValue(row.network ?? network, `WDK token ${index} network`),
        token: stringValue(row.token, `WDK token ${index}`),
        decimals: decimals as number,
      };
    });
  }

  public async getAddress(context: { network: string; wallet: string }): Promise<WalletAddress> {
    const result = record(unwrap(await this.call('get_address', context)), 'WDK address');
    return {
      network: stringValue(result.network ?? context.network, 'WDK address network'),
      address: stringValue(result.address, 'WDK wallet address'),
    };
  }

  public async getBalance(query: { network: string; token?: string; wallet: string }): Promise<WalletBalance> {
    const result = record(unwrap(await this.call('get_balance', query)), 'WDK balance');
    const balance = typeof result.formatted === 'string'
      ? result.formatted.replace(/\s+[^\s]+$/u, '').trim()
      : Number.isInteger(result.decimals)
        ? normalizeBaseUnits(result.balance, result.decimals)
        : typeof result.balance === 'string' ? result.balance : '';
    return {
      network: stringValue(result.network ?? query.network, 'WDK balance network'),
      ...(query.token || typeof result.token === 'string' ? { token: query.token ?? result.token as string } : {}),
      address: typeof result.address === 'string' ? result.address : '',
      balance: stringValue(balance, 'WDK wallet balance'),
    };
  }

  public async getHistory(query: { network: string; token?: string; wallet: string }): Promise<WalletHistory> {
    const result = record(unwrap(await this.call('get_history', query)), 'WDK history');
    if (Array.isArray(result.transactions)) {
      return {
        network: stringValue(result.network ?? query.network, 'WDK history network'),
        transactions: result.transactions.map((value, index) => record(value, `WDK history transaction ${index}`) as Record<string, string>),
      };
    }
    if (!Array.isArray(result.transfers)) throw new Error('WDK history transactions are missing.');
    const wallet = stringValue(result.address, 'WDK history address').toLocaleLowerCase('en-US');
    return {
      network: stringValue(result.network ?? query.network, 'WDK history network'),
      transactions: result.transfers.map((value, index) => {
        const transfer = record(value, `WDK history transfer ${index}`);
        const from = stringValue(transfer.from, `WDK history transfer ${index} sender`);
        const to = stringValue(transfer.to, `WDK history transfer ${index} recipient`);
        const sent = from.toLocaleLowerCase('en-US') === wallet;
        const received = to.toLocaleLowerCase('en-US') === wallet;
        if (!sent && !received) throw new Error(`WDK history transfer ${index} does not involve the queried wallet.`);
        return {
          hash: stringValue(transfer.transactionHash, `WDK history transfer ${index} hash`),
          direction: sent ? 'out' : 'in',
          counterparty: sent ? to : from,
          amount: normalizeBaseUnits(transfer.amount, transfer.decimals),
          token: query.token ?? stringValue(transfer.token, `WDK history transfer ${index} token`),
          timestamp: normalizeTimestamp(transfer.timestamp, index),
        };
      }),
    };
  }

  public async previewTransfer(request: TransferRequest): Promise<TransferPreview> {
    const result = record(unwrap(await this.call('send_token', { ...request, dryRun: true })), 'WDK preview');
    const estimatedFee = result.estimatedFeeFormatted ?? result.estimatedFee;
    if (typeof estimatedFee !== 'string' || estimatedFee.trim().length === 0) throw new Error('Wallet provider returned no fee evidence.');
    return {
      network: request.network,
      token: request.token,
      recipient: request.to,
      amount: request.amount,
      estimatedFee: estimatedFee.trim(),
    };
  }

  public async broadcastTransfer(request: TransferRequest): Promise<BroadcastOutcome> {
    try {
      const result = record(unwrap(await this.call('send_token', { ...request, dryRun: false })), 'WDK broadcast');
      const evidence = result.broadcast === undefined ? undefined : record(result.broadcast, 'WDK broadcast evidence');
      if (evidence) {
        if (evidence.attempted === false || evidence.verification === 'not-dispatched') {
          return { kind: 'not_dispatched', reason: 'Wallet provider did not dispatch the transfer.' };
        }
      }
      const rawHash = result.transactionHash ?? result.txHash ?? result.hash ?? evidence?.hash;
      if (typeof rawHash !== 'string' || !/^0x[0-9a-f]{64}$/iu.test(rawHash)) {
        return { kind: 'uncertain', reason: 'Wallet provider returned no trustworthy transaction hash.' };
      }
      const transaction: TransactionResult = {
        network: request.network,
        transactionHash: rawHash,
        explorerUrl: `https://sepolia.etherscan.io/tx/${rawHash}`,
      };
      return { kind: 'submitted', transaction };
    } catch (error) {
      return { kind: 'uncertain', reason: error instanceof Error ? error.message : 'Wallet provider failed.' };
    }
  }

  public async waitForFinality(request: FinalityRequest, signal?: AbortSignal): Promise<FinalityOutcome> {
    const transaction = 'transaction' in request ? request.transaction : request;
    return defaultTransactionReceiptWaiter(transaction, {
      signal: 'transaction' in request ? request.signal ?? signal : signal,
    });
  }

  public async close(): Promise<void> {
    await this.onClose?.();
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} response is invalid.`);
  return value as Record<string, unknown>;
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`${label} is missing.`);
  return value;
}

function unwrap(value: unknown, depth = 0): unknown {
  if (depth > 5) return value;
  if (typeof value === 'string') {
    try { return unwrap(JSON.parse(value) as unknown, depth + 1); } catch { return value; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const object = value as Record<string, unknown>;
  if (Array.isArray(object.content)) {
    const text = object.content.find((part) => part && typeof part === 'object' && (part as Record<string, unknown>).type === 'text');
    if (text && typeof (text as Record<string, unknown>).text === 'string') return unwrap((text as Record<string, unknown>).text, depth + 1);
  }
  for (const key of ['output', 'result', 'data'] as const) {
    if (key in object) return unwrap(object[key], depth + 1);
  }
  return value;
}

function normalizeBaseUnits(value: unknown, decimals: unknown): string {
  if (typeof value !== 'string' || !/^\d+$/u.test(value) || !Number.isInteger(decimals) || (decimals as number) < 0 || (decimals as number) > 255) {
    throw new Error('WDK base-unit value or decimals are invalid.');
  }
  const places = decimals as number;
  const digits = value.replace(/^0+(?=\d)/u, '');
  if (places === 0) return digits;
  const padded = digits.padStart(places + 1, '0');
  const fraction = padded.slice(-places).replace(/0+$/u, '');
  return fraction ? `${padded.slice(0, -places)}.${fraction}` : padded.slice(0, -places);
}

function normalizeTimestamp(value: unknown, index: number): string {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) || Date.parse(value) : Number.NaN;
  const milliseconds = Math.abs(numeric) < 1_000_000_000_000 ? numeric * 1_000 : numeric;
  const date = new Date(milliseconds);
  if (!Number.isFinite(milliseconds) || Number.isNaN(date.getTime())) throw new Error(`WDK history transfer ${index} timestamp is invalid.`);
  return date.toISOString();
}
