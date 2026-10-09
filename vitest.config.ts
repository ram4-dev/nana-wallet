import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // `src/server.ts` and `src/livekit/worker.ts` import "dotenv/config", so a
    // developer checkout's root `.env` (live credentials) would otherwise leak
    // into every suite that imports the server and turn fixture cases into real
    // provider calls. This setupFile pins those credentials to empty so the
    // local run matches CI. See tests/setup/isolate-provider-env.ts.
    setupFiles: ['./tests/setup/isolate-provider-env.ts'],
  },
});
