import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { readWorkerProcessConfig } from "../../src/config/process.js";

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: String(keys.privateKey.export({ type: "pkcs8", format: "pem" })),
    publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
  };
}

function workerEnv(overrides: Record<string, string | undefined> = {}) {
  return {
    LIVEKIT_URL: "wss://example.livekit.cloud",
    LIVEKIT_API_KEY: "dev-key",
    LIVEKIT_API_SECRET: "dev-secret",
    DATABASE_URL: "postgres://local",
    OPENAI_API_KEY: "openai-key",
    LIVE_VOICE_BINDING_PUBLIC_KEY: keyPair().publicKey,
    ...overrides,
  };
}

describe("worker configuration", () => {
  it("requires OPENAI_API_KEY", () => {
    expect(() =>
      readWorkerProcessConfig(workerEnv({ OPENAI_API_KEY: undefined })),
    ).toThrow("OPENAI_API_KEY is required");
  });

  it("accepts a complete worker environment", () => {
    const config = readWorkerProcessConfig(workerEnv());
    expect(config).toMatchObject({
      databaseUrl: "postgres://local",
    });
  });

  it("no longer reads a voice provider", () => {
    const config = readWorkerProcessConfig(
      workerEnv({ LIVEKIT_VOICE_PROVIDER: "telepathic" }),
    );
    expect("voiceProvider" in config).toBe(false);
  });
});
