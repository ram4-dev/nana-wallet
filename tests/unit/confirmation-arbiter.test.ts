import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfirmationArbiter } from "../../src/conversations/confirmation-arbiter.js";

const userId = "user-1";
const conversationId = "conversation-1";
const transfer = { kind: "transfer" as const, actionId: "preview-1", userId, conversationId, version: 0, createdAt: 1_000 };
const contact = { kind: "contact" as const, actionId: "proposal-1", userId, conversationId, version: 1, createdAt: 1_000 };

function arbiter() {
  return createConfirmationArbiter({
    isConfirmation: (text) => text === "sí",
    isCancellation: (text) => text === "no",
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

describe("confirmation arbiter", () => {
  it("admits only one typed action window in either opening order", () => {
    const first = arbiter();
    expect(first.open(transfer)).toEqual({ status: "opened" });
    expect(first.open(contact)).toEqual({ status: "conflict", current: transfer });

    const second = arbiter();
    expect(second.open(contact)).toEqual({ status: "opened" });
    expect(second.open(transfer)).toEqual({ status: "conflict", current: contact });
  });

  it("binds evidence and consumption to kind, action, user and version exactly once", () => {
    const value = arbiter();
    value.open(contact);
    value.recordEvidence(evidence());
    expect(value.consume({ kind: "transfer", actionId: transfer.actionId, userId, version: 0, tool: "confirm_transfer" })).toEqual({ status: "refused", code: "kind_mismatch" });
    expect(value.consume({ kind: "contact", actionId: contact.actionId, userId: "other", version: 1, tool: "confirm_contact_action" })).toEqual({ status: "refused", code: "user_mismatch" });
    expect(value.consume({ kind: "contact", actionId: contact.actionId, userId, version: 2, tool: "confirm_contact_action" })).toEqual({ status: "refused", code: "version_mismatch" });
    expect(value.consume({ kind: "contact", actionId: contact.actionId, userId, version: 1, tool: "confirm_contact_action" })).toEqual({ status: "consumed" });
    expect(value.consume({ kind: "contact", actionId: contact.actionId, userId, version: 1, tool: "confirm_contact_action" })).toEqual({ status: "refused", code: "already_consumed" });
  });

  it("rejects interim, unauthenticated, cross-conversation, and pre-window evidence", () => {
    const value = arbiter();
    value.open(contact);
    for (const input of [
      evidence({ isFinal: false }),
      evidence({ authenticatedSpeaker: false }),
      evidence({ conversationId: "foreign" }),
      evidence({ createdAt: 1_000 }),
    ]) value.recordEvidence(input);
    expect(value.consume({ kind: "contact", actionId: contact.actionId, userId, version: 1, tool: "confirm_contact_action" })).toEqual({ status: "refused", code: "no_evidence" });
  });

  it("waits for a delayed final affirmative and invalidates it on replacement", async () => {
    vi.useFakeTimers();
    const value = arbiter();
    value.open(contact);
    const pending = value.waitAndConsume({ kind: "contact", actionId: contact.actionId, userId, version: 1, tool: "confirm_contact_action" });
    setTimeout(() => value.recordEvidence(evidence()), 48);
    await vi.advanceTimersByTimeAsync(48);
    await expect(pending).resolves.toEqual({ status: "consumed" });

    const replacement = arbiter();
    replacement.open(contact);
    const stale = replacement.waitAndConsume({ kind: "contact", actionId: contact.actionId, userId, version: 1, tool: "confirm_contact_action" });
    replacement.clear(contact.actionId);
    await expect(stale).resolves.toEqual({ status: "refused", code: "no_window" });
  });
  afterEach(() => vi.useRealTimers());
});
