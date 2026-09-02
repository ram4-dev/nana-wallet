import type { VoiceClient } from "./voice-client";

export function createLiveKitWebClient(dependencies: {
  connect: () => Promise<void>;
  setMicrophoneEnabled: (enabled: boolean) => Promise<void>;
  interrupt: () => Promise<void>;
  disconnect: () => Promise<void>;
}): VoiceClient {
  return {
    connect: dependencies.connect,
    setMicrophoneEnabled: dependencies.setMicrophoneEnabled,
    interruptAgentSpeech: dependencies.interrupt,
    pauseForLifecycle: () => dependencies.setMicrophoneEnabled(false),
    disconnect: dependencies.disconnect,
  };
}
