/**
 * One in-memory authorization window for a conversation. Durable contact
 * proposals provide cross-process one-use protection; this object only binds
 * authenticated, final user evidence to the currently visible action.
 */
export type ActionKind = "transfer" | "contact";
export type ActionWindow = {
  kind: ActionKind;
  actionId: string;
  userId: string;
  conversationId: string;
  version: number;
  createdAt: number;
};
export type ArbiterRefusalCode =
  | "no_window" | "kind_mismatch" | "action_mismatch" | "user_mismatch"
  | "version_mismatch" | "already_consumed" | "expired" | "no_evidence"
  | "evidence_expired" | "model_supplied";
export type ArbiterResult = { status: "consumed" } | { status: "refused"; code: ArbiterRefusalCode };

type Classifiers = { isConfirmation(text: string): boolean; isCancellation(text: string): boolean };
type Evidence = "confirmed" | "cancelled";
type ConsumeInput = { kind: ActionKind; actionId: string; userId: string; version: number; tool: string; decision?: "confirm" | "cancel" };
const DEFAULT_WAIT_MS = 2_000;
/**
 * The ONLY keys a confirmation call may carry. Every value here is server-owned
 * state (the window it names, the identity it binds, the tool asking); design
 * §7.5 forbids the arbiter from accepting any identifier, phrase, timestamp or
 * turn ordinal a model supplied, so an unexpected key is refused by name rather
 * than silently ignored.
 */
const CONSUME_KEYS = new Set(["kind", "actionId", "userId", "version", "tool", "decision"]);

export function createConfirmationArbiter(
  classifiers: Classifiers & { onObservation?: (event: Record<string, string | number | boolean | null>) => void; boundedWaitMs?: number },
) {
  let active: ActionWindow | undefined;
  let evidence: Evidence | undefined;
  let consumed: string | undefined;
  /** Evidence was spoken, but not after the window existed: it never authorizes. */
  let staleEvidence = false;
  const waiters = new Set<() => void>();
  const wake = () => { for (const waiter of waiters) waiter(); };
  const refuse = (code: ArbiterRefusalCode): ArbiterResult => ({ status: "refused", code });

  function same(input: Pick<ActionWindow, "kind" | "actionId" | "userId" | "version">): ArbiterRefusalCode | undefined {
    if (!active) return consumed === input.actionId ? "already_consumed" : "no_window";
    if (active.kind !== input.kind) return "kind_mismatch";
    if (active.actionId !== input.actionId) return "action_mismatch";
    if (active.userId !== input.userId) return "user_mismatch";
    if (active.version !== input.version) return "version_mismatch";
    if (consumed === input.actionId) return "already_consumed";
    return undefined;
  }

  return {
    open(window: ActionWindow): { status: "opened" } | { status: "conflict"; current: ActionWindow } {
      if (active && (active.actionId !== window.actionId || active.kind !== window.kind || active.version !== window.version)) return { status: "conflict", current: active };
      active = window;
      evidence = undefined;
      consumed = undefined;
      staleEvidence = false;
      wake();
      return { status: "opened" };
    },
    current(): ActionWindow | undefined { return active; },
    recordEvidence(input: { text: string; isFinal: boolean; authenticatedSpeaker: boolean; createdAt: number; userId: string; conversationId: string }): void {
      const window = active;
      const afterWindow = Boolean(window && Number.isFinite(input.createdAt) && input.createdAt > window.createdAt);
      const eligible = Boolean(window && input.isFinal && input.authenticatedSpeaker && Number.isFinite(input.createdAt) && afterWindow && input.userId === window.userId && input.conversationId === window.conversationId && !consumed);
      const decision = eligible ? classifiers.isConfirmation(input.text) ? "confirmed" : classifiers.isCancellation(input.text) ? "cancelled" : undefined : undefined;
      // Spoken before the window existed (or with an unorderable timestamp): it
      // answered an earlier question, so it is recorded as expired, never armed.
      if (window && input.isFinal && input.authenticatedSpeaker && !afterWindow) staleEvidence = true;
      classifiers.onObservation?.({ event: "transcript", isFinal: input.isFinal, authenticatedSpeaker: input.authenticatedSpeaker, afterWindow, decision: decision ?? null });
      if (decision) { evidence = decision; wake(); }
    },
    consume(input: ConsumeInput): ArbiterResult {
      if (Object.keys(input).some((key) => !CONSUME_KEYS.has(key))) return refuse("model_supplied");
      const mismatch = same(input);
      if (mismatch) return refuse(mismatch);
      const expected = input.decision === "cancel" ? "cancelled" : "confirmed";
      if (evidence !== expected) return refuse(evidence === undefined && staleEvidence ? "evidence_expired" : "no_evidence");
      consumed = input.actionId;
      evidence = undefined;
      staleEvidence = false;
      wake();
      return { status: "consumed" };
    },
    async waitAndConsume(input: ConsumeInput, timeoutMs = classifiers.boundedWaitMs ?? DEFAULT_WAIT_MS): Promise<ArbiterResult> {
      const now = this.consume(input);
      if (now.status === "consumed" || now.code !== "no_evidence") return now;
      const changed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const finish = (value: boolean) => { if (!settled) { settled = true; waiters.delete(done); clearTimeout(timer); resolve(value); } };
        const done = () => finish(true);
        const timer = setTimeout(() => finish(false), timeoutMs);
        waiters.add(done);
      });
      if (!changed) return refuse("no_evidence");
      return this.consume(input);
    },
    cancel(kind: ActionKind, actionId: string): void { if (active?.kind === kind && active.actionId === actionId) { active = undefined; evidence = undefined; staleEvidence = false; wake(); } },
    clear(actionId: string): void { if (active?.actionId === actionId) { active = undefined; evidence = undefined; staleEvidence = false; wake(); } },
  };
}

export type ConfirmationArbiter = ReturnType<typeof createConfirmationArbiter>;
