#!/usr/bin/env node
/**
 * Slice 3 spike: the FULL user turn round trip against the real stack.
 *
 * Question it answers: after Nani's greeting, can the caller publish a
 * pre-recorded user turn as microphone audio and capture Nani's spoken ANSWER —
 * with the end of both turns detected by SILENCE, not by a fixed sleep?
 *
 * It extends scripts/voice-room-spike.ts (Slice 2: greeting only) rather than
 * replacing it: the seed / bind / join logic now lives in
 * tests/e2e/voice-room/ so the script and the vitest spec share one
 * implementation of a handshake that has three paid-for traps in it.
 *
 * Run: npm run test:e2e:voice-room-roundtrip
 *
 * Requires (names only, values are never printed):
 *   - LIVEKIT_API_KEY / LIVEKIT_API_SECRET      (host-side room + dispatch)
 *   - LIVE_VOICE_BINDING_PRIVATE_KEY            (the signer it reuses)
 *   - LIVE_VOICE_BINDING_PUBLIC_KEY             (local fail-fast pre-check)
 *   - OPENAI_API_KEY                            (the WORKER's key; this process
 *                                                only checks that it exists,
 *                                                because its absence means the
 *                                                container cannot answer)
 *   - the isolated stack up (see docs/voice-room-e2e-runbook.md)
 *
 * Optional:
 *   - VOICE_ROUNDTRIP_RUNS (default 3) -> how many round trips to run in a row
 *   - VOICE_ROUNDTRIP_TURN (default balance-question.wav)
 *   - E2E_DATABASE_URL / E2E_LIVEKIT_HOST_URL / E2E_AGENT_NAME
 */

import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ARTIFACTS_DIR,
  DEFAULT_TURN_FIXTURE,
  FIXTURES_DIR,
  describeMissingCredentials,
  injectWorktreeCredentials,
  resolveVoiceRoomConfig,
} from '../tests/e2e/voice-room/config.js';
import { runVoiceRoomRoundTrip, type VoiceRoomRoundTripReport } from '../tests/e2e/voice-room/roundtrip.js';

const RUNS = Number(process.env.VOICE_ROUNDTRIP_RUNS ?? '3');
const TURN_FILE = process.env.VOICE_ROUNDTRIP_TURN ?? DEFAULT_TURN_FIXTURE;

async function main(): Promise<number> {
  console.log('[0/3] inputs');
  const injection = injectWorktreeCredentials();
  const resolved = resolveVoiceRoomConfig();
  if (!resolved.ok) {
    console.log(`FAIL: ${describeMissingCredentials(resolved.missing, injection)}`);
    return 2;
  }
  const config = resolved.config;
  console.log(`livekit          : ${config.livekitHostUrl}`);
  console.log(`agent name       : ${config.agentName}`);
  console.log(`database         : ${config.databaseUrl.replace(/\/\/[^@]*@/u, '//***@')}`);
  console.log(`credentials      : injected from ${injection.envFilePath} (values are never printed)`);
  console.log(`turn fixture     : ${TURN_FILE}`);
  console.log(`runs             : ${RUNS}`);

  const turnWavPath = resolve(FIXTURES_DIR, TURN_FILE);
  if (!existsSync(turnWavPath)) {
    console.log(
      `FAIL: the turn fixture ${turnWavPath} is missing. Generate it once with \`npm run e2e:voice-room:fixtures\` and commit it.`,
    );
    return 2;
  }

  console.log('[1/3] round trips');
  const reports: VoiceRoomRoundTripReport[] = [];
  for (let index = 1; index <= RUNS; index += 1) {
    const label = `run${index}`;
    console.log(`\n===== round trip ${index}/${RUNS} (${label}) =====`);
    const report = await runVoiceRoomRoundTrip({
      config,
      turnWavPath,
      label,
      log: (line) => console.log(line),
    });
    reports.push(report);
    console.log(`  => ${report.passed ? 'PASS' : 'FAIL'}${report.passed ? '' : `: ${report.failures.join('; ')}`}`);
  }

  console.log('\n[2/3] artifacts');
  for (const report of reports) {
    console.log(`${report.label} (room ${report.roomName}, bind ${JSON.stringify(report.bind)})`);
    console.log(`  greeting : ${report.greeting.wavPath ?? 'not written'} (${report.greeting.windowMs} ms window, ${report.greeting.speechMs} ms speech)`);
    console.log(`  user turn: ${report.userTurn.wavPath || 'not written'} (${report.userTurn.durationMs} ms, ${report.userTurn.framesSent} frames)`);
    console.log(`  answer   : ${report.response.wavPath ?? 'not written'} (${report.response.windowMs} ms window, ${report.response.speechMs} ms speech)`);
  }
  console.log(`artifacts dir    : ${ARTIFACTS_DIR} (git-ignored)`);

  console.log('\n[3/3] determinism (honest spread, not byte-equality)');
  console.log('the model is generative, so the answer is expected to differ between runs:');
  console.log('run | greeting speech | answer window | answer speech | first answer speech after publish');
  for (const report of reports) {
    console.log(
      `${report.label.padEnd(4)}| ${String(report.greeting.speechMs).padStart(15)} | ${String(report.response.windowMs).padStart(13)} | ${String(report.response.speechMs).padStart(13)} | ${report.replyLatency.firstSpeechMs === null ? 'n/a' : `${report.replyLatency.firstSpeechMs} ms`}`,
    );
  }
  const answerSpeech = reports.map((report) => report.response.speechMs);
  const greetingSpeech = reports.map((report) => report.greeting.speechMs);
  console.log(
    `answer speech    : min ${Math.min(...answerSpeech)} ms, max ${Math.max(...answerSpeech)} ms, spread ${Math.max(...answerSpeech) - Math.min(...answerSpeech)} ms`,
  );
  console.log(
    `greeting speech  : min ${Math.min(...greetingSpeech)} ms, max ${Math.max(...greetingSpeech)} ms, spread ${Math.max(...greetingSpeech) - Math.min(...greetingSpeech)} ms`,
  );

  const failed = reports.filter((report) => !report.passed);
  if (failed.length > 0) {
    console.log(`\nFAIL: ${failed.length}/${reports.length} round trip(s) failed`);
    for (const report of failed) {
      for (const failure of report.failures) console.log(`  - ${report.label}: ${failure}`);
    }
    console.log('hint: `docker logs --tail 60 nana-e2e-voice-worker-1` shows the bind/session outcome');
    return 1;
  }
  console.log(
    `\nPASS: ${reports.length}/${reports.length} round trips bound the conversation, captured the greeting, published the user turn and captured a spoken answer.`,
  );
  return 0;
}

main()
  .then((code) => {
    // The Slice 2 trap still applies: a live AudioStream keeps the FFI loop
    // alive, so the exit has to be explicit. The capture does release its
    // readers now (RoomAudioCapture.stop), but the FFI client itself does not
    // shut down on its own.
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.log(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
