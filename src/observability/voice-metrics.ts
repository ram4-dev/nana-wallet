export type VoicePhase =
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'reconnecting'
  | 'failed';

export type VoiceMetricName =
  | 'turns_started'
  | 'turns_completed'
  | 'turns_failed'
  | 'reconnects'
  | 'fallbacks'
  | `phase_${VoicePhase}`;

export type VoiceRuntime = 'service-adapter' | 'native-livekit';

export type VoiceLatencyMilestone =
  | 'connection'
  | 'final_transcript'
  | 'first_token'
  | 'first_audio'
  | 'interrupt'
  | 'recovery'
  | 'total';

type LegacyVoiceLatencyName = 'stt' | 'turn_detection' | 'agent' | 'first_audio' | 'total';

export type VoiceMetricsSnapshot = {
  counters: Record<string, number>;
  latencyMs: Record<string, { count: number; total: number; max: number }>;
};

/** Content-free metrics: no user, room, transcript, address, or provider payload is accepted. */
export class VoiceMetrics {
  private readonly counters = new Map<string, number>();
  private readonly latency = new Map<string, { count: number; total: number; max: number }>();

  public increment(metric: VoiceMetricName | VoicePhase): void {
    const name = metric in this.phaseNames() ? `phase_${metric}` : metric;
    this.counters.set(name, (this.counters.get(name) ?? 0) + 1);
  }

  public observe(
    name: LegacyVoiceLatencyName | VoiceLatencyMilestone,
    durationMs: number,
    runtime?: VoiceRuntime,
  ): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const key = runtime ? `${runtime}.${name}` : name;
    const current = this.latency.get(key) ?? { count: 0, total: 0, max: 0 };
    current.count += 1;
    current.total += durationMs;
    current.max = Math.max(current.max, durationMs);
    this.latency.set(key, current);
  }

  public snapshot(): VoiceMetricsSnapshot {
    return {
      counters: Object.fromEntries(this.counters),
      latencyMs: Object.fromEntries(
        [...this.latency.entries()].map(([name, value]) => [name, { ...value }]),
      ),
    };
  }

  private phaseNames(): Record<VoicePhase, true> {
    return {
      connecting: true,
      listening: true,
      thinking: true,
      speaking: true,
      reconnecting: true,
      failed: true,
    };
  }
}

/**
 * Keeps only relative timestamps for one active room session. Calling the
 * methods below emits aggregate timings and never accepts conversation content
 * or participant identifiers.
 */
export class VoiceLatencyMilestones {
  private readonly startedAt: number;
  private finalTranscriptAt: number | undefined;
  private firstTokenRecorded = false;
  private firstAudioRecorded = false;

  public constructor(
    private readonly metrics: VoiceMetrics,
    private readonly runtime: VoiceRuntime,
    private readonly now: () => number = Date.now,
  ) {
    this.startedAt = now();
  }

  public connected(): void {
    this.metrics.observe('connection', this.elapsed(this.startedAt), this.runtime);
  }

  public finalTranscript(): void {
    this.finalTranscriptAt = this.now();
    this.firstTokenRecorded = false;
    this.firstAudioRecorded = false;
    this.metrics.increment('turns_started');
    this.metrics.observe('final_transcript', this.elapsed(this.startedAt), this.runtime);
  }

  public firstToken(): void {
    if (!this.finalTranscriptAt || this.firstTokenRecorded) return;
    this.firstTokenRecorded = true;
    this.metrics.observe('first_token', this.elapsed(this.finalTranscriptAt), this.runtime);
  }

  public firstTokenDuration(durationMs: number): void {
    if (this.firstTokenRecorded) return;
    this.firstTokenRecorded = true;
    this.metrics.observe('first_token', durationMs, this.runtime);
  }

  public firstAudio(): void {
    if (!this.finalTranscriptAt || this.firstAudioRecorded) return;
    this.firstAudioRecorded = true;
    this.metrics.observe('first_audio', this.elapsed(this.finalTranscriptAt), this.runtime);
  }

  public firstAudioDuration(durationMs: number): void {
    if (this.firstAudioRecorded) return;
    this.firstAudioRecorded = true;
    this.metrics.observe('first_audio', durationMs, this.runtime);
  }

  public interrupted(startedAt: number): void {
    this.metrics.increment('turns_failed');
    this.metrics.observe('interrupt', this.elapsed(startedAt), this.runtime);
  }

  public recovered(startedAt: number): void {
    this.metrics.increment('reconnects');
    this.metrics.observe('recovery', this.elapsed(startedAt), this.runtime);
  }

  public completed(): void {
    if (!this.finalTranscriptAt) return;
    this.metrics.increment('turns_completed');
    this.metrics.observe('total', this.elapsed(this.finalTranscriptAt), this.runtime);
  }

  private elapsed(startedAt: number): number {
    return Math.max(0, this.now() - startedAt);
  }
}
