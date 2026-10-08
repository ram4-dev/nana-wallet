import { afterEach, describe, expect, it, vi } from "vitest";

import { attachRealtimeLatencyLogging } from "../../src/livekit/realtime-latency-logger.js";

/**
 * The worker logs never show what the realtime model actually said, so prompt
 * work on the opening turn was guesswork. `VOICE_PROMPT_DEBUG=1` prints the
 * assistant's own text; these tests pin both halves of that contract: it stays
 * silent by default, and when enabled it prints the assistant turn only.
 */

type Listener = (event: unknown) => void;

function fakeSession() {
  const listeners = new Map<string, Listener[]>();
  return {
    session: {
      on: (event: string, listener: Listener) => {
        listeners.set(event, [...(listeners.get(event) ?? []), listener]);
        return undefined;
      },
    },
    emit: (event: string, payload: unknown) => {
      for (const listener of listeners.get(event) ?? []) listener(payload);
    },
  };
}

/** Minimal shape of the SDK's ConversationItemAdded event this module reads. */
function messageItem(role: "assistant" | "user", text: string) {
  return {
    item: {
      type: "message",
      role,
      textContent: text,
      createdAt: 1_700_000_000_000,
    },
  };
}

describe("attachRealtimeLatencyLogging prompt debug", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.VOICE_PROMPT_DEBUG;
  });

  it("prints nothing by default, even for an assistant turn", () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { session, emit } = fakeSession();

    attachRealtimeLatencyLogging(session as never);
    emit("conversation_item_added", messageItem("assistant", "Hola, soy Nani."));

    expect(log).not.toHaveBeenCalled();
  });

  it("prints the assistant turn text when the debug switch is on", () => {
    process.env.VOICE_PROMPT_DEBUG = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { session, emit } = fakeSession();

    attachRealtimeLatencyLogging(session as never);
    emit("conversation_item_added", messageItem("assistant", "Hola, soy Nani."));

    expect(log).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(log.mock.calls[0]?.[0]))).toEqual({
      type: "voice_prompt_turn",
      role: "assistant",
      text: "Hola, soy Nani.",
      createdAt: 1_700_000_000_000,
    });
  });

  it("never prints the user's own speech", () => {
    process.env.VOICE_PROMPT_DEBUG = "1";
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const { session, emit } = fakeSession();

    attachRealtimeLatencyLogging(session as never);
    emit("conversation_item_added", messageItem("user", "transferí todo"));

    expect(log).not.toHaveBeenCalled();
  });
});
