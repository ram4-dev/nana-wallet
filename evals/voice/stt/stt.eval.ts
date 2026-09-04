/**
 * STT eval: transcribes the FLEURS es_419 clips and scores WER against the
 * reference transcripts.
 *
 * - Offline-safe: with no API key, the eval is skipped (evalite.skip).
 * - Provider selection: EVAL_STT_PROVIDER=nan|openai-transcribe|openai-realtime-whisper
 *   (default: nan, the current Nana pipeline).
 * - Dataset: run `npm run eval:voice:dataset` first (see download-dataset.ts).
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalite } from 'evalite';
import { wer } from './wer.js';
import { resolveSttProvider, transcribeAudioWithCause } from './providers.js';

const AUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.audio');

type Manifest = {
  clips: Array<{ file: string; transcription: string; rawTranscription: string }>;
  clipCount: number;
};

async function loadManifest(): Promise<Manifest | null> {
  try {
    const raw = await readFile(join(AUDIO_DIR, 'manifest.json'), 'utf8');
    return JSON.parse(raw) as Manifest;
  } catch {
    return null;
  }
}

const manifest = await loadManifest();
const resolved = resolveSttProvider();

const SKIP_REASON =
  process.env.EVAL_REAL !== '1'
    ? 'real mode off (set EVAL_REAL=1)'
    : !manifest
      ? 'dataset missing — run `npm run eval:voice:dataset`'
      : 'error' in resolved
        ? resolved.error
        : null;

const run = SKIP_REASON ? evalite.skip : evalite;

// Serialize STT calls: 30 concurrent multipart uploads exhaust sockets and
// trip provider rate limits (observed: 'fetch failed' under parallelism).
let last: Promise<unknown> = Promise.resolve();
function enqueueSequential<T>(fn: () => Promise<T>): Promise<T> {
  const next = last.then(fn, fn);
  last = next.catch(() => undefined);
  return next;
}

run(`STT: WER (${manifest ? manifest.clipCount : 0} clips FLEURS es_419)`, {
  data: manifest
    ? manifest.clips.map((clip) => ({
        input: { file: clip.file, expected: clip.transcription },
      }))
    : [],
  task: async (input: { file: string; expected: string }) => {
    if ('error' in resolved) throw new Error(resolved.error);
    return enqueueSequential(async () => {
      const audio = await readFile(join(AUDIO_DIR, input.file));
      const startedAt = Date.now();
      const transcript = await transcribeAudioWithCause(resolved.provider, resolved.apiKey, audio);
      return {
        file: input.file,
        transcript,
        expected: input.expected,
        wer: wer(input.expected, transcript),
        provider: resolved.provider.id,
        latencyMs: Date.now() - startedAt,
      };
    });
  },
  scorers: [
    {
      // Evalite optimizes for higher = better; WER is error rate, so the
      // headline score is accuracy (1 - WER) and the raw WER is metadata.
      name: 'accuracy_1_minus_wer',
      scorer: ({ output }) => ({
        score: Math.max(0, 1 - (output as { wer: number }).wer),
        metadata: {
          wer: (output as { wer: number }).wer,
          transcript: (output as { transcript: string }).transcript,
          latencyMs: (output as { latencyMs: number }).latencyMs,
        },
      }),
    },
  ],
  columns: ({ output }) => {
    const o = output as { wer?: number; latencyMs?: number; transcript?: string };
    return [
      { label: 'WER', value: o.wer == null ? '—' : `${(o.wer * 100).toFixed(1)}%` },
      { label: 'Latencia', value: o.latencyMs == null ? '—' : `${o.latencyMs}ms` },
    ];
  },
});

if (SKIP_REASON) {
  console.warn(`[stt eval] SKIP: ${SKIP_REASON}`);
}