import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ARTIFACTS_DIR,
  FIXTURES_DIR,
  TRANSFER_CANCEL_FIXTURE,
  TRANSFER_CONFIRM_FIXTURE,
  TRANSFER_REQUEST_FIXTURE,
  describeMissingCredentials,
  injectWorktreeCredentials,
  preflightVoiceRoomStack,
  resolveVoiceRoomConfig,
} from './config.js';
import {
  FIXTURE_CANCEL_CONVERSATION_ID,
  FIXTURE_TRANSFER_CONVERSATION_ID,
  FIXTURE_USER_ID,
} from './fixture.js';
import { seedFixtureRecipientMemory } from './recipient-fixture.js';
import { runVoiceRoomScenario, type VoiceRoomScenarioReport } from './roundtrip.js';
import { waitForTransferSettlement } from './transfer-state.js';
import { ConversationTransferState, describeTransferState } from './transfer-state.js';

/**
 * Slice 4: assert the BACKEND STATE a voice conversation leaves behind.
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Every other voice-room assertion is about audio: Nani was heard, the caller
 * was heard, an answer arrived. None of them can tell a transfer that actually
 * happened from a transfer that was merely narrated — and "the agent said it did
 * it" is exactly the claim that moves real money without moving it, or moves it
 * without saying so.
 *
 * So this spec reads `public.conversation_transfer_attempts` (the state table,
 * src/db/migrations/002_conversations.sql:36) after two real spoken scenarios and
 * asserts the DISCRIMINATING PAIR:
 *
 *   - CONFIRMED: a row reached 'confirmed'. The assertion is on that row, never
 *     on the agent having spoken.
 *   - CANCELLED: NO row is left active ('previewed'/'broadcasting'/'submitted'/
 *     'uncertain') and NO row reached 'confirmed'. This negative assertion is the
 *     one that catches a transfer that should never have been broadcast, so it is
 *     not optional and it is not softened.
 *
 * The cancelled scenario ALSO asserts that a transfer was actually staged (a row
 * exists at all). Without that, "no transfer is left behind" would be true and
 * meaningless whenever the request turn never produced a preview — the vacuous
 * green this slice exists to prevent.
 *
 * HONESTY
 * -------
 * The confirmed path has to line up recipient resolution, the preview, the
 * spoken-decision gate and the (fixture-mode) broadcast. If it does not, this
 * test is SUPPOSED to go red with the observed status written down, not to be
 * weakened. See docs/voice-room-e2e-runbook.md for the observed state.
 *
 * WIRING
 * ------
 * It runs under the suite config (`npm run test:e2e:voice-room`), which includes
 * `tests/e2e/voice-room/**\/*.test.ts`. It injects credentials explicitly and
 * fails loudly if the stack or a credential is missing — never a silent skip.
 */

const injection = injectWorktreeCredentials();
const resolved = resolveVoiceRoomConfig();

const REQUEST_WAV = resolve(FIXTURES_DIR, TRANSFER_REQUEST_FIXTURE);
const CONFIRM_WAV = resolve(FIXTURES_DIR, TRANSFER_CONFIRM_FIXTURE);
const CANCEL_WAV = resolve(FIXTURES_DIR, TRANSFER_CANCEL_FIXTURE);

let transferState: ConversationTransferState;
let recipientAddress = '';
let recipientName = '';

describe('voice room backend state — the transfer discriminating pair', () => {
  beforeAll(async () => {
    if (!resolved.ok) {
      throw new Error(describeMissingCredentials(resolved.missing, injection));
    }
    for (const [name, path] of [
      [TRANSFER_REQUEST_FIXTURE, REQUEST_WAV],
      [TRANSFER_CONFIRM_FIXTURE, CONFIRM_WAV],
      [TRANSFER_CANCEL_FIXTURE, CANCEL_WAV],
    ] as const) {
      if (!existsSync(path)) {
        throw new Error(
          `voice-room e2e: the transfer fixture ${name} is missing at ${path}. Generate it with "npm run e2e:voice-room:fixtures" and commit it.`,
        );
      }
    }

    await preflightVoiceRoomStack(resolved.config);

    // The recipient the recorded turn names has to EXIST in the fixture user's
    // memory, or the request turn can never preview a transfer. Seeded once for
    // both scenarios from the same code path `npm run db:seed` uses.
    const seeded = await seedFixtureRecipientMemory({
      databaseUrl: resolved.config.databaseUrl,
      userId: FIXTURE_USER_ID,
      log: (line) => console.log(line),
    });
    recipientName = seeded.name;
    recipientAddress = seeded.address;

    transferState = new ConversationTransferState(resolved.config.databaseUrl);
  }, 300_000);

  afterAll(async () => {
    await transferState?.close();
  });

  it('a confirmed transfer leaves a row at status confirmed', async () => {
    const report = await runConfirmedScenario();
    logScenario(report);

    // First: the scenario itself has to have happened. A confirmation cannot be
    // discussed if the caller was never heard.
    expect(report.passed, scenarioDetail(report)).toBe(true);

    const snapshot = await transferState.read(FIXTURE_TRANSFER_CONVERSATION_ID);
    const observed = describeTransferState(snapshot);
    console.log(`confirmed state : ${observed}`);

    // The assertion this slice exists for: the BACKEND says confirmed. It is on
    // the row, not on the agent having spoken about it.
    expect(
      snapshot.confirmed.length,
      `the confirmed scenario left no 'confirmed' transfer attempt row. ${observed}; recipient seeded: ${recipientName} (${recipientAddress})`,
    ).toBe(1);

    const row = snapshot.confirmed[0]!;
    expect(row.transactionHash, `the confirmed row carries a transaction hash: ${observed}`).toBeTruthy();
    expect(
      snapshot.active,
      `a confirmed transfer must not be left in an active state too: ${observed}`,
    ).toHaveLength(0);
  }, 480_000);

  it('a cancelled transfer leaves NO transfer behind', async () => {
    const report = await runCancelScenario();
    logScenario(report);

    expect(report.passed, scenarioDetail(report)).toBe(true);

    const snapshot = await transferState.read(FIXTURE_CANCEL_CONVERSATION_ID);
    const observed = describeTransferState(snapshot);
    console.log(`cancelled state : ${observed}`);

    // Non-vacuity: a cancellation proves nothing unless a transfer was actually
    // staged for it to cancel.
    expect(
      snapshot.attempts.length,
      `no transfer attempt row was ever created, so this scenario proves nothing (the request turn never previewed a transfer). ${observed}; recipient seeded: ${recipientName} (${recipientAddress})`,
    ).toBeGreaterThan(0);

    // The negative assertion: no money can move from a cancelled conversation.
    expect(
      snapshot.active.length,
      `no transfer attempt may be left ACTIVE after a cancellation. ${observed}`,
    ).toBe(0);
    expect(
      snapshot.confirmed.length,
      `no transfer attempt may reach 'confirmed' after a cancellation. ${observed}`,
    ).toBe(0);
  }, 480_000);
});

async function runConfirmedScenario(): Promise<VoiceRoomScenarioReport> {
  if (!resolved.ok) throw new Error(describeMissingCredentials(resolved.missing, injection));
  return runVoiceRoomScenario({
    config: resolved.config,
    conversationId: FIXTURE_TRANSFER_CONVERSATION_ID,
    turnWavPaths: [REQUEST_WAV, CONFIRM_WAV],
    label: 'transfer-confirmed',
    artifactsDir: ARTIFACTS_DIR,
    log: (line) => console.log(`  ${line}`),
    // The broadcast outlives the spoken answer; wait for it with the room open.
    afterTurns: async () => {
      await waitForTransferSettlement({
        state: transferState,
        conversationId: FIXTURE_TRANSFER_CONVERSATION_ID,
        log: (line) => console.log(`  ${line}`),
      });
    },
  });
}

async function runCancelScenario(): Promise<VoiceRoomScenarioReport> {
  if (!resolved.ok) throw new Error(describeMissingCredentials(resolved.missing, injection));
  return runVoiceRoomScenario({
    config: resolved.config,
    conversationId: FIXTURE_CANCEL_CONVERSATION_ID,
    turnWavPaths: [REQUEST_WAV, CANCEL_WAV],
    label: 'transfer-cancelled',
    artifactsDir: ARTIFACTS_DIR,
    log: (line) => console.log(`  ${line}`),
    afterTurns: async () => {
      await waitForTransferSettlement({
        state: transferState,
        conversationId: FIXTURE_CANCEL_CONVERSATION_ID,
        log: (line) => console.log(`  ${line}`),
      });
    },
  });
}

function scenarioDetail(report: VoiceRoomScenarioReport): string {
  const failures = report.failures.length > 0 ? `\n  - ${report.failures.join('\n  - ')}` : '';
  const transcripts = report.transcripts.map((line) => `${line.identity}: ${line.text}`).join(' | ');
  return `${report.failures.length} failure(s)${failures}\ntranscripts: ${transcripts || 'none'}`;
}

function logScenario(report: VoiceRoomScenarioReport): void {
  console.log(
    [
      `bind              : ${JSON.stringify(report.bind)}`,
      `greeting          : ${Math.round(report.greeting.speechMs)} ms of speech`,
      ...report.turns.map(
        (turn) =>
          `turn ${turn.index} (${turn.fixturePath.split('/').pop()}): ${turn.framesSent} frames sent, answer ${Math.round(turn.answer.speechMs)} ms of speech (ended=${turn.answer.ended})`,
      ),
      `wavs              : ${report.greeting.wavPath ?? 'n/a'} | ${report.turns
        .map((turn) => turn.answer.wavPath ?? 'n/a')
        .join(' | ')}`,
    ].join('\n'),
  );
}
