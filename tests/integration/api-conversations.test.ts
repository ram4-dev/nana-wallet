import { vi, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { buildTestServer } from '../fixtures/test-server.js';
import { provisionTestUser } from '../fixtures/provision-user.js';

// Per-suite identity: unique so parallel suites never share per-user rows.
const USER_ID = randomUUID();

describe('conversation API', () => {
  beforeAll(async () => {
    // The durable-conversation case writes rows for this suite's own identity;
    // on a fresh database the `users` row must exist first (FK).
    await provisionTestUser(USER_ID);
  });

  it('does not expose legacy session routes', async () => {
    const app = buildTestServer({ userId: USER_ID });
    const response = await app.inject({ method: 'POST', url: '/v1/sessions' });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it.skipIf(!process.env.DATABASE_URL)('creates and reads a durable conversation', async () => {
    const app = buildTestServer({ userId: USER_ID });
    const created = await app.inject({ method: 'POST', url: '/v1/conversations' });
    expect(created.statusCode).toBe(200);
    const { conversationId } = created.json();
    const state = await app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/state` });
    expect(state.statusCode).toBe(200);
    expect(state.headers.etag).toMatch(/^"conversation-\d+"$/u);
    await app.close();
  });
});
