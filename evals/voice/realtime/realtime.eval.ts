/**
 * Realtime E2E eval: feeds FLEURS clips as user audio to gpt-realtime-2.1-mini
 * and measures whether the model produces a sensible Spanish voice response.
 *
 * - Offline: WAV/PCM extraction + message construction (no network).
 * - Real (EVAL_REAL=1): one realtime session per clip over the first 5 clips.
 *   Scorers: response produced, transcript non-empty, latency marks.
 *   The response transcript is NOT judged by the conversational rubric here —
 *   the clip content is read-aloud text, not a user request to Nana; this eval
 *   measures pipeline success (hears → answers in voice), i.e. smoke E2E.
 */
import 'dotenv/config';
import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evalite } from 'evalite';
import { extractPcm16, runRealtimeTurn } from './session.js';

const AUDIO_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.audio');

// ---------------------------------------------------------------------------
// Offline: machinery
// ---------------------------------------------------------------------------

evalite('Realtime: harness offline (WAV extraction + message shape)', {
  data: [{ input: 'static' }],
  task: async () => {
    // Synthetic minimal PCM16 WAV @ 16kHz: header + 100 samples.
    const sampleRate = 16000;
    const samples = new Int16Array([0, 100, -100, 500, -500, 1000, -1000, 42]);
    const dataSize = samples.length * 2;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20); // PCM
    header.writeUInt16LE(1, 22); // mono
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataSize, 40);
    const wav = Buffer.concat([header, Buffer.from(samples.buffer)]);

    const { pcm, sampleRate: rate } = extractPcm16(wav);
    const base64Ok = pcm.toString('base64').length > 0;
    return {
      rate,
      pcmBytes: pcm.length,
      base64Ok,
      pcmMatches: pcm.readInt16LE(0) === 0 && pcm.readInt16LE(14) === 42,
    };
  },
  scorers: [
    {
      name: 'harness_valid',
      scorer: ({ output }) => {
        const o = output as {
          rate: number;
          pcmBytes: number;
          base64Ok: boolean;
          pcmMatches: boolean;
        };
        return {
          score:
            o.rate === 16000 && o.pcmBytes === 16 && o.base64Ok && o.pcmMatches ? 1 : 0,
        };
      },
    },
  ],
  // Evalite's detailed table requires a consistent column count across all
  // evals in a file; the real E2E eval below defines 3 custom columns.
  columns: () => [
    { label: 'Chequeo', value: 'WAV→PCM24 + base64' },
    { label: 'TTFA', value: '—' },
    { label: 'Respuesta', value: '—' },
  ],
});

// ---------------------------------------------------------------------------
// Real: E2E per clip (gated)
// ---------------------------------------------------------------------------

type Manifest = { clips: Array<{ file: string; transcription: string }> };

const manifest: Manifest | null = await readFile(
  join(AUDIO_DIR, 'manifest.json'),
  'utf8',
)
  .then((raw) => JSON.parse(raw) as Manifest)
  .catch(() => null);

const REAL_SKIP_REASON =
  process.env.EVAL_REAL !== '1'
    ? 'real mode off (set EVAL_REAL=1)'
    : !manifest
      ? 'dataset missing — run `npm run eval:voice:dataset`'
      : !process.env.OPEN_AI_API_KEY
        ? 'OPEN_AI_API_KEY required for the realtime session'
        : null;

const run = REAL_SKIP_REASON ? evalite.skip : evalite;
const EVAL_CLIPS = Number(process.env.EVAL_REALTIME_CLIPS ?? '5');

run(`Realtime E2E: gpt-realtime-2.1-mini (${manifest ? Math.min(EVAL_CLIPS, manifest.clips.length) : 0} clips)`, {
  data: manifest
    ? manifest.clips.slice(0, EVAL_CLIPS).map((clip) => ({
        input: { file: clip.file, expected: clip.transcription },
      }))
    : [],
  task: async (input: { file: string; expected: string }) => {
    if (REAL_SKIP_REASON) throw new Error(REAL_SKIP_REASON);
    const wav = await readFile(join(AUDIO_DIR, input.file));
    const turn = await runRealtimeTurn(
      {
        model: process.env.EVAL_REALTIME_MODEL ?? 'gpt-realtime-2.1-mini',
        apiKey: process.env.OPEN_AI_API_KEY!,
      },
      wav,
      input.expected,
    );
    // Evalite renders the output object in a table; newlines break it.
    return { ...turn, transcript: turn.transcript.replace(/\s+/gu, ' ') };
  },
  scorers: [
    {
      name: 'turn_completed',
      scorer: ({ output }) => {
        const o = output as { transcript: string; audioBytes: number };
        return {
          score: o.transcript.length > 0 && o.audioBytes > 0 ? 1 : 0,
          metadata: {
            transcript: o.transcript.slice(0, 200),
            firstAudioMs: (output as { firstAudioMs: number | null }).firstAudioMs,
            totalMs: (output as { totalMs: number }).totalMs,
          },
        };
      },
    },
  ],
  columns: ({ output }) => {
    const o = output as {
      transcript?: string;
      firstAudioMs?: number | null;
      totalMs?: number;
    };
    return [
      { label: 'TTFA', value: o.firstAudioMs == null ? '—' : `${o.firstAudioMs}ms` },
      { label: 'Total', value: o.totalMs == null ? '—' : `${o.totalMs}ms` },
      { label: 'Respuesta', value: (o.transcript ?? '—').replace(/\s+/gu, ' ').slice(0, 60) },
    ];
  },
});

if (REAL_SKIP_REASON) {
  console.warn(`[realtime eval] SKIP: ${REAL_SKIP_REASON}`);
}