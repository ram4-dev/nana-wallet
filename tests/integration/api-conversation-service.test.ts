import { vi, afterEach, describe, expect, it } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { buildTestServer, TEST_USER_ID } from "../fixtures/test-server.js";

const databaseUrl = process.env.DATABASE_URL;
// The shared fixture identity: every server-based suite in a shared database
// agrees on one user id (idempotent under concurrency).
const userId = TEST_USER_ID;
const recipient = "0x1234567890123456789012345678901234567890";

describe("typed conversation service with fixture wallet", () => {
  const previous = {
    enabled: process.env.RECIPIENT_MEMORY_ENABLED,
    runtime: process.env.AGENT_RUNTIME,
  };

  afterEach(() => {
    for (const [key, value] of Object.entries({
      RECIPIENT_MEMORY_ENABLED: previous.enabled,
      AGENT_RUNTIME: previous.runtime,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it.skipIf(!databaseUrl)(
    "completes preview, atomic confirmation, and fixture finality through HTTP",
    async () => {
      process.env.RECIPIENT_MEMORY_ENABLED = "true";
      process.env.AGENT_RUNTIME = "deterministic";
      const app = buildTestServer({ userId });
      try {
        const created = await app.inject({
          method: "POST",
          url: "/v1/conversations",
        });
        expect(created.statusCode).toBe(200);
        const { conversationId } = created.json() as { conversationId: string };

        const preview = await app.inject({
          method: "POST",
          url: `/v1/conversations/${conversationId}/turns`,
          payload: { message: `Send 10 USDT to ${recipient}` },
        });
        expect(preview.statusCode).toBe(200);
        expect(preview.json()).toMatchObject({
          status: "confirmation_required",
        });

        const state = await app.inject({
          method: "GET",
          url: `/v1/conversations/${conversationId}/state`,
        });
        const previewId = (
          state.json() as { pendingTransfer: { previewId: string } }
        ).pendingTransfer.previewId;
        const decision = await app.inject({
          method: "POST",
          url: `/v1/conversations/${conversationId}/decisions`,
          payload: { previewId, decision: "confirm" },
        });
        expect(decision.statusCode).toBe(200);
        expect(decision.json()).toMatchObject({
          accepted: true,
          state: {
            lastTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
          },
        });

        const finalState = await app.inject({
          method: "GET",
          url: `/v1/conversations/${conversationId}/state`,
        });
        expect(finalState.json()).toMatchObject({
          lastTransactionHash: expect.stringMatching(/^0x[0-9a-f]{64}$/u),
        });
        expect(
          (finalState.json() as { pendingTransfer?: unknown }).pendingTransfer,
        ).toBeUndefined();
      } finally {
        await app.close();
      }
    },
  );
});
