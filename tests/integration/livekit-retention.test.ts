import { describe, expect, it } from 'vitest';
import { readLiveKitPrivacyConfig } from '../../src/config/livekit.js';
import { readVoiceTraceConfig } from '../../src/config/privacy.js';

describe('LiveKit retention policy', () => {
  it('fails closed for application and observability recording', () => {
    expect(() => readLiveKitPrivacyConfig({ LIVEKIT_RECORDING_ENABLED: '1' })).toThrow();
    expect(() => readLiveKitPrivacyConfig({ AGENT_OBSERVABILITY_RECORDING: 'true' })).toThrow();
    expect(readLiveKitPrivacyConfig({})).toEqual({ recordingEnabled: false, observabilityRecording: false, deepgramMipOptOut: true });
  });

  it('keeps traces opt-in and bounded to seven days', () => {
    expect(readVoiceTraceConfig({})).toMatchObject({ enabled: false, retentionDays: 7 });
    expect(() => readVoiceTraceConfig({ VOICE_TRACE_RETENTION_DAYS: '8' })).toThrow();
  });
});
