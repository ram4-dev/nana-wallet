import { describe, expect, it } from "vitest";

import { classifySessionSubmission, getSessionControlState } from "@/lib/session-resolution";

describe("session text resolution", () => {
  it("turns an explicit confirmation phrase into the canonical resolution", () => {
    expect(classifySessionSubmission("Confirmar la transferencia.", true)).toEqual({
      kind: "resolution",
      message: "confirmar la transferencia",
    });
    expect(classifySessionSubmission("Confirmo la transferencia.", true)).toEqual({
      kind: "resolution",
      message: "confirmar la transferencia",
    });
    for (const phrase of [
      "confirmo",
      "sí, confirmo",
      "I confirm",
      "yes, confirm",
      "yes, I confirm",
    ]) {
      expect(classifySessionSubmission(phrase, true)).toEqual({
        kind: "resolution",
        message: "confirmar la transferencia",
      });
    }
    expect(classifySessionSubmission("sí", true)).toEqual({ kind: "blocked" });
    expect(classifySessionSubmission("yes", true)).toEqual({ kind: "blocked" });
  });

  it("uses the same pending-resolution path for a voice transcript", () => {
    const voiceTranscript = "I confirm";

    expect(classifySessionSubmission(voiceTranscript, true)).toEqual({
      kind: "resolution",
      message: "confirmar la transferencia",
    });
  });

  it("turns an explicit cancellation phrase into the canonical resolution", () => {
    expect(classifySessionSubmission("Cancelar la transferencia", true)).toEqual({
      kind: "resolution",
      message: "cancelar la transferencia",
    });
    expect(classifySessionSubmission("cancel the transfer", true)).toEqual({
      kind: "resolution",
      message: "cancelar la transferencia",
    });
  });

  it("blocks new or ambiguous instructions while a transfer is pending", () => {
    expect(classifySessionSubmission("mandá el doble", true)).toEqual({ kind: "blocked" });
    expect(classifySessionSubmission("puede ser", true)).toEqual({ kind: "blocked" });
  });

  it("keeps ordinary text as a new message when no confirmation is pending", () => {
    expect(classifySessionSubmission("  ¿Cuánto saldo tengo?  ", false)).toEqual({
      kind: "new",
      message: "¿Cuánto saldo tengo?",
    });
  });

  it("keeps text and microphone controls available for an explicit pending resolution", () => {
    expect(
      getSessionControlState({
        isAgentWorking: false,
        isConfirmationPending: true,
        areSessionActionsLocked: false,
        isRecording: false,
      }),
    ).toEqual({ microphoneDisabled: false, textDisabled: false });

    expect(
      getSessionControlState({
        isAgentWorking: false,
        isConfirmationPending: true,
        areSessionActionsLocked: true,
        isRecording: false,
      }),
    ).toEqual({ microphoneDisabled: true, textDisabled: true });
  });
});
