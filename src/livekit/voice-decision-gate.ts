export type VoiceDecision = "confirm" | "cancel";
export type VoiceDecisionResult = "confirmed" | "cancelled";

/**
 * Whether the active preview's read-back has played in full.
 *
 * `interrupted` is not a dead end, it is a REQUEST TO RE-READ: the user did not
 * hear the preview, so no decision can bind to it until the server reads it
 * again. That fact used to be invisible — the gate simply refused, forever, and
 * nothing could tell the difference between "the user has not answered yet" and
 * "this preview can never be confirmed". A user who spoke over the read-back
 * (the most natural thing to do) was stuck with no way forward.
 */
export type VoiceReadbackStatus = "none" | "interrupted" | "completed";

export type VoiceDecisionGate = ReturnType<typeof createVoiceDecisionGate>;

/**
 * Per-session, one-use authorization evidence for an explicitly spoken
 * decision. Evidence is available only after a persisted preview's complete
 * read-back has played without interruption.
 */
export function createVoiceDecisionGate(classifiers: {
  isConfirmation(text: string): boolean;
  isCancellation(text: string): boolean;
}) {
  let activePreviewId: string | undefined;
  let readback: VoiceReadbackStatus = "none";
  let narrationCompletedAt: number | undefined;
  let evidence: VoiceDecisionResult | undefined;

  return {
    prepare(previewId: string): void {
      if (!previewId) {
        activePreviewId = undefined;
        readback = "none";
        narrationCompletedAt = undefined;
        evidence = undefined;
        return;
      }
      activePreviewId = previewId;
      readback = "none";
      narrationCompletedAt = undefined;
      evidence = undefined;
    },

    completeNarration(previewId: string, result: { interrupted: boolean }): void {
      if (activePreviewId !== previewId) return;
      readback = result.interrupted ? "interrupted" : "completed";
      narrationCompletedAt = result.interrupted ? undefined : Date.now();
      evidence = undefined;
    },

    /**
     * Why the pending preview cannot be decided yet. `interrupted` means the
     * read-back has to happen again; `none` means it never played.
     */
    readbackStatus(previewId: string): VoiceReadbackStatus {
      return previewId === activePreviewId ? readback : "none";
    },

    recordTranscript(input: {
      previewId: string;
      text: string;
      isFinal: boolean;
      authenticatedSpeaker: boolean;
      createdAt: number;
    }): void {
      if (
        readback !== "completed" ||
        !input.isFinal ||
        input.authenticatedSpeaker !== true ||
        narrationCompletedAt === undefined ||
        !Number.isFinite(input.createdAt) ||
        input.createdAt <= narrationCompletedAt
      ) {
        return;
      }
      if (classifiers.isConfirmation(input.text)) evidence = "confirmed";
      else if (classifiers.isCancellation(input.text)) evidence = "cancelled";
    },

    consume(previewId: string, decision: VoiceDecision): VoiceDecisionResult | undefined {
      if (previewId !== activePreviewId) return undefined;
      const expected = decision === "confirm" ? "confirmed" : "cancelled";
      if (readback !== "completed" || evidence !== expected) return undefined;
      evidence = undefined;
      readback = "none";
      return expected;
    },

    clear(previewId: string): void {
      if (previewId !== activePreviewId) return;
      activePreviewId = undefined;
      readback = "none";
      narrationCompletedAt = undefined;
      evidence = undefined;
    },
  };
}
