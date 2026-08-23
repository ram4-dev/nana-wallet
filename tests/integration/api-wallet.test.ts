import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('wallet read endpoints', () => {
  it('GET /v1/wallet/address returns the fixture address', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/v1/wallet/address' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ network: 'sepolia', address: expect.any(String) });
    await app.close();
  });

  it('GET /v1/wallet/balance returns the fixture balance', async () => {
    const app = buildServer();
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
    const app = buildServer();
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
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ status: 'error', code: 'invalid_query' });
    await app.close();
  });
});
