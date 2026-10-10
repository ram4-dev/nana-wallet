/**
 * Minimal RIFF/WAVE I/O for the voice-room harness.
 *
 * The harness needs exactly two things: read a committed user-turn fixture, and
 * write the audio it captured from the room. Both are PCM16 WAVs, and both ends
 * have to agree on the sample rate, so the format contract lives here instead of
 * being spread through the caller.
 *
 * It is deliberately self-contained rather than importing
 * `evals/voice/realtime/session.ts`: that module is an OpenAI-realtime client and
 * its WAV helpers exist to feed the Realtime API, not to describe a capture
 * artifact. A harness that reads its own artifacts should not depend on an eval
 * that loads dotenv and speaks WebSocket.
 *
 * Resampling is mono-only on purpose: every artifact in this harness is one
 * channel, and a stereo path that is never exercised would be untested code.
 */

export type WavAudio = {
  /** Interleaved PCM16, little-endian. */
  pcm: Buffer;
  sampleRate: number;
  channels: number;
};

const WAV_HEADER_BYTES = 44;
const FORMAT_PCM = 1;
const FORMAT_IEEE_FLOAT = 3;
/**
 * OpenAI's `/audio/speech` returns a WAV whose RIFF and data sizes are both
 * 0xFFFFFFFF (it streams, so it does not know them upfront). A strict reader
 * rejects every generated fixture, so the placeholder means "to end of file"
 * here; a size that overruns the file in any OTHER value is still treated as a
 * truncated file.
 */
const STREAMING_SIZE_PLACEHOLDER = 0xffff_ffff;

/** Reads a PCM16 (or 32-bit float, converted) WAV into raw PCM. Throws on anything else. */
export function decodeWav(bytes: Buffer): WavAudio {
  if (bytes.length < WAV_HEADER_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error(
      `not a RIFF/WAVE buffer (first bytes: ${JSON.stringify(bytes.toString('ascii', 0, 4))}, length ${bytes.length})`,
    );
  }

  let offset = 12; // past "RIFF<size>WAVE"
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;
  let format = FORMAT_PCM;

  while (offset + 8 <= bytes.length) {
    const chunkId = bytes.toString('ascii', offset, offset + 4);
    const chunkSize = bytes.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      format = bytes.readUInt16LE(offset + 8);
      channels = bytes.readUInt16LE(offset + 10);
      sampleRate = bytes.readUInt32LE(offset + 12);
      bitsPerSample = bytes.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      const remaining = bytes.length - (offset + 8);
      const declared =
        chunkSize === STREAMING_SIZE_PLACEHOLDER ? remaining : chunkSize;
      // A data chunk whose declared size overruns the file is a truncated
      // fixture, and silently accepting it would produce a short turn that the
      // model never hears in full.
      if (declared > remaining) {
        throw new Error(
          `truncated WAVE data chunk: declared ${chunkSize} bytes, file holds ${remaining}`,
        );
      }
      const data = bytes.subarray(offset + 8, offset + 8 + declared);
      if (format === FORMAT_IEEE_FLOAT && bitsPerSample === 32) {
        return { pcm: float32ToPcm16(data), sampleRate, channels };
      }
      if (format !== FORMAT_PCM) {
        throw new Error(`unsupported WAVE format tag ${format} (only PCM16 and float32)`);
      }
      if (bitsPerSample !== 16) {
        throw new Error(`unsupported WAVE sample width ${bitsPerSample}-bit (only 16-bit PCM)`);
      }
      return { pcm: Buffer.from(data), sampleRate, channels };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }

  throw new Error('no WAVE data chunk found');
}

export function encodeWav(pcm: Buffer, sampleRate: number, channels: number): Buffer {
  const bitsPerSample = 16;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(FORMAT_PCM, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE((sampleRate * channels * bitsPerSample) / 8, 28);
  header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function pcmDurationMs(pcm: Buffer, sampleRate: number, channels: number): number {
  const frames = pcm.length / 2 / channels;
  return Math.round((frames / sampleRate) * 1_000);
}

/**
 * Views raw PCM16 bytes as samples.
 *
 * It copies sample by sample instead of wrapping the Buffer: a Node Buffer is a
 * view into a pooled ArrayBuffer whose byteOffset is not guaranteed to be
 * 2-aligned, and `new Int16Array(buffer, offset, length)` throws on an odd
 * offset. That failure would only show up under a specific allocation pattern.
 */
export function pcmToInt16(pcm: Buffer): Int16Array {
  const samples = new Int16Array(Math.floor(pcm.length / 2));
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2);
  }
  return samples;
}

export function int16ToPcm(samples: Int16Array): Buffer {
  const pcm = Buffer.alloc(samples.length * 2);
  for (let index = 0; index < samples.length; index += 1) {
    pcm.writeInt16LE(samples[index] ?? 0, index * 2);
  }
  return pcm;
}

/** Linear-interpolation resampler for mono PCM16. */
export function resamplePcm16Mono(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  const source = pcmToInt16(pcm);
  const target = Math.round((source.length * toRate) / fromRate);
  const out = new Int16Array(target);
  for (let index = 0; index < target; index += 1) {
    const position = (index * fromRate) / toRate;
    const lower = Math.floor(position);
    const fraction = position - lower;
    const a = source[lower] ?? 0;
    const b = source[lower + 1] ?? a;
    out[index] = Math.round(a + (b - a) * fraction);
  }
  return int16ToPcm(out);
}

function float32ToPcm16(data: Buffer): Buffer {
  const count = Math.floor(data.length / 4);
  const out = Buffer.alloc(count * 2);
  for (let index = 0; index < count; index += 1) {
    const value = data.readFloatLE(index * 4);
    const clamped = value < -1 ? -1 : value > 1 ? 1 : value;
    out.writeInt16LE(Math.round(clamped * 32_767), index * 2);
  }
  return out;
}
