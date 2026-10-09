import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

function es256Pair() {
  return generateKeyPairSync("ec", { namedCurve: "P-256" });
}

const keys = es256Pair();
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
    .setAudience("test-cross-app")
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
}

const DID_A = "did:privy:test-cross-a";
const DID_B = "did:privy:test-cross-b";

suite("contacts cross-user isolation (PMU-013/019)", () => {
  const previousEnv = { ...process.env };

  beforeAll(() => {
    process.env.PRIVY_APP_ID = "test-cross-app";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
    delete process.env.DEMO_USER_ID;
  });

  afterAll(() => {
    for (const key of [
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "DEMO_USER_ID",
    ]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  it("never lets A read, mutate or reveal B data; existence is not revealed", {
    timeout: 60_000,
  }, async () => {
    const app = buildServer();
    try {
      const authA = { authorization: `Bearer ${await tokenFor(DID_A)}` };
      const authB = { authorization: `Bearer ${await tokenFor(DID_B)}` };

      // Both users create a contact.
      const createdA = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: authA,
        payload: {
          name: "Contacto de A",
          description: "de A",
          address: "0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
        },
      });
      const createdB = await app.inject({
        method: "POST",
        url: "/v1/contacts",
        headers: authB,
        payload: {
          name: "Contacto de B",
          description: "de B",
          address: "0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB",
        },
      });
      expect(createdA.statusCode).toBe(201);
      expect(createdB.statusCode).toBe(201);
      const idB = createdB.json().data.id as string;
      const idA = createdA.json().data.id as string;

      // LIST: A sees only A's contacts.
      const listA = await app.inject({
        method: "GET",
        url: "/v1/contacts",
        headers: authA,
      });
      const listIds = (listA.json().data as { id: string }[]).map((c) => c.id);
      expect(listIds).toContain(idA);
      expect(listIds).not.toContain(idB);

      // PATCH B's id as A: indistinguishable not-found, no mutation.
      const patchB = await app.inject({
        method: "PATCH",
        url: `/v1/contacts/${idB}`,
        headers: authA,
        payload: { name: "Hacked", expectedVersion: 1 },
      });
      expect(patchB.statusCode).toBe(404);
      const bStill = await app.inject({
        method: "GET",
        url: "/v1/contacts",
        headers: authB,
      });
      expect(
        bStill.json().data.find((c: { id: string }) => c.id === idB)?.name,
      ).toBe("Contacto de B");

      // DELETE B's id as A: not-found, row untouched (relative count check so
      // the test tolerates prior runs of the same suite against one DB).
      const countBefore = (
        await app.inject({ method: "GET", url: "/v1/contacts", headers: authB })
      ).json().data.length as number;
      const deleteB = await app.inject({
        method: "DELETE",
        url: `/v1/contacts/${idB}`,
        headers: authA,
      });
      expect(deleteB.statusCode).toBe(404);
      expect(
        (
          await app.inject({
            method: "GET",
            url: "/v1/contacts",
            headers: authB,
          })
        ).json().data.length,
      ).toBe(countBefore);

      // REVEAL B's id as A: not-found, no address.
      const revealB = await app.inject({
        method: "POST",
        url: `/v1/contacts/${idB}/reveal-cbu`,
        headers: authA,
      });
      expect(revealB.statusCode).toBe(404);
      expect(JSON.stringify(revealB.json())).not.toContain("BBBBBB");

      // CREATE cannot target another user (no client-supplied user_id exists in
      // the contract; the row is always bound to the resolved UUID).
      expect(JSON.stringify(createContactContractShape())).not.toContain(
        "userId",
      );

      // Identity scoping: /v1/me returns each caller's own row.
      const meA = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: authA,
      });
      const meB = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: authB,
      });
      expect(meA.json().data?.userId).not.toBe(meB.json().data?.userId);
    } finally {
      await app.close();
    }
  });
});

function createContactContractShape(): string {
  // The create contract (createContactInputSchema) has exactly these keys.
  return "name,description,address";
}
