/**
 * The user-turn round trip against the real stack.
 *
 * This is the code every consumer shares: the standalone script
 * (`scripts/voice-room-roundtrip.ts`, which repeats it three times for the
 * determinism spread and writes the artifacts) and the vitest specs (which
 * assert on the same report instead of re-implementing the handshake). Keeping
 * one implementation is the point: the handshake has three paid-for traps in it
 * (see caller.ts) and duplicating it would duplicate them.
 *
 * TWO ENTRY POINTS, ONE ENGINE
 * ----------------------------
 * A transfer needs a SEQUENCE of recorded user turns (request, then confirm or
 * cancel), each one waiting for the previous answer to end on silence before the
 * next is published. So the engine is `runVoiceRoomScenario`, which takes a LIST
 * of turn WAVs, and `runVoiceRoomRoundTrip` is the single-turn shorthand the
 * balance scenario has always used. Nothing about the transfer is special-cased:
 * a scenario is a list of recorded turns and a label.
 *
 * WHAT IS ASSERTED VS WHAT IS EVIDENCE (see the design doc, 03-design-discussion):
 *   - asserted: the worker resolved the binding, audio arrived on both sides, the
 *     recorded turns have real speech in them, and the agent answered each one
 *     with real speech; a transfer scenario additionally asserts on the BACKEND
 *     state it left (see transfer-state.ts), which lives in the spec, not here;
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
import { FIXTURE_CONVERSATION_ID, mintFixtureBinding, seedVoiceRoomFixture } from './fixture.js';
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

/** One recorded user turn inside a scenario, with the answer it produced. */
export type ScenarioTurnReport = {
  /** 1-based position in the scenario. */
  index: number;
  fixturePath: string;
  /** Absolute path of the written user-turn artifact, or null (no artifacts requested). */
  userWavPath: string | null;
  durationMs: number;
  framesSent: number;
  playoutDrained: boolean;
  microphoneSource: boolean;
  /** The agent's spoken answer to THIS turn. */
  answer: PhaseReport;
  /** Latency from publish to the first captured frame / first speech frame. */
  latency: { firstFrameMs: number | null; firstSpeechMs: number | null };
  /** True when the answer turn was cut off by the deadline (a real failure). */
  timedOut: boolean;
};

export type VoiceRoomScenarioReport = {
  label: string;
  roomName: string;
  agentIdentity: string;
  bind: BindReply;
  /** The greeting always runs first; a scenario starts from a bound, greeted session. */
  greeting: PhaseReport;
  turns: ScenarioTurnReport[];
  transcripts: TranscriptLine[];
  failures: string[];
  passed: boolean;
};

export type ScenarioOptions = {
  config: VoiceRoomConfig;
  /** Absolute paths to the committed user-turn WAV fixtures, in publish order. */
  turnWavPaths: readonly string[];
  /**
   * The conversation the binding targets. Defaults to the fixture conversation;
   * the transfer scenarios pass their own so the confirmed/cancelled pair is
   * independent (see fixture.ts FIXTURE_CONVERSATION_IDS).
   */
  conversationId?: string;
  label?: string;
  artifactsDir?: string;
  log?: (line: string) => void;
  writeArtifacts?: boolean;
  /**
   * Runs after every turn has been published and answered, but BEFORE the room is
   * torn down.
   *
   * WHY THIS HOOK EXISTS
   * --------------------
   * A spoken confirmation is not the same as a settled transfer. When the caller
   * says yes, the agent acknowledges, and the BROADCAST that follows outlives the
   * turn: tearing the room down the moment the answer stops leaves the confirm in
   * flight and the row stuck at `previewed`, which reads exactly like an agent
   * that never acted.
   *
   * So a scenario that asserts on backend state gets to wait for that state to
   * settle while the room is still up, instead of racing the teardown.
   */
  afterTurns?: () => Promise<void>;
};

export type RoundTripOptions = {
  config: VoiceRoomConfig;
  /** Absolute path to the committed user-turn WAV fixture. */
  turnWavPath: string;
  conversationId?: string;
  label?: string;
  artifactsDir?: string;
  log?: (line: string) => void;
  writeArtifacts?: boolean;
};

/**
 * Runs a scenario: seed → bind → greet → publish each recorded turn in order and
 * capture the answer to each.
 *
 * One room and one session for the whole scenario: a transfer request and its
 * confirmation MUST happen in the same conversation, and a fresh room per turn
 * would reset the pending preview the second turn depends on.
 */
export async function runVoiceRoomScenario(
  options: ScenarioOptions,
): Promise<VoiceRoomScenarioReport> {
  const log = options.log ?? (() => {});
  const label = options.label ?? 'run';
  const artifactsDir = options.artifactsDir ?? ARTIFACTS_DIR;
  const writeArtifacts = options.writeArtifacts ?? true;
  const { config } = options;

  if (options.turnWavPaths.length === 0) {
    throw new Error('runVoiceRoomScenario: at least one turn WAV is required');
  }
  // The single-turn harness has always named its artifacts `<label>-user-turn.wav`
  // and `<label>-answer.wav`; a multi-turn scenario uses `<label>-turn<N>-…` so
  // the artifacts of each turn are distinguishable. Preserved verbatim for the
  // single-turn case so nothing the existing script prints changed.
  const singleTurn = options.turnWavPaths.length === 1;
  const artifactName = (
    position: number,
    kind: 'user' | 'answer',
  ): string => (singleTurn ? `${label}-${kind === 'user' ? 'user-turn' : 'answer'}.wav` : `${label}-turn${position}-${kind}.wav`);

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
    conversationId: options.conversationId ?? FIXTURE_CONVERSATION_ID,
  });
  log(
    `binding          : sub=${binding.claims.sub} conversationId=${binding.claims.conversationId} jti=${binding.claims.jti} exp=${binding.claims.exp}`,
  );

  log('3/7 create the room and dispatch the agent');
  const roomName = `nani-voice-scenario-${label}-${Date.now()}`;
  const rooms = new RoomServiceClient(httpUrl(config.livekitHostUrl), config.apiKey, config.apiSecret);
  await rooms.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 });
  const dispatch = await new AgentDispatchClient(
    httpUrl(config.livekitHostUrl),
    config.apiKey,
    config.apiSecret,
  ).createDispatch(roomName, config.agentName, { metadata: `nani-voice-scenario:${label}` });
  log(`room             : ${roomName}`);
  log(`dispatch         : ${dispatch.id} for agent "${config.agentName}"`);

  // Decode every turn up front: a malformed fixture must fail before a room is
  // created, and the duration is evidence the spec prints.
  const turns: Array<{ path: string; audio: WavAudio }> = [];
  for (const turnWavPath of options.turnWavPaths) {
    const audio = decodeWav(await readFile(turnWavPath));
    turns.push({ path: turnWavPath, audio });
    log(
      `user turn ${turns.length}      : ${turnWavPath} (${pcmDurationMs(audio.pcm, audio.sampleRate, audio.channels)} ms, ${audio.sampleRate} Hz, ${audio.channels} ch)`,
    );
  }

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
  const turnReports: ScenarioTurnReport[] = [];
  // Frames per turn, kept only so the artifacts on disk hold the real audio. The
  // report itself carries numbers, never buffers.
  const answerFramesByTurn = new Map<number, readonly CapturedFrame[]>();

  try {
    log('4/7 join the room as the binding subject');
    await room.connect(
      config.livekitHostUrl,
      await callerToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        roomName,
        identity: binding.claims.sub,
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

    log(`7/7 publish ${turns.length} recorded turn(s) and capture each answer`);
    for (let index = 0; index < turns.length; index += 1) {
      const turn = turns[index]!;
      const position = index + 1;
      log(`--- turn ${position}/${turns.length}: ${turn.path}`);
      const answerStart = capture.markTurnStart();
      const publishStartedAtMs = Date.now();

      const published = await publishUserTurn({
        room,
        audio: turn.audio,
        trackName: `user-turn-${position}`,
      });
      const playoutDrained = await waitForPlayout(published.source, published.durationMs + 2_000);
      const microphoneSource = isAgentAudibleSource(published.trackSource);
      log(
        `published        : ${published.framesSent} frames, ${published.durationMs} ms, track=${published.trackSid ?? 'no sid'}, microphoneSource=${microphoneSource}, playout drained=${playoutDrained}`,
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

      const answer: TurnWaitResult = await waitForTurnEnd({
        frames: () => capture.framesSince(answerStart),
        options: RESPONSE_TURN_END,
        deadlineMs: RESPONSE_DEADLINE_MS,
      });
      // One short flush so the trailing frames of the answer are on disk too.
      await sleep(RESPONSE_FLUSH_MS);
      const answerFrames = capture.framesSince(answerStart);
      answerFramesByTurn.set(position, answerFrames);
      log(
        `answer           : ${answerFrames.length} frames, ${Math.round(answer.state.speechMs)} ms of speech, ${Math.round(answer.state.trailingSilenceMs)} ms trailing silence, ended=${answer.state.ended}${answer.timedOut ? ' (TIMED OUT)' : ''}`,
      );

      turnReports.push({
        index: position,
        fixturePath: turn.path,
        userWavPath: writeArtifacts ? resolve(artifactsDir, artifactName(position, 'user')) : null,
        durationMs: published.durationMs,
        framesSent: published.framesSent,
        playoutDrained,
        microphoneSource,
        answer: buildPhaseReport({
          name: `turn ${position} answer`,
          frames: answerFrames,
          state: answer.state,
          timedOut: answer.timedOut,
          wavPath: writeArtifacts ? resolve(artifactsDir, artifactName(position, 'answer')) : null,
        }),
        latency: {
          firstFrameMs: offsetOfFirst(answerFrames, () => true, publishStartedAtMs),
          firstSpeechMs: offsetOfFirst(
            answerFrames,
            (frame) => frame.energy.rms >= RESPONSE_TURN_END.speechRmsThreshold,
            publishStartedAtMs,
          ),
        },
        timedOut: answer.timedOut,
      });

      if (writeArtifacts) {
        await mkdir(artifactsDir, { recursive: true });
        await writeFile(
          resolve(artifactsDir, artifactName(position, 'user')),
          encodeWav(turn.audio.pcm, turn.audio.sampleRate, turn.audio.channels),
        );
      }
      if (!answer.state.ended || answer.state.speechMs < RESPONSE_TURN_END.minSpeechMs) {
        // The next turn would answer nothing. Stop the sequence and report: the
        // transcripts recorded so far are what make this diagnosable.
        failures.push(
          `turn ${position}: the agent did not answer with speech (speech=${Math.round(answer.state.speechMs)} ms, ended=${answer.state.ended}, timedOut=${answer.timedOut}); transcripts so far: ${transcripts.length === 0 ? 'none (the model never reacted to the turn)' : transcripts.map((line) => `${line.identity}: ${line.text}`).join(' | ')}`,
        );
        break;
      }
    }

    // With the room still up: let any last-mile work (a broadcast, a ledger
    // write) finish before teardown can cut it short. Only fires when the turn
    // loop reached its end without breaking on a failed answer.
    if (options.afterTurns && failures.length === 0) {
      await options.afterTurns();
    }
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
  if (turnReports.length < turns.length) {
    failures.push(
      `the scenario stopped after ${turnReports.length}/${turns.length} turn(s); the remaining turns were never published`,
    );
  }
  for (const turn of turnReports) {
    if (turn.framesSent === 0 || turn.durationMs === 0) {
      failures.push(`turn ${turn.index}: the user turn was never published`);
    } else if (!turn.microphoneSource) {
      failures.push(
        `turn ${turn.index}: the user turn was not published with the microphone source, so the agent never listened to it`,
      );
    }
  }
  for (const error of capture.streamErrors) failures.push(`audio stream error: ${error}`);

  const greetingReport = buildPhaseReport({
    name: 'greeting',
    frames: greetingFrames,
    state: greetingState,
    timedOut: greetingTimedOut,
    wavPath: writeArtifacts ? resolve(artifactsDir, `${label}-greeting.wav`) : null,
  });

  if (writeArtifacts) {
    await mkdir(artifactsDir, { recursive: true });
    if (greetingFrames.length > 0 && greetingReport.wavPath) {
      await writeFile(
        greetingReport.wavPath,
        encodeWav(concatenatePcm(greetingFrames), capture.sampleRate, capture.channels),
      );
    }
    for (const turn of turnReports) {
      const frames = answerFramesByTurn.get(turn.index);
      if (turn.answer.wavPath && frames && frames.length > 0) {
        await writeFile(
          turn.answer.wavPath,
          encodeWav(concatenatePcm(frames), capture.sampleRate, capture.channels),
        );
      }
    }
  }

  return {
    label,
    roomName,
    agentIdentity,
    bind,
    greeting: greetingReport,
    turns: turnReports,
    transcripts,
    failures,
    passed: failures.length === 0,
  };
}

/**
 * Single-turn shorthand used by the balance scenario.
 *
 * It runs the same engine with one turn and adapts the result to the report the
 * existing script and spec have always consumed, so adding multi-turn support
 * changed no observable behaviour for them (artifact names included).
 */
export async function runVoiceRoomRoundTrip(
  options: RoundTripOptions,
): Promise<VoiceRoomRoundTripReport> {
  const log = options.log ?? (() => {});
  const label = options.label ?? 'run';
  const artifactsDir = options.artifactsDir ?? ARTIFACTS_DIR;
  const scenario = await runVoiceRoomScenario({
    config: options.config,
    turnWavPaths: [options.turnWavPath],
    ...(options.conversationId ? { conversationId: options.conversationId } : {}),
    label,
    artifactsDir,
    log,
    ...(options.writeArtifacts !== undefined ? { writeArtifacts: options.writeArtifacts } : {}),
  });

  const turn = scenario.turns[0];
  const audio = decodeWav(await readFile(options.turnWavPath));
  const userTurn: UserTurnReport = {
    fixturePath: options.turnWavPath,
    wavPath: turn?.userWavPath ?? '',
    sampleRate: audio.sampleRate,
    channels: audio.channels,
    durationMs: turn?.durationMs ?? 0,
    framesSent: turn?.framesSent ?? 0,
    playoutDrained: turn?.playoutDrained ?? false,
    trackSid: undefined,
    microphoneSource: turn?.microphoneSource ?? false,
  };

  return {
    label: scenario.label,
    roomName: scenario.roomName,
    agentIdentity: scenario.agentIdentity,
    bind: scenario.bind,
    greeting: scenario.greeting,
    userTurn,
    response: turn?.answer ?? emptyPhaseReport('answer'),
    replyLatency: turn?.latency ?? { firstFrameMs: null, firstSpeechMs: null },
    transcripts: scenario.transcripts,
    failures: scenario.failures,
    passed: scenario.passed,
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

function emptyPhaseReport(name: string): PhaseReport {
  return {
    name,
    frames: 0,
    windowMs: 0,
    speechMs: 0,
    trailingSilenceMs: 0,
    leadingSilenceMs: null,
    ended: false,
    timedOut: false,
    wavPath: null,
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
