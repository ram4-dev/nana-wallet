import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfirmationArbiter } from "../../../src/conversations/confirmation-arbiter.js";
import { createVoiceDecisionGate } from "../../../src/livekit/voice-decision-gate.js";

/**
 * Transfer gate ↔ arbiter adapter (task 4.4, design §7.3/§7.4).
 *
 * The transfer kind is a DELEGATION: `prepare` opens an arbiter window
 * `{kind:'transfer', actionId: previewId, version: 0}`, the eligibility rule and
 * the 2 000 ms bound are inherited verbatim, and consumption is once per action
 * id with a consumed id never re-armed.
 *
 * This suite drives every existing transfer scenario through BOTH
 * implementations — the legacy gate with no arbiter and the same gate wired to
 * the real arbiter — and asserts the observable outcome is identical step by
 * step. The existing `voice-decision-gate` suites are not touched.
 */

const PREVIEW_AT = 1_000_000;
const USER = "user-1";
const CONVERSATION = "conversation-1";

const isConfirmation = (text: string): boolean => text === "sí" || text === "dale";
const isCancellation = (text: string): boolean => text === "cancelar";

type Gate = ReturnType<typeof createVoiceDecisionGate>;

function createGates() {
  const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation });
  const legacy: Gate = createVoiceDecisionGate({ isConfirmation, isCancellation });
  const adapted: Gate = createVoiceDecisionGate({
    isConfirmation,
    isCancellation,
    arbiter,
    userId: USER,
    conversationId: CONVERSATION,
  });
  return { arbiter, legacy, adapted };
}

function record(
  gate: Gate,
  text: string,
  overrides: Partial<Parameters<Gate["recordTranscript"]>[0]> = {},
): void {
  gate.recordTranscript({
    previewId: "preview-1",
    text,
    isFinal: true,
    authenticatedSpeaker: true,
    createdAt: PREVIEW_AT + 1,
    ...overrides,
  });
}

/** Runs the same script against both gates and asserts identical outcomes. */
function expectEquivalence(script: (gate: Gate) => unknown[]) {
  const legacy = createGates();
  const adapted = createGates();
  const legacyOutcome = script(legacy.legacy);
  const adaptedOutcome = script(adapted.adapted);
  expect(adaptedOutcome).toEqual(legacyOutcome);
  return { legacy: legacyOutcome, adapted: adaptedOutcome, arbiter: adapted.arbiter };
}

describe("voice decision gate through the confirmation arbiter", () => {
  afterEach(() => vi.useRealTimers());

  it("opens the transfer window as {kind:'transfer', version:0} on prepare", () => {
    const { legacy, adapted, arbiter } = createGates();
    expect(adapted.prepare("preview-1", PREVIEW_AT)).toBe(legacy.prepare("preview-1", PREVIEW_AT));
    expect(legacy.prepare("preview-1", PREVIEW_AT)).toBe(true);
    expect(arbiter.current()).toEqual({
      kind: "transfer",
      actionId: "preview-1",
      userId: USER,
      conversationId: CONVERSATION,
      version: 0,
      createdAt: PREVIEW_AT,
    });
  });

  it("consumes an immediate affirmative identically and clears the window", () => {
    const { legacy, adapted, arbiter } = expectEquivalence((gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      record(gate, "sí");
      const first = gate.consume("preview-1", "confirm");
      const replay = gate.consume("preview-1", "confirm");
      return [first, replay];
    });
    expect(adapted).toEqual(["confirmed", undefined]);
    expect(legacy).toEqual(["confirmed", undefined]);
    expect(arbiter.current()).toBeUndefined();
  });

  it("consumes a delayed affirmative inside the inherited 2 000 ms bound", async () => {
    vi.useFakeTimers();
    const legacy = createGates();
    const adapted = createGates();
    const run = async (gate: Gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      const decision = gate.waitAndConsume("preview-1", "confirm");
      setTimeout(() => record(gate, "sí"), 48);
      await vi.advanceTimersByTimeAsync(48);
      return decision;
    };
    const fromLegacy = run(legacy.legacy);
    const fromAdapted = run(adapted.adapted);
    await vi.advanceTimersByTimeAsync(48);
    await expect(fromAdapted).resolves.toBe(await fromLegacy);
    expect(await fromAdapted).toBe("confirmed");
  });

  it("expires a missing affirmative at the bound identically, leaving no window", async () => {
    vi.useFakeTimers();
    const legacy = createGates();
    const adapted = createGates();
    const run = async (gate: Gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      const decision = gate.waitAndConsume("preview-1", "confirm");
      await vi.advanceTimersByTimeAsync(2_000);
      return decision;
    };
    const fromLegacy = run(legacy.legacy);
    const fromAdapted = run(adapted.adapted);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await fromAdapted).toBe(await fromLegacy);
    expect(await fromAdapted).toBeUndefined();
    // The window still exists (nothing consumed it) but holds no evidence.
    expect(adapted.arbiter.consume({ kind: "transfer", actionId: "preview-1", userId: USER, version: 0, tool: "confirm_transfer" })).toEqual({
      status: "refused",
      code: "no_evidence",
    });
  });

  it("refuses a replayed consumption and never re-arms a consumed preview", () => {
    const { adapted, arbiter } = expectEquivalence((gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      record(gate, "sí");
      const consumed = gate.consume("preview-1", "confirm");
      record(gate, "sí");
      return [consumed, gate.consume("preview-1", "confirm")];
    });
    expect(adapted).toEqual(["confirmed", undefined]);
    expect(arbiter.current()).toBeUndefined();
    expect(arbiter.consume({ kind: "transfer", actionId: "preview-1", userId: USER, version: 0, tool: "confirm_transfer" })).toEqual({
      status: "refused",
      code: "already_consumed",
    });
  });

  it("drops evidence on a replaced preview in both implementations", () => {
    const { adapted, legacy } = expectEquivalence((gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      record(gate, "sí");
      gate.prepare("preview-2", PREVIEW_AT);
      return [gate.consume("preview-1", "confirm"), gate.consume("preview-2", "confirm")];
    });
    expect(adapted).toEqual([undefined, undefined]);
    expect(legacy).toEqual([undefined, undefined]);
  });

  it("clears a preview identically and leaves a later decision unauthorized", () => {
    const { adapted, legacy, arbiter } = expectEquivalence((gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      record(gate, "sí");
      gate.clear("preview-1");
      return [gate.consume("preview-1", "confirm"), gate.currentPreviewId()];
    });
    expect(adapted).toEqual([undefined, undefined]);
    expect(legacy).toEqual([undefined, undefined]);
    expect(arbiter.current()).toBeUndefined();
  });

  it("refuses interim, unauthenticated, foreign-preview and pre-preview speech identically", () => {
    const cases: Array<Partial<Parameters<Gate["recordTranscript"]>[0]>> = [
      { isFinal: false },
      { authenticatedSpeaker: false },
      { previewId: "other-preview" },
      { createdAt: PREVIEW_AT },
      { createdAt: PREVIEW_AT - 1 },
    ];
    for (const mutation of cases) {
      const { adapted } = expectEquivalence((gate) => {
        gate.prepare("preview-1", PREVIEW_AT);
        record(gate, "sí", mutation);
        return [gate.consume("preview-1", "confirm")];
      });
      expect(adapted, JSON.stringify(mutation)).toEqual([undefined]);
    }
  });

  it("keeps a spoken cancellation preview-bound in both implementations", () => {
    const { adapted } = expectEquivalence((gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      record(gate, "cancelar");
      return [gate.consume("preview-1", "confirm"), gate.consume("preview-1", "cancel")];
    });
    expect(adapted).toEqual([undefined, "cancelled"]);
  });

  it("fails a transfer open closed while another kind holds the window (design §7.4)", () => {
    const { adapted, legacy, arbiter } = createGates();
    arbiter.open({
      kind: "contact",
      actionId: "proposal-1",
      userId: USER,
      conversationId: CONVERSATION,
      version: 1,
      createdAt: PREVIEW_AT,
    });
    // The deliberate, typed divergence: the transfer window cannot open, so the
    // transfer tool reports its existing confirmation-required shape.
    expect(adapted.prepare("preview-1", PREVIEW_AT)).toBe(false);
    expect(legacy.prepare("preview-1", PREVIEW_AT)).toBe(true);
    expect(arbiter.current()).toMatchObject({ kind: "contact", actionId: "proposal-1" });
    // A transfer affirmative spoken now cannot authorize either kind.
    record(adapted, "sí");
    expect(adapted.consume("preview-1", "confirm")).toBeUndefined();
    expect(
      arbiter.consume({ kind: "transfer", actionId: "preview-1", userId: USER, version: 0, tool: "confirm_transfer" }),
    ).toEqual({ status: "refused", code: "kind_mismatch" });
  });

  it("keeps the arbiter bound inherited rather than redefined by the gate", async () => {
    vi.useFakeTimers();
    const { adapted, legacy } = createGates();
    const run = async (gate: Gate) => {
      gate.prepare("preview-1", PREVIEW_AT);
      const decision = gate.waitAndConsume("preview-1", "confirm");
      setTimeout(() => record(gate, "sí"), 1_999);
      await vi.advanceTimersByTimeAsync(1_999);
      return decision;
    };
    const fromAdapted = run(adapted);
    const fromLegacy = run(legacy);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(await fromAdapted).toBe(await fromLegacy);
    expect(await fromAdapted).toBe("confirmed");
  });

  beforeEach(() => vi.useRealTimers());
});
