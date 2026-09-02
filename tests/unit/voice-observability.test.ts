import { describe, expect, it } from 'vitest';
import { readVoiceTraceConfig } from '../../src/config/privacy.js';
import { VoiceMetrics } from '../../src/observability/voice-metrics.js';
import { VoiceTraceRecorder } from '../../src/observability/voice-trace.js';

describe('voice observability', () => {
  it('keeps metrics content-free and records phase and latency aggregates', () => {
    const metrics = new VoiceMetrics();
    metrics.increment('listening');
    metrics.increment('turns_completed');
    metrics.observe('first_audio', 120);
    expect(metrics.snapshot()).toEqual({
      counters: { phase_listening: 1, turns_completed: 1 },
      latencyMs: { first_audio: { count: 1, total: 120, max: 120 } },
    });
  });

  it('is disabled by default and rejects unapproved production traces', () => {
    expect(readVoiceTraceConfig({ NODE_ENV: 'production' })).toMatchObject({ enabled: false, retentionDays: 7 });
    expect(() => readVoiceTraceConfig({ NODE_ENV: 'production', VOICE_TRACE_ENABLED: 'true' })).toThrow('PRIVACY_APPROVED');
  });

  it('redacts before storing and expires traces after at most seven days', async () => {
    let now = 0;
    const recorder = new VoiceTraceRecorder({
      enabled: true,
      environment: 'development',
      retentionDays: 7,
      privacyApproved: false,
    }, () => now);
    await recorder.record({
      traceId: 'trace-1',
      conversationIdHash: 'conversation-1',
      roomIdHash: 'room-1',
      startedAt: new Date(0).toISOString(),
      transcript: { redactedText: 'Send 10 USDT to Ana at 0x1111111111111111111111111111111111111111', language: 'en' },
      response: { redactedText: 'Transfer ready', segments: 1 },
      toolCalls: [{ name: 'send_token', redactedInput: { amount: '10 USDT', address: '0x1111111111111111111111111111111111111111' }, outcome: 'success' }],
      timings: { sttMs: 1, turnDetectionMs: 2, agentMs: 3, firstAudioMs: 4, totalMs: 5 },
    });
    const stored = recorder.list()[0];
    expect(stored?.transcript.redactedText).not.toContain('10 USDT');
    expect(stored?.transcript.redactedText).not.toContain('0x1111');
    now = 7 * 24 * 60 * 60 * 1000;
    expect(recorder.list()).toEqual([]);
  });
});
