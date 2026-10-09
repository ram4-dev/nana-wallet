import { generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { SignJWT } from "jose";
import { buildServer } from "../../src/server.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const APP_ID = "privy-runtime-fail-closed";
const DID = `did:privy:runtime-${randomUUID()}`;
const { privateKey, publicKey } = generateKeyPairSync("ec", {
  namedCurve: "P-256",
});

async function token(): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setSubject(DID)
    .setExpirationTime("5m")
    .sign(privateKey);
}

suite("Privy runtime without server credentials", () => {
  const previous = { ...process.env };

  beforeAll(() => {
    process.env.PRIVY_APP_ID = APP_ID;
    process.env.PRIVY_VERIFICATION_KEY = publicKey.export({
      type: "spki",
      format: "pem",
    }) as string;
    process.env.DATABASE_URL = databaseUrl!;
    delete process.env.PRIVY_APP_SECRET;
    delete process.env.DEMO_USER_ID;
    delete process.env.WDK_NETWORK;
    delete process.env.WDK_TOKEN;
  });

  afterAll(() => {
    for (const name of [
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "PRIVY_APP_SECRET",
      "DATABASE_URL",
      "DEMO_USER_ID",
      "WDK_NETWORK",
      "WDK_TOKEN",
    ]) {
      const value = previous[name];
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });

  it("does not create a fixture wallet and returns explicit configuration errors", async () => {
    const app = buildServer();
    const authorization = `Bearer ${await token()}`;
    try {
      const sync = await app.inject({
        method: "POST",
        url: "/v1/wallets/sync",
        headers: { authorization },
      });
      const current = await app.inject({
        method: "GET",
        url: "/v1/wallets/current",
        headers: { authorization },
      });
      const balance = await app.inject({
        method: "GET",
        url: "/v1/wallet/balance",
        headers: { authorization },
      });

      expect(sync.statusCode).toBe(503);
      expect(sync.json()).toMatchObject({
        ok: false,
        error: { code: "WALLET_NO_DISPONIBLE" },
      });
      expect(current.statusCode).toBe(200);
      expect(current.json()).toMatchObject({
        ok: true,
        data: { state: "unprovisioned", address: "" },
      });
      expect(balance.statusCode).toBe(503);
      expect(balance.json()).toMatchObject({
        status: "error",
        code: "wallet_config_error",
      });
      expect(`${sync.body}${current.body}${balance.body}`).not.toContain(
        "42.5",
      );
    } finally {
      await app.close();
    }
  });
});
