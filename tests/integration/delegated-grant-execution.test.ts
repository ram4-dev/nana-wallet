import { randomUUID } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { DelegatedGrantService } from "../../src/wallet/grants/consumption.js";
import { seedWalletPolicyState } from "./helpers/policy-state.js";
import { createWalletConversationService } from "../../src/conversations/service.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";

/**
 * Phase 4 RED (slice3-grant-execution): atomic ledger claim ordering.
 *
 * AD-6 sequencing (binding): for delegated grants, `claimConsumption` MUST
 * commit (claim row + `used` audit) BEFORE the single-winner
 * `claimPendingTransfer` attempt transition; only the attempt winner may
 * broadcast. A same-key ledger replay must NOT bypass the attempt gate.
 *
 * These tests are RED against the current code: the service does not yet
 * accept a claim callback (grantLedger) and never calls claimConsumption on
 * the delegated-grant path.
 */

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "0x1234567890123456789012345678901234567890";
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
// One generated user per scenario: the grant ledger, wallet row, and
// conversation all belong to the SAME resolved user id.
let userId = "";

function repositoryWithSpy(predeterminedAttemptId?: string): {
  repository: ConversationRepositoryLike;
  events: string[];
} {
  let usedPredetermined = false;
  type attempt = { id: string; status: string };
  const attempts: attempt[] = [];
  const events: string[] = [];
  let snapshot: ConversationSnapshot = {
    id: conversationId,
    userId,
    mode: "typed" as const,
    createdAt: new Date(0).toISOString(),
    updatedAt: new Date(0).toISOString(),
    revision: 0,
    language: "es" as const,
    generation: 1,
    messages: [],
  };
  const repository = {
    async create(_userId: string) {
      return snapshot;
    },
    async get(_userId: string, _conversationId: string) {
      return { ...snapshot, messages: [...snapshot.messages] };
    },
    async inspect(_userId: string, _conversationId: string) {
      return this.get(userId, conversationId);
    },
    async appendMessage(
      _u: string,
      _c: string,
      m: ConversationSnapshot["messages"][number],
    ) {
      snapshot.messages.push(m);
    },
    async saveSnapshot(_u: string, incoming: typeof snapshot) {
      // Model the durable repository behavior: a snapshot carrying a NEW
      // pendingTransfer without an attempt id creates a
      // conversation_transfer_attempts row and attaches its durable id as
      // previewId (PostgresConversationRepository.saveSnapshot semantics).
      let pending = incoming.pendingTransfer;
      if (pending && !pending.previewId) {
        const id =
          predeterminedAttemptId !== undefined && !usedPredetermined
            ? ((usedPredetermined = true), predeterminedAttemptId)
            : randomUUID();
        attempts.push({ id, status: "previewed" });
        events.push(`attempt:previewed:${id}`);
        pending = { ...pending, previewId: id };
      }
      snapshot = {
        ...incoming,
        ...(pending ? { pendingTransfer: pending } : {}),
        revision: incoming.revision + 1,
      };
      return snapshot;
    },
    async updateState(
      _u: string,
      _c: string,
      _r: number,
      state: Record<string, unknown>,
    ) {
      snapshot = { ...snapshot, ...state } as typeof snapshot;
      return snapshot.revision + 1;
    },
    async setProgress(_u: string, _c: string, _p: unknown) {
      return snapshot.revision + 1;
    },
    async setPendingTransfer(
      _u: string,
      _c: string,
      transfer: Record<string, unknown>,
    ) {
      const id = randomUUID();
      attempts.push({ id, status: "previewed" });
      events.push(`attempt:previewed:${id}`);
      snapshot = {
        ...snapshot,
        pendingTransfer: {
          ...(transfer as object),
          previewId: id,
        } as ConversationSnapshot["pendingTransfer"],
        revision: snapshot.revision + 1,
      };
      return snapshot;
    },
    async clearPendingTransfer() {
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        revision: snapshot.revision + 1,
      };
      return snapshot;
    },
    async cancelPendingTransfer() {
      return "cancelled" as const;
    },
    async claimPendingTransfer() {
      const pending = attempts.find((a) => a.status === "previewed");
      if (!pending) return { status: "missing" as const };
      pending.status = "broadcasting";
      events.push(`attempt:broadcasting:${pending.id}`);
      const claimed = snapshot.pendingTransfer;
      if (!claimed) return { status: "missing" as const };
      return {
        status: "claimed" as const,
        transfer: { ...claimed, previewId: pending.id },
      };
    },
    async releasePendingTransferClaim() {},
    async markPendingTransferUncertain() {},
    async setLastTransactionHash() {},
    async markTransferSubmitted(_u: string, _c: string, hash: string) {
      events.push(`submitted:${hash}`);
    },
    async finalizeTransfer(
      _u: string,
      _c: string,
      result: { transactionHash: string },
    ) {
      events.push(`finalized:${result.transactionHash}`);
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        revision: snapshot.revision + 1,
      };
    },
    async setMode() {
      return snapshot.revision + 1;
    },
    async acquireLiveLease() {
      throw new Error("not used");
    },
    async renewLiveLease() {
      return false;
    },
    async releaseLiveLease() {
      return false;
    },
  };
  return {
    repository: repository as unknown as ConversationRepositoryLike,
    events,
  };
}

type ConversationSnapshotMessage = {
  role: "user" | "assistant";
  content: string;
};
type ConversationRepositoryLike =
  import("../../src/conversations/repository.js").ConversationRepository;

suite("delegated grant execution ordering (phase 4 RED)", () => {
  let database: DatabaseClient;
  let grants: DelegatedGrantService;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    grants = new DelegatedGrantService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  const previousRuntime = process.env.AGENT_RUNTIME;
  beforeEach(() => {
    process.env.AGENT_RUNTIME = "deterministic";
  });
  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
  });

  async function provisionGrant(policyId: string | null): Promise<{
    grantId: string;
    walletId: string;
    grantUserId: string;
  }> {
    const user = (
      await database.query<{ id: string }>(
        `INSERT INTO users (privy_did, display_name)
         VALUES ($1, 'DGE') ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
         RETURNING id`,
        [`did:privy:dge-${randomUUID()}`],
      )
    ).rows[0]!.id;
    userId = user; // the SAME user owns grant, wallet and conversation
    const walletId = (
      await database.query<{ id: string }>(
        `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
         VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
        [user, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
      )
    ).rows[0]!.id;
    // Task 2.11: a claimable wallet is a wallet whose applied policy is
    // verified (design §4.1) — the refusal itself is pinned in
    // `grant-consumption-revision.test.ts`.
    await seedWalletPolicyState(database, user, walletId);
    const grant = await grants.createGrant({
      userId: user,
      walletId,
      action: "transfer",
      chain: "solana",
      maxPerTransfer: "10000000",
      maxCumulative: "50000000",
      windowSeconds: 3600,
      recipients: [RECIPIENT],
      expiresAt: new Date(Date.now() + 7 * 86_400_000),
    });
    if (policyId !== null) {
      await database.query(
        `UPDATE delegated_grants SET provider_policy_id = $2 WHERE id = $1`,
        [grant.id, policyId],
      );
    }
    return { grantId: grant.id, walletId, grantUserId: user };
  }

  /** REAL ledger claim through DelegatedGrantService (no mocks). */
  function realLedgerClaim(repositoryEvents: string[]) {
    const events: string[] = [];
    return {
      events,
      claim: async (input: {
        grantId: string;
        userId: string;
        amount: string;
        idempotencyKey: string;
      }) => {
        const result = await grants.claimConsumption(input);
        // Event recorded strictly AFTER the DB commit returns.
        const event = `ledger:${result.consumed ? "consumed" : "rejected"}:${result.replay ? "replay" : "fresh"}`;
        events.push(event);
        repositoryEvents.push(event);
        return result;
      },
    };
  }

  it("RED: claimConsumption commits (claim row + used audit) before attempt claim and broadcast", async () => {
    const { grantId } = await provisionGrant("policy-test");
    const { repository, events } = repositoryWithSpy();
    const wallet = new FixtureWalletProvider();
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const ledger = realLedgerClaim(events);
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      grantLedger: { claim: ledger.claim },
      grantGate: {
        evaluate: async () => ({
          covered: true,
          source: "delegated_grant" as const,
          grantId,
          amountSmallestUnits: "10000000",
        }),
      },
    });
    for await (const _ of service.handleTurnStream({
      conversationId,
      userId,
      text: `Send 10 USDT to ${RECIPIENT}`,
    }))
      void _;

    // The REAL claim ran and consumed budget.
    expect(
      ledger.events.some((e) => e.startsWith("ledger:consumed:fresh")),
    ).toBe(true);
    expect(broadcast).toHaveBeenCalled();
    // Ordering invariant: budget claim BEFORE the attempt transition, and the
    // broadcast only after the attempt gate won.
    const ledgerClaimed = events.findIndex((e) =>
      e.startsWith("ledger:consumed"),
    );
    const attemptBroadcasting = events.findIndex((e) =>
      e.startsWith("attempt:broadcasting:"),
    );
    const submitted = events.findIndex((e) => e.startsWith("submitted:"));
    expect(ledgerClaimed).toBeGreaterThanOrEqual(0);
    expect(attemptBroadcasting).toBeGreaterThan(ledgerClaimed);
    expect(submitted).toBeGreaterThan(attemptBroadcasting);
  });

  it("RED: a real rejected claim (unbound grant) never reaches the broadcast", async () => {
    // provider_policy_id stays NULL: the ledger refuses to consume (policy_not_ready).
    const { grantId } = await provisionGrant(null);
    const { repository, events } = repositoryWithSpy();
    const wallet = new FixtureWalletProvider();
    const broadcast = vi.spyOn(wallet, "broadcastTransfer");
    const ledger = realLedgerClaim(events);
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      grantLedger: { claim: ledger.claim },
      grantGate: {
        evaluate: async () => ({
          covered: true,
          source: "delegated_grant" as const,
          grantId,
          amountSmallestUnits: "10000000",
        }),
      },
    });
    for await (const _ of service.handleTurnStream({
      conversationId,
      userId,
      text: `Send 10 USDT to ${RECIPIENT}`,
    }))
      void _;

    // The REAL claim rejected (policy_not_ready), the attempt never claimed,
    // and nothing was broadcast.
    expect(ledger.events.some((e) => e.startsWith("ledger:rejected"))).toBe(
      true,
    );
    expect(broadcast).not.toHaveBeenCalled();
    expect(events.some((e) => e.startsWith("attempt:broadcasting:"))).toBe(
      false,
    );
  });

  it("RED: same-key ledger replay still requires winning claimPendingTransfer before broadcast", async () => {
    const { grantId } = await provisionGrant("policy-test");
    const attemptId = randomUUID();
    const { repository, events } = repositoryWithSpy(attemptId);
    const wallet = new FixtureWalletProvider();

    // Pre-claim the SAME namespaced key the service will derive from the
    // persisted attempt id.
    const idempotencyKey = `grant-exec:${userId}:${attemptId}`;
    const first = await grants.claimConsumption({
      grantId,
      userId,
      amount: "10000000",
      idempotencyKey,
    });
    expect(first.consumed).toBe(true);

    // Audit before/after replay: no second `used` row for the same key.
    const auditCount = async (): Promise<number> => {
      const result = await database.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM grant_audit_log
         WHERE grant_id = $1 AND event = 'used'`,
        [grantId],
      );
      return Number(result.rows[0]!.count);
    };
    const before = await auditCount();

    const ledger = realLedgerClaim(events);
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      grantLedger: { claim: ledger.claim },
      grantGate: {
        evaluate: async () => ({
          covered: true,
          source: "delegated_grant" as const,
          grantId,
          amountSmallestUnits: "10000000",
        }),
      },
    });
    for await (const _ of service.handleTurnStream({
      conversationId,
      userId,
      text: `Send 10 USDT to ${RECIPIENT}`,
    }))
      void _;

    // Replay path: same key, no second audit row, consumed via replay.
    const after = await auditCount();
    expect(after).toBe(before);
    expect(
      ledger.events.some((e) => e.startsWith("ledger:consumed:replay")),
    ).toBe(true);
    // Even on a budget replay, the broadcast required winning the attempt gate.
    const attemptBroadcasting = events.findIndex((e) =>
      e.startsWith("attempt:broadcasting:"),
    );
    const submitted = events.findIndex((e) => e.startsWith("submitted:"));
    expect(attemptBroadcasting).toBeGreaterThanOrEqual(0);
    expect(submitted).toBeGreaterThan(attemptBroadcasting);
  });
});
