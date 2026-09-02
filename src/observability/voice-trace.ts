import { createHash } from 'node:crypto';
import { readVoiceTraceConfig, type VoiceTraceConfig } from '../config/privacy.js';
import { redactText, redactValue } from './redaction.js';

export type VoiceTurnTrace = {
  traceId: string;
  conversationIdHash: string;
  roomIdHash: string;
  startedAt: string;
  transcript: { redactedText: string; language: 'es' | 'en' };
  response: { redactedText: string; segments: number };
  toolCalls: Array<{ name: string; redactedInput: unknown; outcome: 'success' | 'failure' | 'uncertain' }>;
  timings: { sttMs: number; turnDetectionMs: number; agentMs: number; firstAudioMs: number; totalMs: number };
  errorCode?: string;
};

export function hashTraceIdentity(value: string): string { return createHash('sha256').update(value).digest('hex'); }

export function redactVoiceTrace(trace: VoiceTurnTrace): VoiceTurnTrace {
  return {
    ...trace,
    conversationIdHash: hashTraceIdentity(trace.conversationIdHash),
    roomIdHash: hashTraceIdentity(trace.roomIdHash),
    transcript: { ...trace.transcript, redactedText: redactText(trace.transcript.redactedText) },
    response: { ...trace.response, redactedText: redactText(trace.response.redactedText) },
    toolCalls: trace.toolCalls.map((call) => ({ ...call, redactedInput: redactValue(call.redactedInput) })),
  };
}

export type VoiceTraceSink = (trace: VoiceTurnTrace) => void | Promise<void>;

/**
 * Development diagnostics are opt-in and held in a bounded, expiring buffer.
 * The recorder receives already structured data, redacts it before storage, and
 * never exposes audio or raw provider responses.
 */
export class VoiceTraceRecorder {
  private readonly traces = new Map<string, VoiceTurnTrace & { expiresAt: number }>();
  private readonly config: VoiceTraceConfig;

  public constructor(
    config: VoiceTraceConfig = readVoiceTraceConfig(),
    private readonly now: () => number = Date.now,
    private readonly sink?: VoiceTraceSink,
  ) {
    this.config = config;
  }

  public get enabled(): boolean { return this.config.enabled; }
  public get retentionDays(): number { return this.config.retentionDays; }

  public async record(trace: VoiceTurnTrace): Promise<void> {
    if (!this.config.enabled) return;
    this.purge();
    const redacted = redactVoiceTrace(trace);
    const expiresAt = this.now() + this.config.retentionDays * 24 * 60 * 60 * 1000;
    this.traces.set(redacted.traceId, { ...redacted, expiresAt });
    await this.sink?.(redacted);
  }

  public list(): VoiceTurnTrace[] {
    this.purge();
    return [...this.traces.values()].map(({ expiresAt: _expiresAt, ...trace }) => trace);
  }

  public purge(): void {
    const now = this.now();
    for (const [traceId, trace] of this.traces) {
      if (trace.expiresAt <= now) this.traces.delete(traceId);
    }
  }

  public clear(): void { this.traces.clear(); }
}
