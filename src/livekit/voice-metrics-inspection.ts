import type { VoiceMetrics } from "../observability/voice-metrics.js";

export function createVoiceMetricsInspectionHandler(input: {
  enabled: boolean;
  participantIdentity: string;
  metrics: VoiceMetrics;
}):
  | ((data: { callerIdentity: string }) => Promise<string>)
  | undefined {
  if (!input.enabled) return undefined;
  return async (data) => {
    if (data.callerIdentity !== input.participantIdentity) {
      return JSON.stringify({ ok: false, code: "conversation_forbidden" });
    }
    return JSON.stringify({ ok: true, metrics: input.metrics.snapshot() });
  };
}
