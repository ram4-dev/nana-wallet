import { pathToFileURL } from 'node:url';
import { readRecipientMemoryConfig } from '../config/env.js';
import { EmbeddingService } from './embedding.js';

async function main(): Promise<void> {
  const config = readRecipientMemoryConfig();
  await new EmbeddingService(config.modelCacheDirectory).prefetch();
  console.log('Recipient memory embedding model is cached.');
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : 'Embedding prefetch failed.');
    process.exitCode = 1;
  });
}
