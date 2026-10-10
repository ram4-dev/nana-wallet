import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    // tests/e2e/voice-room is excluded on purpose: that suite needs a live
    // isolated stack and paid provider credentials, so it runs through its own
    // config (`npm run test:e2e:voice-room`) instead of the default suite. See
    // tests/e2e/voice-room/vitest.voice-room.config.ts.
    include: ['tests/**/*.test.ts', '!tests/e2e/voice-room/**'],
    // `src/server.ts` and `src/livekit/worker.ts` import "dotenv/config", so a
    // developer checkout's root `.env` (live credentials) would otherwise leak
    // into every suite that imports the server and turn fixture cases into real
    // provider calls. This setupFile pins those credentials to empty so the
    // local run matches CI. See tests/setup/isolate-provider-env.ts.
    setupFiles: ['./tests/setup/isolate-provider-env.ts'],
  },
});
