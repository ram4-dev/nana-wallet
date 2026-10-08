export type VoiceClientState =
  "idle" | "connecting" | "listening" | "muted" | "speaking" | "reconnecting" | "failed";

export type VoiceClient = {
  connect(): Promise<{ conversationId?: string; revision?: number }>;
  setMicrophoneEnabled(enabled: boolean): Promise<void>;
  interruptAgentSpeech(): Promise<void>;
  pauseForLifecycle(): Promise<void>;
  disconnect(): Promise<void>;
  /**
   * Whether the browser is currently allowed to play remote audio. It is false
   * while the autoplay policy holds the agent's voice.
   */
  canPlaybackAudio(): boolean;
  /** Resumes audio playback; browsers require a user gesture for it. */
  startAudio(): Promise<void>;
  /**
   * Subscribes to every change of the playback permission and reports the
   * current value right away. Returns the unsubscribe function.
   */
  watchAudioPlayback(listener: (blocked: boolean) => void): () => void;
  /**
   * Subscribes to the agent's utterances as they are transcribed, already
   * joined in order. Returns the unsubscribe function.
   */
  watchAgentTranscript(listener: (text: string) => void): () => void;
};
