import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  readApiProcessConfig,
  readWorkerProcessConfig,
} from "../../src/config/process.js";
import { readElevenLabsApiKey } from "../../src/config/privacy.js";

// A real (throwaway) ES256 public key generated at test runtime: config tests
// must validate that the value actually parses as a PEM key.
function es256KeyPair() {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return String(keys.publicKey.export({ type: "spki", format: "pem" }));
}
const PRIVY_TEST_KEY = es256KeyPair();

function keyPair() {
  const keys = generateKeyPairSync("ed25519");
  return {
    privateKey: String(
      keys.privateKey.export({ type: "pkcs8", format: "pem" }),
    ),
    publicKey: String(keys.publicKey.export({ type: "spki", format: "pem" })),
  };
}

describe("process-specific configuration", () => {
  it("allows a fixture API without live credentials", () => {
    expect(readApiProcessConfig({ PORT: "3001" })).toMatchObject({
      host: "127.0.0.1",
      port: 3001,
    });
  });

  it("requires a tenant when the API has durable database access", () => {
    expect(() =>
      readApiProcessConfig({ DATABASE_URL: "postgres://local" }),
    ).toThrow("DEMO_USER_ID");
  });

  it("defaults to the demo identity provider and rejects unknown values (PMU-001)", () => {
    expect(readApiProcessConfig({ PORT: "3001" })).toMatchObject({
      identityProvider: "demo",
    });
    expect(
      readApiProcessConfig({
        PORT: "3001",
        IDENTITY_PROVIDER: "demo",
        DEMO_USER_ID: "11111111-1111-4111-8111-111111111111",
      }),
    ).toMatchObject({ identityProvider: "demo" });
    expect(() => readApiProcessConfig({ IDENTITY_PROVIDER: "auth0" })).toThrow(
      "IDENTITY_PROVIDER",
    );
  });

  it("privy mode requires Privy credentials and rejects the demo sentinel id (PMU-001)", () => {
    expect(() => readApiProcessConfig({ IDENTITY_PROVIDER: "privy" })).toThrow(
      /PRIVY_APP_ID/u,
    );
    expect(() =>
      readApiProcessConfig({ IDENTITY_PROVIDER: "privy", PRIVY_APP_ID: "app" }),
    ).toThrow(/PRIVY_VERIFICATION_KEY/u);
    expect(() =>
      readApiProcessConfig({
        IDENTITY_PROVIDER: "privy",
        PRIVY_APP_ID: "app",
        PRIVY_VERIFICATION_KEY: PRIVY_TEST_KEY,
        DEMO_USER_ID: "11111111-1111-4111-8111-111111111111",
      }),
    ).toThrow("DEMO_USER_ID");
    expect(
      readApiProcessConfig({
        IDENTITY_PROVIDER: "privy",
        PRIVY_APP_ID: "app",
        PRIVY_VERIFICATION_KEY: PRIVY_TEST_KEY,
      }),
    ).toMatchObject({ identityProvider: "privy" });
  });

  it("rejects a funded singleton wallet provider in privy mode (PMU-024)", () => {
    // The `live`/WDK provider family was removed from the switch; a stale
    // `WDK_TOOLS_SOURCE=live` is still rejected in privy mode instead of
    // silently selecting a provider. The per-user-bound sources are accepted.
    expect(() =>
      readApiProcessConfig({
        IDENTITY_PROVIDER: "privy",
        PRIVY_APP_ID: "app",
        PRIVY_VERIFICATION_KEY: PRIVY_TEST_KEY,
        WDK_TOOLS_SOURCE: "live",
      }),
    ).toThrow(/singleton|funded|WDK_TOOLS_SOURCE/u);
    for (const source of ["fixture", "solana-devnet"] as const) {
      expect(
        readApiProcessConfig({
          IDENTITY_PROVIDER: "privy",
          PRIVY_APP_ID: "app",
          PRIVY_VERIFICATION_KEY: PRIVY_TEST_KEY,
          WDK_TOOLS_SOURCE: source,
        }),
      ).toMatchObject({ identityProvider: "privy" });
    }
  });

  it("accepts the per-user-bound solana-devnet provider in privy mode (PMU-024)", () => {
    // The guard exists to keep a FUNDED SINGLETON out of privy mode. Solana
    // devnet signs through a per-user wallet binding, so it has no singleton
    // sender identity and fails closed on its own. This must stay in sync with
    // `readPrivyServerConfig`, which already allows it: an API that refuses to
    // boot on a configuration the rest of the stack supports is unusable.
    expect(
      readApiProcessConfig({
        IDENTITY_PROVIDER: "privy",
        PRIVY_APP_ID: "app",
        PRIVY_VERIFICATION_KEY: PRIVY_TEST_KEY,
        WDK_TOOLS_SOURCE: "solana-devnet",
      }),
    ).toMatchObject({ identityProvider: "privy" });
  });

  it("rejects an invalid API binding key", () => {
    expect(() =>
      readApiProcessConfig({
        LIVE_VOICE_ENABLED: "true",
        LIVE_VOICE_BINDING_PRIVATE_KEY: "not-a-key",
      }),
    ).toThrow("Ed25519");
  });

  it("requires worker-only credentials and validates key roles", () => {
    const keys = keyPair();
    const base = {
      LIVEKIT_URL: "wss://example.livekit.cloud",
      LIVEKIT_API_KEY: "dev-key",
      LIVEKIT_API_SECRET: "dev-secret",
      DATABASE_URL: "postgres://local",
      DEMO_USER_ID: "11111111-1111-4111-8111-111111111111",
      OPENAI_API_KEY: "openai-key",
    };
    expect(() => readWorkerProcessConfig(base)).toThrow(
      "LIVE_VOICE_BINDING_PUBLIC_KEY",
    );
    expect(() =>
      readWorkerProcessConfig({
        ...base,
        LIVE_VOICE_BINDING_PUBLIC_KEY: keys.privateKey,
      }),
    ).toThrow("Ed25519 public");
    expect(
      readWorkerProcessConfig({
        ...base,
        LIVE_VOICE_BINDING_PUBLIC_KEY: keys.publicKey,
      }),
    ).toMatchObject({
      databaseUrl: "postgres://local",
      demoUserId: "11111111-1111-4111-8111-111111111111",
    });
  });

  it("requires the OpenAI key for the worker and no longer consumes ElevenLabs there", () => {
    // Post-migration: the worker requires OPENAI_API_KEY and no longer consumes
    // ElevenLabs (ElevenLabs remains only in the API process for the recorded
    // transport /v1/voice/speak).
    const keys = keyPair();
    const base = {
      LIVEKIT_URL: "wss://example.livekit.cloud",
      LIVEKIT_API_KEY: "dev-key",
      LIVEKIT_API_SECRET: "dev-secret",
      DATABASE_URL: "postgres://local",
      DEMO_USER_ID: "11111111-1111-4111-8111-111111111111",
      LIVE_VOICE_BINDING_PUBLIC_KEY: keys.publicKey,
    };
    expect(() => readWorkerProcessConfig(base)).toThrow(
      "OPENAI_API_KEY is required",
    );
    expect(
      readWorkerProcessConfig({ ...base, OPENAI_API_KEY: "vault-openai-key" }),
    ).toBeDefined();
  });
});

// The dedicated Vault key is consumed by the recorded-audio API; the current
// live worker uses OpenAI. Preserve the alias without reverting that migration.
describe("ElevenLabs API credential aliases", () => {
  it("prioritizes the dedicated Vault name and trims whitespace", () => {
    expect(
      readElevenLabsApiKey({
        ELEVEN_LABS_API_KEY: " dedicated ",
        ELEVEN_LABS: "legacy",
        ELEVENLABS_API_KEY: "compat",
      }),
    ).toBe("dedicated");
    expect(
      readElevenLabsApiKey({ ELEVEN_LABS_API_KEY: " ", ELEVEN_LABS: "legacy" }),
    ).toBe("legacy");
    expect(readElevenLabsApiKey({ ELEVENLABS_API_KEY: "compat" })).toBe(
      "compat",
    );
  });
});
