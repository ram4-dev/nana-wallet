export type LiveKitPrivacyConfig = {
  recordingEnabled: false;
  observabilityRecording: false;
  deepgramMipOptOut: true;
};

export function readLiveKitPrivacyConfig(environment: NodeJS.ProcessEnv = process.env): LiveKitPrivacyConfig {
  if (environment.LIVEKIT_RECORDING_ENABLED === '1' || environment.LIVEKIT_RECORDING_ENABLED === 'true') {
    throw new Error('LiveKit recording must remain disabled.');
  }
  if (environment.AGENT_OBSERVABILITY_RECORDING === '1' || environment.AGENT_OBSERVABILITY_RECORDING === 'true') {
    throw new Error('Agent observability recording must remain disabled.');
  }
  return { recordingEnabled: false, observabilityRecording: false, deepgramMipOptOut: true };
}
