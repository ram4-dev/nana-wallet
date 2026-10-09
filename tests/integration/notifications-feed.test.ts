import { beforeAll, describe, expect, it, afterAll } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// RED: the authenticated notifications feed/read API (/v1/notifications, task 2.3)
// does not exist yet; these tests must fail until it is implemented.
suite("authenticated notifications feed HTTP (Slice 5 RED)", () => {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const verificationKeyPem = String(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );
  const previousEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of [
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "WDK_TOOLS_SOURCE",
      "DEMO_USER_ID",
    ]) {
      previousEnv[key] = process.env[key];
    }
    process.env.PRIVY_APP_ID = "test-notifications-feed";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
    process.env.WDK_TOOLS_SOURCE = "fixture";
    delete process.env.DEMO_USER_ID;
  });

  afterAll(() => {
    for (const key of Object.keys(previousEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  it("rejects unauthenticated feed access", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications",
      });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
