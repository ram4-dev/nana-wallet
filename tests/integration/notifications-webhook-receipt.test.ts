import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { buildServer } from "../../src/server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

// Receipt-only webhook contract (task 2.3 revision): a signed generic payload
// proves delivery authenticity, NOT a confirmed inbound deposit. The endpoint
// persists only the scoped dedupe receipt; canonical wallet_event rows come
// exclusively from the Solana devnet reconciler from chain evidence.
suite("provider webhook ingress receipt-only contract", () => {
  let database: DatabaseClient;
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const verificationKeyPem = String(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );

  const TEST_WEBHOOK_SECRET_BYTES =
    "rOVC0woIVF8NaBn2utX1Ll/EvV1rl+TDpqxD+uGV3ms=";
  const TEST_WEBHOOK_SECRET = `whsec_${TEST_WEBHOOK_SECRET_BYTES}`;
  const previousEnv: Record<string, string | undefined> = {};

  const privyAccountId = `acct-receipt-${randomUUID()}`;
  const deliveryId = `msg-receipt-${randomUUID()}`;
  // Signed compact bytes; NO wallet_address field (not required in
  // receipt-only mode).
  const validBody = JSON.stringify({
    type: "wallet.transaction.confirmed",
    account_id: privyAccountId,
  });

  beforeAll(() => {
    for (const key of [
      "IDENTITY_PROVIDER",
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "PRIVY_WEBHOOK_SECRET",
      "WDK_TOOLS_SOURCE",
      "DEMO_USER_ID",
    ]) {
      previousEnv[key] = process.env[key];
    }
    process.env.IDENTITY_PROVIDER = "privy";
    process.env.PRIVY_APP_ID = "test-notifications-receipt";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
    process.env.PRIVY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    process.env.WDK_TOOLS_SOURCE = "fixture";
    delete process.env.DEMO_USER_ID;
    database = createDatabaseClient(databaseUrl!);
  });

  afterAll(async () => {
    await database.close();
    for (const key of Object.keys(previousEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  function injectWebhook(body: Buffer, headers: Record<string, string>) {
    const app = buildServer();
    return app
      .inject({
        method: "POST",
        url: "/v1/webhooks/provider",
        payload: body,
        headers,
      })
      .finally(() => app.close());
  }

  function signedHeaders(sigBody: Buffer) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const digest = createHmac(
      "sha256",
      Buffer.from(TEST_WEBHOOK_SECRET_BYTES, "base64"),
    )
      .update(`${deliveryId}.${timestamp}.${sigBody.toString("utf8")}`)
      .digest("base64");
    return {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": `v1,${digest}`,
    };
  }

  async function receiptCount(): Promise<number> {
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM provider_webhook_receipts WHERE delivery_id = $1`,
      [deliveryId],
    );
    return rows.rows.length;
  }

  it("persists exactly one receipt for a signed generic payload without wallet_address", async () => {
    const response = await injectWebhook(
      Buffer.from(validBody, "utf8"),
      signedHeaders(Buffer.from(validBody, "utf8")),
    );
    expect(response.statusCode).toBe(200);
    expect(await receiptCount()).toBe(1);
  });

  it("acknowledges a duplicate delivery without a second receipt", async () => {
    const raw = Buffer.from(validBody, "utf8");
    const first = await injectWebhook(raw, signedHeaders(raw));
    expect(first.statusCode).toBe(200);
    expect(await receiptCount()).toBe(1);
  });

  it("never creates a wallet_event notification from a generic signed payload", async () => {
    // Reconciler-created rows all carry dedupe_key = chain:...; a webhook-only
    // receipt must leave zero such rows attributable to this delivery.
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM wallet_notifications WHERE dedupe_key LIKE $1`,
      [`%${deliveryId}%`],
    );
    expect(rows.rows).toHaveLength(0);
  });
});
