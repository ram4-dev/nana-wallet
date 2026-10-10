import { EventEmitter } from "node:events";
import { AgentSessionEventTypes } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { createConfirmationArbiter } from "../../../src/conversations/confirmation-arbiter.js";
import { isCancellation, isConfirmation } from "../../../src/livekit/resolution-phrases.js";
import { attachVoiceDecisionTranscripts } from "../../../src/livekit/voice-decision-transcripts.js";
import { createVoiceDecisionGate } from "../../../src/livekit/voice-decision-gate.js";

/** The open CONTACT window's proposal: no transfer preview exists for it. */
const PROPOSAL_ID = "55555555-5555-4555-8555-555555555555";
const USER = "user-1";
const CONVERSATION = "conv-1";

function contactConsume(overrides: { version?: number; actionId?: string } = {}) {
  return {
    kind: "contact" as const,
    actionId: overrides.actionId ?? PROPOSAL_ID,
    userId: USER,
    version: overrides.version ?? 2,
    tool: "confirm_trusted_recipient_action",
  };
}

function setup() {
  const gate = createVoiceDecisionGate({ isConfirmation, isCancellation });
  gate.prepare("preview-1");
  const session = new EventEmitter();
  const detach = attachVoiceDecisionTranscripts(
    session as never,
    gate,
    (speakerId) => speakerId === null || speakerId === "bound-user",
  );
  return { gate, session, detach };
}

function transcript(session: EventEmitter, overrides: Record<string, unknown> = {}) {
  session.emit(AgentSessionEventTypes.UserInputTranscribed, {
    transcript: "sí",
    isFinal: true,
    speakerId: "bound-user",
    createdAt: Date.now() + 1,
    ...overrides,
  });
}

describe("voice decision transcript binding", () => {
  it("records only final transcripts whose room participant is authenticated", () => {
    const { gate, session } = setup();
    transcript(session, { isFinal: false });
    transcript(session, { speakerId: "other-user" });
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();

    transcript(session);
    expect(gate.consume("preview-1", "confirm")).toBe("confirmed");
  });

  it("binds an incoming transcript to the persisted preview and wakes its waiter", async () => {
    const { gate, session } = setup();
    gate.prepare("persisted-preview-id", 1_000);
    const waiting = gate.waitAndConsume("persisted-preview-id", "confirm");

    transcript(session, { createdAt: 1_001 });

    await expect(waiting).resolves.toBe("confirmed");
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
  });

  it("records final speech for an open CONTACT window instead of requiring a transfer preview", () => {
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
    const gate = createVoiceDecisionGate({
      isConfirmation,
      isCancellation,
      arbiter,
      userId: USER,
      conversationId: CONVERSATION,
    });
    const session = new EventEmitter();
    const detach = attachVoiceDecisionTranscripts(
      session as never,
      gate,
      (speakerId) => speakerId === "bound-user",
    );

    // Positive control: the arbiter really holds an open CONTACT window for the
    // exact proposal, and this session has no transfer preview at all — which is
    // precisely the state in which the listener used to drop the user's speech.
    expect(
      arbiter.open({
        kind: "contact",
        actionId: PROPOSAL_ID,
        userId: USER,
        conversationId: CONVERSATION,
        version: 2,
        createdAt: 1_000,
      }),
    ).toEqual({ status: "opened" });
    expect(gate.currentPreviewId()).toBeUndefined();

    // Guarded one rule at a time, with the positives below: interim speech and a
    // foreign speaker arm nothing at all...
    transcript(session, { isFinal: false, createdAt: 1_001 });
    transcript(session, { speakerId: "other-user", createdAt: 1_001 });
    expect(arbiter.consume(contactConsume())).toEqual({ status: "refused", code: "no_evidence" });

    // ...and speech that predates the window answered an earlier question.
    transcript(session, { createdAt: 999 });
    expect(arbiter.consume(contactConsume())).toEqual({ status: "refused", code: "evidence_expired" });

    // An after-window affirmative is real evidence, but a stale version is never
    // confirmable with it.
    transcript(session, { createdAt: 1_001 });
    expect(arbiter.consume(contactConsume({ version: 1 }))).toEqual({
      status: "refused",
      code: "version_mismatch",
    });

    // The exact proposal consumes that evidence, exactly once.
    expect(arbiter.consume(contactConsume())).toEqual({ status: "consumed" });
    expect(arbiter.consume(contactConsume())).toEqual({
      status: "refused",
      code: "already_consumed",
    });
    detach();
  });

  it("drops contact speech when no window is open, and the same words work once one is", () => {
    const arbiter = createConfirmationArbiter({ isConfirmation, isCancellation, boundedWaitMs: 0 });
    const gate = createVoiceDecisionGate({
      isConfirmation,
      isCancellation,
      arbiter,
      userId: USER,
      conversationId: CONVERSATION,
    });
    const session = new EventEmitter();
    attachVoiceDecisionTranscripts(
      session as never,
      gate,
      (speakerId) => speakerId === "bound-user",
    );

    // No window: the affirmative has nothing to be recorded against, so it is
    // dropped rather than buffered (design §8.2). Widening the listener to the
    // open window must not mean "any final speech is evidence".
    transcript(session, { createdAt: 1_001 });
    expect(arbiter.consume(contactConsume())).toEqual({ status: "refused", code: "no_window" });

    // Positive control: with the window open, the same words do count.
    expect(
      arbiter.open({
        kind: "contact",
        actionId: PROPOSAL_ID,
        userId: USER,
        conversationId: CONVERSATION,
        version: 2,
        createdAt: 2_000,
      }),
    ).toEqual({ status: "opened" });
    transcript(session, { createdAt: 2_001 });
    expect(arbiter.consume(contactConsume())).toEqual({ status: "consumed" });
  });

  it("detaches cleanly and does not route transcripts through a generic conversation API", () => {
    const { gate, session, detach } = setup();
    detach();
    transcript(session);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
    expect(gate).not.toHaveProperty("handleFinalTranscript");
    expect(gate).not.toHaveProperty("handleTurnStream");
  });
});
