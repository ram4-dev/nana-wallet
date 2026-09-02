import { afterEach, describe, expect, it } from 'vitest';
import { buildServer } from '../../src/server.js';

const databaseUrl = process.env.DATABASE_URL;
const userId = '11111111-1111-4111-8111-111111111111';
const recipient = '0x1234567890123456789012345678901234567890';

describe('typed conversation service with fixture wallet', () => {
  const previous = {
    enabled: process.env.RECIPIENT_MEMORY_ENABLED,
    demoUserId: process.env.DEMO_USER_ID,
    runtime: process.env.AGENT_RUNTIME,
    source: process.env.WDK_TOOLS_SOURCE,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries({
      RECIPIENT_MEMORY_ENABLED: previous.enabled,
      DEMO_USER_ID: previous.demoUserId,
      AGENT_RUNTIME: previous.runtime,
      WDK_TOOLS_SOURCE: previous.source,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.skipIf(!databaseUrl)('completes preview, atomic confirmation, and fixture finality through HTTP', async () => {
    process.env.RECIPIENT_MEMORY_ENABLED = 'true';
    process.env.DEMO_USER_ID = userId;
    process.env.AGENT_RUNTIME = 'deterministic';
    process.env.WDK_TOOLS_SOURCE = 'fixture';
    const app = buildServer();
    try {
      const created = await app.inject({ method: 'POST', url: '/v1/conversations' });
      expect(created.statusCode).toBe(200);
      const { conversationId } = created.json() as { conversationId: string };

      const preview = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/turns`,
        payload: { message: `Send 10 USDT to ${recipient}` },
      });
      expect(preview.statusCode).toBe(200);
      expect(preview.json()).toMatchObject({ status: 'confirmation_required' });

      const state = await app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/state` });
      const previewId = (state.json() as { pendingTransfer: { previewId: string } }).pendingTransfer.previewId;
      const decision = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/decisions`,
        payload: { previewId, decision: 'confirm' },
      });
      expect(decision.statusCode).toBe(200);
      expect(decision.json()).toMatchObject({ accepted: true, state: { lastTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u) } });

      const finalState = await app.inject({ method: 'GET', url: `/v1/conversations/${conversationId}/state` });
      expect(finalState.json()).toMatchObject({ lastTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u) });
      expect((finalState.json() as { pendingTransfer?: unknown }).pendingTransfer).toBeUndefined();
    } finally {
      await app.close();
    }
  });
});
