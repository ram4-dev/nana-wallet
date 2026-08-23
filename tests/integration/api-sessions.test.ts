import { describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';
import { createSession, resetSessionStore, stageMemoryWrite } from '../../src/sessions/in-memory-store.js';

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

  it('inspection exposes selection state but never staged recipient addresses', async () => {
    resetSessionStore();
    const session = createSession();
    stageMemoryWrite(session.id, {
      confirmationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      userId: '11111111-1111-4111-8111-111111111111',
      draft: {
        kind: 'recipient',
        name: 'Lucas',
        description: 'mi nieto',
        address: '0x1234567890123456789012345678901234567890',
      },
      expiresAt: Date.now() + 60_000,
      stagedUserTurn: 0,
    });
    const app = buildServer();
    const response = await app.inject({ method: 'GET', url: `/v1/sessions/${session.id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json().recipientMemory).toMatchObject({ pendingWrite: { expiresAt: expect.any(String) } });
    expect(response.body).not.toContain('0x1234567890123456789012345678901234567890');
    await app.close();
  });
});
