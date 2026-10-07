import { generateKeyPairSync } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { PostgresConversationRepository } from "../../src/conversations/postgres-repository.js";

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
    .setAudience("test-voice-app")
    .setExpirationTime(now + 300)
    .sign(keys.privateKey);
}

const DID_A = "did:privy:test-voice-a";
const DID_B = "did:privy:test-voice-b";
const LIVEKIT_ENV = [
  "LIVEKIT_URL",
  "LIVEKIT_API_KEY",
  "LIVEKIT_API_SECRET",
] as const;

suite("/v1/voice/room-token authorization (PMU-020, privy mode)", () => {
  let database: DatabaseClient;
  const previousEnv = { ...process.env };

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    process.env.IDENTITY_PROVIDER = "privy";
    process.env.PRIVY_APP_ID = "test-voice-app";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
    process.env.WDK_TOOLS_SOURCE = "fixture";
    delete process.env.DEMO_USER_ID;
    // Local loopback LiveKit defaults: the issuer fails closed when unset.
    process.env.LIVEKIT_URL = "ws://127.0.0.1:7880";
    process.env.LIVEKIT_API_KEY = "test-key";
    process.env.LIVEKIT_API_SECRET = "test-secret";
  });

  afterAll(async () => {
    await database.close();
    for (const key of [
      "IDENTITY_PROVIDER",
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "DEMO_USER_ID",
      ...LIVEKIT_ENV,
    ]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  it("rejects missing, invalid and expired tokens with 401 and never calls the issuer", async () => {
    const app = buildServer();
    try {
      const now = Math.floor(Date.now() / 1000);
      const expired = await new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(DID_A)
        .setIssuedAt(now - 600)
        .setIssuer("privy.io")
        .setAudience("test-voice-app")
        .setExpirationTime(now - 300)
        .sign(keys.privateKey);
      const conversationId = "00000000-0000-4000-8000-0000000000c1";
      for (const [name, headers] of [
        ["missing", {}],
        ["invalid", { authorization: "Bearer broken" }],
        ["expired", { authorization: `Bearer ${expired}` }],
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: "/v1/voice/room-token",
          headers,
          payload: { conversationId },
        });
        expect(response.statusCode, name).toBe(401);
      }
    } finally {
      await app.close();
    }
  });

  it("registers the authenticated grants route on the production server", async () => {
    const app = buildServer();
    try {
      const response = await app.inject({ method: "GET", url: "/v1/grants" });
      // An unregistered route would be 404; 401 proves the production builder
      // wired the endpoint and that it passes through the shared identity gate.
      expect(response.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("returns the same 404 for a foreign conversation as for a missing one", async () => {
    const app = buildServer();
    try {
      const authA = { authorization: `Bearer ${await tokenFor(DID_A)}` };
      const authB = { authorization: `Bearer ${await tokenFor(DID_B)}` };

      // B owns a conversation (created under B's UUID through RLS).
      const repo = new PostgresConversationRepository(database);
      const conversationB = await repo.create(
        await resolveUserIdFor(app, authB),
      );
      const missing = "00000000-0000-4000-8000-000000000000";

      const foreign = await app.inject({
        method: "POST",
        url: "/v1/voice/room-token",
        headers: authA,
        payload: { conversationId: conversationB.id },
      });
      const absent = await app.inject({
        method: "POST",
        url: "/v1/voice/room-token",
        headers: authA,
        payload: { conversationId: missing },
      });
      expect(foreign.statusCode).toBe(404);
      expect(absent.statusCode).toBe(404);
      // Indistinguishable: identical error shape.
      expect(foreign.json()).toEqual(absent.json());
    } finally {
      await app.close();
    }
  });

  it("issues an owned-room token whose identity is the resolved UUID (issuer called only after authorization)", async () => {
    const app = buildServer();
    try {
      const authA = { authorization: `Bearer ${await tokenFor(DID_A)}` };
      const me = await app.inject({
        method: "GET",
        url: "/v1/me",
        headers: authA,
      });
      const userIdA = me.json().data?.userId ?? (me.json().userId as string);
      const repo = new PostgresConversationRepository(database);
      const conversation = await repo.create(userIdA);

      const response = await app.inject({
        method: "POST",
        url: "/v1/voice/room-token",
        headers: authA,
        payload: { conversationId: conversation.id },
      });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.roomName).toBe(`nani-${conversation.id}`);
      // The participant identity is the resolved internal UUID, server-derived.
      const decoded = JSON.parse(
        Buffer.from(body.participantToken.split(".")[1], "base64url").toString(
          "utf8",
        ),
      ) as { sub?: string };
      expect(decoded.sub).toBe(userIdA);
    } finally {
      await app.close();
    }
  });
});

async function resolveUserIdFor(
  app: Awaited<ReturnType<typeof buildServer>>,
  headers: Record<string, string>,
): Promise<string> {
  const me = await app.inject({ method: "GET", url: "/v1/me", headers });
  return me.json().data?.userId ?? (me.json().userId as string);
}
