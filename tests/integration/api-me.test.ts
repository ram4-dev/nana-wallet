import { generateKeyPairSync } from "node:crypto";
import { vi, afterAll, beforeAll, describe, expect, it } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const DID_ME = "did:privy:test-me-user";

function es256Pair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

const appKeys = es256Pair();
const otherKeys = es256Pair();

async function tokenFor(
  keys: ReturnType<typeof es256Pair>,
  did: string,
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 5)
    .setIssuer("privy.io")
    .setAudience("test-identity-app")
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(keys.privateKey);
}

suite("/v1/me (PMU-007) and contacts auth (privy mode)", () => {
  const previous = { ...process.env };

  beforeAll(() => {
    process.env.PRIVY_APP_ID = "test-identity-app";
    process.env.PRIVY_VERIFICATION_KEY = String(
      appKeys.publicKey.export({ type: "spki", format: "pem" }),
    );
    process.env.WDK_TOOLS_SOURCE = "fixture";
    delete process.env.DEMO_USER_ID;
  });

  afterAll(() => {
    for (const key of [
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key] as string;
    }
    if (previous.DEMO_USER_ID === undefined) delete process.env.DEMO_USER_ID;
    else process.env.DEMO_USER_ID = previous.DEMO_USER_ID;
  });

  it("returns identity-only data for a verified token", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${await tokenFor(appKeys, DID_ME)}` },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json().data;
      expect(response.json().ok).toBe(true);
      expect(body).toMatchObject({
        userId: expect.any(String),
        displayName: null,
      });
      expect(JSON.stringify(body)).not.toContain("did:privy:");
      expect(body.userId).not.toContain("did:privy:");
      // Identity-only: no wallet or balance data.
      expect(Object.keys(body).sort()).toEqual(["displayName", "userId"]);
    } finally {
      await app.close();
    }
  });

  it("provisions the same UUID on repeat logins (idempotent, PMU-003)", async () => {
    const app = buildServer();
    try {
      const auth = {
        authorization: `Bearer ${await tokenFor(appKeys, DID_ME)}`,
      };
      const first = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: auth,
      });
      const second = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: auth,
      });
      expect(first.json().data.userId).toBe(second.json().data.userId);
    } finally {
      await app.close();
    }
  });

  it("rejects missing, invalid, expired, wrong-key and wrong-audience tokens with 401", async () => {
    const app = buildServer();
    try {
      const now = Math.floor(Date.now() / 1000);
      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(DID_ME)
        .setIssuedAt(now - 600)
        .setIssuer("privy.io")
        .setAudience("test-identity-app")
        .setExpirationTime(now - 300)
        .sign(appKeys.privateKey);
      const wrongKey = await tokenFor(otherKeys, DID_ME);
      const wrongAud = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(DID_ME)
        .setIssuedAt(now - 5)
        .setIssuer("privy.io")
        .setAudience("another-app")
        .setExpirationTime(now + 300)
        .sign(appKeys.privateKey);
      for (const [name, headers] of [
        ["missing", {}],
        ["invalid", { authorization: "Bearer not-a-jwt" }],
        ["expired", { authorization: `Bearer ${expired}` }],
        ["wrong-key", { authorization: `Bearer ${wrongKey}` }],
        ["wrong-audience", { authorization: `Bearer ${wrongAud}` }],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: "/v1/me",
          headers,
        });
        expect(response.statusCode, name).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it("rejects unauthenticated contacts access with 401", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/contacts" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });
});
