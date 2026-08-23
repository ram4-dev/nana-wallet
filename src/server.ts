import 'dotenv/config';
import Fastify from 'fastify';
import { registerHealthRoutes } from './api/health.js';
import { registerWalletRoutes } from './api/wallet.js';
import { registerSessionRoutes } from './api/sessions.js';

export const DEFAULT_CORS_ORIGINS = ['http://localhost:8083', 'http://127.0.0.1:8083'];

export function resolveCorsOrigins(raw = process.env.CORS_ORIGINS): string[] {
  if (!raw?.trim()) return DEFAULT_CORS_ORIGINS;
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function buildServer() {
  const app = Fastify({ logger: !process.env.VITEST });

  app.addHook('onRequest', async (request, reply) => {
    const origin = request.headers.origin;
    if (origin && resolveCorsOrigins().includes(origin)) {
      reply.header('Access-Control-Allow-Origin', origin);
      reply.header('Vary', 'Origin');
    }
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, Idempotency-Key',
    );
    reply.header('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
    if (request.method === 'OPTIONS') {
      return reply.code(204).send();
    }
  });

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
