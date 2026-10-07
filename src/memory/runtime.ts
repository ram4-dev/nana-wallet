import { readRecipientMemoryConfig } from "../config/env.js";
import { createDatabaseClient, type DatabaseClient } from "../db/client.js";
import { EmbeddingService } from "./embedding.js";
import { RecipientMemoryRepository } from "./repository.js";
import { RecipientMemoryService } from "./service.js";

export type RecipientMemoryRuntime = {
 userId: string;
 service: RecipientMemoryService;
};

let configuredRuntime: RecipientMemoryRuntime | undefined;
let configuredMemoryService: RecipientMemoryService | undefined;
let configuredDatabase: DatabaseClient | undefined;

/**
 * Lazily builds the shared tenant-agnostic memory service behind one database
 * client. The service holds no fixed userId: every lookup takes the scoping userId
 * as a method argument, so a single service instance can serve multiple tenants.
 * Returns undefined when recipient memory is disabled or `DATABASE_URL` is absent.
 */
function buildConfiguredMemoryService(
 environment: NodeJS.ProcessEnv,
): RecipientMemoryService | undefined {
 const config = readRecipientMemoryConfig(environment);
 if (!config.enabled || !config.databaseUrl) return undefined;
 if (!configuredMemoryService) {
  configuredDatabase = createDatabaseClient(config.databaseUrl);
  configuredMemoryService = new RecipientMemoryService(
   new RecipientMemoryRepository(configuredDatabase),
   new EmbeddingService(config.modelCacheDirectory),
   { scoreThreshold: config.scoreThreshold, scoreFloor: config.scoreFloor, scoreMargin: config.scoreMargin },
  );
 }
 return configuredMemoryService;
}

/**
 * Lazily creates the configured demo tenant; feature-off callers get no memory tools.
 * This runtime carries a fixed `demoUserId` and is what the text conversation service
 * path expects today. Do NOT use it for the realtime voice tools — those must scope to
 * the binding user via {@link getConfiguredRecipientMemoryService} + the binding `userId`.
 */
export function getConfiguredRecipientMemoryRuntime(
 environment: NodeJS.ProcessEnv = process.env,
): RecipientMemoryRuntime | undefined {
 const config = readRecipientMemoryConfig(environment);
 if (!config.enabled || !config.databaseUrl || !config.demoUserId)
  return undefined;
 const service = buildConfiguredMemoryService(environment);
 if (!service) return undefined;
 return { userId: config.demoUserId, service };
}

/**
 * Returns the shared recipient memory service (tenant selected per call by userId).
 * The realtime voice tools use this so `search_recipients` scopes to `binding.sub` —
 * the actual user of the session — instead of the singleton demo user.
 */
export function getConfiguredRecipientMemoryService(
 environment: NodeJS.ProcessEnv = process.env,
): RecipientMemoryService | undefined {
 return buildConfiguredMemoryService(environment);
}

/**
 * PMU-014: per-request text-path runtime factory. Builds a runtime whose userId
 * is the RESOLVED internal UUID (never a fixed demo tenant) over the shared
 * tenant-agnostic service. Returns undefined when memory is disabled or the
 * database is absent. Demo mode callers may still use the configured demo
 * runtime, but HTTP paths must scope by the resolved user.
 */
export function getMemoryRuntimeForUser(
 userId: string,
 environment: NodeJS.ProcessEnv = process.env,
): RecipientMemoryRuntime | undefined {
 const service = buildConfiguredMemoryService(environment);
 if (!service) return undefined;
 return { userId, service };
}

export async function closeConfiguredRecipientMemoryRuntime(): Promise<void> {
 await configuredDatabase?.close();
 configuredRuntime = undefined;
 configuredMemoryService = undefined;
 configuredDatabase = undefined;
}
