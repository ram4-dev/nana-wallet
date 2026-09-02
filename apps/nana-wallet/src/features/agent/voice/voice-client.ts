export type VoiceClientState =
  "idle" | "connecting" | "listening" | "muted" | "speaking" | "reconnecting" | "failed";

export type VoiceClient = {
  connect(): Promise<void>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  interruptAgentSpeech(): Promise<void>;
  pauseForLifecycle(): Promise<void>;
  disconnect(): Promise<void>;
};
