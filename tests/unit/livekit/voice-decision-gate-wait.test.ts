import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createVoiceDecisionGate } from "../../../src/livekit/voice-decision-gate.js";

const PREVIEW_AT = 1_000_000;

function createGate() {
  return createVoiceDecisionGate({
    isConfirmation: (text) => text === "sí" || text === "dale",
    isCancellation: (text) => text === "cancelar",
  });
}

function record(
  gate: ReturnType<typeof createGate>,
  text: string,
  overrides: Partial<Parameters<ReturnType<typeof createGate>["recordTranscript"]>[0]> = {},
) {
  gate.recordTranscript({
    previewId: "preview-1",
    text,
    isFinal: true,
    authenticatedSpeaker: true,
    createdAt: PREVIEW_AT + 1,
    ...overrides,
  });
}

describe("voice decision gate delayed final evidence", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("consumes qualifying evidence that already exists without waiting", async () => {
    const gate = createGate();
    gate.prepare("preview-1", PREVIEW_AT);
    record(gate, "sí");

    await expect(gate.waitAndConsume("preview-1", "confirm")).resolves.toBe(
      "confirmed",
    );
  });

  it("waits for final evidence that arrives 48ms after the tool call", async () => {
    const gate = createGate();
    gate.prepare("preview-1", PREVIEW_AT);
    const decision = gate.waitAndConsume("preview-1", "confirm");
    setTimeout(() => record(gate, "sí"), 48);

    await vi.advanceTimersByTimeAsync(48);
    await expect(decision).resolves.toBe("confirmed");
  });

  it("refuses when no qualifying final evidence arrives before the bound", async () => {
    const gate = createGate();
    gate.prepare("preview-1", PREVIEW_AT);
    const decision = gate.waitAndConsume("preview-1", "confirm");

    await vi.advanceTimersByTimeAsync(2_000);
    await expect(decision).resolves.toBeUndefined();
  });

  it("does not authorize unauthenticated or pre-preview transcripts", async () => {
    const gate = createGate();
    gate.prepare("preview-1", PREVIEW_AT);
    const unauthenticated = gate.waitAndConsume("preview-1", "confirm");
    setTimeout(
      () => record(gate, "sí", { authenticatedSpeaker: false }),
      48,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(unauthenticated).resolves.toBeUndefined();

    const prePreviewGate = createGate();
    prePreviewGate.prepare("preview-1", PREVIEW_AT);
    const prePreview = prePreviewGate.waitAndConsume("preview-1", "confirm");
    setTimeout(
      () => record(prePreviewGate, "sí", { createdAt: PREVIEW_AT }),
      48,
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(prePreview).resolves.toBeUndefined();
  });

  it("invalidates a waiter when the preview is replaced or cleared", async () => {
    const replaced = createGate();
    replaced.prepare("preview-1", PREVIEW_AT);
    const stale = replaced.waitAndConsume("preview-1", "confirm");
    replaced.prepare("preview-2", PREVIEW_AT + 1);
    record(replaced, "sí", { previewId: "preview-1", createdAt: PREVIEW_AT + 2 });
    await expect(stale).resolves.toBeUndefined();
    expect(replaced.consume("preview-2", "confirm")).toBeUndefined();

    const cleared = createGate();
    cleared.prepare("preview-1", PREVIEW_AT);
    const cancelled = cleared.waitAndConsume("preview-1", "confirm");
    cleared.clear("preview-1");
    record(cleared, "sí");
    await expect(cancelled).resolves.toBeUndefined();
  });

  it("waits for and consumes a cancellation independently", async () => {
    const gate = createGate();
    gate.prepare("preview-1", PREVIEW_AT);
    const decision = gate.waitAndConsume("preview-1", "cancel");
    setTimeout(() => record(gate, "cancelar"), 48);

    await vi.advanceTimersByTimeAsync(48);
    await expect(decision).resolves.toBe("cancelled");
  });

  it("allows only one concurrent waiter and never rearms after a late duplicate", async () => {
    const gate = createGate();
    gate.prepare("preview-1", PREVIEW_AT);
    const first = gate.waitAndConsume("preview-1", "confirm");
    const second = gate.waitAndConsume("preview-1", "confirm");
    setTimeout(() => record(gate, "dale"), 48);

    await vi.advanceTimersByTimeAsync(48);
    await expect(Promise.all([first, second])).resolves.toEqual([
      "confirmed",
      undefined,
    ]);
    record(gate, "sí", { createdAt: PREVIEW_AT + 2 });
    await expect(gate.waitAndConsume("preview-1", "confirm")).resolves.toBeUndefined();
  });
});
