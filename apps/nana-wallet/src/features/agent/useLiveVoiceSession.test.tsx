import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLiveVoiceSession } from "./useLiveVoiceSession";
import type { VoiceClient } from "./voice/voice-client";

type FakeVoiceClient = VoiceClient & {
  emitAudioPlayback: (blocked: boolean) => void;
  emitAgentTranscript: (text: string) => void;
};

function fakeClient(overrides: Partial<FakeVoiceClient> = {}): FakeVoiceClient {
  const audioListeners = new Set<(blocked: boolean) => void>();
  const transcriptListeners = new Set<(text: string) => void>();
  let audioBlocked = false;
  const client = {
    connect: vi.fn(async () => ({ conversationId: "conversation-1", revision: 2 })),
    setMicrophoneEnabled: vi.fn(async () => undefined),
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
  } as unknown as FakeVoiceClient;
  return Object.assign(client, overrides);
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

describe("useLiveVoiceSession", () => {
  afterEach(() => {
    vi.useRealTimers();
    setVisibility("visible");
  });

  it("auto-starts the session on mount when the document is visible", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useLiveVoiceSession(client));

    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));
    expect(client.connect).toHaveBeenCalledOnce();
    expect(client.setMicrophoneEnabled).toHaveBeenLastCalledWith(true);
  });

  it("does not start while the document is hidden and starts when it becomes visible while still idle", async () => {
    setVisibility("hidden");
    const client = fakeClient();
    const { result } = renderHook(() => useLiveVoiceSession(client));

    await flushAsyncWork();
    expect(client.connect).not.toHaveBeenCalled();
    expect(result.current.state).toEqual({ phase: "idle" });

    setVisibility("visible");
    act(() => document.dispatchEvent(new Event("visibilitychange")));

    await waitFor(() => expect(result.current.state).toEqual({ phase: "listening" }));
    expect(client.connect).toHaveBeenCalledOnce();
  });

  it("connects once, toggles the microphone, and interrupts speaking", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useLiveVoiceSession(client));

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
    const { result } = renderHook(() => useLiveVoiceSession(client));
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
    const { result } = renderHook(() => useLiveVoiceSession(client, { onTypedFallback }));
    await flushAsyncWork();
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
    const { result } = renderHook(() => useLiveVoiceSession(client));
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
    const { result } = renderHook(() => useLiveVoiceSession(client, { onTypedFallback }));

    await waitFor(() => expect(result.current.state.phase).toBe("failed"));
    expect(onTypedFallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "voice_unavailable" }),
    );
  });

  it("shows Nani's words in writing and unlocks playback on tap when the browser blocks audio", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useLiveVoiceSession(client));
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
