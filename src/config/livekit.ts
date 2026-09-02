export type LiveKitPrivacyConfig = {
  recordingEnabled: false;
  observabilityRecording: false;
  deepgramMipOptOut: true;
};

export function readLiveKitPrivacyConfig(environment: NodeJS.ProcessEnv = process.env): LiveKitPrivacyConfig {
  for (const name of ['LIVEKIT_RECORDING_ENABLED', 'AGENT_OBSERVABILITY_RECORDING']) {
    const value = environment[name];
    if (value !== undefined && value !== '' && !['0', '1', 'false', 'true'].includes(value)) {
      throw new Error(`${name} must be explicitly true or false.`);
    }
  }
  if (environment.LIVEKIT_RECORDING_ENABLED === '1' || environment.LIVEKIT_RECORDING_ENABLED === 'true') {
    throw new Error('LiveKit recording must remain disabled.');
  }
  if (environment.AGENT_OBSERVABILITY_RECORDING === '1' || environment.AGENT_OBSERVABILITY_RECORDING === 'true') {
    throw new Error('Agent observability recording must remain disabled.');
  }
  return { recordingEnabled: false, observabilityRecording: false, deepgramMipOptOut: true };
}
