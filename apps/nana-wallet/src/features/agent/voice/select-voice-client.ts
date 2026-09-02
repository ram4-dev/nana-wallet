import type { VoiceClient } from "./voice-client";

export function selectVoiceClient(input: {
  isNative: boolean;
  live: VoiceClient;
  recorded: VoiceClient;
}): VoiceClient {
  return input.isNative ? input.recorded : input.live;
}
