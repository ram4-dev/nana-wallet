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
      reject(new Error(`Realtime WS error: ${String(((event as { message?: string }).message ?? 'unknown'))}`));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (event) =>
        reject(new Error(`Realtime WS open failed: ${String(((event as { message?: string }).message ?? 'unknown'))}`)),
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
        case 'response.output_audio_transcript.delta':
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

    // ---------------------------------------------------------------------------
    // Multi-user-turn dialogue runner (tools-matrix eval)
    // ---------------------------------------------------------------------------

    /**
     * One user turn in a multi-turn dialogue. Text turns are injected as
     * `conversation.item.create` user items (deterministic, cheap, ASR-free); audio
     * turns stream a PCM16 clip exactly like `runRealtimeTurn`.
     */
    export type RealtimeUserTurn =
      | { kind: 'text'; text: string }
      | { kind: 'audio'; wav: Buffer };

    export type RealtimeDialogueOptions = {
      /** Total response-round budget across the whole dialogue. Defaults to 40. */
      maxTurns?: number;
      /** WebSocket factory override for tests. Defaults to the global WebSocket. */
      wsFactory?: (url: string, options: { headers: Record<string, string> }) => InstanceType<typeof WebSocket>;
      /** Session setup timeout in ms. Defaults to 10_000. */
      setupTimeoutMs?: number;
      /** Whole-dialogue timeout in ms. Defaults to 120_000. */
      dialogueTimeoutMs?: number;
      /** Consecutive empty-response retries before resolving the turn. Defaults to 2. */
      emptyResponseRetries?: number;
    };

    export type RealtimeDialogueTurnResult = {
      /** The user input: the text item, or `'<audio>'` for an audio turn. */
      input: string;
      /** Assistant audio transcript produced while resolving this turn. */
      transcript: string;
      /** Tool calls executed while resolving this turn, in order. */
      toolCalls: ToolCallRecord[];
    };

    export type RealtimeDialogueResult = {
      transcript: string;
      toolCalls: ToolCallRecord[];
      audioBytes: number;
      firstAudioMs: number | null;
      totalMs: number;
      turns: RealtimeDialogueTurnResult[];
    };

    /**
     * Opens a realtime session and runs a multi-user-turn dialogue with tool support.
     * Each user turn is injected (text item or audio), a response is requested, and
     * every `function_call` the model emits is executed through the binding and fed
     * back as `function_call_output`. The turn ends when a `response.done` arrives
     * with no pending function calls; the next user turn is then injected.
     *
     * The returned `transcript` is the concatenated assistant narration; `turns` holds
     * a per-user-turn transcript + tool sequence for scenario assertions.
     */
    export async function runRealtimeDialogue(
      config: RealtimeConfig,
      userTurns: RealtimeUserTurn[],
      toolBinding: RealtimeToolBinding,
      options: RealtimeDialogueOptions = {},
    ): Promise<RealtimeDialogueResult> {
      // The realtime API applies strict per-minute token rate limits; concurrent or
      // back-to-back sessions can be rejected at setup (WS close 1013
      // `tokens.rate_limit_exceeded`) or simply not confirm the session in time.
      // Retry transient setup failures with linear backoff; real assertion failures
      // are never retried because their messages do not match the transient set.
      const maxAttempts = 3;
      const retryableError = /setup timeout|closed during setup|rate_limit/i;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          return await runRealtimeDialogueAttempt(config, userTurns, toolBinding, options);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (attempt === maxAttempts || !retryableError.test(message)) throw err;
          if (process.env.EVAL_REALTIME_DEBUG) {
            console.error(`[rt] attempt ${attempt} failed (${message}); retrying after backoff`);
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 3_000 * attempt));
        }
      }
      // Unreachable: the loop either returns or throws on the final attempt.
      throw new Error('runRealtimeDialogue: retry loop exited unexpectedly');
    }

    async function runRealtimeDialogueAttempt(
      config: RealtimeConfig,
      userTurns: RealtimeUserTurn[],
      toolBinding: RealtimeToolBinding,
      options: RealtimeDialogueOptions = {},
    ): Promise<RealtimeDialogueResult> {
      const maxTurns = options.maxTurns ?? 40;
      const emptyResponseRetries = options.emptyResponseRetries ?? 2;
      const startedAt = Date.now();
      const wsFactory = options.wsFactory ?? ((url, wsOptions) => new WebSocket(url, wsOptions));
      const ws = wsFactory(
        `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(config.model)}`,
        { headers: { Authorization: `Bearer ${config.apiKey}` } },
      );

      let firstAudioAt: number | null = null;
      let audioBytes = 0;
      let sessionIdReady: PendingResolver | null = null;
      let responseDone: ((err: Error | null) => void) | null = null;
      let totalTurns = 0;
      const pendingCalls = new Map<string, FunctionCallCandidate>();
      let turnTranscript = '';
      let currentTurn: RealtimeDialogueTurnResult | null = null;
      const turns: RealtimeDialogueTurnResult[] = [];
      let emptyRetries = 0;
      const consumed = { startedAt };

      const timeout = setTimeout(
        () => {
          ws.close();
          responseDone?.(new Error('Realtime dialogue timed out'));
          responseDone = null;
        },
        options.dialogueTimeoutMs ?? 120_000,
      );

      const closed = new Promise<void>((resolve, reject) => {
        ws.addEventListener('close', (event) => {
          const ev = event as unknown as { code?: number; reason?: string };
          if (process.env.EVAL_REALTIME_DEBUG) {
            console.error(`[rt] ws closed: code=${ev.code} reason=${ev.reason ?? ''}`);
          }
          // If the socket dies before the session confirms, fail setup immediately
          // (with the server's close reason) instead of waiting out the blind timer.
          sessionIdReady?.reject(
            new Error(`Realtime session closed during setup (code=${ev.code ?? '?'} reason=${ev.reason ?? ''})`),
          );
          resolve();
        });
        ws.addEventListener('error', (event) => {
          reject(new Error(`Realtime WS error: ${String(((event as { message?: string }).message ?? 'unknown'))}`));
        });
      });

      // Deduplicate function-call candidates keyed by call id; prefer the name from
      // `response.output_item.done` or `response.done` and the arguments from the
      // `function_call_arguments.done` event.
      function upsertCall(callId: string, patch: Partial<FunctionCallCandidate>): void {
        const existing = pendingCalls.get(callId) ?? {
          callId,
          name: '',
          arguments: '',
        };
        pendingCalls.set(callId, { ...existing, ...patch });
      }

      function collectOutputCalls(
        outputItems: Array<{ type?: string; call_id?: string; name?: string; arguments?: string }>,
      ): void {
        for (const item of outputItems) {
          if (item.type === 'function_call' && item.call_id) {
            upsertCall(item.call_id, {
              name: item.name ?? '',
              arguments: item.arguments ?? '',
            });
          }
        }
      }

      try {
        await new Promise<void>((resolve, reject) => {
          ws.addEventListener('open', () => resolve());
          ws.addEventListener('error', (event) =>
            reject(new Error(`Realtime WS open failed: ${String(((event as { message?: string }).message ?? 'unknown'))}`)),
          );
        });

        ws.addEventListener('message', async (event) => {
          const data = JSON.parse(String(event.data)) as {
            type: string;
            delta?: { transcript?: string; audio?: string };
            call_id?: string;
            arguments?: string;
            item?: { type?: string; call_id?: string; name?: string; arguments?: string };
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
            case 'response.output_audio_transcript.delta':
              turnTranscript += data.delta?.transcript ?? '';
              break;
            case 'response.output_audio.delta': {
              const d = data.delta as unknown;
              const b64 = typeof d === 'string' ? d : (d as { audio?: string })?.audio ?? '';
              audioBytes += Math.floor((b64.length * 3) / 4);
              if (firstAudioAt === null) firstAudioAt = Date.now();
              break;
            }
            case 'response.function_call_arguments.done':
              if (data.call_id) upsertCall(data.call_id, { arguments: data.arguments ?? '' });
              break;
            case 'response.output_item.done': {
              const item = data.item;
              if (item?.type === 'function_call' && item.call_id) {
                upsertCall(item.call_id, {
                  name: item.name ?? '',
                  arguments: item.arguments ?? '',
                });
              }
              break;
            }
            case 'response.done': {
              const outputItems = data.response?.output ?? [];
              collectOutputCalls(outputItems);
              totalTurns += 1;
              if (totalTurns > maxTurns) {
                responseDone?.(new Error(`Realtime dialogue exceeded max turns (${maxTurns})`));
                return;
              }
              if (pendingCalls.size > 0) {
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
                  // Store the RAW tool result (not the FunctionCallOutput wrapper) so
                  // `ToolCallRecord` stays semantically consistent for the eval assertions.
                  let rawResult: unknown = result.output;
                  try {
                    rawResult = JSON.parse(result.output);
                  } catch {
                    // keep the raw output string on parse failure.
                  }
                  if (currentTurn) {
                    currentTurn.toolCalls.push({
                      name: call.name,
                      rawArgs: call.arguments,
                      result: rawResult,
                    });
                  }
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
              // The realtime API occasionally answers with a completely empty
              // response (no items, no narration). Resolving the turn there kills
              // the dialogue silently — observed in real runs. Retry the response
              // instead; after exhausting the budget, resolve so the caller can
              // assert on the (partial) turn instead of hanging.
              if (outputItems.length === 0) {
                if (emptyRetries < emptyResponseRetries) {
                  emptyRetries += 1;
                  if (process.env.EVAL_REALTIME_DEBUG) {
                    console.error(`[rt] empty response.done (${emptyRetries}/${emptyResponseRetries}); retrying response.create`);
                  }
                  ws.send(JSON.stringify({ type: 'response.create' }));
                  break;
                }
                if (process.env.EVAL_REALTIME_DEBUG) {
                  console.error('[rt] empty response.done: retries exhausted; resolving turn');
                }
              }
              emptyRetries = 0;
              if (turnTranscript === '') {
                turnTranscript =
                  outputItems
                    .flatMap((o) => o.content ?? [])
                    .map((c) => c.transcript ?? '')
                    .filter(Boolean)
                    .join(' ') ?? '';
              }
              if (currentTurn) currentTurn.transcript = turnTranscript;
              responseDone?.(null);
              break;
            }
            case 'error':
              responseDone?.(new Error(`Realtime API error: ${JSON.stringify(data).slice(0, 500)}`));
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
              const t = setTimeout(
                () => reject(new Error('session setup timeout')),
                options.setupTimeoutMs ?? 10_000,
              );
          sessionIdReady = {
            resolve: () => {
              clearTimeout(t);
              resolve();
            },
            reject,
          };
        });

        for (const turn of userTurns) {
          turnTranscript = '';
          currentTurn = {
            input: turn.kind === 'text' ? turn.text : '<audio>',
            transcript: '',
            toolCalls: [],
          };

          // Bind the response resolver BEFORE sending input so a fast reply is not lost.
          const waitForResponse = new Promise<void>((resolve, reject) => {
            responseDone = (err) => (err ? reject(err) : resolve());
          });

          if (turn.kind === 'audio') {
            const extracted = extractPcm16(turn.wav);
            const pcm = resamplePcm16(extracted.pcm, extracted.sampleRate, 24000);
            for (let i = 0; i < pcm.length; i += CHUNK_BYTES) {
              ws.send(
                JSON.stringify({
                  type: 'input_audio_buffer.append',
                  audio: pcm.subarray(i, i + CHUNK_BYTES).toString('base64'),
                }),
              );
            }
            ws.send(JSON.stringify({ type: 'input_audio_buffer.commit' }));
          } else {
            ws.send(
              JSON.stringify({
                type: 'conversation.item.create',
                item: {
                  type: 'message',
                  role: 'user',
                  content: [{ type: 'input_text', text: turn.text }],
                },
              }),
            );
          }
          ws.send(JSON.stringify({ type: 'response.create' }));

          await waitForResponse;
          if (currentTurn) turns.push(currentTurn);
          currentTurn = null;
        }

        const transcript = turns
          .map((t) => t.transcript)
          .join(' ')
          .replace(/\s+/gu, ' ')
          .trim();
        return {
          transcript,
          toolCalls: toolBinding.calls,
          audioBytes,
          firstAudioMs: firstAudioAt === null ? null : firstAudioAt - consumed.startedAt,
          totalMs: Date.now() - consumed.startedAt,
          turns,
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
      reject(new Error(`Realtime WS error: ${String(((event as { message?: string }).message ?? 'unknown'))}`));
    });
  });

  try {
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener('open', () => resolve());
      ws.addEventListener('error', (event) =>
        reject(new Error(`Realtime WS open failed: ${String(((event as { message?: string }).message ?? 'unknown'))}`)),
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
        case 'response.output_audio_transcript.delta':
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