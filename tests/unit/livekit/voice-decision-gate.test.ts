import { describe, expect, it } from "vitest";
import { createVoiceDecisionGate } from "../../../src/livekit/voice-decision-gate.js";

/**
 * Unit contract for the pure voice decision gate (Slice 4, task 1.1).
 *
 * Spec: openspec/changes/slice4-voice-confirmation/specs — "Explicit
 * confirmation is authorized by final user speech" and "Spoken cancellation
 * is preview-bound". Design: .agent-workflow/tasks/slice4-voice-confirmation/
 * 02-research.md — per-preview, one-use gate armed only by a final exact
 * decision transcript after uninterrupted preview narration, consumed once
 * by the matching tool callback, failing closed otherwise.
 *
 * Pure state only: no timers, no I/O. Phrase classification is injected.
 */

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

function arm(
  gate: ReturnType<typeof createGate>,
  previewId = "preview-1",
): void {
  gate.prepare(previewId);
  gate.completeNarration(previewId, { interrupted: false });
}

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
    createdAt: Date.now() + 1,
    ...overrides,
  });
}

describe("voice decision gate — exact final localized decision after arm", () => {
  it("consumes a final exact confirmation spoken after uninterrupted narration, including standalone yes/sí/si", () => {
    for (const phrase of [
      "yes",
      "sí",
      "si",
      "confirmo",
      "sí, confirmo",
      "confirmar transferencia",
    ]) {
      const gate = createGate();
      arm(gate);
      record(gate, phrase);
      expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
    }
  });

  it("consumes a final exact cancellation after arm, distinct from confirmation", () => {
    for (const phrase of [
      "cancel",
      "cancelar",
      "no, cancel",
      "cancelar la transferencia",
    ]) {
      const gate = createGate();
      arm(gate);
      record(gate, phrase);
      expect(gate.consume("preview-1", "cancel")).toBe("cancelled");
    }
  });

  it("ignores speech outside the exact decision sets", () => {
    const gate = createGate();
    arm(gate);
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
    arm(gate);
    record(gate, "cancelar");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — arms only after uninterrupted narration", () => {
  it("ignores confirmation spoken before narration completed and requires a fresh one", () => {
    const gate = createGate();
    gate.prepare("preview-1");
    record(gate, "sí");
    gate.completeNarration("preview-1", { interrupted: false });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("does not arm when narration was interrupted; new speech after re-narration is required", () => {
    const gate = createGate();
    gate.prepare("preview-1");
    gate.completeNarration("preview-1", { interrupted: true });
    record(gate, "sí");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    gate.completeNarration("preview-1", { interrupted: false });
    record(gate, "sí");
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
  });
});

describe("voice decision gate — reports an interrupted read-back so it can be re-read", () => {
  it("reports none, interrupted and completed across the read-back lifecycle", () => {
    const gate = createGate();
    expect(gate.readbackStatus("preview-1")).toBe("none");

    gate.prepare("preview-1");
    expect(gate.readbackStatus("preview-1")).toBe("none");

    gate.completeNarration("preview-1", { interrupted: true });
    expect(gate.readbackStatus("preview-1")).toBe("interrupted");

    gate.completeNarration("preview-1", { interrupted: false });
    expect(gate.readbackStatus("preview-1")).toBe("completed");
  });

  it("reports none for an unknown or replaced preview, never another preview's state", () => {
    const gate = createGate();
    gate.prepare("preview-1");
    gate.completeNarration("preview-1", { interrupted: true });

    expect(gate.readbackStatus("other-preview")).toBe("none");

    gate.prepare("preview-2");
    expect(gate.readbackStatus("preview-1")).toBe("none");
    expect(gate.readbackStatus("preview-2")).toBe("none");
  });

  /**
   * The distinction the caller needs: "the user has not answered yet" and "this
   * preview can never be confirmed" must not look the same. A user who speaks
   * over the read-back gets an interruption, and the recovery is to read it
   * again — not to ask the user to repeat a phrase that can never work.
   */
  it("distinguishes an interrupted read-back from a missing decision", () => {
    const interrupted = createGate();
    interrupted.prepare("preview-1");
    interrupted.completeNarration("preview-1", { interrupted: true });
    record(interrupted, "sí");
    expect(interrupted.consume("preview-1", "confirm")).toBeUndefined();
    expect(interrupted.readbackStatus("preview-1")).toBe("interrupted");

    const completed = createGate();
    arm(completed);
    expect(completed.consume("preview-1", "confirm")).toBeUndefined();
    expect(completed.readbackStatus("preview-1")).toBe("completed");
  });

  it("clears the interrupted state once the preview is decided or replaced", () => {
    const gate = createGate();
    gate.prepare("preview-1");
    gate.completeNarration("preview-1", { interrupted: true });
    gate.clear("preview-1");
    expect(gate.readbackStatus("preview-1")).toBe("none");

    gate.prepare("preview-1");
    gate.completeNarration("preview-1", { interrupted: false });
    record(gate, "sí");
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
    // A consumed decision leaves the preview with no read-back to report.
    expect(gate.readbackStatus("preview-1")).toBe("none");
  });
});

describe("voice decision gate — final transcripts only, ordering enforced", () => {
  it("ignores interim transcripts even when the text is an exact phrase", () => {
    const gate = createGate();
    arm(gate);
    record(gate, "sí", { isFinal: false });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    record(gate, "sí", { isFinal: true });
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
  });

  it("does not accept speech recorded before the preview was prepared (transcript-before-preview)", () => {
    const gate = createGate();
    record(gate, "confirmo");
    arm(gate);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("rejects a delayed transcript event that was created before narration completed", () => {
    const gate = createGate();
    gate.prepare("preview-1");
    const narratedAt = Date.now();
    gate.completeNarration("preview-1", { interrupted: false });
    gate.recordTranscript({
      previewId: "preview-1",
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: true,
      createdAt: narratedAt - 1,
    });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — consume once for the same preview ID", () => {
  it("returns the decision exactly once and is then exhausted", () => {
    const gate = createGate();
    arm(gate);
    record(gate, "yes");
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    const cancelGate = createGate();
    arm(cancelGate, "preview-2");
    record(cancelGate, "cancelar");
    expect(cancelGate.consume("preview-2", "cancel")).toBe("cancelled");
    expect(cancelGate.consume("preview-2", "cancel")).toBeUndefined();
  });

  it("fails closed when evidence is missing but the preview is armed", () => {
    const gate = createGate();
    arm(gate);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("fails closed when consuming an unknown or never-armed preview ID", () => {
    const gate = createGate();
    arm(gate);
    record(gate, "yes");
    expect(gate.consume("other-preview", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — replaced or cleared previews fail closed", () => {
  it("rejects stale evidence after a replacement preview is prepared", () => {
    const gate = createGate();
    arm(gate, "preview-1");
    record(gate, "sí");
    gate.prepare("preview-2");
    gate.completeNarration("preview-2", { interrupted: false });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    record(gate, "sí");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
    expect(gate.consume("preview-2", "confirm")).toBe("confirmed");
  });

  it("disarms evidence when the pending preview is cleared", () => {
    const gate = createGate();
    arm(gate);
    record(gate, "sí");
    gate.clear("preview-1");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — fails closed for unknown speaker identity", () => {
  it("rejects final exact decisions from an unauthenticated speaker", () => {
    const gate = createGate();
    arm(gate);
    record(gate, "sí", { authenticatedSpeaker: false });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("rejects evidence when the transcript carries no identity signal at all", () => {
    const gate = createGate();
    arm(gate);
    gate.recordTranscript({
      previewId: "preview-1",
      text: "sí",
      isFinal: true,
      authenticatedSpeaker: null as unknown as boolean,
      createdAt: Date.now() + 1,
    });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });
});

describe("voice decision gate — no parallel generic resolution route", () => {
  it("exposes decision evidence only through one-use consume and never routes transcripts into generic conversation handling", () => {
    const gate = createGate();
    arm(gate);
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
