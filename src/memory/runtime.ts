import { readRecipientMemoryConfig } from '../config/env.js';
import { createDatabaseClient, type DatabaseClient } from '../db/client.js';
import { EmbeddingService } from './embedding.js';
import { RecipientMemoryRepository } from './repository.js';
import { RecipientMemoryService } from './service.js';

export type RecipientMemoryRuntime = {
  userId: string;
  service: RecipientMemoryService;
};

let configuredRuntime: RecipientMemoryRuntime | undefined;
let configuredDatabase: DatabaseClient | undefined;

/** Lazily creates the configured demo tenant; feature-off callers get no memory tools. */
export function getConfiguredRecipientMemoryRuntime(): RecipientMemoryRuntime | undefined {
  const config = readRecipientMemoryConfig();
  if (!config.enabled || !config.databaseUrl || !config.demoUserId) return undefined;
  if (!configuredRuntime) {
    configuredDatabase = createDatabaseClient(config.databaseUrl);
    configuredRuntime = {
      userId: config.demoUserId,
      service: new RecipientMemoryService(
        new RecipientMemoryRepository(configuredDatabase),
        new EmbeddingService(config.modelCacheDirectory),
        { scoreThreshold: config.scoreThreshold, scoreMargin: config.scoreMargin },
      ),
    };
  }
  return configuredRuntime;
}

export async function closeConfiguredRecipientMemoryRuntime(): Promise<void> {
  await configuredDatabase?.close();
  configuredRuntime = undefined;
  configuredDatabase = undefined;
}
