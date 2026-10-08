import { useCallback, useEffect, useReducer, useRef, useState } from "react";

import {
  avatarAction,
  reduceLiveVoice,
  type LiveVoiceEvent,
  type LiveVoiceState,
  type VoiceFailure,
} from "./voice/live-voice-reducer";
import type { VoiceClient } from "./voice/voice-client";

type LiveVoiceOptions = {
  onConversationBound?: (conversationId: string) => void;
  onTypedFallback?: (reason: VoiceFailure) => void;
};

export function useLiveVoiceSession(client: VoiceClient, options: LiveVoiceOptions = {}) {
  const [state, dispatch] = useReducer(
    (current: LiveVoiceState, event: LiveVoiceEvent) => reduceLiveVoice(current, event),
    { phase: "idle" },
  );
  // Playback permission and what Nani already said live outside the session
  // phase: a blocked browser keeps the session live and visible.
  const [audioBlocked, setAudioBlocked] = useState(false);
  const [agentTranscript, setAgentTranscript] = useState<string | null>(null);
  const stateRef = useRef(state);
  const previousStateRef = useRef(state);
  const fallbackNotifiedRef = useRef(false);
  stateRef.current = state;

  useEffect(() => {
    const stopWatchingAudio = client.watchAudioPlayback(setAudioBlocked);
    const stopWatchingTranscript = client.watchAgentTranscript((text) => {
      setAgentTranscript(text.trim() ? text : null);
    });
    return () => {
      stopWatchingAudio();
      stopWatchingTranscript();
    };
  }, [client]);

  const notifyTypedFallback = useCallback(
    (reason: VoiceFailure) => {
      if (fallbackNotifiedRef.current) return;
      fallbackNotifiedRef.current = true;
      options.onTypedFallback?.(reason);
    },
    [options],
  );

  useEffect(() => {
    const previous = previousStateRef.current;
    previousStateRef.current = state;
    if (
      previous.phase === "reconnecting" &&
      (state.phase === "listening" || state.phase === "muted")
    ) {
      void client.setMicrophoneEnabled(state.phase === "listening").catch(() => {
        const reason: VoiceFailure = {
          code: "connection_lost",
          message: "No pudimos recuperar el micrófono. Podés seguir escribiéndome.",
        };
        dispatch({ type: "FAILED", reason });
        notifyTypedFallback(reason);
        void client.disconnect();
      });
    }
  }, [client, notifyTypedFallback, state]);

  useEffect(() => {
    if (state.phase !== "reconnecting") return;
    const remaining = Math.max(0, state.deadlineAt - Date.now());
    const timer = window.setTimeout(() => {
      if (stateRef.current.phase !== "reconnecting") return;
      const reason: VoiceFailure = {
        code: "recovery_expired",
        message: "La voz se desconectó. Podés seguir escribiéndome.",
      };
      dispatch({ type: "RECOVERY_EXPIRED" });
      notifyTypedFallback(reason);
      void client.disconnect();
    }, remaining);
    return () => window.clearTimeout(timer);
  }, [client, notifyTypedFallback, state]);

  useEffect(() => {
    const pause = () => {
      const current = stateRef.current;
      if (
        ["listening", "muted", "thinking", "speaking", "request_waiting"].includes(current.phase)
      ) {
        dispatch({ type: "LIFECYCLE_PAUSED" });
        void client.pauseForLifecycle();
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "hidden") pause();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("pagehide", pause);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("pagehide", pause);
    };
  }, [client]);

  useEffect(
    () => () => {
      void client.disconnect();
    },
    [client],
  );

  const start = useCallback(async () => {
    if (stateRef.current.phase !== "idle" && stateRef.current.phase !== "failed") return;
    fallbackNotifiedRef.current = false;
    dispatch({ type: "START" });
    try {
      const connection = await client.connect();
      if (connection.conversationId) options.onConversationBound?.(connection.conversationId);
      dispatch({ type: "ROOM_CONNECTED" });
      dispatch({ type: "BINDING_ACCEPTED" });
      await client.setMicrophoneEnabled(true);
    } catch (error) {
      console.error("Live voice start failed", error);
      await client.disconnect().catch(() => undefined);
      const detail = error instanceof Error ? error.message : "";
      const reason: VoiceFailure = {
        code: "voice_unavailable",
        message:
          detail === "microphone_permission_denied"
            ? "Necesito permiso para usar el micrófono. Habilitalo en el navegador y probá de nuevo."
            : detail === "microphone_not_found"
              ? "No encontré un micrófono disponible. Revisá el dispositivo y probá de nuevo."
              : detail === "microphone_in_use"
                ? "Otra aplicación está usando el micrófono. Cerrala y probá de nuevo."
                : "La voz no está disponible. Podés seguir escribiéndome.",
      };
      dispatch({ type: "FAILED", reason });
      notifyTypedFallback(reason);
    }
  }, [client, notifyTypedFallback, options]);

  const handleAvatarPress = useCallback(async () => {
    const action = avatarAction(stateRef.current);
    if (action === "start") return start();
    try {
      if (action === "mute") {
        dispatch({ type: "AVATAR_PRESSED" });
        return await client.setMicrophoneEnabled(false);
      }
      if (action === "resume") {
        dispatch({ type: "AVATAR_PRESSED" });
        return await client.setMicrophoneEnabled(true);
      }
      if (action === "interrupt") {
        dispatch({ type: "AVATAR_PRESSED" });
        return await client.interruptAgentSpeech();
      }
    } catch {
      const reason: VoiceFailure = {
        code: "connection_lost",
        message: "No pudimos controlar el micrófono. Podés seguir escribiéndome.",
      };
      dispatch({ type: "FAILED", reason });
      notifyTypedFallback(reason);
      await client.disconnect().catch(() => undefined);
    }
  }, [client, notifyTypedFallback, start]);

  const endConversation = useCallback(async () => {
    try {
      await client.disconnect();
    } finally {
      dispatch({ type: "END_CONVERSATION" });
    }
  }, [client]);

  const unlockAudio = useCallback(async () => {
    try {
      await client.startAudio();
    } catch {
      // A rejected unlock leaves the written opening turn and its control on
      // screen instead of failing silently.
    }
    setAudioBlocked(!client.canPlaybackAudio());
  }, [client]);

  // Opening the app must greet the user before any tap. The session starts on
  // mount when the document is visible, and again when the page returns to the
  // foreground while still idle. A session the lifecycle paused keeps waiting
  // for an explicit tap, so auto-start never fights pause/resume/reconnect.
  const startRef = useRef(start);
  startRef.current = start;
  useEffect(() => {
    const autoStartIfIdle = () => {
      if (document.visibilityState !== "visible") return;
      if (stateRef.current.phase !== "idle") return;
      void startRef.current();
    };
    autoStartIfIdle();
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") autoStartIfIdle();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, []);

  return {
    state,
    handleAvatarPress,
    endConversation,
    dispatch,
    audioBlocked,
    agentTranscript,
    unlockAudio,
  };
}
