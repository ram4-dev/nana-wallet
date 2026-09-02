import Fastify from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerConversationRoutes } from "../../src/api/conversations.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";

const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const userId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function liveSnapshot(): ConversationSnapshot {
  return {
    id: conversationId,
    userId,
    mode: "live",
    revision: 4,
    language: "es",
    generation: 1,
    messages: [],
    pendingTransfer: {
      network: "sepolia",
      token: "USDT",
      to: "0x1234567890123456789012345678901234567890",
      amount: "10",
      wallet: "agent-demo",
      preview: {
        network: "sepolia",
        token: "USDT",
        recipient: "0x1234567890123456789012345678901234567890",
        amount: "10",
        estimatedFee: "0.001 ETH",
      },
      previewId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    },
    updatedAt: new Date(0).toISOString(),
    createdAt: new Date(0).toISOString(),
  };
}

describe("end live conversation route", () => {
  it("requires acknowledgement and commits live to typed only after it is supplied", async () => {
    let snapshot = liveSnapshot();
    const setMode = vi.fn(
      async (
        _userId: string,
        _id: string,
        mode: "typed" | "live",
        expectedRevision: number,
      ) => {
        expect(expectedRevision).toBe(4);
        snapshot = {
          ...snapshot,
          mode,
          revision: 5,
          pendingTransfer: snapshot.pendingTransfer,
        };
        return 5;
      },
    );
    const app = Fastify();
    await app.register(registerConversationRoutes, {
      conversations: {
        inspect: vi.fn(async () => snapshot),
        get: vi.fn(async () => snapshot),
        setMode,
      } as never,
      resolveUserId: async () => userId,
    });

    const blocked = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/end-live`,
      payload: { expectedRevision: 4 },
    });
    expect(blocked.statusCode).toBe(409);
    expect(setMode).not.toHaveBeenCalled();

    const ended = await app.inject({
      method: "POST",
      url: `/v1/conversations/${conversationId}/end-live`,
      payload: {
        expectedRevision: 4,
        acknowledgeUnresolvedFinancialWork: true,
      },
    });
    expect(ended.statusCode).toBe(200);
    expect(ended.json()).toMatchObject({
      mode: "typed",
      revision: 5,
      state: { mode: "typed", revision: 5 },
    });
    expect(setMode).toHaveBeenCalledOnce();
    await app.close();
  });
});
