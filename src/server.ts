import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerHealthRoutes } from "./api/health.js";
import { registerWalletRoutes } from "./api/wallet.js";
import { registerConversationRoutes } from "./api/conversations.js";
import { createConfiguredDatabaseClient } from "./db/client.js";
import { PostgresConversationRepository } from "./conversations/postgres-repository.js";
import { createWalletConversationService } from "./conversations/service.js";
import { readRecipientMemoryConfig } from "./config/env.js";
import { registerVoiceRoutes } from "./api/voice.js";
import { createCoreDependencies } from "./runtime/dependencies.js";
import { DemoIdentityProvider } from "./auth/identity.js";
import { FinancialTaskRegistry } from "./conversations/financial-task-registry.js";
import { readApiProcessConfig } from "./config/process.js";

export const DEFAULT_CORS_ORIGINS = [
  "http://localhost:8083",
  "http://127.0.0.1:8083",
];

export function resolveCorsOrigins(raw = process.env.CORS_ORIGINS): string[] {
  if (!raw?.trim()) return DEFAULT_CORS_ORIGINS;
  return raw
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

export function buildServer() {
  // 25MB matches the upstream Whisper transcription limit (see NAN_API docs).
  const app = Fastify({
    logger: !process.env.VITEST,
    bodyLimit: 25 * 1024 * 1024,
  });

  app.register(cors, {
    origin: resolveCorsOrigins(),
    allowedHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  const core = createCoreDependencies();
  app.register(registerHealthRoutes, { wallet: core.walletReads });
  app.register(registerWalletRoutes, { wallet: core.walletReads });
  const config = readRecipientMemoryConfig();
  if (config.databaseUrl && config.demoUserId) {
    const database = createConfiguredDatabaseClient();
    const conversations = new PostgresConversationRepository(database);
    const financialTasks = new FinancialTaskRegistry();
    const service = createWalletConversationService({
      conversations,
      wallet: core.wallet,
      financialTasks,
      contextRenewal: core.contextRenewal,
    });
    const identity = new DemoIdentityProvider(config.demoUserId);
    app.addHook("onClose", async () => {
      await financialTasks.drain({ timeoutMs: 10_000 });
      if (core.walletReads !== core.wallet) await core.walletReads.close();
      await core.wallet.close();
      await database.close();
    });
    app.register(registerConversationRoutes, {
      conversations,
      service,
      resolveUserId: async (request) =>
        (await identity.resolve(request)).userId,
      ...(process.env.LIVE_VOICE_BINDING_PRIVATE_KEY
        ? { bindingPrivateKey: process.env.LIVE_VOICE_BINDING_PRIVATE_KEY }
        : {}),
    });
  }
  if (!config.databaseUrl || !config.demoUserId)
    app.addHook("onClose", async () => {
      if (core.walletReads !== core.wallet) await core.walletReads.close();
      await core.wallet.close();
    });
  app.register(registerVoiceRoutes);

  return app;
}

export function serverHost(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  return environment.HOST ?? "127.0.0.1";
}

async function main() {
  const config = readApiProcessConfig();
  const app = buildServer();
  await app.listen({ port: config.port, host: config.host });
}

const isDirectRun = /server\.(ts|js)$/.test(process.argv[1] ?? "");
if (isDirectRun) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
