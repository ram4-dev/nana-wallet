import { describe, expect, it } from "vitest";
import { readPrivyServerConfig } from "../../src/config/privy-server.js";

describe("Privy server configuration for per-user Solana devnet", () => {
  const base = {
    IDENTITY_PROVIDER: "privy",
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
  };

  it("allows the Solana provider only with the Privy identity path", () => {
    expect(
      readPrivyServerConfig({ ...base, WDK_TOOLS_SOURCE: "solana-devnet" }),
    ).toMatchObject({ appId: "app" });
    expect(() =>
      readPrivyServerConfig({ ...base, WDK_TOOLS_SOURCE: "live" }),
    ).toThrow(/WDK_TOOLS_SOURCE/);
  });
});
