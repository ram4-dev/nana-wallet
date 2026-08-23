import 'dotenv/config';
import Fastify from 'fastify';
import { registerHealthRoutes } from './api/health.js';
import { registerWalletRoutes } from './api/wallet.js';
import { registerSessionRoutes } from './api/sessions.js';

export function buildServer() {
  const app = Fastify({ logger: !process.env.VITEST });

  app.register(registerHealthRoutes);
  app.register(registerWalletRoutes);
  app.register(registerSessionRoutes);

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
