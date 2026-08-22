import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('GET /health', () => {
  it('reports ok status with mcp and wallet state', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: '/health' });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe('ok');
    expect(body.mcp).toBe('connected');
    expect(body.wallet).toBe('unlocked');
    expect(body.network).toBe('sepolia');

    await app.close();
  });
});
