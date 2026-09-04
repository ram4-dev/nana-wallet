import { describe, expect, it } from "vitest";
import { createRevisionPublisher } from "../../src/livekit/revision-publisher.js";

describe("revision publisher", () => {
  it("publishes only lightweight revision events", async () => {
    const events: unknown[] = [];
    const publish = createRevisionPublisher(async (event) => {
      events.push(event);
    });
    await publish({
      type: "conversation_state_changed",
      conversationId: "c1",
      revision: 4,
    });
    expect(events).toEqual([
      { type: "conversation_state_changed", conversationId: "c1", revision: 4 },
    ]);
  });
});
