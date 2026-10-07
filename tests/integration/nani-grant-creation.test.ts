import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";

import { createWalletConversationService } from "../../src/conversations/service.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";
import { createDatabaseClient, type DatabaseClient } from "../../src/db/client.js";
import type { RecipientMemoryRuntime } from "../../src/memory/runtime.js";
import type { RecipientMemoryService } from "../../src/memory/service.js";
import {
  composeGrantCreator,
  DelegatedGrantService,
} from "../../src/wallet/grants/consumption.js";
import {
  PrivyPolicySyncService,
  type GrantPolicyProvisioner,
} from "../../src/wallet/grants/privy-policy-sync.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const CONVERSATION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOLANA_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const EVM_RECIPIENT = "0x1234567890123456789012345678901234567890";

/** Always-successful provisioner: proves a created grant can become executable. */
function approvingProvisioner(): GrantPolicyProvisioner {
  return {
    async provisionPolicy() {
      return { policyId: `policy-${randomUUID()}` };
    },
    async revokePolicy() {},
  };
}

function memoryFixture(
  userId: string,
  recipient: {
    id: string;
    name: string;
    address: string;
    network?: "solana-devnet";
    version: number;
  },
): RecipientMemoryRuntime {
  return {
    userId,
    service: {
      getRecipientForVersion: async () => ({
        id: recipient.id,
        userId,
        name: recipient.name,
        normalizedName: recipient.name.toLowerCase(),
        description: "friend",
        address: recipient.address,
        ...(recipient.network ? { network: recipient.network } : {}),
        version: recipient.version,
        status: "active" as const,
        embeddingModelRevision: "rev",
      }),
    } as unknown as RecipientMemoryService,
  };
}

function conversationsFixture(userId: string): ConversationRepository {
  const snapshot: ConversationSnapshot = {
    id: CONVERSATION_ID,
    userId,
    mode: "typed",
    language: "en",
    generation: 1,
    revision: 0,
    messages: [],
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
  };
  return {
    async get(candidateUserId: string, conversationId: string) {
      return candidateUserId === userId && conversationId === CONVERSATION_ID
        ? { ...snapshot, messages: [...snapshot.messages] }
        : undefined;
    },
  } as unknown as ConversationRepository;
}

suite("Nani delegated-grant creation seam (DGC-6)", () => {
  let database: DatabaseClient;
  let grants: DelegatedGrantService;

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    grants = new DelegatedGrantService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  function serviceFor(
    userId: string,
    recipient: {
      id: string;
      name: string;
      address: string;
      network?: "solana-devnet";
      version: number;
    },
    provisioner: GrantPolicyProvisioner = approvingProvisioner(),
  ) {
    return createWalletConversationService({
      conversations: conversationsFixture(userId),
      wallet: new FixtureWalletProvider(),
      memory: memoryFixture(userId, recipient),
      grantCreator: composeGrantCreator(
        grants,
        new PrivyPolicySyncService(database, provisioner),
      ),
    });
  }

  const createInput = {
    conversationId: CONVERSATION_ID,
    recipientId: "c-1",
    recipientVersion: 1,
    maxPerTransferSol: "0.01",
    maxCumulativeSol: "0.05",
  };

  async function grantRows(userId: string) {
    return database.withUserTransaction(userId, async (client) => {
      const result = await client.query<{
        id: string;
        chain: string;
        max_per_transfer: string;
        max_cumulative: string;
        window_seconds: number;
        recipients: unknown;
        state: string;
        provider_policy_id: string | null;
        expires_at: Date;
      }>(
        `SELECT id, chain, max_per_transfer, max_cumulative, window_seconds,
                recipients, state, provider_policy_id, expires_at
         FROM delegated_grants WHERE user_id = $1 ORDER BY created_at`,
        [userId],
      );
      return result.rows;
    });
  }

  it("creates a grant for a solana recipient: DB row + honest policyReady", async () => {
    const userId = await provisionUser(database, "nani-grant-create");
    await provisionWallet(database, userId);
    const service = serviceFor(userId, {
      id: "c-1",
      name: "Lucas",
      address: SOLANA_RECIPIENT,
      network: "solana-devnet",
      version: 1,
    });

    const result = await service.createDelegatedGrant({ ...createInput, userId });

    expect(result.status).toBe("created");
    expect(result.policyReady).toBe(true);
    expect(result.grantId).toBeDefined();
    expect(result.maxPerTransfer).toBe("0.01");
    expect(result.message.toLowerCase()).not.toMatch(/not ready/);

    const rows = await grantRows(userId);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(result.grantId);
    expect(row.chain).toBe("solana");
    expect(row.state).toBe("active");
    expect(row.max_per_transfer).toBe("10000000");
    expect(row.max_cumulative).toBe("50000000");
    expect(row.window_seconds).toBe(86_400);
    expect(row.provider_policy_id).not.toBeNull();
    expect(row.recipients).toEqual([SOLANA_RECIPIENT]);
    const ttlMs = row.expires_at.getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 86_400_000);
    expect(ttlMs).toBeLessThanOrEqual(7 * 86_400_000);
  });

  it("narrates a created-but-non-executable grant honestly when provisioning fails", async () => {
    const userId = await provisionUser(database, "nani-grant-policy-fail");
    await provisionWallet(database, userId);
    const service = serviceFor(
      userId,
      {
        id: "c-1",
        name: "Lucas",
        address: SOLANA_RECIPIENT,
        network: "solana-devnet",
        version: 1,
      },
      {
        async provisionPolicy() {
          throw new Error("provider unavailable");
        },
        async revokePolicy() {},
      },
    );

    const result = await service.createDelegatedGrant({ ...createInput, userId });

    expect(result.status).toBe("created");
    expect(result.policyReady).toBe(false);
    expect(result.message.toLowerCase()).toMatch(/not ready/);
    const rows = await grantRows(userId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider_policy_id).toBeNull();
  });

  it("rejects a non-solana (EVM) recipient without creating a grant", async () => {
    const userId = await provisionUser(database, "nani-grant-evm");
    await provisionWallet(database, userId);
    const service = serviceFor(userId, {
      id: "c-1",
      name: "Eve",
      address: EVM_RECIPIENT,
      version: 1,
    });

    const result = await service.createDelegatedGrant({ ...createInput, userId });

    expect(result.status).toBe("error");
    expect(result.code).toBe("recipient_not_solana");
    expect(await grantRows(userId)).toHaveLength(0);
  });

  it("rejects a per-transfer amount above the 0.01 SOL ceiling without creating a grant", async () => {
    const userId = await provisionUser(database, "nani-grant-over-ceiling");
    await provisionWallet(database, userId);
    const service = serviceFor(userId, {
      id: "c-1",
      name: "Lucas",
      address: SOLANA_RECIPIENT,
      network: "solana-devnet",
      version: 1,
    });

    const result = await service.createDelegatedGrant({
      ...createInput,
      userId,
      maxPerTransferSol: "0.02",
      maxCumulativeSol: "0.05",
    });

    expect(result.status).toBe("error");
    expect(result.code).toBe("amount_over_ceiling");
    expect(await grantRows(userId)).toHaveLength(0);
  });

  it("fails closed with a narratable error when no ready solana wallet exists", async () => {
    const userId = await provisionUser(database, "nani-grant-no-wallet");
    const service = serviceFor(userId, {
      id: "c-1",
      name: "Lucas",
      address: SOLANA_RECIPIENT,
      network: "solana-devnet",
      version: 1,
    });

    const result = await service.createDelegatedGrant({ ...createInput, userId });

    expect(result.status).toBe("error");
    expect(result.code).toBe("wallet_unavailable");
    expect(await grantRows(userId)).toHaveLength(0);
  });
});

async function provisionUser(database: DatabaseClient, suffix: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, $2) RETURNING id`,
    [`did:privy:${suffix}-${randomUUID()}`, "Nani Grant"],
  );
  return result.rows[0]!.id;
}

async function provisionWallet(database: DatabaseClient, userId: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  return result.rows[0]!.id;
}
