/**
 * One full user-turn round trip against the real stack.
 *
 * This is the code both consumers share: the standalone script
 * (`scripts/voice-room-roundtrip.ts`, which also repeats it three times for the
 * determinism spread and writes the artifacts) and the vitest spec
 * (`roundtrip.e2e.spec.ts`, which asserts on the same report instead of
 * re-implementing the handshake). Keeping one implementation is the point: the
 * handshake has three paid-for traps in it (see caller.ts) and duplicating it
 * would duplicate them.
 *
 * WHAT IS ASSERTED VS WHAT IS EVIDENCE (see the design doc, 03-design-discussion):
 *   - asserted: the worker resolved the binding, audio arrived on both sides, the
 *     recorded turn has real speech in it, and the agent answered with real speech;
 *   - evidence, never an assertion: exact durations, latencies and the WAVs. The
 *     model is generative, so byte-equal audio across runs is not a thing anyone
 *     should assert.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Room } from '@livekit/rtc-node';
import { AgentDispatchClient, RoomServiceClient } from 'livekit-server-sdk';
import { decodeWav, encodeWav, pcmDurationMs, type WavAudio } from './audio.js';
import {
  AGENT_WAIT_MS,
  RoomAudioCapture,
  bindConversation,
  callerToken,
  concatenatePcm,
  httpUrl,
  isAgentAudibleSource,
  publishUserTurn,
  sleep,
  waitForAgent,
  waitForPlayout,
  waitForTurnEnd,
  type BindReply,
  type CapturedFrame,
  type TurnWaitResult,
} from './caller.js';
import { ARTIFACTS_DIR, type VoiceRoomConfig } from './config.js';
import { FIXTURE_USER_ID, mintFixtureBinding, seedVoiceRoomFixture } from './fixture.js';
import {
  GREETING_TURN_END,
  RESPONSE_TURN_END,
  type TurnEndState,
} from './turn-detector.js';

/** Hard cap for the greeting phase: a silent worker must fail, not hang. */
export const GREETING_DEADLINE_MS = 45_000;
/** Hard cap for the answer: the model has to think, then speak. */
export const RESPONSE_DEADLINE_MS = 60_000;
/**
 * How long the capture waits, after the response turn closes, before it stops:
 * enough to flush the tail, short enough not to add dead air to every run.
 */
export const RESPONSE_FLUSH_MS = 500;

export type PhaseReport = {
  name: string;
  frames: number;
  windowMs: number;
  speechMs: number;
  trailingSilenceMs: number;
  /** Offset of the first speech frame inside this window (leading silence). */
  leadingSilenceMs: number | null;
  ended: boolean;
  timedOut: boolean;
  wavPath: string | null;
};

export type UserTurnReport = {
  fixturePath: string;
  wavPath: string;
  sampleRate: number;
  channels: number;
  durationMs: number;
  framesSent: number;
  playoutDrained: boolean;
  trackSid: string | undefined;
  microphoneSource: boolean;
};

export type TranscriptLine = {
  identity: string;
  text: string;
};

export type VoiceRoomRoundTripReport = {
  label: string;
  roomName: string;
  agentIdentity: string;
  bind: BindReply;
  greeting: PhaseReport;
  userTurn: UserTurnReport;
  response: PhaseReport;
  replyLatency: {
    firstFrameMs: number | null;
    firstSpeechMs: number | null;
  };
  /**
   * Evidence, never an assertion: what the room's transcription streams said.
   * This is what turns "no answer arrived" into "the model never heard the turn"
   * without guessing.
   */
  transcripts: TranscriptLine[];
  failures: string[];
  passed: boolean;
};

export type RoundTripOptions = {
  config: VoiceRoomConfig;
  /** Absolute path to the committed user-turn WAV fixture. */
  turnWavPath: string;
  label?: string;
  artifactsDir?: string;
  log?: (line: string) => void;
  writeArtifacts?: boolean;
};

export async function runVoiceRoomRoundTrip(
  options: RoundTripOptions,
): Promise<VoiceRoomRoundTripReport> {
  const log = options.log ?? (() => {});
  const label = options.label ?? 'run';
  const artifactsDir = options.artifactsDir ?? ARTIFACTS_DIR;
  const writeArtifacts = options.writeArtifacts ?? true;
  const { config } = options;

  const failures: string[] = [];

  log('1/7 seed the fixture conversation (isolated Postgres)');
  const seed = await seedVoiceRoomFixture(config.databaseUrl, log);
  if (seed.liveLeasesHeld !== 0) {
    failures.push(`fixture still holds ${seed.liveLeasesHeld} live lease(s) after reseeding`);
  }

  log('2/7 mint + locally verify the live-voice binding');
  const binding = await mintFixtureBinding({
    privateKey: config.bindingPrivateKey,
    publicKey: config.bindingPublicKey,
  });
  log(
    `binding          : sub=${binding.claims.sub} conversationId=${binding.claims.conversationId} jti=${binding.claims.jti} exp=${binding.claims.exp}`,
  );

  log('3/7 create the room and dispatch the agent');
  const roomName = `nani-voice-roundtrip-${label}-${Date.now()}`;
  const rooms = new RoomServiceClient(httpUrl(config.livekitHostUrl), config.apiKey, config.apiSecret);
  await rooms.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 });
  const dispatch = await new AgentDispatchClient(
    httpUrl(config.livekitHostUrl),
    config.apiKey,
    config.apiSecret,
  ).createDispatch(roomName, config.agentName, { metadata: `nani-voice-roundtrip:${label}` });
  log(`room             : ${roomName}`);
  log(`dispatch         : ${dispatch.id} for agent "${config.agentName}"`);

  const turn: WavAudio = decodeWav(await readFile(options.turnWavPath));
  log(
    `user turn        : ${options.turnWavPath} (${pcmDurationMs(turn.pcm, turn.sampleRate, turn.channels)} ms, ${turn.sampleRate} Hz, ${turn.channels} ch)`,
  );

  const capture = new RoomAudioCapture();
  const room = new Room();
  capture.attach(room);

  // The agent publishes its own transcription (and, for a realtime model, the
  // transcription of what it HEARD) on `lk.transcription`. Subscribing is the
  // only cheap way to tell "the model ignored the turn" from "the turn never
  // reached the model", and the transcript is evidence the design asks for.
  const transcripts: TranscriptLine[] = [];
  room.registerTextStreamHandler('lk.transcription', (reader, info) => {
    void (async () => {
      try {
        const text = (await reader.readAll()).trim();
        if (text.length === 0) return;
        transcripts.push({ identity: info.identity, text });
        log(`transcript[${info.identity}]: ${text}`);
      } catch (error) {
        log(`transcript handler error: ${error instanceof Error ? error.message : String(error)}`);
      }
    })();
  });

  let bind: BindReply = { ok: false, code: 'not_attempted' };
  let agentIdentity = 'not_joined';
  let greetingFrames: readonly CapturedFrame[] = [];
  let greetingState: TurnEndState = emptyState();
  let greetingTimedOut = false;
  let responseFrames: readonly CapturedFrame[] = [];
  let responseState: TurnEndState = emptyState();
  let responseTimedOut = false;
  let userTurn: UserTurnReport | null = null;
  let publishStartedAtMs = 0;

  try {
    log('4/7 join the room as the binding subject');
    await room.connect(
      config.livekitHostUrl,
      await callerToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        roomName,
        identity: FIXTURE_USER_ID,
      }),
    );
    const agent = await waitForAgent(room, AGENT_WAIT_MS);
    agentIdentity = agent.identity;
    log(`agent participant: ${agent.identity} (kind ${agent.info.kind})`);

    log('5/7 RPC bind_conversation');
    bind = await bindConversation({
      room,
      agentIdentity: agent.identity,
      bindingToken: binding.token,
    });
    log(`bind reply       : ${JSON.stringify(bind)}`);
    if (!bind.ok) failures.push(`bind_conversation answered ok:false (${bind.code})`);

    const greetingStart = capture.markTurnStart();
    log('6/7 wait for the end of the greeting (silence-detected, never a sleep)');
    const greeting: TurnWaitResult = await waitForTurnEnd({
      frames: () => capture.framesSince(greetingStart),
      options: GREETING_TURN_END,
      deadlineMs: GREETING_DEADLINE_MS,
    });
    greetingFrames = greeting.frames;
    greetingState = greeting.state;
    greetingTimedOut = greeting.timedOut;
    log(
      `greeting         : ${Math.round(greetingState.speechMs)} ms of speech, ${Math.round(greetingState.trailingSilenceMs)} ms trailing silence, ended=${greetingState.ended}${greetingTimedOut ? ' (TIMED OUT)' : ''}`,
    );

    log('7/7 publish the user turn and capture the answer');
    const responseStart = capture.markTurnStart();
    publishStartedAtMs = Date.now();
    const published = await publishUserTurn({ room, audio: turn, trackName: 'user-turn' });
    const playoutDrained = await waitForPlayout(published.source, published.durationMs + 2_000);
    userTurn = {
      fixturePath: options.turnWavPath,
      wavPath: resolve(artifactsDir, `${label}-user-turn.wav`),
      sampleRate: turn.sampleRate,
      channels: turn.channels,
      durationMs: published.durationMs,
      framesSent: published.framesSent,
      playoutDrained,
      trackSid: published.trackSid,
      microphoneSource: isAgentAudibleSource(published.trackSource),
    };
    log(
      `published        : ${published.framesSent} frames, ${published.durationMs} ms, track=${published.trackSid ?? 'no sid'}, microphoneSource=${userTurn.microphoneSource}, playout drained=${playoutDrained}`,
    );
    // Server-side truth: what the room thinks we published. If the source is not
    // 2 (SOURCE_MICROPHONE) the agent's input stream ignores the track silently.
    const publishedOnServer = await rooms.listParticipants(roomName).catch(() => []);
    for (const participant of publishedOnServer) {
      for (const track of participant.tracks) {
        log(
          `room track       : ${participant.identity} sid=${track.sid} type=${track.type} source=${track.source} name=${track.name}`,
        );
      }
    }

    const response: TurnWaitResult = await waitForTurnEnd({
      frames: () => capture.framesSince(responseStart),
      options: RESPONSE_TURN_END,
      deadlineMs: RESPONSE_DEADLINE_MS,
    });
    // One short flush so the trailing frames of the answer are on disk too.
    await sleep(RESPONSE_FLUSH_MS);
    responseFrames = capture.framesSince(responseStart);
    responseState = response.state;
    responseTimedOut = response.timedOut;
    log(
      `answer           : ${responseFrames.length} frames, ${Math.round(responseState.speechMs)} ms of speech, ${Math.round(responseState.trailingSilenceMs)} ms trailing silence, ended=${responseState.ended}${responseTimedOut ? ' (TIMED OUT)' : ''}`,
    );
  } finally {
    await capture.stop().catch(() => undefined);
    await Promise.race([room.disconnect(), sleep(3_000)]).catch(() => undefined);
    await Promise.race([rooms.deleteRoom(roomName), sleep(2_000)]).catch(() => undefined);
  }

  if (!bind.ok) {
    failures.push('the conversation was never bound, so no turn could be validated');
  }
  if (capture.audioTracksSubscribed === 0) {
    failures.push('no agent audio track was ever subscribed (check the worker logs)');
  }
  if (!greetingState.ended || greetingState.speechMs <= 1_000) {
    failures.push(
      `the greeting did not arrive as speech (speech=${Math.round(greetingState.speechMs)} ms, ended=${greetingState.ended}, timedOut=${greetingTimedOut})`,
    );
  }
  if (!userTurn || userTurn.framesSent === 0 || userTurn.durationMs === 0) {
    failures.push('the user turn was never published');
  } else if (!userTurn.microphoneSource) {
    failures.push('the user turn was not published with the microphone source, so the agent never listened to it');
  }
  if (!responseState.ended || responseState.speechMs < RESPONSE_TURN_END.minSpeechMs) {
    failures.push(
      `the agent did not answer with speech (speech=${Math.round(responseState.speechMs)} ms, ended=${responseState.ended}, timedOut=${responseTimedOut}); transcripts captured: ${transcripts.length === 0 ? 'none (the model never reacted to the turn)' : transcripts.map((line) => `${line.identity}: ${line.text}`).join(' | ')}`,
    );
  }
  for (const error of capture.streamErrors) failures.push(`audio stream error: ${error}`);

  if (writeArtifacts) {
    await mkdir(artifactsDir, { recursive: true });
    if (userTurn) {
      await writeFile(userTurn.wavPath, encodeWav(turn.pcm, turn.sampleRate, turn.channels));
    }
  }

  const greetingReport = buildPhaseReport({
    name: 'greeting',
    frames: greetingFrames,
    state: greetingState,
    timedOut: greetingTimedOut,
    wavPath: writeArtifacts ? resolve(artifactsDir, `${label}-greeting.wav`) : null,
  });
  const responseReport = buildPhaseReport({
    name: 'answer',
    frames: responseFrames,
    state: responseState,
    timedOut: responseTimedOut,
    wavPath: writeArtifacts ? resolve(artifactsDir, `${label}-answer.wav`) : null,
  });

  if (writeArtifacts) {
    if (greetingFrames.length > 0 && greetingReport.wavPath) {
      await writeFile(
        greetingReport.wavPath,
        encodeWav(concatenatePcm(greetingFrames), capture.sampleRate, capture.channels),
      );
    }
    if (responseFrames.length > 0 && responseReport.wavPath) {
      await writeFile(
        responseReport.wavPath,
        encodeWav(concatenatePcm(responseFrames), capture.sampleRate, capture.channels),
      );
    }
  }

  return {
    label,
    roomName,
    agentIdentity,
    bind,
    greeting: greetingReport,
    userTurn: userTurn ?? {
      fixturePath: options.turnWavPath,
      wavPath: '',
      sampleRate: turn.sampleRate,
      channels: turn.channels,
      durationMs: 0,
      framesSent: 0,
      playoutDrained: false,
      trackSid: undefined,
      microphoneSource: false,
    },
    response: responseReport,
    replyLatency: {
      firstFrameMs: offsetOfFirst(responseFrames, () => true, publishStartedAtMs),
      firstSpeechMs: offsetOfFirst(
        responseFrames,
        (frame) => frame.energy.rms >= RESPONSE_TURN_END.speechRmsThreshold,
        publishStartedAtMs,
      ),
    },
    transcripts,
    failures,
    passed: failures.length === 0,
  };
}

function buildPhaseReport(input: {
  name: string;
  frames: readonly CapturedFrame[];
  state: TurnEndState;
  timedOut: boolean;
  wavPath: string | null;
}): PhaseReport {
  const firstSpeech = input.frames.find(
    (frame) => frame.energy.rms >= GREETING_TURN_END.speechRmsThreshold,
  );
  const windowMs = Math.round(
    input.frames.reduce((sum, frame) => sum + frame.energy.durationMs, 0),
  );
  return {
    name: input.name,
    frames: input.frames.length,
    windowMs,
    speechMs: Math.round(input.state.speechMs),
    trailingSilenceMs: Math.round(input.state.trailingSilenceMs),
    leadingSilenceMs: firstSpeech
      ? Math.round(
          input.frames
            .slice(0, input.frames.indexOf(firstSpeech))
            .reduce((sum, frame) => sum + frame.energy.durationMs, 0),
        )
      : null,
    ended: input.state.ended,
    timedOut: input.timedOut,
    wavPath: input.frames.length > 0 ? input.wavPath : null,
  };
}

function offsetOfFirst(
  frames: readonly CapturedFrame[],
  predicate: (frame: CapturedFrame) => boolean,
  sinceMs: number,
): number | null {
  const frame = frames.find(predicate);
  return frame ? Math.max(0, frame.atMs - sinceMs) : null;
}

function emptyState(): TurnEndState {
  return {
    ended: false,
    speechStarted: false,
    speechMs: 0,
    trailingSilenceMs: 0,
    totalMs: 0,
  };
}
