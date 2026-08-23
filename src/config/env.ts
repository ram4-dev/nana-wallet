import { z } from 'zod';

const uuid = z.string().uuid();

const optionalNonEmpty = z.preprocess(
  (value) => value === '' || value === undefined ? undefined : value,
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  RECIPIENT_MEMORY_ENABLED: z.enum(['true', 'false']).optional().default('false'),
  DATABASE_URL: optionalNonEmpty,
  DATABASE_ADMIN_URL: optionalNonEmpty,
  DEMO_USER_ID: optionalNonEmpty,
  RECIPIENT_MEMORY_MODEL_CACHE: z.string().min(1).optional().default('.cache/recipient-memory-model'),
  RECIPIENT_MEMORY_SCORE_THRESHOLD: z.coerce.number().min(0).max(1).optional().default(0.78),
  RECIPIENT_MEMORY_SCORE_MARGIN: z.coerce.number().min(0).max(1).optional().default(0.08),
  RECIPIENT_MEMORY_SEED_FILE: optionalNonEmpty,
});

export type RecipientMemoryConfig = {
  enabled: boolean;
  databaseUrl?: string;
  databaseAdminUrl?: string;
  demoUserId?: string;
  modelCacheDirectory: string;
  scoreThreshold: number;
  scoreMargin: number;
  seedFile?: string;
};

export function readRecipientMemoryConfig(environment: NodeJS.ProcessEnv = process.env): RecipientMemoryConfig {
  const parsed = environmentSchema.parse(environment);
  const enabled = parsed.RECIPIENT_MEMORY_ENABLED === 'true';

  if (enabled) {
    if (!parsed.DATABASE_URL) {
      throw new Error('DATABASE_URL is required when RECIPIENT_MEMORY_ENABLED=true.');
    }
    if (!parsed.DEMO_USER_ID || !uuid.safeParse(parsed.DEMO_USER_ID).success) {
      throw new Error('DEMO_USER_ID must be a UUID when RECIPIENT_MEMORY_ENABLED=true.');
    }
  }

  return {
    enabled,
    databaseUrl: parsed.DATABASE_URL,
    databaseAdminUrl: parsed.DATABASE_ADMIN_URL,
    demoUserId: parsed.DEMO_USER_ID,
    modelCacheDirectory: parsed.RECIPIENT_MEMORY_MODEL_CACHE,
    scoreThreshold: parsed.RECIPIENT_MEMORY_SCORE_THRESHOLD,
    scoreMargin: parsed.RECIPIENT_MEMORY_SCORE_MARGIN,
    seedFile: parsed.RECIPIENT_MEMORY_SEED_FILE,
  };
}
