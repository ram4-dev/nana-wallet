import { z } from "zod";

const uuid = z.string().uuid();

const optionalNonEmpty = z.preprocess(
  (value) => (value === "" || value === undefined ? undefined : value),
  z.string().min(1).optional(),
);

const environmentSchema = z.object({
  RECIPIENT_MEMORY_ENABLED: z
    .enum(["true", "false"])
    .optional()
    .default("false"),
  IDENTITY_PROVIDER: z.enum(["demo", "privy"]).optional().default("demo"),
  DATABASE_URL: optionalNonEmpty,
  DEMO_USER_ID: optionalNonEmpty,
  RECIPIENT_MEMORY_MODEL_CACHE: z
    .string()
    .min(1)
    .optional()
    .default(".cache/recipient-memory-model"),
  RECIPIENT_MEMORY_SCORE_THRESHOLD: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.78),
  RECIPIENT_MEMORY_SCORE_MARGIN: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.08),
  RECIPIENT_MEMORY_SCORE_FLOOR: z.coerce
    .number()
    .min(0)
    .max(1)
    .optional()
    .default(0.55),
  RECIPIENT_MEMORY_SEED_FILE: optionalNonEmpty,
});

export type RecipientMemoryConfig = {
  enabled: boolean;
  identityProvider: "demo" | "privy";
  databaseUrl?: string;
  demoUserId?: string;
  modelCacheDirectory: string;
  scoreThreshold: number;
  scoreFloor: number;
  scoreMargin: number;
  seedFile?: string;
};

export function readRecipientMemoryConfig(
  environment: NodeJS.ProcessEnv = process.env,
): RecipientMemoryConfig {
  const parsed = environmentSchema.parse(environment);
  const enabled = parsed.RECIPIENT_MEMORY_ENABLED === "true";
  const identityProvider = parsed.IDENTITY_PROVIDER;

  if (enabled) {
    if (!parsed.DATABASE_URL) {
      throw new Error(
        "DATABASE_URL is required when RECIPIENT_MEMORY_ENABLED=true.",
      );
    }
    // PMU-004: DEMO_USER_ID is a demo-mode concern only.
    if (
      identityProvider === "demo" &&
      (!parsed.DEMO_USER_ID || !uuid.safeParse(parsed.DEMO_USER_ID).success)
    ) {
      throw new Error(
        "DEMO_USER_ID must be a UUID when RECIPIENT_MEMORY_ENABLED=true and IDENTITY_PROVIDER=demo.",
      );
    }
  }

  return {
    enabled,
    identityProvider,
    databaseUrl: parsed.DATABASE_URL,
    demoUserId: parsed.DEMO_USER_ID,
    modelCacheDirectory: parsed.RECIPIENT_MEMORY_MODEL_CACHE,
    scoreThreshold: parsed.RECIPIENT_MEMORY_SCORE_THRESHOLD,
    scoreFloor: parsed.RECIPIENT_MEMORY_SCORE_FLOOR,
    scoreMargin: parsed.RECIPIENT_MEMORY_SCORE_MARGIN,
    seedFile: parsed.RECIPIENT_MEMORY_SEED_FILE,
  };
}

export {
  readApiProcessConfig,
  readApiConfig,
  readWorkerConfig,
  readWorkerProcessConfig,
} from "./process.js";
export { readVoiceTraceConfig } from "./privacy.js";
