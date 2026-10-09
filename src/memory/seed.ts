import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import { readRecipientMemoryConfig } from "../config/env.js";
import { createConfiguredDatabaseClient } from "../db/client.js";
import {
  EmbeddingService,
  factEmbeddingText,
  recipientEmbeddingText,
} from "./embedding.js";
import { RecipientMemoryRepository } from "./repository.js";
import {
  EMBEDDING_MODEL_ID,
  type RecipientInput,
  type UserMemoryInput,
} from "./types.js";

const seedSchema = z.object({
  recipients: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string(),
        address: z.string().min(1),
      }),
    )
    .default([]),
  facts: z
    .array(
      z.object({ fact: z.string().min(1), kind: z.string().min(1).optional() }),
    )
    .default([]),
});

export async function seedConfirmedMemory(
  repository: RecipientMemoryRepository,
  embeddings: EmbeddingService,
  userId: string,
  values: { recipients: RecipientInput[]; facts: UserMemoryInput[] },
): Promise<void> {
  for (const recipient of values.recipients) {
    const embedding = await embeddings.embed(
      recipientEmbeddingText(recipient.name, recipient.description),
    );
    await repository.insertRecipient(
      userId,
      recipient,
      embedding,
      EMBEDDING_MODEL_ID,
    );
  }
  for (const fact of values.facts) {
    const embedding = await embeddings.embed(factEmbeddingText(fact.fact));
    await repository.insertFact(userId, fact, embedding, EMBEDDING_MODEL_ID);
  }
}

async function main(): Promise<void> {
  const config = readRecipientMemoryConfig();
  if (!config.enabled || !config.seedFile) {
    throw new Error(
      "Recipient memory and RECIPIENT_MEMORY_SEED_FILE are required for seeding.",
    );
  }
  // There is no fixed demo tenant any more: identity is the Privy user resolved
  // per login, so the operator names the user this seed is scoped to.
  const userId = process.argv[2]?.trim();
  if (!userId) {
    throw new Error(
      "A target user id is required for seeding: npm run db:seed -- <userId>.",
    );
  }
  // Decode the seed file at the I/O boundary: parse errors become a single
  // actionable seed failure instead of an unguarded throw.
  let input: { recipients: RecipientInput[]; facts: UserMemoryInput[] };
  try {
    input = seedSchema.parse(
      JSON.parse(await readFile(config.seedFile, "utf8")),
    );
  } catch (error) {
    const reason =
      error instanceof Error ? error.message : "unknown parse error";
    throw new Error(
      `Recipient memory seed file could not be parsed: ${reason}`,
    );
  }
  const database = createConfiguredDatabaseClient();
  try {
    await seedConfirmedMemory(
      new RecipientMemoryRepository(database),
      new EmbeddingService(config.modelCacheDirectory),
      userId,
      input,
    );
  } finally {
    await database.close();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    console.error(
      error instanceof Error ? error.message : "Recipient memory seed failed.",
    );
    process.exitCode = 1;
  });
}
