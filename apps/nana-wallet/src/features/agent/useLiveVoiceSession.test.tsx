import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useLiveVoiceSession } from "./useLiveVoiceSession";
import type { VoiceClient } from "./voice/voice-client";

function fakeClient(overrides: Partial<VoiceClient> = {}): VoiceClient {
  return {
    connect: vi.fn(async () => ({ conversationId: "conversation-1", revision: 2 })),
    setMicrophoneEnabled: vi.fn(async () => undefined),
    interruptAgentSpeech: vi.fn(async () => undefined),
    pauseForLifecycle: vi.fn(async () => undefined),
    disconnect: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("useLiveVoiceSession", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("connects once, toggles the microphone, and interrupts speaking", async () => {
    const client = fakeClient();
    const { result } = renderHook(() => useLiveVoiceSession(client));

    await act(async () => {
      await result.current.handleAvatarPress();
    });
    expect(result.current.state).toEqual({ phase: "listening" });

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
    await act(async () => {
      await result.current.handleAvatarPress();
    });

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.state).toEqual({ phase: "paused", previousMic: "enabled" });
    expect(client.pauseForLifecycle).toHaveBeenCalledOnce();

    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
    act(() => document.dispatchEvent(new Event("visibilitychange")));
    expect(result.current.state).toEqual({ phase: "paused", previousMic: "enabled" });

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
    await act(async () => {
      await result.current.handleAvatarPress();
    });
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
    await act(async () => {
      await result.current.handleAvatarPress();
    });
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
    await act(async () => {
      await result.current.handleAvatarPress();
    });
    expect(result.current.state.phase).toBe("failed");
    expect(onTypedFallback).toHaveBeenCalledWith(
      expect.objectContaining({ code: "voice_unavailable" }),
    );
  });
});
