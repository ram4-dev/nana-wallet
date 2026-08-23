import type { TransactionResult } from '../contracts/http.js';

const SEPOLIA_CHAIN_ID = 11155111n;
const DEFAULT_SEPOLIA_RPC_URL = 'https://ethereum-sepolia-rpc.publicnode.com';
const DEFAULT_POLL_INTERVAL_MS = 4_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000;
const EVM_TRANSACTION_HASH = /^0x[0-9a-fA-F]{64}$/u;

export type TransactionReceiptOutcome = {
  status: 'confirmed' | 'reverted';
  network: 'sepolia';
  transactionHash: string;
};

export type TransactionReceiptWaiter = (
  transaction: TransactionResult,
  options?: { signal?: AbortSignal },
) => Promise<TransactionReceiptOutcome>;

type WaitForTransactionReceiptOptions = {
  rpcUrl?: string;
  pollIntervalMs?: number;
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
};

export class TransactionReceiptValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TransactionReceiptValidationError';
  }
}

export class TransactionReceiptAbortedError extends Error {
  constructor() {
    super('Transaction receipt wait was aborted.');
    this.name = 'TransactionReceiptAbortedError';
  }
}

function sleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new TransactionReceiptAbortedError());
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new TransactionReceiptAbortedError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseChainId(value: unknown): bigint | null {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/u.test(value)) return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

async function rpcRequest(
  rpcUrl: string,
  method: string,
  params: unknown[],
  fetchImpl: typeof fetch,
  requestTimeoutMs: number,
  signal?: AbortSignal,
): Promise<unknown> {
  if (signal?.aborted) throw new TransactionReceiptAbortedError();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, requestTimeoutMs);
  const abortRequest = () => controller.abort();
  signal?.addEventListener('abort', abortRequest, { once: true });
  try {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: controller.signal,
    });
    if (!response.ok) {
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new Error(`Sepolia RPC returned transient HTTP ${response.status}.`);
      }
      throw new TransactionReceiptValidationError(`Sepolia RPC returned terminal HTTP ${response.status}.`);
    }
    let body: unknown;
    try {
      body = await response.json() as unknown;
    } catch {
      throw new TransactionReceiptValidationError('Sepolia RPC returned malformed JSON.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new TransactionReceiptValidationError('Sepolia RPC returned an invalid JSON-RPC response.');
    }
    const envelope = body as Record<string, unknown>;
    if ('error' in envelope) throw new Error('Sepolia RPC returned a JSON-RPC error.');
    if (!('result' in envelope)) {
      throw new TransactionReceiptValidationError('Sepolia RPC response did not include a result.');
    }
    return envelope.result;
  } catch (error) {
    if (signal?.aborted) throw new TransactionReceiptAbortedError();
    if (timedOut) throw new Error('Sepolia RPC request timed out.');
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortRequest);
  }
}

function validateOptions(rpcUrl: string, pollIntervalMs: number, requestTimeoutMs: number): void {
  let parsed: URL;
  try {
    parsed = new URL(rpcUrl);
  } catch {
    throw new TransactionReceiptValidationError('SEPOLIA_RPC_URL is not a valid URL.');
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new TransactionReceiptValidationError('SEPOLIA_RPC_URL must use HTTP or HTTPS.');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new TransactionReceiptValidationError('Receipt poll interval must be non-negative.');
  }
  if (!Number.isFinite(requestTimeoutMs) || requestTimeoutMs <= 0) {
    throw new TransactionReceiptValidationError('Receipt request timeout must be positive.');
  }
}

function validateReceipt(
  value: unknown,
  expectedHash: string,
): TransactionReceiptOutcome['status'] | null {
  if (value === null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TransactionReceiptValidationError('Sepolia RPC returned an invalid transaction receipt.');
  }
  const receipt = value as Record<string, unknown>;
  if (
    typeof receipt.transactionHash !== 'string' ||
    receipt.transactionHash.toLocaleLowerCase('en-US') !== expectedHash.toLocaleLowerCase('en-US')
  ) {
    throw new TransactionReceiptValidationError('Sepolia RPC returned a receipt for a different transaction.');
  }
  if (receipt.status === '0x1') return 'confirmed';
  if (receipt.status === '0x0') return 'reverted';
  throw new TransactionReceiptValidationError('Sepolia RPC returned a receipt with an invalid status.');
}

/**
 * Waits without a global timeout. Only the read-only RPC request is retried;
 * the transaction broadcast must remain outside this function.
 */
export async function waitForSepoliaTransactionReceipt(
  transaction: TransactionResult,
  options: WaitForTransactionReceiptOptions = {},
): Promise<TransactionReceiptOutcome> {
  if (transaction.network.toLocaleLowerCase('en-US') !== 'sepolia') {
    throw new TransactionReceiptValidationError(`Unsupported receipt network: ${transaction.network}.`);
  }
  if (!EVM_TRANSACTION_HASH.test(transaction.transactionHash)) {
    throw new TransactionReceiptValidationError('Expected a 32-byte EVM transaction hash.');
  }

  const rpcUrl = options.rpcUrl?.trim() || process.env.SEPOLIA_RPC_URL?.trim() || DEFAULT_SEPOLIA_RPC_URL;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const fetchImpl = options.fetchImpl ?? fetch;
  const wait = options.sleep ?? sleep;
  const signal = options.signal;
  validateOptions(rpcUrl, pollIntervalMs, requestTimeoutMs);
  let networkValidated = false;

  for (;;) {
    if (signal?.aborted) throw new TransactionReceiptAbortedError();
    try {
      if (!networkValidated) {
        const chainId = parseChainId(await rpcRequest(
          rpcUrl,
          'eth_chainId',
          [],
          fetchImpl,
          requestTimeoutMs,
          signal,
        ));
        if (chainId !== SEPOLIA_CHAIN_ID) {
          throw new TransactionReceiptValidationError('The configured RPC endpoint is not Sepolia.');
        }
        networkValidated = true;
      }

      const receipt = await rpcRequest(
        rpcUrl,
        'eth_getTransactionReceipt',
        [transaction.transactionHash],
        fetchImpl,
        requestTimeoutMs,
        signal,
      );
      const status = validateReceipt(receipt, transaction.transactionHash);
      if (status) {
        return { status, network: 'sepolia', transactionHash: transaction.transactionHash };
      }
    } catch (error) {
      if (
        error instanceof TransactionReceiptValidationError ||
        error instanceof TransactionReceiptAbortedError
      ) throw error;
      // HTTP, JSON-RPC, network and per-request timeout errors are transient.
    }
    await wait(pollIntervalMs, signal);
  }
}

export const immediateTransactionReceiptWaiter: TransactionReceiptWaiter = async (transaction, options) => {
  if (options?.signal?.aborted) throw new TransactionReceiptAbortedError();
  return {
    status: 'confirmed',
    network: 'sepolia',
    transactionHash: transaction.transactionHash,
  };
};

export const defaultTransactionReceiptWaiter: TransactionReceiptWaiter = (transaction, options) =>
  process.env.WDK_TOOLS_SOURCE === 'live'
    ? waitForSepoliaTransactionReceipt(transaction, { signal: options?.signal })
    : immediateTransactionReceiptWaiter(transaction, options);
