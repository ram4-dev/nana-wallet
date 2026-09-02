import type { VoiceClient } from "./voice-client";

export function createRecordedVoiceClient(dependencies: {
  start: () => Promise<void>;
  stop: () => Promise<void>;
}): VoiceClient {
  return {
    connect: dependencies.start,
    setMicrophoneEnabled: async (enabled) => {
      if (enabled) await dependencies.start();
      else await dependencies.stop();
    },
    interruptAgentSpeech: dependencies.stop,
    pauseForLifecycle: dependencies.stop,
    disconnect: dependencies.stop,
  };
}
