import { describe, expect, it } from "vitest";
import { avatarAction, reduceLiveVoice, type LiveVoiceState } from "./live-voice-reducer";

describe("live voice reducer", () => {
  it("walks binding into listening and maps avatar actions", () => {
    let state: LiveVoiceState = { phase: "idle" };
    state = reduceLiveVoice(state, { type: "START" });
    state = reduceLiveVoice(state, { type: "ROOM_CONNECTED" });
    state = reduceLiveVoice(state, { type: "BINDING_ACCEPTED" });
    expect(state).toEqual({ phase: "listening" });
    expect(avatarAction(state)).toBe("mute");
    expect(reduceLiveVoice(state, { type: "AVATAR_PRESSED" })).toEqual({ phase: "muted" });
  });

  it("preserves mute preference during recovery and falls back after deadline", () => {
    const muted = reduceLiveVoice({ phase: "muted" }, { type: "CONNECTION_LOST", now: 100 });
    expect(muted).toEqual({ phase: "reconnecting", previousMic: "muted", deadlineAt: 10100 });
    expect(reduceLiveVoice(muted, { type: "RECONNECTED" })).toEqual({ phase: "muted" });
    const listening = reduceLiveVoice(
      { phase: "listening" },
      { type: "CONNECTION_LOST", now: 100 },
    );
    expect(reduceLiveVoice(listening, { type: "RECOVERY_EXPIRED" })).toEqual({
      phase: "failed",
      reason: "Live voice disconnected.",
    });
  });

  it("pauses and interrupts without changing durable conversation state", () => {
    expect(reduceLiveVoice({ phase: "speaking" }, { type: "AVATAR_PRESSED" })).toEqual({
      phase: "listening",
    });
    expect(reduceLiveVoice({ phase: "listening" }, { type: "LIFECYCLE_PAUSED" })).toEqual({
      phase: "paused",
      previousMic: "enabled",
    });
    expect(
      reduceLiveVoice({ phase: "paused", previousMic: "enabled" }, { type: "END_CONVERSATION" }),
    ).toEqual({ phase: "idle" });
  });
});
