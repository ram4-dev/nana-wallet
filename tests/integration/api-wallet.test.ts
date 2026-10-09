import { describe, expect, it, vi } from 'vitest';

// CI-load headroom: these server-injection cases can exceed Vitest's 5s
// default under full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

// Hermetic: the network and token these cases query come from the ambient .env
// otherwise, so they are pinned before the server import (dotenv evaluates that
// file during the import chain and src/api/wallet.ts freezes NETWORK at module
// import time). The wallet provider comes from the fixture doubles injected by
// buildTestServer, not from WDK_TOOLS_SOURCE.
vi.hoisted(() => {
  process.env.WDK_NETWORK = 'sepolia';
  process.env.WDK_TOKEN = 'USDT';
});

import { buildTestServer } from '../fixtures/test-server.js';

describe('wallet read endpoints', () => {
  it('GET /v1/wallet/address returns the fixture address', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/v1/wallet/address' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ network: 'sepolia', address: expect.any(String) });
    await app.close();
  });

  it('GET /v1/wallet/balance returns the fixture balance', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/v1/wallet/balance?network=sepolia&token=USDT' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      network: 'sepolia',
      token: 'USDT',
      balance: '42.5',
    });
    await app.close();
  });

  it('GET /v1/wallet/history returns fixture transactions', async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url: '/v1/wallet/history?network=sepolia' });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.network).toBe('sepolia');
    expect(Array.isArray(body.transactions)).toBe(true);
    expect(body.transactions.length).toBeGreaterThan(0);
    await app.close();
  });

  it.each([
    '/v1/wallet/balance?network=',
    '/v1/wallet/balance?network=sepolia&token=%20%20',
    '/v1/wallet/history?network=%20%20',
    '/v1/wallet/history?network=sepolia&token=',
  ])('rejects empty wallet query fields: %s', async (url) => {
    const app = buildTestServer();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 'error', code: 'invalid_query' });
    await app.close();
  });
});
