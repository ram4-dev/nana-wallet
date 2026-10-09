import { vi, afterAll, beforeAll, describe, expect, it } from "vitest";

// CI-load headroom: server-injection cases can exceed Vitest's 5s default under
// full-suite parallel load (documented pattern in api-voice).
vi.setConfig({ testTimeout: 15_000 });

import { createHmac, generateKeyPairSync, randomUUID } from "node:crypto";
import { SignJWT } from "jose";
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

// Task 2.3 deep coverage: exact raw-byte verification, ownership resolution,
// duplicate delivery semantics, and the authenticated feed surface.
suite("provider webhook receipts + notifications feed (receipt-only)", () => {
  let database: DatabaseClient;
  const keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const verificationKeyPem = String(
    keys.publicKey.export({ type: "spki", format: "pem" }),
  );

  const privyAccountId = `acct-test-${randomUUID()}`;
  // Valid Solana devnet address (base58, from existing fixtures).
  const walletAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const otherAddress = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
  let userId = "";
  let privyDid = "";
  let walletId = "";
  let authHeader: { authorization: string };
  // Shared tx_hash so deliveries covering the same chain event collapse into
  // one canonical notification (webhook/poll overlap dedupe contract).
  const sharedTxHash = `txhash-${randomUUID()}`;

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

    // Seed an enrolled wallet with a verified Privy account binding.
    const userResult = await database.query<{ id: string; privy_did: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id, privy_did`,
      [`did:privy:slice5-t23-${randomUUID()}`, "Slice 5 Task 2.3"],
    );
    userId = userResult.rows[0]!.id;
    privyDid = userResult.rows[0]!.privy_did;
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

    // Authenticated token for the enrolled owner (feed assertions).
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: "ES256" })
      .setSubject(privyDid)
      .setIssuedAt(now - 5)
      .setIssuer("privy.io")
      .setAudience("test-notifications-webhook")
      .setExpirationTime(now + 300)
      .sign(keys.privateKey);
    authHeader = { authorization: `Bearer ${token}` };
  });

  afterAll(async () => {
    await database.close();
    for (const key of Object.keys(previousEnv)) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  function signedHeaders(deliveryId: string, raw: Buffer) {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = hmacSignature(
      deliveryId,
      timestamp,
      raw.toString("utf8"),
      TEST_WEBHOOK_SECRET_BYTES,
    );
    return {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    };
  }

  function compactPayload(
    accountId: string,
    address: string,
    extra: Record<string, unknown> = {},
  ): Buffer {
    // Compact JSON: the exact bytes the signature covers. tx_hash pins the
    // canonical chain-event identity so repeated deliveries dedupe.
    return Buffer.from(
      JSON.stringify({
        type: "wallet.transaction.confirmed",
        account_id: accountId,
        wallet_address: address,
        tx_hash: sharedTxHash,
        ...extra,
      }),
      "utf8",
    );
  }

  async function injectRaw(
    deliveryId: string,
    raw: Buffer,
    headers?: Record<string, string>,
  ) {
    const app = buildServer();
    try {
      return await app.inject({
        method: "POST",
        url: "/v1/webhooks/provider",
        payload: raw,
        headers: headers ?? signedHeaders(deliveryId, raw),
      });
    } finally {
      await app.close();
    }
  }

  async function feedCount(): Promise<number> {
    const app = buildServer();
    try {
      const response = await app.inject({
        method: "GET",
        url: "/v1/notifications",
        headers: authHeader,
      });
      expect(response.statusCode).toBe(200);
      const body = response.json<{ ok: boolean; data: unknown[] }>();
      return body.data.length;
    } finally {
      await app.close();
    }
  }

  async function receiptCount(deliveryId: string): Promise<number> {
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM provider_webhook_receipts WHERE delivery_id = $1`,
      [deliveryId],
    );
    return rows.rows.length;
  }

  it("rejects signature over different bytes than the sent raw body with zero side effects", async () => {
    // Signature covers compact JSON, but the request ships whitespace-
    // different bytes: the verifier must see tampered raw bytes.
    const compact = compactPayload(privyAccountId, walletAddress);
    const timestamp = String(Math.floor(Date.now() / 1000));
    const deliveryId = `msg-tampered-${randomUUID()}`;
    const signature = hmacSignature(
      deliveryId,
      timestamp,
      compact.toString("utf8"),
      TEST_WEBHOOK_SECRET_BYTES,
    );
    const tampered = Buffer.from(
      JSON.stringify(JSON.parse(compact.toString("utf8")), null, 2),
      "utf8",
    );
    expect(tampered.equals(compact)).toBe(false);

    const response = await injectRaw(deliveryId, tampered, {
      "content-type": "application/json",
      "svix-id": deliveryId,
      "svix-timestamp": timestamp,
      "svix-signature": signature,
    });
    expect(response.statusCode).toBe(401);
    expect(await receiptCount(deliveryId)).toBe(0);
    expect(await feedCount()).toBe(0);
  });

  it("stores only a receipt for a valid signed delivery (receipt-only)", async () => {
    const deliveryId = `msg-owner-${randomUUID()}`;
    const raw = compactPayload(privyAccountId, walletAddress, {
      user_id: randomUUID(),
    });
    const response = await injectRaw(deliveryId, raw);
    expect(response.statusCode).toBe(200);
    expect(await receiptCount(deliveryId)).toBe(1);
    // No wallet_event notification may be produced by the webhook itself.
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM wallet_notifications WHERE wallet_id = $1`,
      [walletId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("acknowledges a duplicate delivery with a single receipt", async () => {
    const deliveryId = `msg-dup-${randomUUID()}`;
    const raw = compactPayload(privyAccountId, walletAddress);
    const first = await injectRaw(deliveryId, raw);
    const second = await injectRaw(deliveryId, raw);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(await receiptCount(deliveryId)).toBe(1);
  });

  it("does not notify for a mismatched wallet address (receipt only)", async () => {
    const deliveryId = `msg-mismatch-${randomUUID()}`;
    const raw = compactPayload(privyAccountId, otherAddress);
    const response = await injectRaw(deliveryId, raw);
    expect(response.statusCode).toBe(200);
    expect(await receiptCount(deliveryId)).toBe(1);
    const rows = await database.query<{ id: string }>(
      `SELECT id FROM wallet_notifications WHERE wallet_id = $1`,
      [walletId],
    );
    expect(rows.rows).toHaveLength(0);
  });

  it("exposes the feed only to the enrolled owner and supports mark-read", async () => {
    // Seed the canonical row the reconciler would have created.
    await database.withUserTransaction(userId, (client) =>
      client.query(
        `INSERT INTO wallet_notifications (user_id, wallet_id, category, status, dedupe_key, title, projection)
             VALUES ($1, $2, 'wallet_event', 'deposit', $3, 'Depósito confirmado', '{}')`,
        [userId, walletId, `chain:test:${randomUUID()}`],
      ),
    );
    expect(await feedCount()).toBe(1);

    const app = buildServer();
    try {
      const list = await app.inject({
        method: "GET",
        url: "/v1/notifications",
        headers: authHeader,
      });
      const body = list.json<{
        ok: boolean;
        data: { id: string; readAt: string | null }[];
      }>();
      expect(list.statusCode).toBe(200);
      expect(body.data).toHaveLength(1);
      const notificationId = body.data[0]!.id;
      expect(body.data[0]!.readAt).toBeNull();

      const marked = await app.inject({
        method: "POST",
        url: `/v1/notifications/${notificationId}/read`,
        headers: authHeader,
      });
      expect(marked.statusCode).toBe(200);

      const reread = await app.inject({
        method: "GET",
        url: "/v1/notifications",
        headers: authHeader,
      });
      const rereadBody = reread.json<{ data: { readAt: string | null }[] }>();
      expect(rereadBody.data[0]!.readAt).not.toBeNull();
    } finally {
      await app.close();
    }
  });
});
