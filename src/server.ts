import "dotenv/config";
import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerHealthRoutes } from "./api/health.js";
import { registerWalletRoutes } from "./api/wallet.js";
import { registerConversationRoutes } from "./api/conversations.js";
import {
  createConfiguredDatabaseClient,
  type DatabaseClient,
} from "./db/client.js";
import { PostgresConversationRepository } from "./conversations/postgres-repository.js";
import { createWalletConversationService } from "./conversations/service.js";
import { readRecipientMemoryConfig } from "./config/env.js";
import { registerVoiceRoutes, type VoiceRoutesOptions } from "./api/voice.js";
import { readLiveKitTokenIssuerConfig } from "./config/livekit.js";
import { issueRoomToken, type RoomTokenInput } from "./livekit/token-issuer.js";
import {
  createConfiguredWalletForUser,
  createCoreDependencies,
  createGrantCreator,
} from "./runtime/dependencies.js";
import {
  DemoIdentityProvider,
  type RequestIdentityProvider,
} from "./auth/identity.js";
import { ensureDemoSentinelUser } from "./auth/demo-sentinel.js";
import {
  PrivyIdentityError,
  PrivyIdentityProvider,
  readPrivyVerificationInputs,
} from "./auth/privy-identity.js";
import { registerMeRoutes } from "./api/me.js";
import {
  registerContactsRoutes,
  createContactsEmbedder,
} from "./api/contacts.js";
import { ContactsRepository } from "./memory/contacts-repository.js";
import { EmbeddingService } from "./memory/embedding.js";
import { FinancialTaskRegistry } from "./conversations/financial-task-registry.js";
import {
  readApiProcessConfig,
  readIdentityProviderMode,
} from "./config/process.js";
import {
  getConfiguredRecipientMemoryRuntime,
  getMemoryRuntimeForUser,
} from "./memory/runtime.js";
import {
  EmbeddedWalletService,
  WalletUnavailableError,
} from "./wallet/embedded.js";
import {
  WalletBalancesService,
  createBalanceReader,
  readBalanceReadConfig,
} from "./wallet/balances.js";
import {
  createPrivyWalletApiClient,
  type PrivyWalletApiClient,
} from "./wallet/privy-client.js";
import { registerWalletsRoutes } from "./api/wallets.js";
import { registerProviderWebhookRoutes } from "./api/provider-webhooks.js";
import { registerNotificationsFeedRoutes } from "./api/notifications.js";
import { randomUUID } from "node:crypto";
import { createDefaultSolanaDevnetReconciliationSource } from "./notifications/solana-reconciliation-source.js";
import { startReconciliationWorker } from "./notifications/reconciliation-worker.js";
import { dispatchPendingAssistantOutbox } from "./notifications/outbox-dispatcher.js";
import { startAssistantOutboxWorker } from "./notifications/outbox-worker.js";
import { createOptionalLiveKitInvalidationPublisher } from "./notifications/livekit-invalidation-publisher.js";
import { registerGrantsRoutes } from "./api/grants.js";
import { DelegatedGrantService } from "./wallet/grants/consumption.js";
import { createGrantGate } from "./conversations/grant-gate.js";
import { createGrantPolicySyncService } from "./wallet/grants/privy-policy-runtime.js";
import { readPrivyServerConfig } from "./config/privy-server.js";
import { PrivyServerClient } from "./wallet/privy-server-client.js";
import { createPrivyWalletHealthProvider } from "./wallet/privy-user-provider.js";
import type { FastifyRequest } from "fastify";

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

export function buildServer(options: { privyServer?: PrivyServerClient } = {}) {
  // 25MB matches the upstream Whisper transcription limit (see NAN_API docs).
  const app = Fastify({
    logger: !process.env.VITEST,
    bodyLimit: 25 * 1024 * 1024,
  });
  const backgroundNotificationWorkers: Array<{ stop: () => Promise<void> }> =
    [];

  app.register(cors, {
    origin: resolveCorsOrigins(),
    // If-None-Match/If-Modified-Since back the ETag-based conversation state
    // reads (GET /v1/conversations/:id/state) used by the voice revision flow.
    allowedHeaders: [
      "Content-Type",
      "Authorization",
      "Idempotency-Key",
      "If-None-Match",
      "If-Modified-Since",
    ],
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
  });

  // PMU-002/007: identity failures are 401 everywhere, never 500.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof PrivyIdentityError) {
      reply.code(401);
      return reply.send({
        status: "error",
        message: "Authentication required.",
        code: "no_autenticado",
      });
    }
    throw error;
  });

  const core = createCoreDependencies();
  const config = readRecipientMemoryConfig();
  const identityProviderMode = readIdentityProviderMode();

  // PMU-001: build the sole identity provider from configuration.
  let identity: RequestIdentityProvider;
  let database: DatabaseClient | undefined;
  if (identityProviderMode === "privy") {
    const { appId, verificationKeyPem } = readPrivyVerificationInputs(
      process.env,
    );
    if (!config.databaseUrl)
      throw new Error("DATABASE_URL is required when IDENTITY_PROVIDER=privy.");
    // PMU-024: identity-only rollout — a funded singleton provider is already
    // rejected at config-read time (readApiProcessConfig).
    database = createConfiguredDatabaseClient();
    identity = new PrivyIdentityProvider({
      appId,
      verificationKeyPem,
      resolvePrivyDid: (did, displayName) =>
        database!
          .query<{ id: string }>(
            "SELECT users_ensure_for_privy_did($1, $2) AS id",
            [did, displayName ?? null],
          )
          .then((result) => {
            const row = result.rows[0];
            if (!row)
              throw new Error("users_ensure_for_privy_did returned no id");
            return row.id;
          }),
    });
  } else {
    identity = new DemoIdentityProvider(config.demoUserId ?? "");
    if (config.databaseUrl) database = createConfiguredDatabaseClient();
  }

  const resolveUserId = async (request: FastifyRequest): Promise<string> =>
    (await identity.resolve(request)).userId;

  const privyServerConfig = database
    ? readPrivyServerConfig(process.env)
    : undefined;
  const privyServer =
    options.privyServer ??
    (privyServerConfig
      ? new PrivyServerClient({
          appId: privyServerConfig.appId,
          appSecret: privyServerConfig.appSecret,
          baseUrl: privyServerConfig.baseUrl,
          // S2a boundary: the VOICE WORKER moved to the local signing sidecar
          // (src/wallet/signer/, wired in src/runtime/dependencies.ts). This
          // HTTP API process still signs enrollment/grant-policy mutations with
          // the key it holds, because PrivyServerClient derives its
          // authorization context from that key string; migrating it to
          // `sign_fns` is a follow-up slice.
          authorizationPrivateKey:
            process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY?.trim() || undefined,
        })
      : undefined);
  const walletForUser = database
    ? createConfiguredWalletForUser(database, process.env, privyServer)
    : undefined;

  const healthWallet =
    identityProviderMode === "privy"
      ? createPrivyWalletHealthProvider(Boolean(privyServer))
      : core.walletReads;
  app.register(registerHealthRoutes, { wallet: healthWallet });
  // PMU-024: wallet reads authenticate in privy mode (public in demo for compatibility).
  app.register(registerWalletRoutes, {
    wallet: core.walletReads,
    ...(identityProviderMode === "privy" ? { resolveUserId } : {}),
    ...(walletForUser ? { walletForUser } : {}),
  });

  if (database) {
    // DGC-4/D-4: the ledger stays authoritative and Solana grants receive a
    // composed, signer-bound Privy policy only when signed server credentials
    // and the canonical authorization quorum are configured. Otherwise the
    // Slice 1 unavailable provisioner keeps grants non-executable.
    const grants = new DelegatedGrantService(database);
    const grantPolicySync = createGrantPolicySyncService({
      database,
      privyServer,
      quorumId: privyServerConfig?.keyQuorumId,
    }).service;
    // DGC-6: the same grant-creation owners as the LiveKit worker, exposed to
    // the conversation service so Nani (voice/text) can create grants.
    const grantCreator = createGrantCreator(
      database,
      privyServer,
      privyServerConfig?.keyQuorumId,
    );
    app.register(registerGrantsRoutes, {
      grants,
      policySync: grantPolicySync,
      resolveUserId,
    });

    const conversations = new PostgresConversationRepository(database);
    const financialTasks = new FinancialTaskRegistry();
    const memory =
      identityProviderMode === "demo"
        ? getConfiguredRecipientMemoryRuntime()
        : undefined;
    const service = createWalletConversationService({
      conversations,
      wallet: core.wallet,
      ...(walletForUser ? { walletForUser } : {}),
      financialTasks,
      grantCreator,
      contextRenewal: core.contextRenewal,
      // slice3-grant-execution: server-owned grant gate (original user
      // turn path only; the service never consults it for model-tool
      // previews). Requires the resolved chain-aware wallet seam; absent
      // seam ⇒ no gate ⇒ today's unconditional preview + confirmation.
      ...(walletForUser
        ? {
            grantGate: createGrantGate({
              grants,
              walletForUser,
            }),
            // AD-6: the atomic ledger claim is the sole execution
            // authority; same grants service as the HTTP lifecycle.
            grantLedger: {
              claim: (input) => grants.claimConsumption(input),
              // AD-10: atomic owned-CAS settlement (attempt CAS + ledger
              // release + released audit) for definitive non-dispatch.
              settle: (input) => grants.settleGrantReservation(input),
            },
          }
        : {}),
      // PMU-014: memory scoped to the RESOLVED per-request user in every mode;
      // the fixed demo runtime (if configured) is only a fallback.
      ...(memory ? { memory } : {}),
      memoryForUser: (userId) => getMemoryRuntimeForUser(userId),
    });

    // PMU-004: demo-mode startup provisions the sentinel before serving
    // requests, including the seed-before-server flow.
    if (identityProviderMode === "demo" && config.demoUserId) {
      const demoUserId = config.demoUserId;
      app.addHook("onReady", async () => {
        await ensureDemoSentinelUser(database!, demoUserId);
      });
    }

    app.addHook("onClose", async () => {
      // Stop every DB-backed notifications worker before closing the pool.
      // Keeping this in the same hook removes any dependence on Fastify hook
      // ordering when the workers are registered later during construction.
      for (const worker of backgroundNotificationWorkers) await worker.stop();
      await financialTasks.drain({ timeoutMs: 10_000 });
      if (core.walletReads !== core.wallet) await core.walletReads.close();
      await core.wallet.close();
      await database!.close();
    });

    app.register(registerConversationRoutes, {
      conversations,
      service,
      resolveUserId,
      ...(process.env.LIVE_VOICE_BINDING_PRIVATE_KEY
        ? { bindingPrivateKey: process.env.LIVE_VOICE_BINDING_PRIVATE_KEY }
        : {}),
    });

    // PMU-007: identity-only bootstrap.
    app.register(registerMeRoutes, { resolveUserId, database });

    // Slice 5: authenticated notifications feed/read surface.
    app.register(registerNotificationsFeedRoutes, {
      resolveUserId,
      database,
    });

    // Slice 5: signed provider webhook ingress. Raw-byte Svix verification
    // is only reachable when the signing secret is configured; without it
    // the route is intentionally absent (fail closed, no unverified path).
    const providerWebhookSecret = process.env.PRIVY_WEBHOOK_SECRET?.trim();
    if (database && providerWebhookSecret) {
      app.register(registerProviderWebhookRoutes, {
        database,
        webhookSecret: providerWebhookSecret,
      });
    }

    // PMU-008..013: user-scoped contacts CRUD.
    app.register(registerContactsRoutes, {
      resolveUserId,
      contacts: new ContactsRepository(database),
      embedder: createContactsEmbedder(),
    });

    // Contact creation embeds the name through the transformers.js model;
    // a cold load cost minutes on the first save. Warm it in the background
    // once the server is listening so the first contact saves fast and
    // /health is not delayed.
    const contactsEmbedder = new EmbeddingService(
      readRecipientMemoryConfig().modelCacheDirectory,
    );
    app.addHook("onReady", async () => {
      void contactsEmbedder.prefetch().catch(() => {
        // Prefetch is an optimization; the first create loads on demand.
      });
    });

    // Slice 5: durable outbox dispatcher. Enabled by default with a database;
    // tests opt out via VITEST and deployments may explicitly disable it.
    // Fan-out is optional because polling the durable feed remains authoritative.
    const outboxDispatcherEnabled =
      database &&
      process.env.NOTIFICATIONS_OUTBOX_ENABLED !== "false" &&
      !process.env.VITEST;
    app.addHook("onReady", async () => {
      if (!outboxDispatcherEnabled) return;
      const publishInvalidation = createOptionalLiveKitInvalidationPublisher();
      const worker = startAssistantOutboxWorker({
        dispatch: () =>
          dispatchPendingAssistantOutbox({
            database: database!,
            ...(publishInvalidation ? { publishInvalidation } : {}),
            batchSize: 100,
          }),
        intervalMs: 5_000,
        backoffOptions: { baseSeconds: 2, maxSeconds: 60 },
        onError: () => {
          // Pending rows are durable and the worker retries with backoff. Avoid
          // writing outbox payloads to application logs.
        },
      });
      backgroundNotificationWorkers.push(worker);
    });

    // Slice 5: durable reconciliation worker (bounded devnet polling).
    // Gated so tests (any truthy VITEST) and non-polling deployments
    // never hit live RPC. Started inside onReady — never at build time —
    // and stopped, awaiting in-flight work, in onClose.
    const reconciliationEnabled =
      database &&
      process.env.NOTIFICATIONS_RECONCILIATION_ENABLED === "true" &&
      !process.env.VITEST;
    let reconciliationWorker: ReturnType<
      typeof startReconciliationWorker
    > | null = null;
    app.addHook("onReady", async () => {
      if (!reconciliationEnabled) return;
      reconciliationWorker = startReconciliationWorker({
        database: database!,
        source: createDefaultSolanaDevnetReconciliationSource(),
        workerId: `server-${randomUUID()}`,
        pageSize: 100,
        leaseSeconds: 300,
        intervalMs: 30_000,
        backoffOptions: { baseSeconds: 5, maxSeconds: 300 },
      });
      backgroundNotificationWorkers.push(reconciliationWorker);
    });

    // PEW-001..014: user-scoped embedded wallet surface. The fixture Privy
    // client is the default (and the only mode allowed in privy identity
    // mode); the live wallet client fails closed without PRIVY_* credentials.
    // The server client is constructed ONLY when the server config is present
    // (app id + secret); otherwise sync/enrollment stay fixture-backed.
    const privyClient =
      identityProviderMode === "privy" && !privyServer
        ? unavailablePrivyWalletClient()
        : createPrivyWalletApiClient(process.env, {});
    const enrollment = privyServerConfig?.keyQuorumId
      ? { keyQuorumId: privyServerConfig.keyQuorumId }
      : undefined;
    // WP-008: the balances service shares the same own-binding resolver as
    // the wallet surface but NEVER receives sync/permission/sign methods.
    const embeddedWallet = new EmbeddedWalletService(
      database,
      privyClient,
      privyServer,
      enrollment,
    );
    app.register(registerWalletsRoutes, {
      resolveUserId,
      wallet: embeddedWallet,
      balances: new WalletBalancesService({
        resolveWallet: (userId) => embeddedWallet.getCurrentWallet(userId),
        reader: createBalanceReader(readBalanceReadConfig(process.env)),
      }),
    });
  } else {
    app.addHook("onClose", async () => {
      if (core.walletReads !== core.wallet) await core.walletReads.close();
      await core.wallet.close();
    });
  }

  // PMU-020: room tokens authenticate the caller and authorize the owned
  // conversation in privy mode; demo keeps the compatibility path.
  const voiceOptions: VoiceRoutesOptions = {};
  if (identityProviderMode === "privy") {
    voiceOptions.authorizeRoomToken = async (request, conversationId) => {
      const userId = await resolveUserId(request);
      const owned = database
        ? await new PostgresConversationRepository(database).get(
            userId,
            conversationId,
          )
        : undefined;
      // Missing and foreign conversations are indistinguishable: same 404.
      if (!owned) return { ok: false as const, reason: "not_found" as const };
      return {
        ok: true as const,
        identity: userId,
        roomName: `nani-${conversationId}`,
      };
    };
  }
  voiceOptions.liveKitTokenIssuer = {
    issue: (input: RoomTokenInput) =>
      issueRoomToken(
        {
          ...readLiveKitTokenIssuerConfig(),
          identity: input.identity ?? config.demoUserId ?? "",
        },
        input,
      ),
  };
  app.register(registerVoiceRoutes, voiceOptions);

  return app;
}

function unavailablePrivyWalletClient(): PrivyWalletApiClient {
  const unavailable = (): never => {
    throw new WalletUnavailableError(
      "Privy wallet operations require a configured server client.",
    );
  };
  return {
    mode: "live",
    async listWallets() {
      return unavailable();
    },
    async getWallet() {
      return unavailable();
    },
    async verifyOwnership() {
      return unavailable();
    },
    async createWallet() {
      return unavailable();
    },
    async readEffectivePolicy() {
      return unavailable();
    },
    async createGrantPolicy() {
      return unavailable();
    },
    async revokeGrantPolicy() {
      return unavailable();
    },
    async signTransaction() {
      return unavailable();
    },
  };
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
