import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('conversation API', () => {
  it('does not expose legacy session routes', async () => {
    const app = buildServer();
    const response = await app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.skipIf(!process.env.DATABASE_URL)('creates and reads a durable conversation', async () => {
    const app = buildServer();
    const created = await app.inject({ method: 'POST', url: '/v1/conversations' });
    expect(created.statusCode).toBe(200);
    const { conversationId } = created.json();
    const state = await app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/state` });
    expect(state.statusCode).toBe(200);
    expect(state.headers.etag).toMatch(/^"conversation-\d+"$/u);
    await app.close();
  });
});
