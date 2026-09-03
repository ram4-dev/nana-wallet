import { z } from "zod";

const booleanFlag = z.preprocess(
  (value) => {
    if (value === undefined || value === "") return undefined;
    return value;
  },
  z.enum(["true", "false", "1", "0"]).optional(),
);

const privacySchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).optional().default("development"),
  VOICE_TRACE_ENABLED: booleanFlag.default("false"),
  VOICE_TRACE_RETENTION_DAYS: z.coerce.number().int().min(1).max(7).optional().default(7),
  VOICE_TRACE_DESTINATION: z.string().trim().min(1).optional(),
  VOICE_TRACE_PRIVACY_APPROVED: booleanFlag.default("false"),
  VOICE_TRACE_ACCESS_ROLE: z.string().trim().min(1).optional(),
  VOICE_TRACE_DELETION_MECHANISM: z.string().trim().min(1).optional(),
  ELEVENLABS_ZERO_RETENTION_VERIFIED: booleanFlag.default("false"),
});

export type VoiceTraceConfig = {
  enabled: boolean;
  environment: "development" | "test" | "production";
  retentionDays: number;
  destination?: string;
  privacyApproved: boolean;
  accessRole?: string;
  deletionMechanism?: string;
};

export type VoiceProviderConfig = {
  elevenLabsZeroRetentionVerified: boolean;
  elevenLabsEnableLogging: boolean;
};

function isTrue(value: string | undefined): boolean {
  return value === "true" || value === "1";
}

export function readVoiceTraceConfig(
  environment: NodeJS.ProcessEnv = process.env,
): VoiceTraceConfig {
  const parsed = privacySchema.parse(environment);
  const enabled = isTrue(parsed.VOICE_TRACE_ENABLED);
  const privacyApproved = isTrue(parsed.VOICE_TRACE_PRIVACY_APPROVED);

  if (parsed.NODE_ENV === "production" && enabled) {
    if (!privacyApproved) {
      throw new Error("Production voice traces require VOICE_TRACE_PRIVACY_APPROVED=true.");
    }
    if (!parsed.VOICE_TRACE_DESTINATION) {
      throw new Error("Production voice traces require VOICE_TRACE_DESTINATION.");
    }
    if (!parsed.VOICE_TRACE_ACCESS_ROLE) {
      throw new Error("Production voice traces require VOICE_TRACE_ACCESS_ROLE.");
    }
    if (!parsed.VOICE_TRACE_DELETION_MECHANISM) {
      throw new Error("Production voice traces require VOICE_TRACE_DELETION_MECHANISM.");
    }
  }

  return {
    enabled,
    environment: parsed.NODE_ENV,
    retentionDays: parsed.VOICE_TRACE_RETENTION_DAYS,
    destination: parsed.VOICE_TRACE_DESTINATION,
    privacyApproved,
    accessRole: parsed.VOICE_TRACE_ACCESS_ROLE,
    deletionMechanism: parsed.VOICE_TRACE_DELETION_MECHANISM,
  };
}

export function readVoiceProviderConfig(
  environment: NodeJS.ProcessEnv = process.env,
): VoiceProviderConfig {
  const parsed = privacySchema.parse(environment);
  const verified = isTrue(parsed.ELEVENLABS_ZERO_RETENTION_VERIFIED);
  return {
    elevenLabsZeroRetentionVerified: verified,
    // ElevenLabs only accepts enable_logging=false for accounts with the
    // verified zero-retention capability. Otherwise use provider defaults.
    elevenLabsEnableLogging: !verified,
  };
}

export function canInspectVoiceMetrics(
  environment: NodeJS.ProcessEnv = process.env,
): boolean {
  return readVoiceTraceConfig(environment).environment !== "production";
}
