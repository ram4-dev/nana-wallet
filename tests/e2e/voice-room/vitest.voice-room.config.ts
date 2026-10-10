import { defineConfig } from 'vitest/config';

/**
 * Config for the voice-room end-to-end suite only.
 *
 * It is separate from the root config for two reasons:
 *
 *  1. This suite needs a live isolated stack and paid provider credentials, so it
 *     must never run as part of `npm test`. The root config excludes this
 *     directory to make that unambiguous.
 *  2. It deliberately does NOT load the root isolation setup. That setup deletes
 *     the LIVEKIT and OPENAI API keys so ambient credentials cannot change
 *     fixture-based suites; this suite injects them explicitly instead, because
 *     talking to a real room is the point.
 *
 * Run it with: npm run test:e2e:voice-room
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/e2e/voice-room/**/*.test.ts'],
    // A round trip runs two real turns through a speech-to-speech model; the
    // per-test timeout is set in the spec, but the file-level budget needs room.
    // The transfer scenarios run TWO turns each on top of the greeting, so their
    // per-test budgets are larger than the single-turn balance spec's.
    testTimeout: 600_000,
    hookTimeout: 300_000,
    // These tests share one room and one worker, and a second concurrent run would
    // fight over the single conversation lease.
    fileParallelism: false,
  },
});
