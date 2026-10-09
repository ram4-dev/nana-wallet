import { describe, expect, it } from "vitest";
import { readPrivyServerConfig } from "../../src/config/privy-server.js";

// The `WDK_TOOLS_SOURCE` allowlist this file used to pin is gone with the
// switch: there is no provider selector left, so there is no funded-singleton
// source to reject. What remains is the server-client input contract itself.
describe("Privy server configuration input requirements", () => {
  const base = {
    PRIVY_APP_ID: "app",
    PRIVY_APP_SECRET: "secret",
  };

  it("builds the server client from the app id and secret", () => {
    expect(readPrivyServerConfig(base)).toMatchObject({ appId: "app" });
  });

  it("stays unconfigured without the server secret", () => {
    expect(readPrivyServerConfig({ PRIVY_APP_ID: "app" })).toBeUndefined();
  });
});
