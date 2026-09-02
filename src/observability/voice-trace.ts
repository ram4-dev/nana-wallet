import { createHash } from 'node:crypto';
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
