/**
 * Seeds the fixture user's RECIPIENT MEMORY for the transfer scenarios.
 *
 * WHY IT IS A SEPARATE STEP
 * -------------------------
 * A transfer cannot be previewed without a versioned recipient: the model's
 * `search_recipients` has to resolve a contact, and `send_token` then revalidates
 * that contact by id + version before it will persist a preview
 * (src/agent/definition.ts, resolvePreviewRecipient). With an empty `recipients`
 * table the transfer path stops at "I could not find that contact", which is a
 * fixture gap and would look like a product bug.
 *
 * WHY IT DOES NOT REUSE examples/recipient-memory.seed.json
 * ---------------------------------------------------------
 * That seed holds a single EVM recipient ("Lucas", address 0x1531…). This stack
 * runs the voice agent on Solana devnet (`WDK_NETWORK=solana-devnet`), and the
 * preview path validates the recipient address against the network the transfer
 * resolves to: an EVM address is not a valid Solana address, so the seeded
 * contact would fail revalidation. The fixture therefore seeds the SAME contact
 * (Lucas, "mi nieto") with a Solana devnet address, so the person the recorded
 * turn names is the person actually seeded.
 *
 * The embedding is computed with the worker's own model and cache directory
 * (src/memory/embedding.ts) instead of a hand-made vector, so a semantic query
 * ("mi nieto") resolves the same way it would in production, not only an exact
 * name match. The model is downloaded once into the git-ignored cache.
 *
 * This is the same code path `npm run db:seed` uses
 * (src/memory/seed.ts: seedConfirmedMemory → RecipientMemoryRepository), so the
 * rows it writes are indistinguishable from a real seed.
 */

import { resolve } from 'node:path';
import { createDatabaseClient } from '../../../src/db/client.js';
import { EmbeddingService, recipientEmbeddingText } from '../../../src/memory/embedding.js';
import { RecipientMemoryRepository } from '../../../src/memory/repository.js';
import { EMBEDDING_MODEL_ID } from '../../../src/memory/types.js';
import { REPO_ROOT } from './config.js';

/**
 * The contact the recorded transfer turn names, seeded with the Solana devnet
 * address this stack's fixture wallet speaks. Kept in sync with the fixture
 * WAV: `transfer-to-lucas.wav` says "mi nieto Lucas".
 */
export const FIXTURE_RECIPIENT = Object.freeze({
  name: 'Lucas',
  description: 'mi nieto',
  network: 'solana-devnet' as const,
  address: '9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin',
});

/** Same default the app uses (src/config/env.ts), anchored at the repository root. */
export const RECIPIENT_MEMORY_MODEL_CACHE = resolve(
  REPO_ROOT,
  process.env.RECIPIENT_MEMORY_MODEL_CACHE?.trim() || '.cache/recipient-memory-model',
);

export type RecipientSeedReport = {
  userId: string;
  name: string;
  description: string;
  network: string;
  address: string;
  recipientId: string;
  version: number;
  modelCacheDirectory: string;
};

/**
 * Idempotently replaces the fixture user's recipient memory with
 * {@link FIXTURE_RECIPIENT}.
 *
 * The DELETE first is what keeps re-runs honest: without it a second run would
 * leave two "Lucas" rows, `search_recipients` would classify the name as
 * ambiguous, and the model would be asked to disambiguate a contact the user
 * only ever named once.
 */
export async function seedFixtureRecipientMemory(input: {
  databaseUrl: string;
  userId: string;
  log?: (line: string) => void;
}): Promise<RecipientSeedReport> {
  const log = input.log ?? (() => {});
  const database = createDatabaseClient(input.databaseUrl);
  try {
    await database.withUserTransaction(input.userId, async (client) => {
      await client.query('DELETE FROM recipients WHERE user_id = $1', [input.userId]);
      await client.query('DELETE FROM user_memories WHERE user_id = $1', [input.userId]);
    });

    const embeddings = new EmbeddingService(RECIPIENT_MEMORY_MODEL_CACHE);
    const embedding = await embeddings.embed(
      recipientEmbeddingText(FIXTURE_RECIPIENT.name, FIXTURE_RECIPIENT.description),
    );
    const recipient = await new RecipientMemoryRepository(database).insertRecipient(
      input.userId,
      {
        name: FIXTURE_RECIPIENT.name,
        description: FIXTURE_RECIPIENT.description,
        address: FIXTURE_RECIPIENT.address,
        network: FIXTURE_RECIPIENT.network,
      },
      embedding,
      EMBEDDING_MODEL_ID,
    );
    log(
      `recipient memory : ${recipient.name} (${FIXTURE_RECIPIENT.description}) -> ${FIXTURE_RECIPIENT.network} ${FIXTURE_RECIPIENT.address} [id ${recipient.id} v${recipient.version}]`,
    );
    log(`embedding model  : cached at ${RECIPIENT_MEMORY_MODEL_CACHE} (downloaded once)`);
    return {
      userId: input.userId,
      name: recipient.name,
      description: recipient.description,
      network: FIXTURE_RECIPIENT.network,
      address: recipient.address,
      recipientId: recipient.id,
      version: recipient.version,
      modelCacheDirectory: RECIPIENT_MEMORY_MODEL_CACHE,
    };
  } finally {
    await database.close();
  }
}
