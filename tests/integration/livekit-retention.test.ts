import { describe, expect, it } from 'vitest';
import { readLiveKitPrivacyConfig } from '../../src/config/livekit.js';
import { readVoiceProviderConfig, readVoiceTraceConfig } from '../../src/config/privacy.js';

describe('LiveKit retention policy', () => {
  it('fails closed for application and observability recording', () => {
    expect(() => readLiveKitPrivacyConfig({ LIVEKIT_RECORDING_ENABLED: '1' })).toThrow();
    expect(() => readLiveKitPrivacyConfig({ AGENT_OBSERVABILITY_RECORDING: 'true' })).toThrow();
    expect(readLiveKitPrivacyConfig({})).toEqual({ recordingEnabled: false, observabilityRecording: false, deepgramMipOptOut: true });
  });

  it('keeps traces opt-in, bounded to seven days, and provider logging honest', () => {
    expect(readVoiceTraceConfig({})).toMatchObject({ enabled: false, retentionDays: 7 });
    expect(() => readVoiceTraceConfig({ VOICE_TRACE_RETENTION_DAYS: '8' })).toThrow();
    expect(readVoiceProviderConfig({})).toEqual({ elevenLabsZeroRetentionVerified: false, elevenLabsEnableLogging: true });
    expect(readVoiceProviderConfig({ ELEVENLABS_ZERO_RETENTION_VERIFIED: 'true' })).toEqual({ elevenLabsZeroRetentionVerified: true, elevenLabsEnableLogging: false });
  });
});
