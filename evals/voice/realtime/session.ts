/**
 * Minimal OpenAI Realtime WebSocket client for the E2E voice eval.
 *
 * Flow per turn:
 *  1. Connect to wss://api.openai.com/v1/realtime?model=<model>.
 *  2. session.update with Nana persona instructions, pcm16 input audio.
 *  3. Stream the clip as input_audio_buffer.append (base64 PCM16 chunks).
 *  4. input_audio_buffer.commit + response.create.
 *  5. Wait for response.done; collect the response audio transcript, the
 *     audio bytes (delta-accumulated), and latency marks.
 */

import type { RealtimeToolBinding, ToolCallRecord } from './tool-binding.js';

export const NANA_REALTIME_INSTRUCTIONS = `Sos Nana, la asistente de voz de una wallet para personas mayores y personas con discapacidad.
Respondé siempre en español rioplatense, con frases cortas y cálidas, sin jerga técnica.
No menciones herramientas, estados internos ni términos cripto innecesarios.
Si te preguntan por dinero, respondé con lo que podés inferir de la conversación y aclará los datos que falten.`;

export type RealtimeTurnResult = {
  transcript: string;
  audioBytes: number;
  firstAudioMs: number | null;
  totalMs: number;
};

const CHUNK_BYTES = 9600; // 200ms of PCM16 @ 24kHz mono

/** Extracts raw PCM16 samples from a RIFF/WAVE buffer. */
export function extractPcm16(wav: Buffer): { pcm: Buffer; sampleRate: number } {
  if (wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF') {
    throw new Error('Not a RIFF/WAVE buffer');
  }
  let offset = 12; // past "RIFF<size>WAVE"
  let sampleRate = 16000;
  let bits = 16;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === 'fmt ') {
      sampleRate = wav.readUInt32LE(offset + 12);
      bits = wav.readUInt16LE(offset + 22);
    } else if (chunkId === 'data') {
      const data = wav.subarray(offset + 8, offset + 8 + chunkSize);
      if (bits === 16) return { pcm: data, sampleRate };
      if (bits === 32) {
        // FLEURS ships 32-bit float WAVs; the realtime API wants PCM16.
        // Convert with clamping (float32 range is [-1, 1] → int16).
        const floatCount = Math.floor(data.length / 4);
        const pcm = Buffer.alloc(floatCount * 2);
        for (let i = 0; i < floatCount; i++) {
          const f = data.readFloatLE(i * 4);
          const clamped = f < -1 ? -1 : f > 1 ? 1 : f;
          pcm.writeInt16LE(Math.round(clamped * 32767), i * 2);
        }
        return { pcm, sampleRate };
      }
      throw new Error(`Unsupported sample width: ${bits}-bit`);
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error('WAVE data chunk not found');
}

/** Linear-interpolation resampler for PCM16 mono. */
export function resamplePcm16(pcm: Buffer, fromRate: number, toRate: number): Buffer {
  if (fromRate === toRate) return pcm;
  const src = Math.floor(pcm.length / 2);
  const dst = Math.round((src * toRate) / fromRate);
  const out = Buffer.alloc(dst * 2);
  for (let i = 0; i < dst; i++) {
    const t = (i * fromRate) / toRate;
    const i0 = Math.floor(t);
    const frac = t - i0;
    const s0 = i0 < src ? pcm.readInt16LE(i0 * 2) : 0;
    const s1 = i0 + 1 < src ? pcm.readInt16LE((i0 + 1) * 2) : 0;
    out.writeInt16LE(Math.round(s0 + (s1 - s0) * frac), i * 2);
  }
  return out;
}

export type RealtimeConfig = {
  model: string;
  apiKey: string;
  instructions?: string;
};

type PendingResolver = {
  resolve: (value: string) => void;
  reject: (err: Error) => void;
};

/**
 * Opens a realtime session and runs one user-audio turn.
 * Resolves with the assistant's audio transcript (and audio size) when the
 * response completes.
 */
export async function runRealtimeTurn(
  config: RealtimeConfig,
  wav: Buffer,
  userTranscriptHint?: string,
): Promise<RealtimeTurnResult> {
  const startedAt = Date.now();
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    { headers: { Authorization: `Bearer ${config.apiKey}` } },
  );

  const extracted = extractPcm16(wav);
  const pcm = resamplePcm16(extracted.pcm, extracted.sampleRate, 24000);
  let firstAudioAt: number | null = null;
  let transcript = '';
  let audioBytes = 0;
  let sessionIdReady: PendingResolver | null = null;
  let turnDone: ((err: Error | null) => void) | null = null;

  const timeout = setTimeout(
    () => {
      ws.close();
      turnDone?.(new Error('Realtime turn timed out (90s)'));
      turnDone = null;
    },
    90_000,
  );

  const closed = new Promise<void>((resolve, reject) => {
    ws.addEventListener('close', (event) => {
      if (process.env.EVAL_REALTIME_DEBUG) {
        const ev = event as unknown as { code?: number; reason?: string };
        console.error(`[rt] ws closed: code=${ev.code} reason=${ev.reason ?? ''}`);
      }
      resolve();
    });
    ws.addEventListener('error', (event) => {
      reject(new Error(`Realtime WS error: ${String((event as ErrorEvent).message ?? 'unknown')}`));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (event) =>
        reject(new Error(`Realtime WS open failed: ${String((event as ErrorEvent).message ?? 'unknown')}`)),
      );
    });

    ws.addEventListener('message', (event) => {
      const data = JSON.parse(String(event.data)) as {
        type: string;
        delta?: { transcript?: string; audio?: string };
        response?: { output?: Array<{ content?: Array<{ transcript?: string }> }> };
      };
      if (process.env.EVAL_REALTIME_DEBUG) {
        console.error(`[rt] event: ${data.type}`);
      }
      switch (data.type) {
        case 'session.created':
        case 'session.updated':
          sessionIdReady?.resolve('ok');
          sessionIdReady = null;
          break;
        case 'response.audio_transcript.delta':
          transcript += data.delta?.transcript ?? '';
          break;
        case 'response.output_audio.delta': {
          // v2 sends the base64 chunk as the delta itself (string), not
          // wrapped in an object.
          const d = data.delta as unknown;
          const b64 = typeof d === 'string' ? d : (d as { audio?: string })?.audio ?? '';
          audioBytes += Math.floor((b64.length * 3) / 4);
          if (firstAudioAt === null) firstAudioAt = Date.now();
          break;
        }
        case 'response.done': {
          if (transcript === '') {
            // Fall back to the transcript embedded in the response output.
            transcript =
              data.response?.output
                ?.flatMap((o) => o.content ?? [])
                .map((c) => c.transcript ?? '')
                .filter(Boolean)
                .join(' ') ?? '';
          }
          turnDone?.(null);
          break;
        }
        case 'error':
          turnDone?.(new Error(`Realtime API error: ${JSON.stringify(data).slice(0, 500)}`));
          break;
        default:
          break;
      }
    });

    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: config.instructions ?? NANA_REALTIME_INSTRUCTIONS,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              // Manual mode: the eval must be deterministic. Server VAD
              // never fires end-of-speech on clips with trailing noise.
              turn_detection: null,
            },
            output: { format: { type: 'audio/pcm', rate: 24000 } },
          },
        },
      }),
    );

    // Wait for the server to acknowledge session configuration before
    // streaming audio (appends sent too early race the session setup).
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('session setup timeout')), 10_000);
      sessionIdReady = {
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
        reject,
      };
    });

    // Stream PCM in chunks.
    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm.subarray(i, i + CHUNK_BYTES).toString('base64'),
        }),
      );
    }
        // Manual turn detection: commit the full buffer and ask for a response.
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    ws.send(JSON.stringify({ type: 'response.create' }));


    await new Promise<void>((resolve, reject) => {
      turnDone = (err) => (err ? reject(err) : resolve());
    });

    return {
      transcript,
      audioBytes,
      firstAudioMs: firstAudioAt === null ? null : firstAudioAt - startedAt,
      totalMs: Date.now() - startedAt,
    };
    } finally {
    clearTimeout(timeout);
    try {
      ws.close();
    } catch {
      // already closed
    }
        await closed.catch(() => undefined);
  }
}

export type RealtimeConversationOptions = {
  /** Maximum number of response rounds before failing closed. Defaults to 12. */
  maxTurns?: number;
};

export type RealtimeConversationResult = {
  transcript: string;
  toolCalls: ToolCallRecord[];
  audioBytes: number;
  firstAudioMs: number | null;
  totalMs: number;
};

type FunctionCallCandidate = {
  callId: string;
  name: string;
  arguments: string;
};

/**
 * Opens a realtime session and runs a multi-turn user-audio conversation with tool
 * support. Declares the OpenAI `session.tools` from the binding, streams the clip,
 * and loops: when the model emits a `function_call`, the binding executes it and the
 * result is returned via `conversation.item.create` + `response.create`. The loop
 * stops when a `response.done` arrives with no pending function calls, or when the
 * bounded turn budget is exhausted.
 */
export async function runRealtimeConversation(
  config: RealtimeConfig,
  wav: Buffer,
  toolBinding: RealtimeToolBinding,
  options: RealtimeConversationOptions = {},
): Promise<RealtimeConversationResult> {
  const maxTurns = options.maxTurns ?? 12;
  const startedAt = Date.now();
  const ws = new WebSocket(
    `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
    { headers: { Authorization: `Bearer ${config.apiKey}` } },
  );

  const extracted = extractPcm16(wav);
  const pcm = resamplePcm16(extracted.pcm, extracted.sampleRate, 24000);
  let firstAudioAt: number | null = null;
  let transcript = '';
  let audioBytes = 0;
  let sessionIdReady: PendingResolver | null = null;
  let turnDone: ((err: Error | null) => void) | null = null;
  let turnCount = 0;
  const pendingCalls = new Map<string, FunctionCallCandidate>();

  const timeout = setTimeout(
    () => {
      ws.close();
      turnDone?.(new Error('Realtime conversation timed out (90s)'));
      turnDone = null;
    },
    90_000,
  );

  const closed = new Promise<void>((resolve, reject) => {
    ws.addEventListener('close', (event) => {
      if (process.env.EVAL_REALTIME_DEBUG) {
        const ev = event as unknown as { code?: number; reason?: string };
        console.error(`[rt] ws closed: code=${ev.code} reason=${ev.reason ?? ''}`);
      }
      resolve();
    });
    ws.addEventListener('error', (event) => {
      reject(new Error(`Realtime WS error: ${String((event as ErrorEvent).message ?? 'unknown')}`));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (event) =>
        reject(new Error(`Realtime WS open failed: ${String((event as ErrorEvent).message ?? 'unknown')}`)),
      );
    });

    ws.addEventListener('message', async (event) => {
      const data = JSON.parse(String(event.data)) as {
        type: string;
        delta?: { transcript?: string; audio?: string };
        call_id?: string;
        arguments?: string;
        item?: {
          type?: string;
          call_id?: string;
          name?: string;
          arguments?: string;
        };
        response?: {
          output?: Array<{
            type?: string;
            call_id?: string;
            name?: string;
            arguments?: string;
            content?: Array<{ transcript?: string }>;
          }>;
        };
      };
      if (process.env.EVAL_REALTIME_DEBUG) {
        console.error(`[rt] event: ${data.type}`);
      }
      switch (data.type) {
        case 'session.created':
        case 'session.updated':
          sessionIdReady?.resolve('ok');
          sessionIdReady = null;
          break;
        case 'response.audio_transcript.delta':
          transcript += data.delta?.transcript ?? '';
          break;
        case 'response.output_audio.delta': {
          const d = data.delta as unknown;
          const b64 = typeof d === 'string' ? d : (d as { audio?: string })?.audio ?? '';
          audioBytes += Math.floor((b64.length * 3) / 4);
          if (firstAudioAt === null) firstAudioAt = Date.now();
          break;
        }
        case 'response.function_call_arguments.done': {
          const existing = pendingCalls.get(data.call_id ?? '') ?? {
            callId: data.call_id ?? '',
            name: '',
            arguments: '',
          };
          existing.arguments = data.arguments ?? '';
          pendingCalls.set(data.call_id ?? '', existing);
          break;
        }
        case 'response.output_item.done': {
          const item = data.item;
          if (item?.type === 'function_call' && item.call_id) {
            const existing = pendingCalls.get(item.call_id) ?? {
              callId: item.call_id,
              name: '',
              arguments: '',
            };
            existing.name = item.name ?? existing.name;
            if (item.arguments) existing.arguments = item.arguments;
            pendingCalls.set(item.call_id, existing);
          }
          break;
        }
        case 'response.done': {
          const outputItems = data.response?.output ?? [];
          for (const item of outputItems) {
            if (item.type === 'function_call' && item.call_id) {
              const existing = pendingCalls.get(item.call_id) ?? {
                callId: item.call_id,
                name: '',
                arguments: '',
              };
              existing.name = item.name ?? existing.name;
              if (item.arguments) existing.arguments = item.arguments;
              pendingCalls.set(item.call_id, existing);
            }
          }
          turnCount += 1;
          if (pendingCalls.size > 0) {
            if (turnCount >= maxTurns) {
              turnDone?.(new Error(`Realtime conversation exceeded max turns (${maxTurns})`));
              return;
            }
            const calls = [...pendingCalls.values()];
            pendingCalls.clear();
            for (const call of calls) {
              if (!call.name) {
                ws.send(
                  JSON.stringify({
                    type: 'conversation.item.create',
                    item: {
                      type: 'function_call_output',
                      call_id: call.callId,
                      output: JSON.stringify({
                        error: 'unknown_tool',
                        message: 'The model referenced a tool without a name.',
                      }),
                    },
                  }),
                );
                continue;
              }
              const result = await toolBinding.executeFunctionCall(call);
              ws.send(
                JSON.stringify({
                  type: 'conversation.item.create',
                  item: {
                    type: 'function_call_output',
                    call_id: result.callId,
                    output: result.output,
                  },
                }),
              );
            }
            ws.send(JSON.stringify({ type: 'response.create' }));
            break;
          }
          if (transcript === '') {
            transcript =
              outputItems
                .flatMap((o) => o.content ?? [])
                .map((c) => c.transcript ?? '')
                .filter(Boolean)
                .join(' ') ?? '';
          }
          turnDone?.(null);
          break;
        }
        case 'error':
          turnDone?.(new Error(`Realtime API error: ${JSON.stringify(data).slice(0, 500)}`));
          break;
        default:
          break;
      }
    });

    ws.send(
      JSON.stringify({
        type: 'session.update',
        session: {
          type: 'realtime',
          instructions: config.instructions ?? NANA_REALTIME_INSTRUCTIONS,
          tools: toolBinding.tools,
          output_modalities: ['audio'],
          audio: {
            input: {
              format: { type: 'audio/pcm', rate: 24000 },
              turn_detection: null,
            },
            output: { format: { type: 'audio/pcm', rate: 24000 } },
          },
        },
      }),
    );

    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('session setup timeout')), 10_000);
      sessionIdReady = {
        resolve: () => {
          clearTimeout(t);
          resolve();
        },
        reject,
      };
    });

    for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
      ws.send(
        JSON.stringify({
          type: 'input_audio_buffer.append',
          audio: pcm.subarray(i, i + CHUNK_BYTES).toString('base64'),
        }),
      );
    }
    ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
    ws.send(JSON.stringify({ type: 'response.create' }));

    await new Promise<void>((resolve, reject) => {
      turnDone = (err) => (err ? reject(err) : resolve());
    });

    return {
      transcript,
      toolCalls: toolBinding.calls,
      audioBytes,
      firstAudioMs: firstAudioAt === null ? null : firstAudioAt - startedAt,
      totalMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timeout);
    try {
      ws.close();
    } catch {
      // already closed
    }
    await closed.catch(() => undefined);
  }
}