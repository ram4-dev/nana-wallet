import { describe, expect, it, vi } from 'vitest';
import {
  TransactionReceiptAbortedError,
  TransactionReceiptValidationError,
  waitForSepoliaTransactionReceipt,
} from '../../src/wdk/transaction-receipt.js';
import type { TransactionResult } from '../../src/contracts/http.js';

const transactionHash = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const transaction: TransactionResult = {
  network: 'sepolia',
  transactionHash,
  explorerUrl: `https://sepolia.etherscan.io/tx/${transactionHash}`,
};

function rpcResponse(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

function rpcMethod(init?: RequestInit): string {
  return (JSON.parse(String(init?.body)) as { method: string }).method;
}

describe('waitForSepoliaTransactionReceipt', () => {
  it('keeps polling a pending transaction until a successful receipt exists', async () => {
    const receipts = [null, { transactionHash, status: '0x1' }];
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      rpcMethod(init) === 'eth_chainId'
        ? rpcResponse('0xaa36a7')
        : rpcResponse(receipts.shift())) as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(waitForSepoliaTransactionReceipt(transaction, {
      fetchImpl,
      sleep,
      pollIntervalMs: 4_000,
    })).resolves.toEqual({ status: 'confirmed', network: 'sepolia', transactionHash });

    expect(sleep).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('retries a transient receipt RPC failure without revalidating the network', async () => {
    let receiptAttempts = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      if (rpcMethod(init) === 'eth_chainId') return rpcResponse('0xaa36a7');
      receiptAttempts += 1;
      if (receiptAttempts === 1) throw new Error('temporary RPC disconnect');
      return rpcResponse({ transactionHash, status: '0x1' });
    }) as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(waitForSepoliaTransactionReceipt(transaction, { fetchImpl, sleep }))
      .resolves.toMatchObject({ status: 'confirmed', transactionHash });

    expect(receiptAttempts).toBe(2);
    expect(sleep).toHaveBeenCalledOnce();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('returns a terminal reverted outcome for receipt status 0x0', async () => {
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      rpcMethod(init) === 'eth_chainId'
        ? rpcResponse('0xaa36a7')
        : rpcResponse({ transactionHash, status: '0x0' })) as typeof fetch;

    await expect(waitForSepoliaTransactionReceipt(transaction, { fetchImpl }))
      .resolves.toEqual({ status: 'reverted', network: 'sepolia', transactionHash });
  });

  it('stops polling when its AbortSignal is cancelled', async () => {
    const controller = new AbortController();
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      rpcMethod(init) === 'eth_chainId'
        ? rpcResponse('0xaa36a7')
        : rpcResponse(null)) as typeof fetch;

    const waiting = waitForSepoliaTransactionReceipt(transaction, {
      fetchImpl,
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    controller.abort();

    await expect(waiting).rejects.toBeInstanceOf(TransactionReceiptAbortedError);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a non-retriable HTTP 401 as terminal', async () => {
    const fetchImpl = vi.fn(async () => new Response('', { status: 401 })) as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(waitForSepoliaTransactionReceipt(transaction, { fetchImpl, sleep }))
      .rejects.toBeInstanceOf(TransactionReceiptValidationError);

    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(sleep).not.toHaveBeenCalled();
  });

  it('retries a rate-limited HTTP 429 response', async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return new Response('', { status: 429 });
      return rpcMethod(init) === 'eth_chainId'
        ? rpcResponse('0xaa36a7')
        : rpcResponse({ transactionHash, status: '0x1' });
    }) as typeof fetch;
    const sleep = vi.fn(async () => undefined);

    await expect(waitForSepoliaTransactionReceipt(transaction, { fetchImpl, sleep }))
      .resolves.toMatchObject({ status: 'confirmed', transactionHash });

    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it('rejects a receipt from another hash or RPC network', async () => {
    const wrongHashFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) =>
      rpcMethod(init) === 'eth_chainId'
        ? rpcResponse('0xaa36a7')
        : rpcResponse({
          transactionHash: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          status: '0x1',
        })) as typeof fetch;
    await expect(waitForSepoliaTransactionReceipt(transaction, { fetchImpl: wrongHashFetch }))
      .rejects.toBeInstanceOf(TransactionReceiptValidationError);

    const wrongNetworkFetch = vi.fn(async () => rpcResponse('0x1')) as typeof fetch;
    await expect(waitForSepoliaTransactionReceipt(transaction, { fetchImpl: wrongNetworkFetch }))
      .rejects.toBeInstanceOf(TransactionReceiptValidationError);
  });
});
