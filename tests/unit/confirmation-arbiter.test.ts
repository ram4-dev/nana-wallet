import { afterEach, describe, expect, it, vi } from "vitest";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";

const userId = "user-1";
const conversationId = "conversation-1";
const transfer = { kind: "transfer" as const, actionId: "preview-1", userId, conversationId, version: 0, createdAt: 1_000 };
const contact = { kind: "contact" as const, actionId: "proposal-1", userId, conversationId, version: 1, createdAt: 1_000 };

function arbiter(overrides: { boundedWaitMs?: number } = {}) {
  return createConfirmationArbiter({
    isConfirmation: (text) => text === "sí",
    isCancellation: (text) => text === "no",
    ...overrides,
  });
}

function evidence(overrides: Partial<Parameters<ReturnType<typeof arbiter>["recordEvidence"]>[0]> = {}) {
  return {
    text: "sí",
    isFinal: true,
    authenticatedSpeaker: true,
    createdAt: 1_001,
    userId,
    conversationId,
    ...overrides,
  };
}

const consumeContact = { kind: "contact" as const, actionId: contact.actionId, userId, version: 1, tool: "confirm_contact_action" };
const consumeTransfer = { kind: "transfer" as const, actionId: transfer.actionId, userId, version: 0, tool: "confirm_transfer" };

describe("confirmation arbiter", () => {
  afterEach(() => vi.useRealTimers());

  it("admits only one typed action window in either opening order", () => {
    const first = arbiter();
    expect(first.open(transfer)).toEqual({ status: "opened" });
    expect(first.open(contact)).toEqual({ status: "conflict", current: transfer });
    // The conflict is typed and the refused window is NOT installed.
    expect(first.current()).toEqual(transfer);

    const second = arbiter();
    expect(second.open(contact)).toEqual({ status: "opened" });
    expect(second.open(transfer)).toEqual({ status: "conflict", current: contact });
    expect(second.current()).toEqual(contact);

    // Re-opening the SAME window is idempotent, not a conflict.
    expect(first.open(transfer)).toEqual({ status: "opened" });
  });

  it("binds evidence and consumption to kind, action, user and version exactly once", () => {
    const value = arbiter();
    value.open(contact);
    value.recordEvidence(evidence());
    expect(value.consume(consumeTransfer)).toEqual({ status: "refused", code: "kind_mismatch" });
    expect(value.consume({ ...consumeContact, actionId: "other-proposal" })).toEqual({ status: "refused", code: "action_mismatch" });
    expect(value.consume({ ...consumeContact, userId: "other" })).toEqual({ status: "refused", code: "user_mismatch" });
    expect(value.consume({ ...consumeContact, version: 2 })).toEqual({ status: "refused", code: "version_mismatch" });
    expect(value.consume(consumeContact)).toEqual({ status: "consumed" });
    expect(value.consume(consumeContact)).toEqual({ status: "refused", code: "already_consumed" });
  });

  it("never re-arms consumed evidence, even with a fresh affirmative", () => {
    const value = arbiter();
    value.open(contact);
    value.recordEvidence(evidence());
    expect(value.consume(consumeContact)).toEqual({ status: "consumed" });
    value.recordEvidence(evidence());
    expect(value.consume(consumeContact)).toEqual({ status: "refused", code: "already_consumed" });
    // A cancel after consumption cannot re-authorize anything either.
    value.recordEvidence(evidence({ text: "no" }));
    expect(value.consume(consumeContact)).toEqual({ status: "refused", code: "already_consumed" });
    expect(value.consume({ ...consumeTransfer, tool: "cancel_transfer", decision: "cancel" })).toEqual({
      status: "refused",
      code: "kind_mismatch",
    });
  });

  it("refuses interim, unauthenticated, foreign-session and foreign-speaker evidence", () => {
    for (const input of [
      evidence({ isFinal: false }),
      evidence({ authenticatedSpeaker: false }),
      evidence({ conversationId: "foreign" }),
      evidence({ userId: "someone-else" }),
    ]) {
      const value = arbiter();
      value.open(contact);
      value.recordEvidence(input);
      expect(value.consume(consumeContact), JSON.stringify(input)).toEqual({ status: "refused", code: "no_evidence" });
      expect(value.current()).toEqual(contact);
    }
  });

  it("refuses out-of-window evidence as expired instead of authorizing", () => {
    const value = arbiter();
    value.open(contact);
    // Spoken before the window existed: the "sí" answered an earlier question.
    value.recordEvidence(evidence({ createdAt: 1_000 }));
    expect(value.consume(consumeContact)).toEqual({ status: "refused", code: "evidence_expired" });
    // A valid later affirmative still authorizes the same window.
    value.recordEvidence(evidence());
    expect(value.consume(consumeContact)).toEqual({ status: "consumed" });
  });

  it("takes no identifier from a tool call: a model-supplied field is refused", () => {
    const value = arbiter();
    value.open(contact);
    value.recordEvidence(evidence());
    for (const injected of [
      { text: "sí" },
      { confirmationId: "conf-1" },
      { timestamp: 1_001 },
      { turnCount: 3 },
      { address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM" },
      { evidence: "confirmed" },
    ]) {
      expect(value.consume({ ...consumeContact, ...injected }), JSON.stringify(injected)).toEqual({
        status: "refused",
        code: "model_supplied",
      });
    }
    // The window is untouched: the real, server-side evidence still authorizes.
    expect(value.consume(consumeContact)).toEqual({ status: "consumed" });
  });

  it("keeps contact and transfer affirmatives from cross-authorizing in either direction", () => {
    const transferFirst = arbiter();
    transferFirst.open(transfer);
    transferFirst.recordEvidence(evidence({ text: "no" }));
    expect(transferFirst.consume(consumeContact)).toEqual({ status: "refused", code: "kind_mismatch" });
    expect(transferFirst.consume({ ...consumeTransfer, tool: "cancel_transfer", decision: "cancel" })).toEqual({ status: "consumed" });

    const contactFirst = arbiter();
    contactFirst.open(contact);
    contactFirst.recordEvidence(evidence());
    expect(contactFirst.consume({ ...consumeTransfer, tool: "confirm_transfer", decision: "confirm" })).toEqual({
      status: "refused",
      code: "kind_mismatch",
    });
    expect(contactFirst.consume(consumeContact)).toEqual({ status: "consumed" });

    // Cancelling one kind's window never clears a window of another kind.
    const mixed = arbiter();
    mixed.open(transfer);
    mixed.cancel("contact", contact.actionId);
    mixed.clear("proposal-9");
    expect(mixed.current()).toEqual(transfer);
  });

  it("waits inside the inherited bound for a delayed final affirmative and expires outside it", async () => {
    vi.useFakeTimers();
    const value = arbiter();
    value.open(contact);
    const pending = value.waitAndConsume(consumeContact);
    setTimeout(() => value.recordEvidence(evidence()), 48);
    await vi.advanceTimersByTimeAsync(48);
    await expect(pending).resolves.toEqual({ status: "consumed" });

    // Just inside the 2 000 ms inherited default.
    const inside = arbiter();
    inside.open(contact);
    const almost = inside.waitAndConsume(consumeContact);
    setTimeout(() => inside.recordEvidence(evidence()), 1_999);
    await vi.advanceTimersByTimeAsync(1_999);
    await expect(almost).resolves.toEqual({ status: "consumed" });

    // Outside the bound the evidence never authorizes, and comes too late.
    const outside = arbiter();
    outside.open(contact);
    const late = outside.waitAndConsume(consumeContact);
    setTimeout(() => outside.recordEvidence(evidence()), 2_001);
    await vi.advanceTimersByTimeAsync(2_001);
    await expect(late).resolves.toEqual({ status: "refused", code: "no_evidence" });
    expect(outside.current()).toEqual(contact);
  });

  it("never lets replaced-proposal or cleared evidence authorize a later window", () => {
    const replaced = arbiter();
    replaced.open(contact);
    replaced.recordEvidence(evidence());
    replaced.clear(contact.actionId);
    expect(replaced.current()).toBeUndefined();
    expect(replaced.consume(consumeContact)).toEqual({ status: "refused", code: "no_window" });
    // Re-opening the same action id does not resurrect the dropped evidence.
    replaced.open(contact);
    expect(replaced.consume(consumeContact)).toEqual({ status: "refused", code: "no_evidence" });
    replaced.recordEvidence(evidence());
    expect(replaced.consume(consumeContact)).toEqual({ status: "consumed" });

    const superseded = arbiter();
    superseded.open(contact);
    superseded.recordEvidence(evidence());
    // A newer version is a different window; while v1 is visible that is a typed conflict.
    expect(superseded.open({ ...contact, version: 2 })).toEqual({ status: "conflict", current: contact });
    // The v1 affirmative can never authorize v2, and still authorizes v1.
    expect(superseded.consume({ ...consumeContact, version: 2 })).toEqual({ status: "refused", code: "version_mismatch" });
    expect(superseded.consume(consumeContact)).toEqual({ status: "consumed" });
  });

  it("honours an explicit boundedWaitMs and completes the same call for cancel", async () => {
    vi.useFakeTimers();
    const value = arbiter({ boundedWaitMs: 5 });
    value.open(contact);
    const pending = value.waitAndConsume({ ...consumeContact, tool: "cancel_contact_action", decision: "cancel" });
    setTimeout(() => value.recordEvidence(evidence({ text: "no" })), 4);
    await vi.advanceTimersByTimeAsync(4);
    await expect(pending).resolves.toEqual({ status: "consumed" });

    const short = arbiter({ boundedWaitMs: 5 });
    short.open(contact);
    const missed = short.waitAndConsume(consumeContact);
    await vi.advanceTimersByTimeAsync(5);
    await expect(missed).resolves.toEqual({ status: "refused", code: "no_evidence" });
  });

  it("refuses consumption for a window that was never opened", () => {
    const value = arbiter();
    expect(value.consume(consumeContact)).toEqual({ status: "refused", code: "no_window" });
    expect(value.current()).toBeUndefined();
    value.open(contact);
    value.clear(contact.actionId);
    expect(value.consume(consumeContact)).toEqual({ status: "refused", code: "no_window" });
  });
});
