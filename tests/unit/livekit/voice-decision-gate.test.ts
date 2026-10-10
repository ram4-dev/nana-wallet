import { describe, expect, it } from "vitest";
import { createVoiceDecisionGate } from "../../../src/livekit/voice-decision-gate.js";

/**
 * Unit contract for the pure voice decision gate.
 *
 * Spec: openspec/changes/slice4-voice-confirmation/specs — "Explicit
 * confirmation is authorized by final user speech" and "Spoken cancellation
 * is preview-bound".
 *
 * ## What the gate guarantees
 *
 * An affirmative the user spoke AFTER the preview existed, from an
 * authenticated speaker, counted once. That is the whole invariant.
 *
 * The gate used to additionally require a server read-back to have played out
 * in full without interruption. That made paying depend on a nested model
 * generation producing an exact sentence, which a speech-to-speech model does
 * not reliably do: the read-back came back short, the gate never armed, and no
 * confirmation could ever succeed. The ordering rule below is what actually
 * keeps a "sí" that answered some OTHER question — or a model-invented
 * confirmation with no user speech — from authorizing a transfer.
 *
 * Pure state only: no timers, no I/O. Phrase classification is injected.
 */

/** Fixed preview creation instant, so every ordering assertion is exact. */
const PREVIEW_AT = 1_000_000;

const isConfirmation = (text: string): boolean =>
  [
    "yes",
    "sí",
    "si",
    "confirmo",
    "sí, confirmo",
    "confirmar transferencia",
  ].includes(text);
const isCancellation = (text: string): boolean =>
  ["cancel", "cancelar", "no, cancel", "cancelar la transferencia"].includes(
    text,
  );

function createGate() {
  return createVoiceDecisionGate({ isConfirmation, isCancellation });
}

/** Opens the decision window: the preview now exists. */
function open(
  gate: ReturnType<typeof createGate>,
  previewId = "preview-1",
  at = PREVIEW_AT,
): void {
  gate.prepare(previewId, at);
}

/** The user spoke. Defaults to AFTER the preview, the accepting case. */
function record(
  gate: ReturnType<typeof createGate>,
  text: string,
  overrides: Partial<
    Parameters<ReturnType<typeof createGate>["recordTranscript"]>[0]
  > = {},
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

describe("voice decision gate — exact final localized decision", () => {
  it("consumes a final confirmation spoken after the preview existed, including standalone yes/sí/si", () => {
    for (const phrase of [
      "yes",
      "sí",
      "si",
      "confirmo",
      "sí, confirmo",
      "confirmar transferencia",
    ]) {
      const gate = createGate();
      open(gate);
      record(gate, phrase);
      expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
    }
  });

  it("consumes a final cancellation, distinct from confirmation", () => {
    for (const phrase of [
      "cancel",
      "cancelar",
      "no, cancel",
      "cancelar la transferencia",
    ]) {
      const gate = createGate();
      open(gate);
      record(gate, phrase);
      expect(gate.consume("preview-1", "cancel")).toBe("cancelled");
    }
  });

  it("ignores speech outside the decision sets", () => {
    const gate = createGate();
    open(gate);
    for (const phrase of [
      "yes please",
      "dale",
      "ok OK ok",
      "confirm everything else",
      "no",
    ]) {
      record(gate, phrase);
    }
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("rejects a consume decision that does not match the recorded phrase", () => {
    const gate = createGate();
    open(gate);
    record(gate, "cancelar");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — the ordering rule", () => {
  /**
   * The load-bearing property. "Sí, mandale 5 a Test1" is an INSTRUCTION that
   * creates the preview; the "sí" in it is not a decision about a preview that
   * did not exist yet. Without this, the very sentence that starts a transfer
   * would also authorize it.
   */
  it("rejects an affirmative spoken BEFORE the preview existed", () => {
    const gate = createGate();
    record(gate, "sí", { createdAt: PREVIEW_AT - 1 });
    open(gate);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("rejects an affirmative spoken at the exact instant the preview was created", () => {
    // The boundary is strict: the decision window opens when the preview
    // exists, and a timestamp that is not strictly after it is not evidence of
    // having heard it.
    const gate = createGate();
    open(gate);
    record(gate, "sí", { createdAt: PREVIEW_AT });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("accepts an affirmative spoken one millisecond after the preview existed", () => {
    const gate = createGate();
    open(gate);
    record(gate, "sí", { createdAt: PREVIEW_AT + 1 });
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
  });

  /**
   * A model-initiated confirmation is not user authorization: with no user
   * speech after the preview, there is no evidence at all.
   */
  it("rejects a confirmation with no user speech, however prepared", () => {
    const gate = createGate();
    open(gate);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("ignores interim transcripts even when the text is an exact phrase", () => {
    const gate = createGate();
    open(gate);
    record(gate, "sí", { isFinal: false });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    record(gate, "sí", { isFinal: true });
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
  });

  it("rejects a transcript with an unusable timestamp", () => {
    const gate = createGate();
    open(gate);
    record(gate, "sí", { createdAt: Number.NaN });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — consume once for the same preview ID", () => {
  it("returns the decision exactly once and is then exhausted", () => {
    const gate = createGate();
    open(gate);
    record(gate, "yes");
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    const cancelGate = createGate();
    open(cancelGate, "preview-2");
    cancelGate.recordTranscript({
      previewId: "preview-2",
      text: "cancelar",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: PREVIEW_AT + 1,
    });
    expect(cancelGate.consume("preview-2", "cancel")).toBe("cancelled");
    expect(cancelGate.consume("preview-2", "cancel")).toBeUndefined();
  });

  it("fails closed when consuming an unknown or never-opened preview ID", () => {
    const gate = createGate();
    open(gate);
    record(gate, "yes");
    expect(gate.consume("other-preview", "confirm")).toBeUndefined();
  });

  it("fails closed for a preview that was never prepared", () => {
    const gate = createGate();
    record(gate, "sí");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — replaced or cleared previews fail closed", () => {
  it("rejects stale evidence after a replacement preview is prepared", () => {
    const gate = createGate();
    open(gate, "preview-1");
    record(gate, "sí");
    open(gate, "preview-2", PREVIEW_AT + 10);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    gate.recordTranscript({
      previewId: "preview-2",
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: PREVIEW_AT + 11,
    });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
    expect(gate.consume("preview-2", "confirm")).toBe("confirmed");
  });

  it("disarms evidence when the pending preview is cleared", () => {
    const gate = createGate();
    open(gate);
    record(gate, "sí");
    gate.clear("preview-1");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  /**
   * A new preview drops evidence recorded for a previous one: a decision about
   * one transfer must never authorize a different one.
   */
  it("drops evidence for a previous preview when a new one is prepared", () => {
    const gate = createGate();
    open(gate, "preview-1");
    record(gate, "sí");
    open(gate, "preview-2", PREVIEW_AT + 5);
    expect(gate.consume("preview-2", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — fails closed for unknown speaker identity", () => {
  it("rejects final decisions from an unauthenticated speaker", () => {
    const gate = createGate();
    open(gate);
    record(gate, "sí", { authenticatedSpeaker: false });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("rejects evidence when the transcript carries no identity signal at all", () => {
    const gate = createGate();
    open(gate);
    gate.recordTranscript({
      previewId: "preview-1",
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: null as unknown as boolean,
      createdAt: PREVIEW_AT + 1,
    });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — no parallel generic resolution route", () => {
  it("exposes decision evidence only through one-use consume and never routes transcripts into generic conversation handling", () => {
    const gate = createGate();
    open(gate);
    record(gate, "sí");

    // Design (openspec design.md): the worker must not pass the same user
    // transcript through RoomConversation.handleFinalTranscript or
    // handleTurnStream. The gate surface therefore carries no generic
    // routing API at all.
    const surface = gate as unknown as Record<string, unknown>;
    expect(surface.handleFinalTranscript).toBeUndefined();
    expect(surface.handleTurnStream).toBeUndefined();

    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});
