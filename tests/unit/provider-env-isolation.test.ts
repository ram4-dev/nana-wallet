import { describe, expect, it } from "vitest";
import { isolateProviderEnvironment } from "../setup/isolate-provider-env.js";
import { createWorkerPayloadSigner } from "../../src/wallet/signer/index.js";

describe("provider environment isolation", () => {
  it("removes ambient signer capabilities before a fixture can construct a live signer", () => {
    const environment: NodeJS.ProcessEnv = {
      PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign",
      PRIVY_SIGNER_TOKEN: "fixture-token",
      PRIVY_SIGNER_KEY_FILE: "/fixture/key",
      PRIVY_SIGNER_TIMEOUT_MS: "5000",
      DATABASE_URL: "fixture-db",
    };
    isolateProviderEnvironment(environment);
    expect(createWorkerPayloadSigner(environment)).toBeUndefined();
    expect(environment.PRIVY_SIGNER_KEY_FILE).toBeUndefined();
    expect(environment.DATABASE_URL).toBe("fixture-db");
  });

  it("preserves explicitly opted-in real-mode configuration", () => {
    const environment: NodeJS.ProcessEnv = {
      VI_TEST_AMBIENT_PROVIDER_ENV: "1",
      PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign",
      PRIVY_SIGNER_TOKEN: "fixture-token",
    };
    isolateProviderEnvironment(environment);
    expect(environment.PRIVY_SIGNER_TOKEN).toBe("fixture-token");
  });
});
