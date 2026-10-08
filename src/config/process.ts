import { createPrivateKey, createPublicKey } from "node:crypto";
import { z } from "zod";
import { readLiveKitPrivacyConfig } from "./livekit.js";

const uuid = z.string().uuid();

function required(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required for this process.`);
  return value;
}

function positiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  const parsed = Number(value ?? fallback);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function normalizePem(value: string): string {
  return value.replace(/\\n/gu, "\n");
}

function assertEd25519Key(
  value: string,
  name: string,
  kind: "private" | "public",
): void {
  try {
    if (kind === "public" && /BEGIN PRIVATE KEY/u.test(value))
      throw new Error("private key supplied");
    if (
      kind === "private" &&
      !/BEGIN (?:PRIVATE KEY|OPENSSH PRIVATE KEY)/u.test(value)
    )
      throw new Error("private key missing");
    const key =
      kind === "private"
        ? createPrivateKey(normalizePem(value))
        : createPublicKey(normalizePem(value));
    if (key.asymmetricKeyType !== "ed25519") throw new Error("wrong key type");
  } catch {
    throw new Error(`${name} must be a valid Ed25519 ${kind} key.`);
  }
}

export type IdentityProviderMode = "demo" | "privy";

export type ApiProcessConfig = {
  host: string;
  port: number;
  identityProvider: IdentityProviderMode;
  databaseUrl?: string;
  demoUserId?: string;
  bindingPrivateKey?: string;
};

export type WorkerProcessConfig = LiveKitWorkerConfig & {
  identityProvider: IdentityProviderMode;
  databaseUrl: string;
  demoUserId: string;
};

/**
 * PMU-001: exactly two identity modes. `demo` (default) keys identity to the
 * demo sentinel; `privy` verifies Privy access tokens and requires the app id
 * plus verification key. Any other value rejects startup.
 */
export function readIdentityProviderMode(
  environment: NodeJS.ProcessEnv = process.env,
): IdentityProviderMode {
  const raw = environment.IDENTITY_PROVIDER?.trim() || "demo";
  if (raw !== "demo" && raw !== "privy") {
    throw new Error("IDENTITY_PROVIDER must be either 'demo' or 'privy'.");
  }
  return raw;
}

/**
 * PMU-024: until the per-user wallet change replaces the shared singleton, the
 * identity foundation must not serve financial operations from a funded/live
 * singleton provider in privy mode. Fixture stays available for preview.
 *
 * `solana-devnet` is the one exception, and it is not a singleton: its signing
 * path resolves a per-user wallet binding, so the singleton provider has no
 * sender identity and fails closed. `readPrivyServerConfig` already allows it
 * for that reason; this guard must accept exactly the same set, otherwise the
 * API refuses to boot on a configuration the rest of the stack supports.
 */
const PER_USER_BOUND_SOURCES = new Set(["fixture", "solana-devnet"]);

function rejectFundedSingletonInPrivyMode(
  environment: NodeJS.ProcessEnv,
  identityProvider: IdentityProviderMode,
): void {
  if (identityProvider !== "privy") return;
  const source = environment.WDK_TOOLS_SOURCE?.trim() || "fixture";
  if (!PER_USER_BOUND_SOURCES.has(source)) {
    throw new Error(
      `WDK_TOOLS_SOURCE=${source} is not allowed with IDENTITY_PROVIDER=privy: the identity foundation must not start with a funded singleton wallet provider. Use 'fixture' or the per-user-bound 'solana-devnet' provider.`,
    );
  }
}

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
  const identityProvider = readIdentityProviderMode(environment);
  const databaseUrl = environment.DATABASE_URL?.trim() || undefined;
  const demoUserId = environment.DEMO_USER_ID?.trim() || undefined;
  if (identityProvider === "demo") {
    if (databaseUrl && (!demoUserId || !uuid.safeParse(demoUserId).success)) {
      throw new Error(
        "DEMO_USER_ID must be a UUID when DATABASE_URL is configured.",
      );
    }
  } else {
    // PMU-001: privy mode requires Privy credentials; the demo sentinel is a
    // demo-only concern and must not be configured.
    const appId = environment.PRIVY_APP_ID?.trim();
    const verificationKey = environment.PRIVY_VERIFICATION_KEY?.trim();
    if (!appId)
      throw new Error("PRIVY_APP_ID is required when IDENTITY_PROVIDER=privy.");
    if (!verificationKey)
      throw new Error(
        "PRIVY_VERIFICATION_KEY is required when IDENTITY_PROVIDER=privy.",
      );
    if (demoUserId)
      throw new Error(
        "DEMO_USER_ID must not be set when IDENTITY_PROVIDER=privy.",
      );
  }
  rejectFundedSingletonInPrivyMode(environment, identityProvider);

  const bindingPrivateKey =
    environment.LIVE_VOICE_BINDING_PRIVATE_KEY?.trim() || undefined;
  if (bindingPrivateKey)
    assertEd25519Key(
      bindingPrivateKey,
      "LIVE_VOICE_BINDING_PRIVATE_KEY",
      "private",
    );
  if (
    (environment.LIVE_VOICE_ENABLED === "true" ||
      environment.LIVE_VOICE_ENABLED === "1") &&
    !bindingPrivateKey
  ) {
    throw new Error(
      "LIVE_VOICE_BINDING_PRIVATE_KEY is required when LIVE_VOICE_ENABLED is true.",
    );
  }
  if (environment.NODE_ENV === "production") {
    if (!databaseUrl)
      throw new Error("DATABASE_URL is required for production API access.");
    if (!demoUserId || !uuid.safeParse(demoUserId).success)
      throw new Error(
        "DEMO_USER_ID must be replaced with an authenticated identity provider in production.",
      );
    if (!bindingPrivateKey)
      throw new Error(
        "LIVE_VOICE_BINDING_PRIVATE_KEY is required for production API access.",
      );
  }

  return {
    host: environment.HOST?.trim() || "127.0.0.1",
    port: positiveInteger(environment.PORT, "PORT", 3000),
    identityProvider,
    databaseUrl,
    demoUserId,
    bindingPrivateKey,
  };
}

export function readWorkerProcessConfig(
  environment: NodeJS.ProcessEnv = process.env,
): WorkerProcessConfig {
  const identityProvider = readIdentityProviderMode(environment);
  const liveKit = readLiveKitWorkerConfig(environment);
  const publicKey = required(environment, "LIVE_VOICE_BINDING_PUBLIC_KEY");
  assertEd25519Key(publicKey, "LIVE_VOICE_BINDING_PUBLIC_KEY", "public");
  const databaseUrl = required(environment, "DATABASE_URL");
  if (identityProvider === "demo") {
    const demoUserId = required(environment, "DEMO_USER_ID");
    if (!uuid.safeParse(demoUserId).success)
      throw new Error("DEMO_USER_ID must be a UUID for the worker.");
    required(environment, "OPENAI_API_KEY");
    return {
      ...liveKit,
      identityProvider,
      publicKey,
      databaseUrl,
      demoUserId,
    };
  }
  // PMU-001: privy mode requires Privy credentials; the demo sentinel is a
  // demo-only concern and must not be configured.
  const appId = environment.PRIVY_APP_ID?.trim();
  const verificationKey = environment.PRIVY_VERIFICATION_KEY?.trim();
  if (!appId)
    throw new Error("PRIVY_APP_ID is required when IDENTITY_PROVIDER=privy.");
  if (!verificationKey)
    throw new Error(
      "PRIVY_VERIFICATION_KEY is required when IDENTITY_PROVIDER=privy.",
    );
  if (environment.DEMO_USER_ID?.trim())
    throw new Error(
      "DEMO_USER_ID must not be set when IDENTITY_PROVIDER=privy.",
    );
  required(environment, "OPENAI_API_KEY");
  // The worker binds memory tools to the resolved per-session user; without a
  // demo sentinel the resolved UUID arrives at runtime via the conversation binding.
  return {
    ...liveKit,
    identityProvider,
    publicKey,
    databaseUrl,
    demoUserId: "",
  };
}

export const readApiConfig = readApiProcessConfig;
export const readWorkerConfig = readWorkerProcessConfig;
