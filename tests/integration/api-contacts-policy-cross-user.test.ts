import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
const verificationKeyPem = String(
  keys.publicKey.export({ type: "spki", format: "pem" }),
);

async function tokenFor(did: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuedAt(now - 5)
    .setIssuer("privy.io")
    .setAudience("test-cross-policy")
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
}

// One distinct pair per run: a later run must never read an earlier run's row.
const DID_A = `did:privy:test-cross-policy-a-${process.pid}-${Date.now()}`;
const DID_B = `did:privy:test-cross-policy-b-${process.pid}-${Date.now()}`;
const ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * Task 3.2 (design §9.2), cross-user half: every recipient/policy route is
 * owner-scoped. B must never read, mutate or retry A's recipient or policy
 * state, and a foreign id must be indistinguishable from a missing one.
 */
suite("recipient policy routes cross-user isolation (task 3.2)", () => {
  const previousEnv = { ...process.env };

  beforeAll(() => {
    process.env.PRIVY_APP_ID = "test-cross-policy";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
  });

  afterAll(() => {
    for (const key of ["PRIVY_APP_ID", "PRIVY_VERIFICATION_KEY"]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  it("scopes every route to the acting owner", { timeout: 90_000 }, async () => {
    const app = buildServer();
    try {
      const authA = { authorization: `Bearer ${await tokenFor(DID_A)}` };
      const authB = { authorization: `Bearer ${await tokenFor(DID_B)}` };

      const createdA = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: authA,
        payload: { name: "Contacto de A", description: "de A", address: ADDRESS },
      });
      expect(createdA.statusCode).toBe(201);
      const idA = createdA.json().data.id as string;
      const versionA = createdA.json().data.version as number;

      // GET /v1/contacts: B never sees A's contact.
      const listB = await app.inject({
        method: "GET",
        url: "/v1/contacts",
        headers: authB,
      });
      expect(listB.statusCode).toBe(200);
      expect((listB.json().data as { id: string }[]).map((c) => c.id)).not.toContain(
        idA,
      );

      // PATCH A's id as B: not-found, and A's contact is unchanged.
      const patchAsB = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${idA}`,
        headers: authB,
        payload: { name: "Hackeado", expectedVersion: versionA },
      });
      expect(patchAsB.statusCode).toBe(404);
      expect(patchAsB.json().error.code).toBe("CONTACTO_NO_ENCONTRADO");

      // removal-preview + DELETE A's id as B: both not-found, no revocation.
      const previewAsB = await app.inject({
        method: "GET",
        url: `/v1/contacts/${idA}/removal-preview?expectedVersion=${versionA}`,
        headers: authB,
      });
      expect(previewAsB.statusCode).toBe(404);
      const deleteAsB = await app.inject({
        method: "DELETE",
        url: `/v1/contacts/${idA}?expectedVersion=${versionA}`,
        headers: authB,
        payload: { expectedRevokedGrantIds: [] },
      });
      expect(deleteAsB.statusCode).toBe(404);
      expect(JSON.stringify(deleteAsB.json())).not.toContain("revocation");

      // reveal-cbu A's id as B: not-found, no address ever returned.
      const revealAsB = await app.inject({
        method: "POST",
        url: `/v1/contacts/${idA}/reveal-cbu`,
        headers: authB,
      });
      expect(revealAsB.statusCode).toBe(404);
      expect(JSON.stringify(revealAsB.json())).not.toContain(ADDRESS);

      // A's contact survived every foreign attempt.
      const listA = await app.inject({
        method: "GET",
        url: "/v1/contacts",
        headers: authA,
      });
      const found = (
        listA.json().data as { id: string; name: string; version: number }[]
      ).find((c) => c.id === idA);
      expect(found?.name).toBe("Contacto de A");
      expect(found?.version).toBe(versionA);

      // GET /v1/recipient-policy: each caller reads only its own wallet row.
      const policyA = await app.inject({
        method: "GET",
        url: "/v1/recipient-policy",
        headers: authA,
      });
      const policyB = await app.inject({
        method: "GET",
        url: "/v1/recipient-policy",
        headers: authB,
      });
      expect(policyA.statusCode).toBe(200);
      expect(policyB.statusCode).toBe(200);
      // B has no contact and no intent, so B's wallet is not configured.
      expect(policyB.json().data.state).toBe("saved_not_configured");
      expect(policyB.json().data.desiredRevision).toBe(0);
      expect(policyA.json().data.state).not.toBe("applied");

      // POST /v1/recipient-policy/retry: owner-scoped, never at A's expense.
      const retryB = await app.inject({
        method: "POST",
        url: "/v1/recipient-policy/retry",
        headers: {
          ...authB,
          "idempotency-key": `cross-retry-b-${process.pid}-${Date.now()}`,
        },
      });
      expect([202, 409, 503]).toContain(retryB.statusCode);
      if (retryB.statusCode === 202) {
        expect(retryB.json().data.state).not.toBe("applied");
      }
      // A's snapshot is untouched by B's retry.
      const policyAAfter = await app.inject({
        method: "GET",
        url: "/v1/recipient-policy",
        headers: authA,
      });
      expect(policyAAfter.json().data).toEqual(policyA.json().data);
    } finally {
      await app.close();
    }
  });
});
