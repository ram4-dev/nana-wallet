import { EventEmitter } from "node:events";
import { AgentSessionEventTypes } from "@livekit/agents";
import { describe, expect, it } from "vitest";
import { isCancellation, isConfirmation } from "../../../src/livekit/resolution-phrases.js";
import { attachVoiceDecisionTranscripts } from "../../../src/livekit/voice-decision-transcripts.js";
import { createVoiceDecisionGate } from "../../../src/livekit/voice-decision-gate.js";

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

  it("detaches cleanly and does not route transcripts through a generic conversation API", () => {
    const { gate, session, detach } = setup();
    detach();
    transcript(session);
    expect(gate.consume("preview-1", "confirm")).toBeUndefined();
    expect(gate).not.toHaveProperty("handleFinalTranscript");
    expect(gate).not.toHaveProperty("handleTurnStream");
  });
});
