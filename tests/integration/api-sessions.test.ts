import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

describe('session endpoints', () => {
  it('creates a session and allows inspecting it', async () => {
    const app = buildServer();

    const createRes = await app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(createRes.statusCode).toBe(200);
    const { sessionId, status } = createRes.json();
    expect(status).toBe('active');
    expect(typeof sessionId).toBe('string');

    const inspectRes = await app.inject({ method: 'GET', url: `/v1/sessions/${sessionId}` });
    expect(inspectRes.statusCode).toBe(200);
    expect(inspectRes.json()).toMatchObject({ id: sessionId, messages: [] });

    await app.close();
  });

  it('404s when inspecting an unknown session', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/v1/sessions/does-not-exist' });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('errors deterministically when confirming with no pending transfer, without an LLM call', async () => {
    const app = buildServer();
    const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/messages`,
      payload: { message: 'confirm' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({
      status: 'error',
      message: 'There is no pending transfer to confirm.',
      code: 'no_pending_preview',
    });

    await app.close();
  });

  it('rejects an empty message body', async () => {
    const app = buildServer();
    const { sessionId } = (await app.inject({ method: 'POST', url: '/v1/sessions' })).json();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/sessions/${sessionId}/messages`,
      payload: { message: '' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
