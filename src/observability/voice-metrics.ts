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

  public observe(name: 'stt' | 'turn_detection' | 'agent' | 'first_audio' | 'total', durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const current = this.latency.get(name) ?? { count: 0, total: 0, max: 0 };
    current.count += 1;
    current.total += durationMs;
    current.max = Math.max(current.max, durationMs);
    this.latency.set(name, current);
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
