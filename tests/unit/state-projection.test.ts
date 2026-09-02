import { describe, expect, it } from "vitest";

import { projectConversationState } from "../../src/conversations/state-projection.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";

const base: ConversationSnapshot = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  userId: "11111111-1111-4111-8111-111111111111",
  mode: "live",
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  revision: 4,
  language: "es",
  generation: 1,
  messages: [{ role: "user", content: "a private transcript" }],
};

describe("canonical conversation state projection", () => {
  it("only exposes the financial UI facts and requires a preview identity", () => {
    const projection = projectConversationState({
      ...base,
      revision: 7,
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
          estimatedFee: "0.0003 ETH",
        },
        previewId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      },
      progress: { phase: "awaiting_confirmation", label: "Preview ready" },
    });

    expect(projection).toMatchObject({
      revision: 7,
      activity: "awaiting_confirmation",
      pendingTransfer: { previewId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" },
    });
    expect(projection).not.toHaveProperty("messages");
    expect(projection).not.toHaveProperty("userId");
  });

  it("keeps uncertainty visible without retaining an actionable preview", () => {
    const projection = projectConversationState({
      ...base,
      transferResolutionState: "uncertain",
      progress: { phase: "uncertain", label: "The result is uncertain." },
      lastTransactionHash: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(projection).toMatchObject({ activity: "uncertain", error: { code: "broadcast_uncertain" } });
    expect(projection).not.toHaveProperty("pendingTransfer");
  });
});
