import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerHealthRoutes } from './api/health.js';
import { registerWalletRoutes } from './api/wallet.js';
import { registerSessionRoutes } from './api/sessions.js';
import { registerVoiceRoutes } from './api/voice.js';

export function buildServer() {
  // 25MB matches the upstream Whisper transcription limit (see NAN_API docs).
  const app = Fastify({ logger: !process.env.VITEST, bodyLimit: 25 * 1024 * 1024 });

  // Frontend (Vite/Capacitor) and backend run on different origins in dev; reflect the
  // request origin so the browser accepts the response instead of blocking it as CORS.
  app.register(cors, { origin: true });

  app.register(registerHealthRoutes);
  app.register(registerWalletRoutes);
  app.register(registerSessionRoutes);
  app.register(registerVoiceRoutes);

  return app;
}

async function main() {
  const app = buildServer();
  const port = Number(process.env.PORT ?? 3000);
  await app.listen({ port, host: '0.0.0.0' });
}

const isDirectRun = /server\.(ts|js)$/.test(process.argv[1] ?? '');
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
