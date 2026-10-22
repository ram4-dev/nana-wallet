import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLiveVoiceSession } from "./useLiveVoiceSession";
import { GREETING_WINDOW_MS, type LiveKitAgentState } from "./voice/live-voice-reducer";
import type { VoiceClient } from "./voice/voice-client";

type FakeVoiceClient = VoiceClient & {
  emitAudioPlayback: (blocked: boolean) => void;
  emitAgentTranscript: (text: string) => void;
  /** Mirrors `createLiveKitWebClient`: the room reports the agent's live state. */
  onAgentState: (state: string) => void;
};

// The states the live client reports; src/routes/index.tsx forwards exactly these
// into the session reducer through `onAgentState`.
const ACCEPTED_AGENT_STATES: readonly LiveKitAgentState[] = [
  "connecting",
  "initializing",
  "idle",
  "listening",
  "thinking",
  "speaking",
  "failed",
];

function fakeClient(overrides: Partial<FakeVoiceClient> = {}): FakeVoiceClient {
  const audioListeners = new Set<(blocked: boolean) => void>();
  const transcriptListeners = new Set<(text: string) => void>();
  let audioBlocked = false;
  const client = {
    connect: vi.fn(async () => ({ conversationId: "conversation-1", revision: 2 })),
    setMicrophoneEnabled: vi.fn(async (enabled: boolean) => {
      // Publishing the microphone brings the agent's input stream live, so the
      // room reports the agent as listening - the same state the real client
      // surfaces through `onAgentState`.
      if (enabled) client.onAgentState("listening");
    }),
    interruptAgentSpeech: vi.fn(async () => undefined),
    pauseForLifecycle: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    canPlaybackAudio: () => !audioBlocked,
    startAudio: vi.fn(async () => {
      // Resuming playback is what the room does when the unlock succeeds.
      audioBlocked = false;
    }),
    watchAudioPlayback: (listener: (blocked: boolean) => void) => {
      audioListeners.add(listener);
      listener(audioBlocked);
      return () => audioListeners.delete(listener);
    },
    watchAgentTranscript: (listener: (text: string) => void) => {
      transcriptListeners.add(listener);
      return () => transcriptListeners.delete(listener);
    },
    emitAudioPlayback: (blocked: boolean) => {
      audioBlocked = blocked;
      for (const listener of audioListeners) listener(blocked);
    },
    emitAgentTranscript: (text: string) => {
      for (const listener of transcriptListeners) listener(text);
    },
    onAgentState: () => undefined,
  } as unknown as FakeVoiceClient;
  return Object.assign(client, overrides);
}

/**
 * Renders the session the way src/routes/index.tsx wires it: the live client
 * reports the agent's state and the app forwards the accepted ones into the
 * session reducer, so a started session reaches "listening" on its own.
 */
function renderLiveVoiceSession(
  client: FakeVoiceClient,
  options: Parameters<typeof useLiveVoiceSession>[1] = {},
) {
  const rendered = renderHook(() => useLiveVoiceSession(client, options));
  client.onAgentState = (state) => {
    if (!ACCEPTED_AGENT_STATES.includes(state as LiveKitAgentState)) return;
    rendered.result.current.dispatch({ type: "AGENT_STATE", state: state as LiveKitAgentState });
  };
  return rendered;
}

function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { configurable: true, value });
}

/** Drains the microtask chain of a session start without depending on real time. */
async function flushAsyncWork() {
  await act(async () => {
    for (let index = 0; index < 12; index += 1) await Promise.resolve();
  });
}

/**
 * Models the worker's opening greeting turn: Nani speaks first and then hands
 * the turn back by reporting the agent listening again.
 */
function greet(client: FakeVoiceClient) {
  act(() => client.onAgentState("speaking"));
  act(() => client.onAgentState("listening"));
}

describe("useLiveVoiceSession", () => {
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("auto-starts the session on mount when the document is visible", async () => {
    const client = fakeClient();
    const { result } = renderLiveVoiceSession(client);

    await flushAsyncWork();
    greet(client);
    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it("keeps presenting the opening turn while the room only reports the session is listening", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    // The microphone report is silenced so the transient opening turn is
    // observable instead of being immediately replaced by "listening".
    const client = fakeClient({ setMicrophoneEnabled: vi.fn(async () => undefined) });
    const { result } = renderLiveVoiceSession(client);

    await flushAsyncWork();
    // The worker always dispatches the opening greeting turn at session start,
    // so the truthful first state is "thinking", never "listening".
    const opening = {
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: 1_000 + GREETING_WINDOW_MS,
    };
    expect(result.current.state).toEqual(opening);

    // The agent publishing "listening" as soon as the session is up is not the
    // greeting being over: the opening turn (and its marker) survive.
    act(() => client.onAgentState("listening"));
    expect(result.current.state).toEqual(opening);
    act(() => client.onAgentState("idle"));
    expect(result.current.state).toEqual(opening);

    // Nani speaking the greeting drops the marker...
    act(() => client.onAgentState("speaking"));
    expect(result.current.state).toEqual({ phase: "speaking" });

    // ...so a later turn is a plain answer, never the opening turn.
    act(() => client.onAgentState("thinking"));
    expect(result.current.state).toEqual({ phase: "thinking" });

    act(() => client.onAgentState("listening"));
    expect(result.current.state).toEqual({ phase: "listening" });
  });

  it("ends the opening turn when the greeting window expires without a greeting", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const client = fakeClient({ setMicrophoneEnabled: vi.fn(async () => undefined) });
    const { result } = renderLiveVoiceSession(client);

    await flushAsyncWork();
    expect(result.current.state).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: 1_000 + GREETING_WINDOW_MS,
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(GREETING_WINDOW_MS);
    });
    // The deadline ends the opening turn so a silent greeting cannot pin the
    // home on the opening copy forever.
    expect(result.current.state).toEqual({ phase: "listening" });
  });

  it("cancels the greeting deadline when the greeting arrives and never leaks it into a later session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const client = fakeClient({ setMicrophoneEnabled: vi.fn(async () => undefined) });
    const { result } = renderLiveVoiceSession(client);

    await flushAsyncWork();
    // First session: Nani greets before the deadline, so the deadline is cancelled.
    greet(client);
    await act(async () => {
      await result.current.endConversation();
    });
    expect(result.current.state).toEqual({ phase: "idle" });

    // A later session opens its own greeting turn at its own time.
    vi.setSystemTime(3_000);
    await act(async () => {
      await result.current.handleAvatarPress();
    });
    await flushAsyncWork();
    expect(result.current.state).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: 3_000 + GREETING_WINDOW_MS,
    });

    // Reaching the first session's deadline must not cut this opening turn short.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(result.current.state).toEqual({
      phase: "thinking",
      openingTurn: true,
      greetingDeadlineAt: 3_000 + GREETING_WINDOW_MS,
    });

    // Only this session's own deadline ends its opening turn.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });
    expect(result.current.state).toEqual({ phase: "listening" });
  });

  it("does not start while the document is hidden and starts when it becomes visible while still idle", async () => {
    setVisibility("hidden");
    const client = fakeClient();
    const { result } = renderLiveVoiceSession(client);

    await flushAsyncWork();
    expect(client.connect).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ phase: "idle" });

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await flushAsyncWork();
    greet(client);
    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("connects once, toggles the microphone, and interrupts speaking", async () => {
    const client = fakeClient();
    const { result } = renderLiveVoiceSession(client);

    await flushAsyncWork();
    greet(client);
    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));

    await act(async () => {
      await result.current.handleAvatarPress();
    });
    expect(result.current.state).toEqual({ phase: "muted" });
    expect(client.setMicrophoneEnabled).toHaveBeenLastCalledWith(false);

    act(() => result.current.dispatch({ type: "AGENT_STATE", state: "speaking" }));
    await act(async () => {
      await result.current.handleAvatarPress();
    });
    expect(client.interruptAgentSpeech).toHaveBeenCalledOnce();
    expect(result.current.state).toEqual({ phase: "listening" });
  });

  it("pauses on hidden documents and does not resume until an explicit tap", async () => {
    const client = fakeClient();
    const { result } = renderLiveVoiceSession(client);
    await flushAsyncWork();
    greet(client);
    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));

    setVisibility("hidden");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.state).toEqual({ phase: "paused", previousMic: "enabled" });
    expect(client.pauseForLifecycle).toHaveBeenCalledOnce();

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.state).toEqual({ phase: "paused", previousMic: "enabled" });
    expect(client.connect).toHaveBeenCalledOnce();

    await act(async () => {
      await result.current.handleAvatarPress();
    });
    expect(result.current.state).toEqual({ phase: "listening" });
    expect(client.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it("uses the ten-second deadline as a typed fallback and stops the room", async () => {
    vi.useFakeTimers();
    const client = fakeClient();
    const onTypedFallback = vi.fn();
    const { result } = renderLiveVoiceSession(client, { onTypedFallback });
    await flushAsyncWork();
    greet(client);
    expect(result.current.state.phase).toBe("listening");

    act(() => {
      result.current.dispatch({ type: "CONNECTION_LOST", now: Date.now(), recoveryMs: 1_000 });
    });
    expect(result.current.state.phase).toBe("reconnecting");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(result.current.state.phase).toBe("failed");
    expect(onTypedFallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "recovery_expired" }),
    );
    expect(client.disconnect).toHaveBeenCalled();
  });

  it("restores the pre-disconnection microphone preference after recovery", async () => {
    const client = fakeClient();
    const { result } = renderLiveVoiceSession(client);
    await flushAsyncWork();
    greet(client);
    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));

    act(() => result.current.dispatch({ type: "AVATAR_PRESSED" }));
    act(() => result.current.dispatch({ type: "CONNECTION_LOST", now: Date.now() }));
    act(() => result.current.dispatch({ type: "RECONNECTED" }));
    await waitFor(() => expect(client.setMicrophoneEnabled).toHaveBeenLastCalledWith(false));
    expect(result.current.state).toEqual({ phase: "muted" });
  });

  it("falls back to typed mode when voice cannot start", async () => {
    const client = fakeClient({
      connect: vi.fn(async () => {
        throw new Error("missing credentials");
      }),
    });
    const onTypedFallback = vi.fn();
    const { result } = renderLiveVoiceSession(client, { onTypedFallback });

    await waitFor(() => expect(result.current.state.phase).toBe("failed"));
    expect(onTypedFallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "voice_unavailable" }),
    );
  });

  it("shows Nani's words in writing and unlocks playback on tap when the browser blocks audio", async () => {
    const client = fakeClient();
    const { result } = renderLiveVoiceSession(client);
    await flushAsyncWork();
    greet(client);
    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));

    expect(result.current.audioBlocked).toBe(false);
    expect(result.current.agentTranscript).toBeNull();

    act(() => client.emitAudioPlayback(true));
    act(() => client.emitAgentTranscript("Hola, soy Nani. Tenés 12 USDC disponibles."));
    expect(result.current.audioBlocked).toBe(true);
    expect(result.current.agentTranscript).toBe("Hola, soy Nani. Tenés 12 USDC disponibles.");

    await act(async () => {
      await result.current.unlockAudio();
    });
    expect(client.startAudio).toHaveBeenCalledOnce();
    expect(result.current.audioBlocked).toBe(false);

    act(() => client.emitAgentTranscript(""));
    expect(result.current.agentTranscript).toBeNull();
  });
});
