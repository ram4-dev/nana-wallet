import { describe, expect, it } from "vitest";
import {
  avatarAction,
  GREETING_WINDOW_MS,
  reduceLiveVoice,
  type LiveVoiceState,
} from "./live-voice-reducer";

describe("live voice reducer", () => {
  it("walks binding into the opening turn and maps avatar actions", () => {
    let state: LiveVoiceState = { phase: "idle" };
    state = reduceLiveVoice(state, { type: "START" });
    state = reduceLiveVoice(state, { type: "ROOM_CONNECTED" });
    state = reduceLiveVoice(state, {
      type: "BINDING_ACCEPTED",
      now: 1_000,
      greetingWindowMs: GREETING_WINDOW_MS,
    });
    // The worker always dispatches the opening greeting turn at session start,
    // so "preparing a greeting" is the truthful first state - not "listening".
    expect(state).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: 1_000 + GREETING_WINDOW_MS,
    });
    expect(avatarAction(state)).toBe("none");

    // The room reporting "listening" as soon as the session is up only means the
    // session is ready, not that the greeting is over: the opening turn survives.
    const stillOpening = reduceLiveVoice(state, { type: "AGENT_STATE", state: "listening" });
    expect(stillOpening).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: 1_000 + GREETING_WINDOW_MS,
    });
    expect(avatarAction(stillOpening)).toBe("none");

    // Once the greeting window runs out, the session becomes a normal listening
    // turn and the avatar can mute as usual.
    const listening = reduceLiveVoice(stillOpening, { type: "GREETING_WINDOW_EXPIRED" });
    expect(listening).toEqual({ phase: "listening" });
    expect(avatarAction(listening)).toBe("mute");
    expect(reduceLiveVoice(listening, { type: "AVATAR_PRESSED" })).toEqual({ phase: "muted" });
  });

  it("keeps the opening-turn marker until the agent speaks or the window expires", () => {
    const opening = reduceLiveVoice(
      { phase: "binding" },
      { type: "BINDING_ACCEPTED", now: 0, greetingWindowMs: GREETING_WINDOW_MS },
    );
    expect(opening).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: GREETING_WINDOW_MS,
    });

    // Still preparing the greeting: both "thinking" words keep the marker, so a
    // repeated callback never turns the greeting into a generic answer.
    expect(reduceLiveVoice(opening, { type: "AGENT_STATE", state: "thinking" })).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: GREETING_WINDOW_MS,
    });
    expect(reduceLiveVoice(opening, { type: "AGENT_STATE", state: "initializing" })).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: GREETING_WINDOW_MS,
    });

    // The session being ready is not the greeting being over: "listening" and
    // "idle" from the room keep the opening turn alive.
    expect(reduceLiveVoice(opening, { type: "AGENT_STATE", state: "listening" })).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: GREETING_WINDOW_MS,
    });
    expect(reduceLiveVoice(opening, { type: "AGENT_STATE", state: "idle" })).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: GREETING_WINDOW_MS,
    });

    // Speaking the greeting clears the marker...
    const speaking = reduceLiveVoice(opening, { type: "AGENT_STATE", state: "speaking" });
    expect(speaking).toEqual({ phase: "speaking" });
    // ...so a later thinking turn is a plain answer, never the opening turn.
    expect(reduceLiveVoice(speaking, { type: "AGENT_STATE", state: "thinking" })).toEqual({
      phase: "thinking",
    });

    // A thinking state reached without the bind never carries the marker.
    expect(
      reduceLiveVoice({ phase: "listening" }, { type: "AGENT_STATE", state: "thinking" }),
    ).toEqual({ phase: "thinking" });
  });

  it("treats the greeting-window expiry as a no-op outside the opening turn", () => {
    // A stale deadline from an earlier session must never move a live one.
    expect(reduceLiveVoice({ phase: "listening" }, { type: "GREETING_WINDOW_EXPIRED" })).toEqual({
      phase: "listening",
    });
    expect(reduceLiveVoice({ phase: "thinking" }, { type: "GREETING_WINDOW_EXPIRED" })).toEqual({
      phase: "thinking",
    });
    expect(reduceLiveVoice({ phase: "speaking" }, { type: "GREETING_WINDOW_EXPIRED" })).toEqual({
      phase: "speaking",
    });
    expect(reduceLiveVoice({ phase: "muted" }, { type: "GREETING_WINDOW_EXPIRED" })).toEqual({
      phase: "muted",
    });
    expect(reduceLiveVoice({ phase: "idle" }, { type: "GREETING_WINDOW_EXPIRED" })).toEqual({
      phase: "idle",
    });
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
      reason: {
        code: "recovery_expired",
        message: "La voz se desconectó. Podés seguir escribiéndome.",
      },
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

  it("rejects stale lifecycle callbacks and emits side-effect commands", () => {
    const idle = { phase: "idle" } as const;
    expect(reduceLiveVoice(idle, { type: "ROOM_CONNECTED" })).toEqual(idle);
    expect(
      reduceLiveVoice(idle, {
        type: "AGENT_STATE",
        state: "failed",
      }),
    ).toEqual(idle);

    const listening = { phase: "listening" } as const;
    const muted = reduceLiveVoice(listening, { type: "AVATAR_PRESSED" });
    expect(muted).toEqual({ phase: "muted" });
  });
});
