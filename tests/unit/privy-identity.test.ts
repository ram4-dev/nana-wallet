import { generateKeyPairSync } from "node:crypto";
import { SignJWT, exportSPKI, importSPKI } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  PrivyIdentityError,
  PrivyIdentityProvider,
  type PrivyIdentityProviderConfig,
} from "../../src/auth/privy-identity.js";

const APP_ID = "test-privy-app";
const USER_DID = "did:privy:test-did-123";
const RESOLVED_UUID = "11111111-1111-4111-8111-111111111111";

function es256KeyPair() {
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  return {
    privateKey: keys.privateKey,
    publicKeyPem: String(
      keys.publicKey.export({ type: "spki", format: "pem" }),
    ),
  };
}

const app = es256KeyPair();
const other = es256KeyPair();

async function signToken(
  key: Parameters<SignJWT["sign"]>[0],
  claims: {
    iss?: string;
    aud?: string | string[];
    sub?: string;
    exp?: number;
    iat?: number;
  } = {},
): Promise<string> {
  const builder = new SignJWT({}).setProtectedHeader({ alg: "ES256" });
  if (claims.sub !== undefined) builder.setSubject(claims.sub);
  builder.setIssuedAt(claims.iat ?? Math.floor(Date.now() / 1000) - 5);
  builder.setIssuer(claims.iss ?? "privy.io");
  builder.setAudience(claims.aud ?? APP_ID);
  if (claims.exp !== undefined) {
    builder.setExpirationTime(claims.exp);
  } else {
    builder.setExpirationTime(Math.floor(Date.now() / 1000) + 300);
  }
  return builder.sign(key);
}

function requestWithAuth(token: string | undefined): FastifyRequest {
  return {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  } as unknown as FastifyRequest;
}

function provider(verificationKeyPem: string): PrivyIdentityProvider {
  const config: PrivyIdentityProviderConfig = {
    appId: APP_ID,
    verificationKeyPem,
    resolvePrivyDid: vi.fn(async (did: string) => {
      expect(did).toBe(USER_DID);
      return RESOLVED_UUID;
    }),
  };
  return new PrivyIdentityProvider(config);
}

describe("Privy identity provider (PMU-002)", () => {
  let validToken: string;
  let wrongKeyToken: string;

  beforeEach(async () => {
    validToken = await signToken(app.privateKey, { sub: USER_DID });
    wrongKeyToken = await signToken(other.privateKey, { sub: USER_DID });
  });

  it("accepts a valid token and resolves the DID to the internal UUID", async () => {
    const identity = await provider(app.publicKeyPem).resolve(
      requestWithAuth(validToken),
    );
    expect(identity.userId).toBe(RESOLVED_UUID);
  });

  it("surfaces the verified token's issued-at for the session floor", async () => {
    const iat = Math.floor(Date.now() / 1000) - 42;
    const token = await signToken(app.privateKey, { sub: USER_DID, iat });
    const identity = await provider(app.publicKeyPem).resolve(
      requestWithAuth(token),
    );
    expect(identity.issuedAt).toEqual(new Date(iat * 1000));
  });

  it("rejects a missing bearer token", async () => {
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(undefined)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("rejects an expired token", async () => {
    const expired = await signToken(app.privateKey, {
      sub: USER_DID,
      exp: Math.floor(Date.now() / 1000) - 60,
    });
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(expired)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("rejects a token signed by another key", async () => {
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(wrongKeyToken)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("rejects a wrong issuer", async () => {
    const wrongIss = await signToken(app.privateKey, {
      sub: USER_DID,
      iss: "evil.io",
    });
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(wrongIss)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("rejects a wrong audience", async () => {
    const wrongAud = await signToken(app.privateKey, {
      sub: USER_DID,
      aud: "other-app",
    });
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(wrongAud)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("rejects a missing expiry (exp is mandatory)", async () => {
    const now = Math.floor(Date.now() / 1000);
    const noExpiry = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(USER_DID)
      .setIssuedAt(now)
      .setIssuer("privy.io")
      .setAudience(APP_ID)
      .sign(app.privateKey);
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(noExpiry)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("rejects a non-Privy DID subject", async () => {
    const oddSub = await signToken(app.privateKey, { sub: "not-a-privy-did" });
    await expect(
      provider(app.publicKeyPem).resolve(requestWithAuth(oddSub)),
    ).rejects.toThrow(PrivyIdentityError);
  });

  it("maps verification errors to unauthenticated (not provider failures)", async () => {
    try {
      await provider(app.publicKeyPem).resolve(requestWithAuth(wrongKeyToken));
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrivyIdentityError);
      expect((error as PrivyIdentityError).code).toBe("unauthenticated");
    }
  });
});


describe("Privy app verification key rotation", () => {
  it("accepts either trusted signing key from the same configured app", async () => {
    const verifier = provider(app.publicKeyPem + "\n" + other.publicKeyPem);
    for (const key of [app.privateKey, other.privateKey]) {
      await expect(verifier.resolve(requestWithAuth(await signToken(key, { sub: USER_DID })))).resolves.toMatchObject({userId: RESOLVED_UUID});
    }
  });
  it("rejects unknown keys and still enforces audience and expiry with a bundle", async () => {
    const verifier = provider(app.publicKeyPem + "\n" + other.publicKeyPem);
    const unknown = es256KeyPair();
    for (const token of [
      await signToken(unknown.privateKey, { sub: USER_DID }),
      await signToken(other.privateKey, { sub: USER_DID, aud: "another-app" }),
      await signToken(other.privateKey, { sub: USER_DID, exp: 1 }),
    ]) await expect(verifier.resolve(requestWithAuth(token))).rejects.toThrow(PrivyIdentityError);
  });
  it("rejects a malformed additional public key instead of ignoring it", () => {
    expect(() => provider(app.publicKeyPem + "\n-----BEGIN PUBLIC KEY-----\ninvalid\n-----END PUBLIC KEY-----")).toThrow();
  });
});
