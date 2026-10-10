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
import { runBargeInScenario, type BargeInReport } from './barge-in.js';

/**
 * The barge-in scenario (Slice 6): the caller stops Nani mid-sentence, and the
 * conversation must survive it.
 *
 * See tests/e2e/voice-room/barge-in.ts for why this calls the `interrupt_agent`
 * RPC rather than talking over the agent, and RQ8 in the design docs for the
 * product reasoning behind that choice.
 *
 * Same contract as the other voice-room specs: credentials injected explicitly,
 * loud failure, never a silent skip.
 */

const injection = injectWorktreeCredentials();
const resolved = resolveVoiceRoomConfig();

function detail(report: BargeInReport): string {
  const lines = [
    `bind=${JSON.stringify(report.bind)}`,
    `speech before interrupt=${Math.round(report.speechBeforeInterruptMs)} ms`,
    `interrupted=${report.interrupted}`,
    `silenced=${report.silenced} after ${report.yieldLatencyMs ?? 'n/a'} ms`,
    `speech after interrupt=${Math.round(report.speechAfterInterruptMs)} ms`,
    `answer after interrupt=${Math.round(report.answerSpeechMs)} ms`,
  ];
  return lines.join('; ');
}

describe('voice room barge-in', () => {
  it('stops the agent mid-speech and keeps the conversation alive', async () => {
    if (!resolved.ok) {
      throw new Error(describeMissingCredentials(resolved.missing, injection));
    }

    const turnWavPath = resolve(FIXTURES_DIR, DEFAULT_TURN_FIXTURE);
    if (!existsSync(turnWavPath)) {
      throw new Error(
        `voice-room e2e: the user-turn fixture is missing at ${turnWavPath}. Generate it with "npm run e2e:voice-room:fixtures".`,
      );
    }

    await preflightVoiceRoomStack(resolved.config);

    const report = await runBargeInScenario({
      config: resolved.config,
      turnWavPath,
      label: 'vitest',
      log: (line) => console.log(`  ${line}`),
    });
    console.log(`barge-in         : ${detail(report)}`);

    const why = report.failures.length > 0 ? `\n  - ${report.failures.join('\n  - ')}` : '';

    // Preconditions: without these the assertions below would be vacuous, and a
    // barge-in that was never attempted must not read as a pass.
    expect(report.bind.ok, `bind_conversation accepted the caller${why}`).toBe(true);
    expect(
      report.speechBeforeInterruptMs,
      `the agent was speaking when we interrupted, so there was something to cut${why}`,
    ).toBeGreaterThan(0);
    expect(report.interrupted, `the interrupt_agent RPC was accepted${why}`).toBe(true);

    // The assertion this scenario exists for: the agent STOPPED.
    expect(
      report.silenced,
      `the agent fell silent after the interrupt instead of talking over the user${why}`,
    ).toBe(true);

    // And the half that fails worse when it breaks: the session is still usable.
    expect(
      report.answerSpeechMs,
      `the conversation answered a turn published after the interrupt${why}`,
    ).toBeGreaterThan(1_000);

    expect(report.passed, `the barge-in scenario reported overall success${why}`).toBe(true);

    // Evidence, printed on green runs too. The acoustic path is deliberately not
    // asserted on: it belongs to the provider's VAD, not to this product.
    console.log(
      [
        `yield latency    : ${report.yieldLatencyMs ?? 'n/a'} ms from interrupt to silence`,
        `artifacts        : ${ARTIFACTS_DIR}`,
      ].join('\n'),
    );
  }, 300_000);
});
