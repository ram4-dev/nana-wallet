/**
 * Downloads ~30 Spanish audio clips with reference transcripts for the STT eval.
 *
 * Source: Google FLEURS es_419 test split (CC-BY-4.0). Common Voice was the
 * original design pick but its downloads are gated behind Mozilla auth; FLEURS
 * es_419 (Spanish - Latin America) is anonymously downloadable and public.
 *
 * The audio tarball is ~700MB, so we stream it and stop reading once all the
 * selected clips have been extracted (~10MB transferred for 30 clips).
 *
 * Idempotent: if a complete manifest already exists, it exits early.
 *
 * Usage: npx tsx evals/voice/stt/download-dataset.ts
 */
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, access } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { createGunzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { extract as tarExtract, type ReadEntry } from 'tar-stream';

const CLIP_COUNT = 30;

const TSV_URL =
  'https://huggingface.co/datasets/google/fleurs/resolve/main/data/es_419/test.tsv';
const TAR_URL =
  'https://huggingface.co/datasets/google/fleurs/resolve/main/data/es_419/audio/test.tar.gz';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '.audio');
const MANIFEST_PATH = join(OUT_DIR, 'manifest.json');

type TsvRow = {
  id: string;
  file: string;
  transcription: string;
  rawTranscription: string;
};

function selectClips(rows: TsvRow[], count: number): TsvRow[] {
  // Prefer clips with a usable spoken-sentence length, spread evenly across
  // the file so we cover different speakers/topics.
  const usable = rows.filter((r) => {
    const words = r.transcription.split(/\s+/u).length;
    return words >= 4 && words <= 20 && r.transcription.length <= 120;
  });
  const step = Math.max(1, Math.floor(usable.length / count));
  const selected: TsvRow[] = [];
  for (let i = 0; i < usable.length && selected.length < count; i += step) {
    selected.push(usable[i]!);
  }
  if (selected.length < count) {
    for (const r of usable) {
      if (selected.length >= count) break;
      if (!selected.includes(r)) selected.push(r);
    }
  }
  return selected.slice(0, count);
}

function parseTsv(content: string): TsvRow[] {
  return content
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      const cols = line.split('\t');
      return {
        id: cols[0]?.trim() ?? '',
        file: cols[1]?.trim() ?? '',
        transcription: cols[2]?.trim() ?? '',
        rawTranscription: cols[3]?.trim() ?? '',
      };
    })
    .filter((r) => r.file.length > 0 && r.transcription.length > 0);
}

async function fetchText(url: string): Promise<string> {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.text();
}

async function manifestIsComplete(
  expectedFiles: Set<string>,
): Promise<boolean> {
  try {
    const raw = await readFile(MANIFEST_PATH, 'utf8');
    const manifest = JSON.parse(raw) as { clips?: Array<{ file: string }> };
    const clips = manifest.clips ?? [];
    if (clips.length !== expectedFiles.size) return false;
    for (const clip of clips) {
      await access(join(OUT_DIR, clip.file));
    }
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });

  console.log('Fetching FLEURS es_419 test.tsv …');
  const rows = parseTsv(await fetchText(TSV_URL));
  console.log(`TSV rows: ${rows.length}`);

  const selected = selectClips(rows, CLIP_COUNT);
  const wanted = new Map(selected.map((r) => [r.file, r]));

  if (await manifestIsComplete(wanted)) {
    console.log(
      `Manifest already complete with ${wanted.size} clips — nothing to do.`,
    );
    return;
  }

  console.log(
    `Selected ${selected.length} clips. Streaming audio tarball (stops early once all clips are extracted) …`,
  );

  const curl = spawn(
    'curl',
    ['-sL', '--max-time', '600', TAR_URL],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );

  const extract = tarExtract();

  const extracted = new Set<string>();
  let stopping = false;

  extract.on('entry', (entry: ReadEntry, stream, next) => {
    const base = entry.name.split('/').pop() ?? entry.name;
    const row = wanted.get(base);
    if (!row || entry.type !== 'file' || stopping) {
      stream.resume();
      next();
      return;
    }
    const out = createWriteStream(join(OUT_DIR, base));
    stream.pipe(out);
    out.on('finish', () => {
      extracted.add(base);
      next();
      if (extracted.size === wanted.size) {
        // All clips retrieved — stop the download to avoid pulling 700MB.
        stopping = true;
        curl.kill('SIGKILL');
        extract.destroy();
      }
    });
    out.on('error', (err) => next(err));
  });

  try {
    await pipeline(curl.stdout, createGunzip(), extract);
  } catch (err) {
    // Destroying the extract stream on purpose surfaces as a premature-close
    // error from streamx; that is the expected early-stop path.
    const code = (err as NodeJS.ErrnoException)?.code;
    if (!(stopping && (code === 'ERR_STREAM_PREMATURE_CLOSE' || code === 'ERR_STREAM_DESTROYED'))) {
      throw err;
    }
  }

  if (extracted.size !== wanted.size) {
    throw new Error(
      `Expected ${wanted.size} clips, extracted ${extracted.size}. ` +
        'The tar stream ended before all selected clips were found.',
    );
  }

  const manifest = {
    source: 'google/fleurs',
    config: 'es_419',
    split: 'test',
    license: 'CC-BY-4.0',
    url: TAR_URL,
    fetchedAt: new Date().toISOString(),
    clipCount: extracted.size,
    clips: selected.map((r) => ({
      id: r.id,
      file: r.file,
      transcription: r.transcription,
      rawTranscription: r.rawTranscription,
    })),
  };
  await writeFile(MANIFEST_PATH, JSON.stringify(manifest, null, 2) + '\n');

  console.log(
    `Done. ${extracted.size} clips + manifest written to ${resolve(OUT_DIR)}`,
  );
}

main().catch((err) => {
  console.error('Download failed:', err);
  process.exit(1);
});