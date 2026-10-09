import { describe, expect, it, vi } from "vitest";

// Hermetic: the network and token the health contract asserts come from the
// ambient .env otherwise, so they are pinned before the server import (dotenv
// evaluates that file during the import chain). The wallet provider is NOT
// pinned here: buildTestServer injects the fixture doubles the removed
// `WDK_TOOLS_SOURCE=fixture` pin used to select.
//
// The server is built through the injected-identity fixture: production identity
// is always Privy, so a bare `buildServer()` would demand Privy credentials, and
// this suite is about the health contract, not authentication. With no Privy
// identity inputs in the environment `MODE()` reports `fixture`, which is the
// contract asserted below.
vi.hoisted(() => {
  process.env.WDK_NETWORK = "sepolia";
  process.env.WDK_TOKEN = "USDT";
});

import { buildTestServer } from "../fixtures/test-server.js";

describe("GET /health", () => {
  it("reports ok status with mcp and wallet state", async () => {
    const app = buildTestServer();
    const response = await app.inject({ method: "GET", url: "/health" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.status).toBe("ok");
    expect(body.mcp).toBe("connected");
    expect(body.wallet).toBe("unlocked");
    expect(body.mode).toBe("fixture");
    expect(body.network).toBe("sepolia");

    await app.close();
  });

  it("allows the configured frontend origin without reflecting an unknown origin", async () => {
    // Hermetic: the local development .env may set CORS_ORIGINS; this test
    // exercises the built-in default allowlist instead.
    const previous = process.env.CORS_ORIGINS;
    delete process.env.CORS_ORIGINS;
    try {
      const app = buildTestServer();
      const allowed = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "http://localhost:8083" },
      });
      const unknown = await app.inject({
        method: "GET",
        url: "/health",
        headers: { origin: "https://untrusted.example" },
      });

      expect(allowed.headers["access-control-allow-origin"]).toBe(
        "http://localhost:8083",
      );
      expect(unknown.headers["access-control-allow-origin"]).toBeUndefined();

      await app.close();
    } finally {
      if (previous !== undefined) process.env.CORS_ORIGINS = previous;
    }
  });
});
