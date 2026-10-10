#!/usr/bin/env node
/**
 * One-shot generator for the COMMITTED user-turn WAV fixtures.
 *
 * The design (03-design-discussion.md) fixes the caller's audio as pre-recorded
 * WAVs per turn: deterministic input is what makes "did the model hear
 * 'veinticinco' and not '25'" a question the harness can answer at all, and it
 * keeps the e2e stack free of per-run TTS cost and variance. Runtime TTS is only
 * an option, never the default path.
 *
 * So this script runs ONCE, by hand, and its output is committed. Nothing in the
 * test path calls it.
 *
 * Run: npm run e2e:voice-room:fixtures
 *
 * Requires (names only, values are never printed):
 *   - OPENAI_API_KEY  (from the worktree .env, injected explicitly; note that the
 *                      TTS provider registry calls this variable OPEN_AI_API_KEY,
 *                      so the key is passed to `synthesizeSpeech` directly)
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { synthesizeSpeech } from '../evals/voice/tts/providers.js';
import { decodeWav, encodeWav, pcmDurationMs, resamplePcm16Mono } from '../tests/e2e/voice-room/audio.js';
import {
  FIXTURES_DIR,
  injectWorktreeCredentials,
} from '../tests/e2e/voice-room/config.js';

/**
 * The turns themselves. Rioplatense Spanish, the way a real user of this wallet
 * would ask, and short enough to keep a round trip under a few seconds.
 */
const TURNS: ReadonlyArray<{ file: string; text: string; intent: string }> = [
  {
    file: 'balance-question.wav',
    text: 'Che Nani, ¿me decís cuánto saldo tengo en la cuenta?',
    intent: 'ask for the balance (the default harness turn: it lands on get_balance)',
  },
  {
    file: 'send-money-to-sister.wav',
    text: 'Quiero mandarle plata a mi hermana Ana, ¿me ayudás?',
    intent: 'start a transfer to a contact by name',
  },
  {
    file: 'balance-in-dollars.wav',
    text: '¿Y en dólares cuánto tengo?',
    intent: 'ask for a balance on another network (multi-network read)',
  },
];

async function main(): Promise<number> {
  // Only the OpenAI key matters here: this script never touches the room.
  const injection = injectWorktreeCredentials();
  const apiKey = process.env.OPENAI_API_KEY?.trim() ?? '';
  if (apiKey.length === 0) {
    console.log(
      `FAIL: missing OPENAI_API_KEY: expected it in ${injection.envFilePath} (git-ignored; the value is never printed) or in the environment.`,
    );
    return 2;
  }

  await mkdir(FIXTURES_DIR, { recursive: true });
  console.log(`fixtures dir     : ${FIXTURES_DIR}`);
  console.log(`tts provider     : openai-tts (POST /audio/speech, one request per turn)`);

  for (const turn of TURNS) {
    const bytes = await synthesizeSpeech('openai-tts', apiKey, turn.text);
    const decoded = decodeWav(bytes);
    if (decoded.channels !== 1) {
      throw new Error(`${turn.file}: expected mono TTS output, got ${decoded.channels} channels`);
    }
    // The room runs at 48 kHz and the native source resamples from the frame's
    // own rate, so the fixture is normalised once here instead of at every run.
    const pcm = resamplePcm16Mono(decoded.pcm, decoded.sampleRate, 48_000);
    const target = resolve(FIXTURES_DIR, turn.file);
    await writeFile(target, encodeWav(pcm, 48_000, 1));
    console.log(
      `wrote            : ${turn.file}\n  text           : ${turn.text}\n  intent         : ${turn.intent}\n  audio          : ${pcmDurationMs(pcm, 48_000, 1)} ms @ 48000 Hz mono (source ${decoded.sampleRate} Hz, resampled)\n  path           : ${target}`,
    );
  }

  console.log(
    '\nThese WAVs are committed on purpose: they are the deterministic input side of the round trip.',
  );
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    console.log(`\nFAIL: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
