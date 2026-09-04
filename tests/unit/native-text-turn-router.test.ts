import { describe, expect, it, vi } from "vitest";
import { routeNativeTextTurn } from "../../src/livekit/native-text-turn-router.js";

describe("native text turn router", () => {
  it("routes a pending decision through the durable stream instead of model generation", async () => {
    const interrupt = vi.fn(async () => undefined);
    const generateReply = vi.fn();
    const consumed = vi.fn();
    const onDecisionRouted = vi.fn();

    await routeNativeTextTurn({
      session: { interrupt, generateReply } as never,
      text: "cancelar la transferencia",
      resolvePendingDecision: async () => (async function* () {
        consumed();
        yield {
          type: "turn-completed" as const,
          result: { status: "cancelled" as const, message: "Transfer cancelled." },
        };
      })(),
      onDecisionRouted,
    });

    expect(interrupt).toHaveBeenCalledWith({ force: true });
    expect(consumed).toHaveBeenCalledOnce();
    expect(onDecisionRouted).toHaveBeenCalledOnce();
    expect(generateReply).not.toHaveBeenCalled();
  });

  it("continues ordinary text through the native model loop", async () => {
    const interrupt = vi.fn(async () => undefined);
    const generateReply = vi.fn();

    await routeNativeTextTurn({
      session: { interrupt, generateReply } as never,
      text: "What is my balance?",
      resolvePendingDecision: async () => undefined,
    });

    expect(interrupt).toHaveBeenCalledWith({ force: true });
    expect(generateReply).toHaveBeenCalledWith({ userInput: "What is my balance?" });
  });
});
