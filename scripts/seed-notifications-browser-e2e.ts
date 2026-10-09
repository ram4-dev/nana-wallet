import { canonicalDedupeKey } from "../src/notifications/ingestion.js";
import { createDatabaseClient } from "../src/db/client.js";
import { reconcileWalletOnce } from "../src/notifications/reconciliation-worker.js";

const databaseUrl = process.env.DATABASE_URL;
// Fixture identity the seeded rows and the backend agree on. Mirrors
// tests/fixtures/test-server.ts TEST_USER_ID (this script must not import the
// fixture module: it pulls in the whole server graph).
const userId = "00000000-0000-4000-8000-000000000001";
const seedId = process.env.NOTIFICATIONS_E2E_SEED_ID;

if (!databaseUrl || !seedId) {
  throw new Error("DATABASE_URL and NOTIFICATIONS_E2E_SEED_ID are required.");
}

const conversationId = seedId;
const attemptId = seedId;
const walletId = seedId;
const walletAddress = "9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin";
const signature = `e2e-${seedId}`;
const network = "solana-devnet";
const assistantDedupeKey = `assistant-transfer:${attemptId}:submitted`;
const chainDedupeKey = canonicalDedupeKey({
  network,
  walletAddress,
  signature,
  eventClass: "confirmed_transfer",
});
const database = createDatabaseClient(databaseUrl);

try {
  await database.query(
    `INSERT INTO conversations (id, user_id, mode) VALUES ($1, $2, 'typed')`,
    [conversationId, userId],
  );
  await database.query(
    `INSERT INTO conversation_state (conversation_id, user_id, revision)
     VALUES ($1, $2, 2)`,
    [conversationId, userId],
  );
  await database.query(
    `INSERT INTO conversation_transfer_attempts
       (id, conversation_id, user_id, state_revision, status, pending_transfer, transaction_hash)
     VALUES ($1, $2, $3, 2, 'submitted', $4::jsonb, $5)`,
    [
      attemptId,
      conversationId,
      userId,
      JSON.stringify({ network, token: "SOL", amount: "0.01" }),
      `tx-${seedId}`,
    ],
  );
  await database.query(
    `INSERT INTO assistant_lifecycle_outbox (attempt_id, user_id, status, dedupe_key)
     VALUES ($1, $2, 'submitted', $3)`,
    [attemptId, userId, assistantDedupeKey],
  );
  await database.query(
    `INSERT INTO user_wallets (id, user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, $2, 'privy', $3, 'solana', $4, 'ready')`,
    [walletId, userId, `notifications-e2e-${seedId}`, walletAddress],
  );

  const reconciliation = await reconcileWalletOnce({
    database,
    source: {
      async fetchConfirmedPage() {
        return {
          observations: [{ signature, eventClass: "confirmed_transfer" }],
          pageNewest: signature,
          pageOldest: signature,
          reachedWatermark: true,
        };
      },
    },
    wallet: { id: walletId, address: walletAddress, network },
    workerId: `notifications-e2e-${seedId}`,
    pageSize: 10,
    leaseSeconds: 60,
    maxPagesPerRun: 1,
  });
  if (reconciliation.signaturesProcessed !== 1) {
    throw new Error(`Expected one reconciled event; got ${reconciliation.signaturesProcessed}.`);
  }

  console.log(JSON.stringify({
    seedId,
    userId,
    conversationId,
    attemptId,
    walletId,
    assistantDedupeKey,
    chainDedupeKey,
  }));
} finally {
  await database.close();
}
