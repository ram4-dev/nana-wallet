export type VoiceDecision = "confirm" | "cancel";
export type VoiceDecisionResult = "confirmed" | "cancelled";

export type VoiceDecisionGate = ReturnType<typeof createVoiceDecisionGate>;

/**
 * Per-session, one-use authorization evidence for an explicitly spoken
 * decision about ONE persisted preview.
 *
 * ## What actually protects the transfer
 *
 * The invariant is: an affirmative the user spoke AFTER the preview existed,
 * and only that. Everything the gate needs to know is WHEN the preview was
 * created and WHEN the user spoke.
 *
 * ## Why the read-back requirement was removed
 *
 * The gate used to require the server's read-back to have played out in full
 * without interruption, and only then would it arm. That made the user's
 * ability to pay depend on a second, nested model generation producing an exact
 * sentence — something a speech-to-speech model does not reliably do. In
 * practice the read-back came back short or interrupted, the gate never armed,
 * and **no confirmation could ever succeed**, while the refusal blamed the
 * user's own speech.
 *
 * It was also redundant. The preview is persisted and narrated in the
 * assistant's own turn, so by the time the user answers they have been told the
 * amount, the fee and the contact. The ordering rule below is what keeps a "sí"
 * that answered some OTHER question — or a model-invented confirmation with no
 * user speech at all — from authorizing a transfer.
 */
export function createVoiceDecisionGate(classifiers: {
  isConfirmation(text: string): boolean;
  isCancellation(text: string): boolean;
}) {
  let activePreviewId: string | undefined;
  let previewCreatedAt: number | undefined;
  let evidence: VoiceDecisionResult | undefined;

  return {
    /**
     * Opens the decision window for a preview that now exists. Any evidence
     * recorded for a previous preview is dropped: a decision never carries
     * across transfers.
     */
    prepare(previewId: string, createdAt: number = Date.now()): void {
      if (!previewId) {
        activePreviewId = undefined;
        previewCreatedAt = undefined;
        evidence = undefined;
        return;
      }
      activePreviewId = previewId;
      previewCreatedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
      evidence = undefined;
    },

    recordTranscript(input: {
      previewId: string;
      text: string;
      isFinal: boolean;
      authenticatedSpeaker: boolean;
      createdAt: number;
    }): void {
      if (
        previewCreatedAt === undefined ||
        !input.isFinal ||
        input.authenticatedSpeaker !== true ||
        !Number.isFinite(input.createdAt) ||
        // The ordering rule: an affirmative only counts if it came AFTER the
        // preview existed. A "sí" that answered an earlier question — or that
        // was part of the instruction that created the preview — is not a
        // decision about it.
        input.createdAt <= previewCreatedAt
      ) {
        return;
      }
      if (classifiers.isConfirmation(input.text)) evidence = "confirmed";
      else if (classifiers.isCancellation(input.text)) evidence = "cancelled";
    },

    consume(previewId: string, decision: VoiceDecision): VoiceDecisionResult | undefined {
      if (previewId !== activePreviewId) return undefined;
      const expected = decision === "confirm" ? "confirmed" : "cancelled";
      if (evidence !== expected) return undefined;
      evidence = undefined;
      return expected;
    },

    clear(previewId: string): void {
      if (previewId !== activePreviewId) return;
      activePreviewId = undefined;
      previewCreatedAt = undefined;
      evidence = undefined;
    },
  };
}
