import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { readLiveKitPrivacyConfig } from "./livekit.js";
import { readElevenLabsApiKey } from "./privacy.js";

const uuid = z.string().uuid();

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for this process.`);
  return value;
}

function positiveInteger(value: string | undefined, name: string, fallback: number): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, "\n");
}

function assertEd25519Key(value: string, name: string, kind: "private" | "public"): void {
  try {
    if (kind === "public" && /BEGIN PRIVATE KEY/u.test(value)) throw new Error("private key supplied");
    if (kind === "private" && !/BEGIN (?:PRIVATE KEY|OPENSSH PRIVATE KEY)/u.test(value)) throw new Error("private key missing");
    const key = kind === "private"
      ? createPrivateKey(normalizePem(value))
      : createPublicKey(normalizePem(value));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw new Error(`${name} must be a valid Ed25519 ${kind} key.`);
  }
}

export type ApiProcessConfig = {
  host: string;
  port: number;
  databaseUrl?: string;
  demoUserId?: string;
  bindingPrivateKey?: string;
};

export type WorkerProcessConfig = LiveKitWorkerConfig & {
  databaseUrl: string;
  demoUserId: string;
  elevenLabsApiKey: string;
};

export type LiveKitAgentRuntime = "service-adapter" | "native-livekit";

export const nativeLiveKitRetirementGates = [
  "runtime-parity",
  "privacy-safe-metrics",
  "cloud-smoke",
  "browser-manual-verification",
] as const;

export type NativeLiveKitRetirementGate =
  (typeof nativeLiveKitRetirementGates)[number];

export type LiveKitWorkerConfig = {
  url: string;
  apiKey: string;
  apiSecret: string;
  publicKey?: string;
  shutdownTimeoutMs: number;
  agentRuntime: LiveKitAgentRuntime;
};

export function readLiveKitAgentRuntime(
  environment: NodeJS.ProcessEnv = process.env,
): LiveKitAgentRuntime {
  const configured = environment.LIVEKIT_AGENT_RUNTIME;
  if (configured === undefined) return "service-adapter";
  if (configured === "service-adapter" || configured === "native-livekit") {
    return configured;
  }
  throw new Error(
    "LIVEKIT_AGENT_RUNTIME must be either service-adapter or native-livekit.",
  );
}

export function readLiveKitWorkerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): LiveKitWorkerConfig {
  readLiveKitPrivacyConfig(environment);
  const url = environment.LIVEKIT_URL?.trim();
  const apiKey = environment.LIVEKIT_API_KEY?.trim();
  const apiSecret = environment.LIVEKIT_API_SECRET?.trim();
  const publicKey = environment.LIVE_VOICE_BINDING_PUBLIC_KEY?.trim();
  if (!url || !apiKey || !apiSecret) {
    throw new Error(
      "LiveKit worker requires LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET.",
    );
  }
  const shutdownTimeoutMs = positiveInteger(
    environment.LIVEKIT_SHUTDOWN_TIMEOUT_MS,
    "LIVEKIT_SHUTDOWN_TIMEOUT_MS",
    10_000,
  );
  const agentRuntime = readLiveKitAgentRuntime(environment);
  if (agentRuntime === "native-livekit") {
    required(environment, "OPENCODE_GO_API_KEY");
  }
  return {
    url,
    apiKey,
    apiSecret,
    publicKey,
    shutdownTimeoutMs,
    agentRuntime,
  };
}

export function readApiProcessConfig(
  environment: NodeJS.ProcessEnv = process.env,
): ApiProcessConfig {
  const databaseUrl = environment.DATABASE_URL?.trim() || undefined;
  const demoUserId = environment.DEMO_USER_ID?.trim() || undefined;
  if (databaseUrl && (!demoUserId || !uuid.safeParse(demoUserId).success)) {
    throw new Error("DEMO_USER_ID must be a UUID when DATABASE_URL is configured.");
  }

  const bindingPrivateKey = environment.LIVE_VOICE_BINDING_PRIVATE_KEY?.trim() || undefined;
  if (bindingPrivateKey) assertEd25519Key(bindingPrivateKey, "LIVE_VOICE_BINDING_PRIVATE_KEY", "private");
  if ((environment.LIVE_VOICE_ENABLED === "true" || environment.LIVE_VOICE_ENABLED === "1") && !bindingPrivateKey) {
    throw new Error("LIVE_VOICE_BINDING_PRIVATE_KEY is required when LIVE_VOICE_ENABLED is true.");
  }
  if (environment.NODE_ENV === "production") {
    if (!databaseUrl) throw new Error("DATABASE_URL is required for production API access.");
    if (!demoUserId || !uuid.safeParse(demoUserId).success)
      throw new Error("DEMO_USER_ID must be replaced with an authenticated identity provider in production.");
    if (!bindingPrivateKey)
      throw new Error("LIVE_VOICE_BINDING_PRIVATE_KEY is required for production API access.");
  }

  return {
    host: environment.HOST?.trim() || "127.0.0.1",
    port: positiveInteger(environment.PORT, "PORT", 3000),
    databaseUrl,
    demoUserId,
    bindingPrivateKey,
  };
}

export function readWorkerProcessConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerProcessConfig {
  const liveKit = readLiveKitWorkerConfig(environment);
  const publicKey = required(environment, "LIVE_VOICE_BINDING_PUBLIC_KEY");
  assertEd25519Key(publicKey, "LIVE_VOICE_BINDING_PUBLIC_KEY", "public");
  const databaseUrl = required(environment, "DATABASE_URL");
  const demoUserId = required(environment, "DEMO_USER_ID");
  if (!uuid.safeParse(demoUserId).success) throw new Error("DEMO_USER_ID must be a UUID for the worker.");
  const elevenLabsApiKey = readElevenLabsApiKey(environment);
  if (!elevenLabsApiKey) {
    throw new Error("ELEVENLABS_API_KEY or ELEVEN_LABS is required for this process.");
  }
  return { ...liveKit, publicKey, databaseUrl, demoUserId, elevenLabsApiKey };
}

export const readApiConfig = readApiProcessConfig;
export const readWorkerConfig = readWorkerProcessConfig;
