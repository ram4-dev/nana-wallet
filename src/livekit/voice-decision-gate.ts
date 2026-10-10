export type VoiceDecision = "confirm" | "cancel";
export type VoiceDecisionResult = "confirmed" | "cancelled";
import type { ConfirmationArbiter } from "../conversations/confirmation-arbiter.js";

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
  onObservation?(event: Record<string, string | number | boolean | null>): void;
  arbiter?: ConfirmationArbiter;
  userId?: string;
  conversationId?: string;
}) {
  let activePreviewId: string | undefined;
  let previewCreatedAt: number | undefined;
  let evidence: VoiceDecisionResult | undefined;
  let consumedPreviewId: string | undefined;
  const waiters = new Set<() => void>();

  function wakeWaiters(): void {
    for (const wake of waiters) wake();
  }

  function canWaitFor(previewId: string): boolean {
    return (
      previewId === activePreviewId &&
      evidence === undefined &&
      consumedPreviewId !== previewId
    );
  }

  return {
    currentPreviewId(): string | undefined {
      return activePreviewId;
    },

    /**
     * Opens the decision window for a preview that now exists. Any evidence
     * recorded for a previous preview is dropped: a decision never carries
     * across transfers.
     */
    prepare(previewId: string, createdAt: number = Date.now()): boolean {
      if (!previewId) {
        activePreviewId = undefined;
        previewCreatedAt = undefined;
        evidence = undefined;
        wakeWaiters();
        return true;
      }
      // Replacing a transfer preview must release the arbiter window it opened
      // (design §7.4: replacement invalidates the previous window). A window of
      // ANOTHER kind is never preempted: it stays open and this open fails closed.
      const current = classifiers.arbiter?.current();
      if (current?.kind === "transfer" && current.actionId !== previewId) {
        classifiers.arbiter?.clear(current.actionId);
      }
      const opened = classifiers.arbiter?.open({
        kind: "transfer", actionId: previewId,
        userId: classifiers.userId ?? "voice-unbound",
        conversationId: classifiers.conversationId ?? "voice-unbound",
        version: 0, createdAt,
      });
      if (opened?.status === "conflict") return false;
      if (previewId !== consumedPreviewId) consumedPreviewId = undefined;
      activePreviewId = previewId;
      previewCreatedAt = Number.isFinite(createdAt) ? createdAt : Date.now();
      evidence = undefined;
      classifiers.onObservation?.({ event: "prepare", previewCreatedAt, observedAt: Date.now() });
      wakeWaiters();
      return true;
    },

    recordTranscript(input: {
      previewId: string;
      text: string;
      isFinal: boolean;
      authenticatedSpeaker: boolean;
      createdAt: number;
    }): void {
      const matchesPreview = input.previewId === activePreviewId;
      const eligible = !(
        previewCreatedAt === undefined ||
        !matchesPreview ||
        consumedPreviewId === activePreviewId ||
        !input.isFinal ||
        input.authenticatedSpeaker !== true ||
        !Number.isFinite(input.createdAt) ||
        // The ordering rule: an affirmative only counts if it came AFTER the
        // preview existed. A "sí" that answered an earlier question — or that
        // was part of the instruction that created the preview — is not a
        // decision about it.
        input.createdAt <= previewCreatedAt
      );
      const decision = eligible
        ? classifiers.isConfirmation(input.text) ? "confirmed"
          : classifiers.isCancellation(input.text) ? "cancelled" : undefined
        : undefined;
      classifiers.onObservation?.({
        event: "transcript",
        observedAt: Date.now(),
        createdAt: input.createdAt,
        previewCreatedAt: previewCreatedAt ?? null,
        matchesPreview,
        isFinal: input.isFinal,
        authenticatedSpeaker: input.authenticatedSpeaker,
        afterPreview: previewCreatedAt !== undefined && input.createdAt > previewCreatedAt,
        decision: decision ?? null,
      });
      if (decision) {
        classifiers.arbiter?.recordEvidence({
          text: input.text, isFinal: input.isFinal,
          authenticatedSpeaker: input.authenticatedSpeaker, createdAt: input.createdAt,
          userId: classifiers.userId ?? "voice-unbound",
          conversationId: classifiers.conversationId ?? "voice-unbound",
        });
        evidence = decision;
        wakeWaiters();
      }
    },

    consume(previewId: string, decision: VoiceDecision): VoiceDecisionResult | undefined {
      const expected = decision === "confirm" ? "confirmed" : "cancelled";
      const accepted =
        previewId === activePreviewId &&
        consumedPreviewId !== previewId &&
        evidence === expected;
      const arbiterAccepted = !classifiers.arbiter || classifiers.arbiter.consume({
        kind: "transfer", actionId: previewId,
        userId: classifiers.userId ?? "voice-unbound", version: 0,
        tool: decision === "confirm" ? "confirm_transfer" : "cancel_transfer", decision,
      }).status === "consumed";
      classifiers.onObservation?.({
        event: "consume", observedAt: Date.now(),
        matchesPreview: previewId === activePreviewId,
        evidence: evidence ?? null, accepted: accepted && arbiterAccepted,
      });
      if (!accepted || !arbiterAccepted) return undefined;
      evidence = undefined;
      classifiers.arbiter?.clear(previewId);
      consumedPreviewId = previewId;
      wakeWaiters();
      return expected;
    },

    async waitAndConsume(
      previewId: string,
      decision: VoiceDecision,
      timeoutMs: number = 2_000,
    ): Promise<VoiceDecisionResult | undefined> {
      const immediate = this.consume(previewId, decision);
      if (immediate) return immediate;
      // A different final decision has already arrived, or this preview has
      // been replaced, cleared, or consumed. Waiting cannot make any of those
      // states authorize this request.
      if (!canWaitFor(previewId)) return undefined;

      const changed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => {
          if (settled) return;
          settled = true;
          waiters.delete(wake);
          clearTimeout(timer);
          resolve(value);
        };
        const wake = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(wake);
      });
      if (!changed) return undefined;
      return this.consume(previewId, decision);
    },

    clear(previewId: string): void {
      // The arbiter window is closed with the preview, so no later affirmative
      // can find an armed window for an action the caller just discarded.
      if (classifiers.arbiter?.current()?.actionId === previewId) classifiers.arbiter.clear(previewId);
      if (previewId !== activePreviewId) return;
      activePreviewId = undefined;
      previewCreatedAt = undefined;
      evidence = undefined;
      wakeWaiters();
    },
  };
}
