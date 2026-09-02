import { describe, expect, it } from 'vitest';
import { readLiveKitPrivacyConfig } from '../../src/config/livekit.js';

describe('LiveKit privacy configuration', () => {
  it('fails closed when recording is enabled', () => {
    expect(() => readLiveKitPrivacyConfig({ LIVEKIT_RECORDING_ENABLED: 'true' })).toThrow('recording');
    expect(() => readLiveKitPrivacyConfig({ AGENT_OBSERVABILITY_RECORDING: '1' })).toThrow('recording');
  });

  it('defaults to no recording and provider improvement opt-out', () => {
    expect(readLiveKitPrivacyConfig({})).toEqual({ recordingEnabled: false, observabilityRecording: false, deepgramMipOptOut: true });
  });
});
