import { useCallback, useEffect, useReducer, useRef } from "react";

import {
  avatarAction,
  reduceLiveVoice,
  type LiveVoiceEvent,
  type LiveVoiceState,
} from "./voice/live-voice-reducer";
import type { VoiceClient } from "./voice/voice-client";

export function useLiveVoiceSession(client: VoiceClient) {
  const [state, dispatch] = useReducer(
    (current: LiveVoiceState, event: LiveVoiceEvent) => reduceLiveVoice(current, event),
    { phase: "idle" },
  );
  const stateRef = useRef(state);
  stateRef.current = state;

  useEffect(
    () => () => {
      void client.disconnect();
    },
    [client],
  );

  const start = useCallback(async () => {
    dispatch({ type: "START" });
    try {
      await client.connect();
      dispatch({ type: "ROOM_CONNECTED" });
      dispatch({ type: "BINDING_ACCEPTED" });
      await client.setMicrophoneEnabled(true);
    } catch {
      dispatch({ type: "FAILED", reason: "No se pudo iniciar la voz." });
    }
  }, [client]);

  const handleAvatarPress = useCallback(async () => {
    const action = avatarAction(stateRef.current);
    if (action === "start") return start();
    if (action === "mute") {
      dispatch({ type: "AVATAR_PRESSED" });
      return client.setMicrophoneEnabled(false);
    }
    if (action === "resume") {
      dispatch({ type: "AVATAR_PRESSED" });
      return client.setMicrophoneEnabled(true);
    }
    if (action === "interrupt") {
      dispatch({ type: "AVATAR_PRESSED" });
      return client.interruptAgentSpeech();
    }
  }, [client, start]);

  const endConversation = useCallback(async () => {
    dispatch({ type: "END_CONVERSATION" });
    await client.disconnect();
  }, [client]);

  return { state, handleAvatarPress, endConversation, dispatch };
}
