import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ARTIFACTS_DIR,
  DEFAULT_TURN_FIXTURE,
  FIXTURES_DIR,
  describeMissingCredentials,
  injectWorktreeCredentials,
  preflightVoiceRoomStack,
  resolveVoiceRoomConfig,
} from './config.js';
import { runVoiceRoomRoundTrip } from './roundtrip.js';

/**
 * The voice-room end-to-end suite.
 *
 * This is the only test in the repository that puts a real conversation through
 * the real path: room -> worker -> binding RPC -> AgentSession -> spoken answer.
 * Everything else either talks to the model directly (evals/voice/realtime) or
 * never joins a room (tests/e2e/livekit-smoke.e2e.test.ts).
 *
 * WHY IT IS NOT PART OF `npm test`
 * --------------------------------
 * It needs a live isolated stack and paid provider credentials, so it is excluded
 * from the default run and driven by its own config:
 *   npm run test:e2e:voice-room
 *
 * CREDENTIALS ARE INJECTED, NEVER INHERITED
 * -----------------------------------------
 * `injectWorktreeCredentials()` reads the git-ignored .env explicitly. The root
 * suite's isolation setup deletes the LIVEKIT and OPENAI keys precisely so
 * ambient files cannot silently change behaviour, so this suite opts back in on
 * purpose rather than by accident.
 *
 * IT FAILS LOUDLY AND NEVER SKIPS
 * -------------------------------
 * A skip here would be a lie: a voice path that silently stops running looks
 * exactly like a voice path that passes. If the stack is down or a credential is
 * missing, this must go red and say which one.
 */

// Injected before anything reads process.env, and deliberately at module scope so
// a missing .env fails the whole file rather than one test.
const injection = injectWorktreeCredentials();
const resolved = resolveVoiceRoomConfig();

describe('voice room end-to-end', () => {
  it('publishes a recorded user turn and captures a spoken answer', async () => {
    if (!resolved.ok) {
      throw new Error(describeMissingCredentials(resolved.missing, injection));
    }

    const turnWavPath = resolve(FIXTURES_DIR, DEFAULT_TURN_FIXTURE);
    if (!existsSync(turnWavPath)) {
      throw new Error(
        `voice-room e2e: the user-turn fixture is missing at ${turnWavPath}. Generate it with "npm run e2e:voice-room:fixtures".`,
      );
    }

    // Before doing any work: is the stack actually up? This turns a cryptic
    // ECONNREFUSED from an arbitrary later call into a message that names the
    // missing dependency and the command that starts it.
    await preflightVoiceRoomStack(resolved.config);

    const report = await runVoiceRoomRoundTrip({
      config: resolved.config,
      turnWavPath,
      label: 'vitest',
      artifactsDir: ARTIFACTS_DIR,
    });

    // The report already carries a precise reason per phase; surfacing it here
    // keeps a red run diagnosable without re-reading the WAVs.
    const detail = report.failures.length > 0 ? `\n  - ${report.failures.join('\n  - ')}` : '';
    expect(report.bind.ok, `bind_conversation refused the caller${detail}`).toBe(true);

    // Assertions are deliberately on OUTCOMES, not on exact durations: the model is
    // generative, so greeting and answer lengths vary run to run. What must hold is
    // that speech arrived on both sides, that the turn was published as microphone
    // audio, and that the agent answered after it.
    expect(
      report.greeting.speechMs,
      `the greeting arrived as speech with the end detected by silence${detail}`,
    ).toBeGreaterThan(1_000);
    expect(report.greeting.ended, `the greeting turn ended on silence, not on a timeout${detail}`).toBe(
      true,
    );

    expect(report.userTurn.framesSent, `the user turn was published${detail}`).toBeGreaterThan(0);
    expect(
      report.userTurn.microphoneSource,
      `the user turn was published with the microphone source, without which the agent's input ignores the track${detail}`,
    ).toBe(true);
    expect(
      report.userTurn.playoutDrained,
      `the caller finished transmitting the turn instead of racing the capture${detail}`,
    ).toBe(true);

    expect(
      report.response.speechMs,
      `the agent answered the published turn with speech${detail}`,
    ).toBeGreaterThan(1_000);
    expect(report.response.ended, `the answer turn ended on silence${detail}`).toBe(true);

    expect(report.passed, `the round trip reported overall success${detail}`).toBe(true);

    // Evidence for a human, printed on green runs too.
    console.log(
      [
        `bind              : ${JSON.stringify(report.bind)}`,
        `greeting          : ${Math.round(report.greeting.speechMs)} ms of speech`,
        `user turn         : ${report.userTurn.framesSent} frames, ${report.userTurn.durationMs} ms`,
        `answer            : ${Math.round(report.response.speechMs)} ms of speech`,
        `first answer frame: ${report.replyLatency.firstFrameMs ?? 'n/a'} ms after publish`,
        `wavs              : ${report.greeting.wavPath ?? 'n/a'} | ${report.response.wavPath ?? 'n/a'}`,
      ].join('\n'),
    );
  }, 240_000);
});
