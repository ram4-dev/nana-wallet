import { generateKeyPairSync } from "node:crypto";
import { vi, afterAll, beforeAll, describe, expect, it } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-me).
vi.setConfig({ testTimeout: 15_000 });

import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// Unique identity per run: the session floor is durable state on the shared
// database, so reusing a fixed DID across runs would leak a previous floor into
// a later run's "no floor yet" assertions.
const RUN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const did = (name: string) => `did:privy:logout-${RUN}-${name}`;

const appKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const otherKeys = generateKeyPairSync("ec", { namedCurve: "P-256" });

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

async function tokenFor(
  subject: string,
  options: { issuedAt?: number; expiresAt?: number; audience?: string } = {},
): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(subject)
    .setIssuedAt(options.issuedAt ?? nowSeconds() - 5)
    .setIssuer("privy.io")
    .setAudience(options.audience ?? "test-identity-app")
    .setExpirationTime(options.expiresAt ?? nowSeconds() + 300)
    .sign(appKeys.privateKey);
}

suite("POST /v1/auth/logout and the session floor (privy mode)", () => {
  const previous = { ...process.env };

  beforeAll(() => {
    process.env.PRIVY_APP_ID = "test-identity-app";
    process.env.PRIVY_VERIFICATION_KEY = String(
      appKeys.publicKey.export({ type: "spki", format: "pem" }),
    );
  });

  afterAll(() => {
    for (const key of [
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
    ]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key] as string;
    }
  });

  it("revokes a token issued before logout and keeps a fresh token valid", async () => {
    const app = buildServer();
    try {
      const subject = did("basic");
      const stale = await tokenFor(subject, { issuedAt: nowSeconds() - 120 });

      // No floor yet: the stale token is accepted.
      const before = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${stale}` },
      });
      expect(before.statusCode).toBe(200);

      const logout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${stale}` },
      });
      expect(logout.statusCode).toBe(200);

      // The same still-unexpired token is now rejected.
      const revoked = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${stale}` },
      });
      expect(revoked.statusCode).toBe(401);
      expect(revoked.json()).toMatchObject({
        status: "error",
        code: "no_autenticado",
      });

      // A token issued after the floor (a fresh login) is accepted again.
      const fresh = await tokenFor(subject, { issuedAt: nowSeconds() + 30 });
      const accepted = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: { authorization: `Bearer ${fresh}` },
      });
      expect(accepted.statusCode).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("keeps the floor per user: one logout never affects another user", async () => {
    const app = buildServer();
    try {
      const userA = did("iso-a");
      const userB = did("iso-b");
      const tokenA = await tokenFor(userA, { issuedAt: nowSeconds() - 120 });
      const tokenB = await tokenFor(userB, { issuedAt: nowSeconds() - 120 });

      // Resolve both users first so their users rows exist.
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${tokenB}` },
          })
        ).statusCode,
      ).toBe(200);

      const logout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(logout.statusCode).toBe(200);

      // A is revoked, B is untouched.
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${tokenA}` },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${tokenB}` },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await app.close();
    }
  });

  it("is idempotent: repeated logouts succeed and leave the session revoked", async () => {
    const app = buildServer();
    try {
      const subject = did("idem");
      const first = await tokenFor(subject, { issuedAt: nowSeconds() - 120 });
      const firstLogout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${first}` },
      });
      expect(firstLogout.statusCode).toBe(200);

      const second = await tokenFor(subject, { issuedAt: nowSeconds() + 30 });
      const secondLogout = await app.inject({
        method: "POST",
        url: "/v1/auth/logout",
        headers: { authorization: `Bearer ${second}` },
      });
      expect(secondLogout.statusCode).toBe(200);

      // End state is stable: the original token stays revoked.
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/me",
            headers: { authorization: `Bearer ${first}` },
          })
        ).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("requires authentication", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "POST", url: "/v1/auth/logout" });
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("keeps the existing verification guarantees unchanged", async () => {
    const app = buildServer();
    try {
      const subject = did("guarantees");
      const now = nowSeconds();
      const expired = await tokenFor(subject, {
        issuedAt: now - 600,
        expiresAt: now - 300,
      });
      const wrongAudience = await tokenFor(subject, { audience: "another-app" });
      const wrongKey = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(subject)
        .setIssuedAt(now - 5)
        .setIssuer("privy.io")
        .setAudience("test-identity-app")
        .setExpirationTime(now + 300)
        .sign(otherKeys.privateKey);
      const valid = await tokenFor(subject);
      const tampered = `${valid.slice(0, -2)}${valid.slice(-2) === "ab" ? "cd" : "ab"}`;

      for (const [name, token] of [
        ["expired", expired],
        ["wrong-audience", wrongAudience],
        ["wrong-key", wrongKey],
        ["tampered", tampered],
      ] as const) {
        const response = await app.inject({
          method: "GET",
          url: "/v1/me",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(response.statusCode, name).toBe(401);
      }
    } finally {
      await app.close();
    }
  });
});
