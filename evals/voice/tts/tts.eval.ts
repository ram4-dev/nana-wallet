/**
 * TTS eval: synthesizes typical Nana responses and verifies the audio carries
 * the right content.
 *
 * Layers (per design):
 * - Smoke (deterministic, offline): sample set is well-formed; the round-trip
 *   comparison machinery (WER on normalized text) behaves correctly.
 * - Real (gated, needs keys): text -> provider TTS -> audio -> STT round-trip
 *   -> WER against the original text. Provider via EVAL_TTS_PROVIDER
 *   (elevenlabs default | openai-tts); STT provider via EVAL_STT_PROVIDER.
 */
import 'dotenv/config';
import { evalite } from 'evalite';
import { ttsSamples } from './samples.js';
import { resolveTtsProvider, synthesizeSpeech } from './providers.js';
import { resolveSttProvider, transcribeAudio } from '../stt/providers.js';
import { wer } from '../stt/wer.js';

const resolvedTts = resolveTtsProvider();
const resolvedStt = resolveSttProvider();

const REAL_SKIP_REASON =
  process.env.EVAL_REAL !== '1'
    ? 'real mode off (set EVAL_REAL=1)'
    : 'error' in resolvedTts
      ? resolvedTts.error
      : 'error' in resolvedStt
        ? resolvedStt.error
        : null;

// ---------------------------------------------------------------------------
// Offline: smoke + machinery
// ---------------------------------------------------------------------------

evalite('TTS: harness offline (samples + round-trip machinery)', {
  data: [{ input: 'static' }],
  task: async () => {
    const allWellFormed = ttsSamples.every(
      (s) => s.text.length > 10 && s.expectedMinSeconds > 0,
    );
    const original = 'Tenés 42,5 USDT disponibles.';
    const roundTripOk = wer(original, original) === 0;
    const mangled = wer(original, 'Tenés 42,5 USDT disponibles en tu cuenta.');
    return { allWellFormed, roundTripOk, mangled, sampleCount: ttsSamples.length };
  },
  scorers: [
    {
      name: 'harness_valid',
      scorer: ({ output }) => {
        const o = output as {
          allWellFormed: boolean;
          roundTripOk: boolean;
          mangled: number;
          sampleCount: number;
        };
        return {
          score:
            o.allWellFormed && o.roundTripOk && o.mangled > 0 && o.sampleCount >= 5
              ? 1
              : 0,
        };
      },
    },
  ],
  // Evalite's detailed table requires a consistent column count across all
  // evals in a file; the round-trip eval below defines 3 custom columns.
  columns: () => [
    { label: 'Chequeo', value: 'samples + wer' },
    { label: 'WER', value: '—' },
    { label: 'TTS ms', value: '—' },
  ],
});

// ---------------------------------------------------------------------------
// Real: round-trip per sample
// ---------------------------------------------------------------------------

const run = REAL_SKIP_REASON ? evalite.skip : evalite;

run(`TTS: round-trip (EVAL_TTS_PROVIDER=${process.env.EVAL_TTS_PROVIDER ?? 'elevenlabs'})`, {
  data: ttsSamples.map((s) => ({ input: { name: s.name, text: s.text } })),
  task: async (input: { name: string; text: string }) => {
    if ('error' in resolvedTts) throw new Error(resolvedTts.error);
    if ('error' in resolvedStt) throw new Error(resolvedStt.error);

    const ttsStartedAt = Date.now();
    const audio = await synthesizeSpeech(
      resolvedTts.provider.id,
      resolvedTts.apiKey,
      input.text,
    );
    const ttsLatencyMs = Date.now() - ttsStartedAt;

    if (audio.length === 0) throw new Error('TTS produced empty audio');

    // Duration smoke check: mp3 at typical bitrate (~48kbps) should last at
    // least expectedMinSeconds → 6KB/s is a conservative floor.
    const approxSeconds = audio.length / 6000;
    if (approxSeconds < 1) throw new Error('TTS audio suspiciously short');

    const sttStartedAt = Date.now();
    const roundTripTranscript = await transcribeAudio(
      resolvedStt.provider,
      resolvedStt.apiKey,
      audio,
      'audio/wav',
    );
    const sttLatencyMs = Date.now() - sttStartedAt;

    return {
      name: input.name,
      original: input.text,
      roundTripTranscript,
      wer: wer(input.text, roundTripTranscript),
      audioBytes: audio.length,
      approxSeconds,
      ttsLatencyMs,
      sttLatencyMs,
      ttsProvider: resolvedTts.provider.id,
      sttProvider: resolvedStt.provider.id,
    };
  },
  scorers: [
    {
      name: 'round_trip_accuracy',
      scorer: ({ output }) => ({
        score: Math.max(0, 1 - (output as { wer: number }).wer),
        metadata: {
          wer: (output as { wer: number }).wer,
          transcript: (output as { roundTripTranscript: string }).roundTripTranscript,
          ttsLatencyMs: (output as { ttsLatencyMs: number }).ttsLatencyMs,
        },
      }),
    },
  ],
  columns: ({ output }) => {
    const o = output as {
      wer?: number;
      ttsLatencyMs?: number;
      roundTripTranscript?: string;
    };
    return [
      { label: 'WER', value: o.wer == null ? '—' : `${(o.wer * 100).toFixed(1)}%` },
      { label: 'TTS ms', value: o.ttsLatencyMs == null ? '—' : String(o.ttsLatencyMs) },
      { label: 'Transcript', value: (o.roundTripTranscript ?? '—').replace(/\s+/gu, ' ').slice(0, 60) },
    ];
  },
});

if (REAL_SKIP_REASON) {
  console.warn(`[tts eval] SKIP real round-trip: ${REAL_SKIP_REASON}`);
}