export type LiveKitAgentState =
  | "connecting"
  | "initializing"
  | "idle"
  | "listening"
  | "thinking"
  | "speaking"
  | "disconnected"
  | "failed";

export type VoiceFailure = {
  code: "voice_unavailable" | "binding_failed" | "connection_lost" | "recovery_expired" | "unknown";
  message: string;
};

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
  | { phase: "failed"; reason: VoiceFailure };

export type LiveVoiceEvent =
  | { type: "START" }
  | { type: "ROOM_CONNECTED" }
  | { type: "BINDING_ACCEPTED" }
  | { type: "AGENT_STATE"; state: LiveKitAgentState }
  | { type: "AVATAR_PRESSED" }
  | { type: "CONNECTION_LOST"; now: number; recoveryMs?: number }
  | { type: "RECONNECTED" }
  | { type: "RECOVERY_EXPIRED" }
  | { type: "LIFECYCLE_PAUSED" }
  | { type: "END_CONVERSATION" }
  | { type: "FAILED"; reason: VoiceFailure };

export type AvatarAction = "start" | "mute" | "resume" | "interrupt" | "none";

export type LiveVoiceCommand =
  | { type: "enable_microphone" }
  | { type: "disable_microphone" }
  | { type: "interrupt_agent" }
  | { type: "disconnect" }
  | { type: "start_recovery_deadline"; deadlineAt: number };

export function avatarAction(state: LiveVoiceState): AvatarAction {
  switch (state.phase) {
    case "idle":
    case "failed":
      return "start";
    case "listening":
      return "mute";
    case "muted":
    case "paused":
      return "resume";
    case "speaking":
      return "interrupt";
    default:
      return "none";
  }
}

function micPreference(state: LiveVoiceState): "enabled" | "muted" {
  if (state.phase === "muted") return "muted";
  if (state.phase === "paused" || state.phase === "reconnecting") return state.previousMic;
  return "enabled";
}

function isConnectedPhase(state: LiveVoiceState): boolean {
  return ["listening", "muted", "thinking", "speaking", "request_waiting"].includes(state.phase);
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
      if (state.phase === "idle" || state.phase === "failed") return state;
      if (event.state === "failed") {
        return {
          phase: "failed",
          reason: { code: "unknown", message: "La voz de Nani no está disponible." },
        };
      }
      if (event.state === "disconnected" || !isConnectedPhase(state)) return state;
      if (event.state === "speaking") return { phase: "speaking" };
      if (event.state === "thinking" || event.state === "initializing")
        return { phase: "thinking" };
      if (event.state === "listening" || event.state === "idle") {
        return state.phase === "muted" ? state : { phase: "listening" };
      }
      return state;
    case "AVATAR_PRESSED":
      if (state.phase === "listening") return { phase: "muted" };
      if (state.phase === "muted" || state.phase === "paused") return { phase: "listening" };
      if (state.phase === "speaking") return { phase: "listening" };
      return state;
    case "CONNECTION_LOST":
      if (!isConnectedPhase(state)) return state;
      return {
        phase: "reconnecting",
        previousMic: micPreference(state),
        deadlineAt: event.now + (event.recoveryMs ?? 10_000),
      };
    case "RECONNECTED":
      if (state.phase !== "reconnecting") return state;
      return state.previousMic === "muted" ? { phase: "muted" } : { phase: "listening" };
    case "RECOVERY_EXPIRED":
      return state.phase === "reconnecting"
        ? {
            phase: "failed",
            reason: {
              code: "recovery_expired",
              message: "La voz se desconectó. Podés seguir escribiéndome.",
            },
          }
        : state;
    case "LIFECYCLE_PAUSED":
      if (!isConnectedPhase(state)) return state;
      return { phase: "paused", previousMic: micPreference(state) };
    case "END_CONVERSATION":
      return { phase: "idle" };
    case "FAILED":
      return { phase: "failed", reason: event.reason };
  }
}

export function commandsForLiveVoiceEvent(
  previous: LiveVoiceState,
  next: LiveVoiceState,
  event: LiveVoiceEvent,
): LiveVoiceCommand[] {
  if (event.type === "AVATAR_PRESSED" && previous.phase === "listening" && next.phase === "muted") {
    return [{ type: "disable_microphone" }];
  }
  if (
    event.type === "AVATAR_PRESSED" &&
    (previous.phase === "muted" || previous.phase === "paused") &&
    next.phase === "listening"
  ) {
    return [{ type: "enable_microphone" }];
  }
  if (
    event.type === "AVATAR_PRESSED" &&
    previous.phase === "speaking" &&
    next.phase === "listening"
  ) {
    return [{ type: "interrupt_agent" }, { type: "enable_microphone" }];
  }
  if (event.type === "CONNECTION_LOST" && next.phase === "reconnecting") {
    return [
      { type: "disable_microphone" },
      { type: "start_recovery_deadline", deadlineAt: next.deadlineAt },
    ];
  }
  if (event.type === "END_CONVERSATION" && next.phase === "idle") return [{ type: "disconnect" }];
  return [];
}
