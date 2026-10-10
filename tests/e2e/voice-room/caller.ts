/**
 * The host-side caller: it joins the room the way a browser would, binds the
 * conversation over RPC, publishes a user turn as audio, and captures what the
 * agent says back.
 *
 * Three API traps are already paid for here and are marked inline. Do not "clean
 * them up":
 *
 *  1. `track.kind` is the NUMERIC TrackKind enum (KIND_AUDIO === 1), not the
 *     string 'audio'. Comparing against the string silently drops every track:
 *     zero frames, zero errors.
 *  2. `performRpc` is a LOCAL-participant method at runtime; the RemoteParticipant
 *     instance does not have it even though the type reads as if it inherited it.
 *  3. The worker's audio input only accepts publications whose source is
 *     `SOURCE_MICROPHONE` (`@livekit/agents` room_io/_input.js: `publication.source
 *     !== TrackSource.SOURCE_MICROPHONE` -> ignore). Publishing without that hint
 *     produces a track that the agent never listens to: no error, no answer.
 *
 * A live `AudioStream` also keeps the event loop alive and stops
 * `room.disconnect()` from ever resolving, so callers must exit with an explicit
 * `process.exit()` instead of awaiting teardown (see the scripts).
 */

import {
  AudioFrame,
  AudioSource,
  AudioStream,
  LocalAudioTrack,
  ParticipantKind,
  Room,
  RoomEvent,
  TrackKind,
  TrackPublishOptions,
  TrackSource,
  type RemoteParticipant,
  type Track,
} from '@livekit/rtc-node';
import { AccessToken } from 'livekit-server-sdk';
import { pcmDurationMs, pcmToInt16, type WavAudio } from './audio.js';
import {
  detectTurnEnd,
  pcm16Rms,
  type AudioFrameEnergy,
  type TurnEndOptions,
  type TurnEndState,
} from './turn-detector.js';

export const ROOM_SAMPLE_RATE = 48_000;
export const ROOM_CHANNELS = 1;
/** LiveKit audio frames are 20 ms; a real microphone publishes at that cadence. */
export const PUBLISH_FRAME_MS = 20;
export const TURN_POLL_MS = 250;
export const AGENT_WAIT_MS = 20_000;
export const BIND_DEADLINE_MS = 30_000;

export type BindReply =
  | { ok: true; conversationId: string; revision: number }
  | { ok: false; code: string };

export type CapturedFrame = {
  /** Host clock milliseconds when the frame arrived. */
  atMs: number;
  energy: AudioFrameEnergy;
  pcm: Buffer;
  trackSid: string;
};

export type TurnWaitResult = {
  state: TurnEndState;
  timedOut: boolean;
  frames: readonly CapturedFrame[];
};

export function sleep(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

/** Turns a ws(s):// signaling URL into the http(s):// base the server SDKs want. */
export function httpUrl(url: string): string {
  return url.replace(/^wss:/u, 'https:').replace(/^ws:/u, 'http:').replace(/\/+$/u, '');
}

export async function callerToken(input: {
  apiKey: string;
  apiSecret: string;
  roomName: string;
  identity: string;
  ttl?: string;
}): Promise<string> {
  const token = new AccessToken(input.apiKey, input.apiSecret, {
    // The identity is the binding subject on purpose: the worker compares the
    // caller identity against `binding.sub` and answers `conversation_forbidden`
    // otherwise.
    identity: input.identity,
    ttl: input.ttl ?? '5m',
  });
  token.addGrant({
    room: input.roomName,
    roomJoin: true,
    roomAdmin: true,
    canPublish: true,
    canSubscribe: true,
  });
  return await token.toJwt();
}

/**
 * Records every audio frame the room subscribes to, in arrival order.
 *
 * Frames are kept as a single timeline and phases are addressed by index
 * (`markTurnStart`), never by clearing the buffer: an index boundary cannot lose
 * the frames that arrive while the harness decides a turn ended.
 */
export class RoomAudioCapture {
  private readonly frames: CapturedFrame[] = [];
  private readonly attached: Array<{ track: Track; stream: AudioStream }> = [];
  private stopping = false;
  readonly streamErrors: string[] = [];
  audioTracksSubscribed = 0;

  constructor(
    readonly sampleRate: number = ROOM_SAMPLE_RATE,
    readonly channels: number = ROOM_CHANNELS,
  ) {}

  attach(room: Room): void {
    room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
      // TRAP 1: numeric kind, not the string 'audio'.
      if (track.kind !== TrackKind.KIND_AUDIO) return;
      this.audioTracksSubscribed += 1;
      const stream = new AudioStream(track, this.sampleRate, this.channels);
      this.attached.push({ track, stream });
      void (async () => {
        try {
          for await (const frame of stream) {
            const samples = frame.data;
            this.frames.push({
              atMs: Date.now(),
              energy: {
                rms: pcm16Rms(samples),
                durationMs: (frame.samplesPerChannel / frame.sampleRate) * 1_000,
              },
              // Copied, not a view: the frame buffer belongs to the FFI and a
              // long-lived view could be overwritten under memory pressure.
              pcm: Buffer.from(samples),
              trackSid: publication.sid ?? '',
            });
          }
        } catch (error) {
          // A cancellation from stop() is the expected way out, not a failure.
          if (this.stopping) return;
          this.streamErrors.push(error instanceof Error ? error.message : String(error));
        }
      })();
    });
  }

  /**
   * Detaches every reader and closes the subscribed tracks.
   *
   * The process cannot exit, and `room.disconnect()` never resolves, while any
   * AudioStream still has a reader attached (the trap the Slice 2 spike worked
   * around with `process.exit()`). A vitest run cannot call `process.exit()`, so
   * the harness has to release the readers explicitly instead of relying on the
   * process ending.
   */
  async stop(): Promise<void> {
    this.stopping = true;
    for (const { track, stream } of this.attached) {
      await stream.cancel().catch(() => undefined);
      await track.close().catch(() => undefined);
    }
  }

  markTurnStart(): number {
    return this.frames.length;
  }

  /** Snapshot of the frames captured since `index`. Safe to hold across awaits. */
  framesSince(index: number): CapturedFrame[] {
    return this.frames.slice(index);
  }

  get frameCount(): number {
    return this.frames.length;
  }
}

export function concatenatePcm(frames: readonly CapturedFrame[]): Buffer {
  return Buffer.concat(frames.map((frame) => frame.pcm));
}

/**
 * True when the publishing track is one the agent's audio input will accept.
 * Exposed so the harness can assert its own invariant instead of trusting a
 * silent no-op.
 */
export function isAgentAudibleSource(source: TrackSource): boolean {
  return source === TrackSource.SOURCE_MICROPHONE;
}

/**
 * Publishes the caller's turn as microphone audio, paced in real time.
 *
 * Pacing matters: `AudioSource.captureFrame` queues into the native source (1 s
 * queue by default) and returns as soon as the FFI accepted the frame, so
 * pushing a file as fast as the loop allows would compress the turn and the model
 * would hear a chipmunk. The loop schedules each frame against a start timestamp
 * so it does not drift.
 */
export async function publishUserTurn(input: {
  room: Room;
  audio: WavAudio;
  trackName: string;
  frameMs?: number;
}): Promise<{
  framesSent: number;
  durationMs: number;
  track: LocalAudioTrack;
  source: AudioSource;
  trackSid: string | undefined;
  trackSource: TrackSource;
}> {
  const frameMs = input.frameMs ?? PUBLISH_FRAME_MS;
  const { pcm, sampleRate, channels } = input.audio;
  const local = input.room.localParticipant;
  if (!local) throw new Error('room.localParticipant is unavailable');

  const source = new AudioSource(sampleRate, channels, 1_000);
  const track = LocalAudioTrack.createAudioTrack(input.trackName, source);
  const trackSource = TrackSource.SOURCE_MICROPHONE;
  // TRAP 3: without the microphone source the agent's input ignores the track.
  const publication = await local.publishTrack(
    track,
    new TrackPublishOptions({ source: trackSource }),
  );

  const samplesPerFrame = Math.round((sampleRate * frameMs) / 1_000);
  const samples = pcmToInt16(pcm);
  const totalFrames = Math.ceil(samples.length / samplesPerFrame);
  const startedAt = Date.now();
  let framesSent = 0;

  for (let index = 0; index < totalFrames; index += 1) {
    const start = index * samplesPerFrame;
    const slice = samples.subarray(start, Math.min(start + samplesPerFrame, samples.length));
    if (slice.length === 0) break;
    const dueAt = startedAt + index * frameMs;
    const waitMs = dueAt - Date.now();
    if (waitMs > 0) await sleep(waitMs);
    // `AudioFrame.protoInfo()` hands the FFI `new Uint8Array(frame.data.buffer)`:
    // the WHOLE underlying ArrayBuffer, ignoring byteOffset and byteLength. A
    // subarray therefore transmits the buffer's opening bytes on every frame
    // instead of the slice, so every published frame carried the fixture's first
    // 20 ms — the receiver measured a flat ~268 RMS while this loop was verifiably
    // sending 6263. Copy into an owned buffer so `frame.data.buffer` IS the frame.
    const chunk = new Int16Array(slice.length);
    chunk.set(slice);
    await source.captureFrame(
      new AudioFrame(chunk, sampleRate, channels, chunk.length / channels),
    );
    framesSent += 1;
  }

  return {
    framesSent,
    durationMs: pcmDurationMs(pcm, sampleRate, channels),
    track,
    source,
    trackSid: publication.sid,
    trackSource,
  };
}

/** Waits for the native source queue to drain, bounded: a stuck queue must not hang a run. */
export async function waitForPlayout(source: AudioSource, timeoutMs: number): Promise<boolean> {
  const drained = await Promise.race([
    source.waitForPlayout().then(() => true),
    sleep(timeoutMs).then(() => false),
  ]);
  return drained;
}

/**
 * Polls the captured window until the pure detector says the turn is over.
 *
 * Never a fixed sleep: see turn-detector.ts for why. `deadlineMs` is the bound
 * that keeps a silent or stuck agent from hanging the run forever, and a timed-out
 * wait is REPORTED (not treated as success).
 */
export async function waitForTurnEnd(input: {
  frames: () => readonly CapturedFrame[];
  options: TurnEndOptions;
  deadlineMs: number;
  pollMs?: number;
}): Promise<TurnWaitResult> {
  const pollMs = input.pollMs ?? TURN_POLL_MS;
  const deadline = Date.now() + input.deadlineMs;
  for (;;) {
    const frames = input.frames();
    const state = detectTurnEnd(
      frames.map((frame) => frame.energy),
      input.options,
    );
    if (state.ended) return { state, timedOut: false, frames };
    if (Date.now() >= deadline) return { state, timedOut: true, frames };
    await sleep(pollMs);
  }
}

export async function waitForAgent(room: Room, timeoutMs: number): Promise<RemoteParticipant> {
  const deadline = Date.now() + timeoutMs;
  let fallback: RemoteParticipant | undefined;
  while (Date.now() < deadline) {
    for (const participant of room.remoteParticipants.values()) {
      if (participant.info.kind === ParticipantKind.AGENT) return participant;
      fallback ??= participant;
    }
    await sleep(200);
  }
  if (fallback) return fallback;
  throw new Error(`no remote participant joined within ${timeoutMs} ms (is the agent worker running?)`);
}

export async function bindConversation(input: {
  room: Room;
  agentIdentity: string;
  bindingToken: string;
  deadlineMs?: number;
}): Promise<BindReply> {
  // TRAP 2: `performRpc` lives on the LOCAL participant at runtime.
  const local = input.room.localParticipant;
  if (!local) throw new Error('room.localParticipant is unavailable');
  const deadline = Date.now() + (input.deadlineMs ?? BIND_DEADLINE_MS);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      const raw = await local.performRpc({
        destinationIdentity: input.agentIdentity,
        method: 'bind_conversation',
        payload: JSON.stringify({ bindingToken: input.bindingToken }),
        // The handler does not answer until the realtime session has started, so
        // the 10 s default is too tight for a cold provider connection.
        responseTimeout: 60_000,
      });
      return JSON.parse(raw) as BindReply;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // The worker registers `bind_conversation` only after
      // `ctx.waitForParticipant()` resolves, i.e. only after we joined, so a
      // short window of "unknown method"/"no such recipient" is expected.
      const retryable = /unsupported|not supported|not found|1400|1401/i.test(message);
      if (!retryable || Date.now() > deadline) {
        throw new Error(`${message} (attempt ${attempt})`);
      }
      await sleep(500);
    }
  }
}
