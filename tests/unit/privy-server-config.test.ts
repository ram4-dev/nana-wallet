import { describe, expect, it } from "vitest";
import { readPrivyServerConfig } from "../../src/config/privy-server.js";

describe("Privy server configuration for per-user Solana devnet", () => {
  const base = {
    IDENTITY_PROVIDER: "privy",
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
  };

  it("allows only the per-user-bound providers in the Privy identity path", () => {
    for (const source of ["fixture", "solana-devnet"] as const) {
      expect(
        readPrivyServerConfig({ ...base, WDK_TOOLS_SOURCE: source }),
      ).toMatchObject({ appId: "app" });
    }
    // The `live`/WDK provider family was removed; a stale value is still
    // rejected in privy mode instead of silently selecting a provider.
    expect(() =>
      readPrivyServerConfig({ ...base, WDK_TOOLS_SOURCE: "live" }),
    ).toThrow(/WDK_TOOLS_SOURCE/);
  });
});
