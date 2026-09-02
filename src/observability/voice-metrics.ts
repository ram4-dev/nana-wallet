export type VoicePhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'reconnecting' | 'failed';

export class VoiceMetrics {
  private readonly counters = new Map<string, number>();
  public increment(phase: VoicePhase): void { this.counters.set(phase, (this.counters.get(phase) ?? 0) + 1); }
  public snapshot(): Record<string, number> { return Object.fromEntries(this.counters); }
}
