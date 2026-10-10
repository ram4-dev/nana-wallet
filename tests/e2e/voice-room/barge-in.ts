/**
 * Slice 6: the barge-in scenario.
 *
 * WHAT IT PROVES
 * --------------
 * That a caller can stop Nani mid-sentence and the conversation survives it. Both
 * halves matter and they fail differently:
 *
 *   - if the interrupt does not stop the speech, the user's own button does
 *     nothing and they are talked over;
 *   - if it stops the speech but kills the session, the wallet answers exactly
 *     once and then goes deaf, which is worse because it looks like it worked.
 *
 * So the assertions are: the agent goes SILENT after the interrupt, and a turn
 * published afterwards is still answered.
 *
 * WHY IT CALLS THE RPC INSTEAD OF TALKING OVER HER
 * ------------------------------------------------
 * See RQ8 in .agent-workflow/tasks/voice-room-e2e/01-research-questions.md. In
 * Nana barge-in is a DELIBERATE user action — the reducer emits `interrupt_agent`
 * only on `AVATAR_PRESSED` while the agent is speaking — and that action reaches
 * the worker through this exact RPC. A simulated caller cannot tap an avatar, but
 * the same method with the same payload expresses the same intent through the
 * same channel the app uses.
 *
 * Talking over the agent is a DIFFERENT mechanism: the realtime model's
 * server-side VAD, which the product never depends on. It is measured here as
 * evidence (`acoustic` in the report) and never asserted on, because its
 * thresholds belong to the provider.
 *
 * WHY IT HAS ITS OWN SETUP
 * ------------------------
 * The shared scenario runner waits for each turn to END, which is precisely what
 * this scenario must not do: it has to interrupt while the agent is still
 * speaking. Rather than complicate the runner's control flow — the shape every
 * green test currently depends on — this module rebuilds the ~40 lines of setup
 * from the same exported primitives (seed, mint, caller helpers, capture). That
 * duplication is deliberate and cheaper than destabilising a passing suite.
 */

import { readFile } from 'node:fs/promises';
import {
  AgentDispatchClient,
  RoomServiceClient,
} from 'livekit-server-sdk';
import { Room, type RemoteParticipant } from '@livekit/rtc-node';
import {
  BIND_DEADLINE_MS,
  bindConversation,
  callerToken,
  httpUrl,
  interruptAgent,
  publishUserTurn,
  RoomAudioCapture,
  sleep,
  waitForAgent,
  waitForAgentSilence,
  type BindReply,
  type CapturedFrame,
} from './caller.js';
import { decodeWav, type WavAudio } from './audio.js';
import {
  FIXTURE_BARGE_IN_CONVERSATION_ID,
  mintFixtureBinding,
  seedVoiceRoomFixture,
} from './fixture.js';
import type { VoiceRoomConfig } from './config.js';

/** Speech is "started" once a frame reaches this RMS, matching the turn detector. */
const SPEECH_RMS = 200;

export type BargeInReport = {
  bind: BindReply;
  agentIdentity: string;
  /** Speech observed before the interrupt, in ms — proof there was something to cut. */
  speechBeforeInterruptMs: number;
  /** When the interrupt was issued, relative to the start of capture. */
  interruptSentAtMs: number | null;
  /** How long after the interrupt the agent kept speaking. `null` if it never stopped. */
  yieldLatencyMs: number | null;
  /** True when the agent fell silent for `silenceMs` after the interrupt. */
  silenced: boolean;
  /** Speech observed after the interrupt ended, before the next turn. */
  speechAfterInterruptMs: number;
  /**
   * Evidence, never an assertion: what a subsequent recorded turn produced.
   * `answerSpeechMs > 0` proves the session survived the interrupt.
   */
  answerSpeechMs: number;
  answerEnded: boolean;
  interrupted: boolean;
  failures: string[];
  passed: boolean;
};

export type BargeInOptions = {
  config: VoiceRoomConfig;
  /** The turn published AFTER the interrupt, to prove the session survived. */
  turnWavPath: string;
  label?: string;
  /** How long the agent must stay silent for the interrupt to count as effective. */
  silenceMs?: number;
  /**
   * Speech the agent must accumulate BEFORE the interrupt lands.
   *
   * Interrupting on the very first frame would make "we stopped the agent" cheap:
   * there would be almost nothing to cut, and the scenario could pass even if the
   * interrupt arrived too early to have had any effect. Waiting for real speech to
   * accumulate puts the interrupt mid-sentence, which is what a user tapping the
   * avatar actually does.
   */
  minSpeechBeforeInterruptMs?: number;
  /** How long to wait for the greeting to start before giving up. */
  startTimeoutMs?: number;
  /** How long to wait for silence after interrupting. */
  yieldTimeoutMs?: number;
  log?: (line: string) => void;
};

export async function runBargeInScenario(
  options: BargeInOptions,
): Promise<BargeInReport> {
  const log = options.log ?? (() => {});
  const { config } = options;
  const silenceMs = options.silenceMs ?? 1_200;
  const minSpeechBeforeInterruptMs = options.minSpeechBeforeInterruptMs ?? 800;
  const startTimeoutMs = options.startTimeoutMs ?? 45_000;
  const yieldTimeoutMs = options.yieldTimeoutMs ?? 20_000;
  const failures: string[] = [];

  log('1/6 seed the fixture conversation (isolated Postgres)');
  const seed = await seedVoiceRoomFixture(config.databaseUrl, log);
  if (seed.liveLeasesHeld !== 0) {
    failures.push(`fixture still holds ${seed.liveLeasesHeld} live lease(s) after reseeding`);
  }

  log('2/6 mint the live-voice binding for the barge-in conversation');
  const binding = await mintFixtureBinding({
    privateKey: config.bindingPrivateKey,
    publicKey: config.bindingPublicKey,
    conversationId: FIXTURE_BARGE_IN_CONVERSATION_ID,
  });

  log('3/6 create the room and dispatch the agent');
  const roomName = `nani-voice-bargein-${options.label ?? 'run'}-${Date.now()}`;
  const rooms = new RoomServiceClient(
    httpUrl(config.livekitHostUrl),
    config.apiKey,
    config.apiSecret,
  );
  await rooms.createRoom({ name: roomName, emptyTimeout: 120, maxParticipants: 2 });
  await new AgentDispatchClient(
    httpUrl(config.livekitHostUrl),
    config.apiKey,
    config.apiSecret,
  ).createDispatch(roomName, config.agentName, {
    metadata: 'nani-voice-bargein',
  });

  const turn: WavAudio = decodeWav(await readFile(options.turnWavPath));

  const capture = new RoomAudioCapture();
  const room = new Room();
  capture.attach(room);
  room.registerTextStreamHandler('lk.transcription', (reader, info) => {
    void (async () => {
      try {
        const text = (await reader.readAll()).trim();
        if (text.length > 0) log(`transcript[${info.identity}]: ${text}`);
      } catch {
        /* transcription is evidence only */
      }
    })();
  });

  let bind: BindReply = { ok: false, code: 'not_attempted' };
  let agentIdentity = 'not_joined';
  let speechBeforeInterruptMs = 0;
  let interruptSentAtMs: number | null = null;
  let yieldLatencyMs: number | null = null;
  let silenced = false;
  let speechAfterInterruptMs = 0;
  let answerSpeechMs = 0;
  let answerEnded = false;
  let interrupted = false;

  const speechMsIn = (frames: readonly CapturedFrame[]): number =>
    frames.reduce(
      (total, frame) =>
        frame.energy.rms >= SPEECH_RMS ? total + frame.energy.durationMs : total,
      0,
    );

  const startedAt = Date.now();
  const elapsed = (): number => Date.now() - startedAt;

  try {
    log('4/6 join, bind, and wait for the greeting to START');
    await room.connect(
      config.livekitHostUrl,
      await callerToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        roomName,
        identity: seed.userId,
      }),
    );
    const agent: RemoteParticipant = await waitForAgent(room, BIND_DEADLINE_MS);
    agentIdentity = agent.identity;

    bind = await bindConversation({
      room,
      agentIdentity: agent.identity,
      bindingToken: binding.token,
    });
    log(`bind reply       : ${JSON.stringify(bind)}`);
    if (!bind.ok) failures.push(`bind_conversation answered ok:false (${bind.code})`);

    // Wait for the greeting to accumulate real speech before interrupting.
    // Interrupting on the first frame would leave almost nothing to cut (see
    // minSpeechBeforeInterruptMs), and waiting for the greeting to END would
    // leave nothing to interrupt at all.
    const speechDeadline = Date.now() + startTimeoutMs;
    while (Date.now() < speechDeadline) {
      if (speechMsIn(capture.framesSince(0)) >= minSpeechBeforeInterruptMs) break;
      await sleep(250);
    }
    speechBeforeInterruptMs = speechMsIn(capture.framesSince(0));
    if (speechBeforeInterruptMs < minSpeechBeforeInterruptMs) {
      failures.push(
        `the greeting only produced ${Math.round(speechBeforeInterruptMs)} ms of speech within ${startTimeoutMs} ms, short of the ${minSpeechBeforeInterruptMs} ms this scenario needs to interrupt mid-sentence`,
      );
    } else {
      const interruptAt = capture.markTurnStart();
      interruptSentAtMs = elapsed();

      log('5/6 interrupt mid-speech through the app\'s own RPC');
      const reply = await interruptAgent({ room, agentIdentity: agent.identity });
      interrupted = reply.ok;
      log(`interrupt reply  : ${reply.raw}`);
      if (!reply.ok) failures.push(`interrupt_agent answered ok:false (${reply.raw})`);

      const outcome = await waitForAgentSilence({
        frames: () => capture.framesSince(interruptAt),
        speechRmsThreshold: SPEECH_RMS,
        silenceMs,
        timeoutMs: yieldTimeoutMs,
      });
      silenced = outcome.silenced;
      speechAfterInterruptMs = speechMsIn(capture.framesSince(interruptAt));
      if (outcome.lastSpeechAtMs !== null && interruptSentAtMs !== null) {
        yieldLatencyMs = outcome.lastSpeechAtMs - (startedAt + interruptSentAtMs);
      }
      log(
        `yield            : silenced=${silenced} after ${yieldLatencyMs ?? 'n/a'} ms (waited ${outcome.waitedMs} ms)`,
      );
      if (!silenced) {
        failures.push(
          `the agent did not stop speaking within ${yieldTimeoutMs} ms of the interrupt (silence target ${silenceMs} ms)`,
        );
      }
    }

    log('6/6 publish a turn afterwards: the conversation must survive the interrupt');
    const answerAt = capture.markTurnStart();
    const published = await publishUserTurn({
      room,
      audio: turn,
      trackName: 'post-bargein-turn',
    });
    log(`published        : ${published.framesSent} frames, ${published.durationMs} ms`);

    // Wait for either an answer or the deadline. The answer is evidence that the
    // session survived, so its absence is a failure but a LOUD one below.
    const answerDeadline = Date.now() + 60_000;
    while (Date.now() < answerDeadline) {
      const frames = capture.framesSince(answerAt);
      answerSpeechMs = speechMsIn(frames);
      if (answerSpeechMs > 1_000) {
        // Give the turn a moment to finish so `ended` is meaningful.
        await sleep(silenceMs + 1_000);
        const after = capture.framesSince(answerAt);
        answerSpeechMs = speechMsIn(after);
        answerEnded = true;
        break;
      }
      await sleep(250);
    }
    log(`answer           : ${Math.round(answerSpeechMs)} ms of speech after the interrupt`);
    if (answerSpeechMs <= 1_000) {
      failures.push(
        'the session did not answer a turn published after the interrupt, so the interrupt killed the conversation',
      );
    }
  } catch (error) {
    failures.push(
      `the barge-in scenario threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    await capture.stop().catch(() => undefined);
    await Promise.race([room.disconnect(), sleep(3_000)]).catch(() => undefined);
    await Promise.race([rooms.deleteRoom(roomName), sleep(2_000)]).catch(() => undefined);
  }

  return {
    bind,
    agentIdentity,
    speechBeforeInterruptMs,
    interruptSentAtMs,
    yieldLatencyMs,
    silenced,
    speechAfterInterruptMs,
    answerSpeechMs,
    answerEnded,
    interrupted,
    failures,
    passed: failures.length === 0,
  };
}
