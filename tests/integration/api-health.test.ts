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

  it('allows the configured frontend origin without reflecting an unknown origin', async () => {
    const app = buildServer();
    const allowed = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'http://localhost:8083' },
    });
    const unknown = await app.inject({
      method: 'GET',
      url: '/health',
      headers: { origin: 'https://untrusted.example' },
    });

    expect(allowed.headers['access-control-allow-origin']).toBe('http://localhost:8083');
    expect(unknown.headers['access-control-allow-origin']).toBeUndefined();

    await app.close();
  });
});
