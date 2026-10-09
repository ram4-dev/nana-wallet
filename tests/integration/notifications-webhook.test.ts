import { vi, afterAll, beforeAll, describe, expect, it } from "vitest";

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

// Test-only signing secret as a valid whsec_ fixture: Svix whsec_ secrets are
// base64-encoded key bytes and the verifier must base64-decode before HMAC.
// Saved before the suite; every changed env var is restored in afterAll.
const TEST_WEBHOOK_SECRET_BYTES =
  "rOVC0woIVF8NaBn2utX1Ll/EvV1rl+TDpqxD+uGV3ms=";
const TEST_WEBHOOK_SECRET = `whsec_${TEST_WEBHOOK_SECRET_BYTES}`;
const previousEnv: Record<string, string | undefined> = {};

function hmacSignature(
  deliveryId: string,
  timestamp: string,
  body: string,
  secretBytesBase64: string,
): string {
  const key = Buffer.from(secretBytesBase64, "base64");
  const signedContent = `${deliveryId}.${timestamp}.${body}`;
  const digest = createHmac("sha256", key)
    .update(signedContent)
    .digest("base64");
  return `v1,${digest}`;
}

// RED: the provider webhook ingress route (task 2.3) does not exist yet. These
// tests pin the no-side-effects contract: invalid signatures and duplicate
// deliveries must leave zero receipt and zero notification rows, and a valid
// signed delivery must resolve a real locally enrolled wallet.
suite("provider webhook ingress no-side-effects (Slice 5 RED)", () => {
  let database: DatabaseClient;
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const verificationKeyPem = String(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );

  // Unique per-run scope so zero-side-effect assertions never touch rows from
  // other suites sharing this database.
  const privyAccountId = `acct-test-${randomUUID()}`;
  // Valid Solana devnet address (base58, 44 chars, from existing fixtures).
  const walletAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const deliveryInvalid = `msg-invalid-${randomUUID()}`;
  const deliveryValid = `msg-valid-${randomUUID()}`;
  let userId = "";
  let walletId = "";
  beforeAll(async () => {
    for (const key of [
      "PRIVY_APP_ID",
      "PRIVY_VERIFICATION_KEY",
      "PRIVY_WEBHOOK_SECRET",
      "DEMO_USER_ID",
    ]) {
      previousEnv[key] = process.env[key];
    }
    process.env.PRIVY_APP_ID = "test-notifications-webhook";
    process.env.PRIVY_VERIFICATION_KEY = verificationKeyPem;
    process.env.PRIVY_WEBHOOK_SECRET = TEST_WEBHOOK_SECRET;
    delete process.env.DEMO_USER_ID;
    database = createDatabaseClient(databaseUrl!);

    // Seed a real locally enrolled wallet owned by a unique test user; the
    // provider_wallet_id matches the webhook account_id so identity resolution
    // (task 2.3) can map the verified Privy account to this owner.
    const userResult = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:slice5-webhook-${randomUUID()}`, "Slice 5 Webhook RED"],
    );
    userId = userResult.rows[0]!.id;
    const walletResult = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, 'privy', $2, 'solana', $3, 'ready', now())
       ON CONFLICT (provider_wallet_id) DO UPDATE
         SET user_id = EXCLUDED.user_id, address = EXCLUDED.address,
             state = 'ready', verified_at = now()
       RETURNING id`,
      [userId, privyAccountId, walletAddress],
    );
    walletId = walletResult.rows[0]!.id;
  });

  afterAll(async () => {
    await database.close();
    for (const key of Object.keys(previousEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  const webhookUrl = "/v1/webhooks/provider";
  const validBody = JSON.stringify({
    type: "wallet.transaction.confirmed",
    account_id: privyAccountId,
    wallet_address: walletAddress,
  });

  /**
   * Notifications scoped to the seeded wallet: the wallet starts with zero
   * rows, so any notification visible for it after an invalid-signature
   * delivery proves an accidental side effect, regardless of the canonical
   * dedupe key shape (signature/wallet/event class).
   */
  async function notificationCountForSeededWallet(): Promise<number> {
    const result = await database.query<{ id: string }>(
      `SELECT id FROM wallet_notifications WHERE wallet_id = $1`,
      [walletId],
    );
    return result.rows.length;
  }

  function injectWebhook(
    deliveryId: string,
    signature: string,
    timestamp: string,
  ) {
    const app = buildServer();
    return app
      .inject({
        method: "POST",
        url: webhookUrl,
        payload: validBody,
        headers: {
          "content-type": "application/json",
          "svix-id": deliveryId,
          "svix-timestamp": timestamp,
          "svix-signature": signature,
        },
      })
      .finally(() => app.close());
  }

  it("rejects an invalid signature and leaves zero matching receipt/notification rows", async () => {
    // The timestamp is computed once so the signed content equals the sent
    // headers even across a second boundary.
    const timestamp = String(Math.floor(Date.now() / 1000));
    // Truly invalid: signed with an attacker-controlled secret, so the
    // verifier must reject before any persistence or fan-out.
    const badSignature = hmacSignature(
      deliveryInvalid,
      timestamp,
      validBody,
      Buffer.from("attacker-controlled-secret-bytes-0000").toString("base64"),
    );

    const response = await injectWebhook(
      deliveryInvalid,
      badSignature,
      timestamp,
    );
    expect(response.statusCode).toBeGreaterThanOrEqual(400);

    // No side effects: with the migration applied (task 2.1) the invalid
    // signature must leave zero receipt and zero notification rows scoped to
    // this delivery/wallet. Until then the queries themselves fail RED on the
    // missing relations.
    const receipts = await database.query<{ id: string }>(
      `SELECT id FROM provider_webhook_receipts WHERE delivery_id = $1`,
      [deliveryInvalid],
    );
    expect(receipts.rows).toHaveLength(0);
    expect(await notificationCountForSeededWallet()).toBe(0);
  });

  it("accepts a valid signed delivery for an enrolled wallet and persists exactly one receipt row", async () => {
    // Properly signed over deliveryId.timestamp.rawBody with the base64-decoded
    // whsec_ key bytes; the delivery resolves the seeded enrolled wallet.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hmacSignature(
      deliveryValid,
      timestamp,
      validBody,
      TEST_WEBHOOK_SECRET_BYTES,
    );

    const response = await injectWebhook(deliveryValid, signature, timestamp);
    // Any 2xx acknowledgement is acceptable; the SDD does not pin a
    // specific success status.
    expect(response.statusCode).toBeGreaterThanOrEqual(200);
    expect(response.statusCode).toBeLessThan(300);

    const receipts = await database.query<{ id: string }>(
      `SELECT id FROM provider_webhook_receipts
       WHERE delivery_id = $1 AND provider = 'privy' AND account_id = $2`,
      [deliveryValid, privyAccountId],
    );
    expect(receipts.rows).toHaveLength(1);
    expect(receipts.rows[0]!.id).toBeTruthy();
  });

  it("acknowledges a duplicate delivery without creating a second receipt row", async () => {
    // Continuation of the accepted path above: the provider retries the same
    // scoped delivery ID and the endpoint must dedupe safely.
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hmacSignature(
      deliveryValid,
      timestamp,
      validBody,
      TEST_WEBHOOK_SECRET_BYTES,
    );

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await injectWebhook(deliveryValid, signature, timestamp);
      expect(response.statusCode).toBeGreaterThanOrEqual(200);
      expect(response.statusCode).toBeLessThan(300);
    }

    const receipts = await database.query<{ id: string }>(
      `SELECT id FROM provider_webhook_receipts WHERE delivery_id = $1`,
      [deliveryValid],
    );
    expect(receipts.rows).toHaveLength(1);
  });
});
