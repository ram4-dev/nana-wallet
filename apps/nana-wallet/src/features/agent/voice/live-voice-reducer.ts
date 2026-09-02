export type LiveVoiceState =
  | { phase: "idle" }
  | { phase: "connecting" }
  | { phase: "binding" }
  | { phase: "listening" }
  | { phase: "muted" }
  | { phase: "thinking" }
  | { phase: "speaking" }
  | { phase: "request_waiting" }
  | { phase: "reconnecting"; previousMic: "enabled" | "muted"; deadlineAt: number }
  | { phase: "paused"; previousMic: "enabled" | "muted" }
  | { phase: "failed"; reason: string };

export type LiveVoiceEvent =
  | { type: "START" }
  | { type: "ROOM_CONNECTED" }
  | { type: "BINDING_ACCEPTED" }
  | {
      type: "AGENT_STATE";
      state:
        | "connecting"
        | "initializing"
        | "idle"
        | "listening"
        | "thinking"
        | "speaking"
        | "disconnected"
        | "failed";
    }
  | { type: "AVATAR_PRESSED" }
  | { type: "CONNECTION_LOST"; now: number; recoveryMs?: number }
  | { type: "RECONNECTED" }
  | { type: "RECOVERY_EXPIRED" }
  | { type: "LIFECYCLE_PAUSED" }
  | { type: "END_CONVERSATION" }
  | { type: "FAILED"; reason: string };

export function avatarAction(
  state: LiveVoiceState,
): "start" | "mute" | "resume" | "interrupt" | "none" {
  if (state.phase === "idle" || state.phase === "failed") return "start";
  if (state.phase === "listening") return "mute";
  if (state.phase === "muted" || state.phase === "paused") return "resume";
  if (state.phase === "speaking") return "interrupt";
  return "none";
}

function micPreference(state: LiveVoiceState): "enabled" | "muted" {
  if (
    state.phase === "muted" ||
    state.phase === "paused" ||
    (state.phase === "reconnecting" && state.previousMic === "muted")
  )
    return "muted";
  return "enabled";
}

export function reduceLiveVoice(state: LiveVoiceState, event: LiveVoiceEvent): LiveVoiceState {
  switch (event.type) {
    case "START":
      return state.phase === "idle" || state.phase === "failed" ? { phase: "connecting" } : state;
    case "ROOM_CONNECTED":
      return state.phase === "connecting" ? { phase: "binding" } : state;
    case "BINDING_ACCEPTED":
      return state.phase === "binding" ? { phase: "listening" } : state;
    case "AGENT_STATE":
      if (event.state === "listening") return { phase: "listening" };
      if (event.state === "thinking" || event.state === "initializing")
        return { phase: "thinking" };
      if (event.state === "speaking") return { phase: "speaking" };
      if (event.state === "failed") return { phase: "failed", reason: "Live voice failed." };
      return state;
    case "AVATAR_PRESSED":
      if (state.phase === "listening") return { phase: "muted" };
      if (state.phase === "muted") return { phase: "listening" };
      if (state.phase === "speaking") return { phase: "listening" };
      if (state.phase === "paused") return { phase: "listening" };
      return state;
    case "CONNECTION_LOST":
      return {
        phase: "reconnecting",
        previousMic: micPreference(state),
        deadlineAt: event.now + (event.recoveryMs ?? 10_000),
      };
    case "RECONNECTED":
      return state.phase === "reconnecting"
        ? state.previousMic === "muted"
          ? { phase: "muted" }
          : { phase: "listening" }
        : state;
    case "RECOVERY_EXPIRED":
      return state.phase === "reconnecting"
        ? { phase: "failed", reason: "Live voice disconnected." }
        : state;
    case "LIFECYCLE_PAUSED":
      return state.phase === "listening" || state.phase === "muted" || state.phase === "speaking"
        ? { phase: "paused", previousMic: micPreference(state) }
        : state;
    case "END_CONVERSATION":
      return { phase: "idle" };
    case "FAILED":
      return { phase: "failed", reason: event.reason };
    default:
      return state;
  }
}
