import { randomUUID } from "node:crypto";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import {
  DelegatedGrantService,
  type DelegatedGrantRow,
} from "../../src/wallet/grants/consumption.js";
import { classifyGrantCoverage } from "../../src/conversations/grant-coverage.js";
import { createWalletConversationService } from "../../src/conversations/service.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import type { ConversationRepository } from "../../src/conversations/repository.js";

/**
 * Phase 4.4 (slice3-grant-execution): REAL ordered candidate fallback through
 * the service + real gate + real ledger. The gate returns ALL statically
 * eligible candidates (Q3 order); the service iterates claims sequentially,
 * skipping rejected candidates; only the winning claim's grant is consumed,
 * and the broadcast still requires winning claimPendingTransfer. When every
 * candidate is rejected: no broadcasting, the standard preview+confirmation
 * flow, and each rejection audited by the ledger.
 */

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "0x1234567890123456789012345678901234567890";
const conversationId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

suite(
  "delegated grant candidate fallback & audited degradation (phase 4.4)",
  () => {
    let database: DatabaseClient;
    let grants: DelegatedGrantService;
    const previousRuntime = process.env.AGENT_RUNTIME;

    beforeAll(async () => {
      database = createDatabaseClient(databaseUrl!);
      grants = new DelegatedGrantService(database);
    });
    afterAll(async () => {
      await database.close();
    });
    const previousNetwork = process.env.WDK_NETWORK;
    const previousToken = process.env.WDK_TOKEN;
    beforeEach(() => {
      process.env.AGENT_RUNTIME = "deterministic";
      // Route previews to the Solana delegated-grant registry network.
      process.env.WDK_NETWORK = "solana-devnet";
      process.env.WDK_TOKEN = "SOL";
    });
    afterEach(() => {
      if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
      else process.env.AGENT_RUNTIME = previousRuntime;
      if (previousNetwork === undefined) delete process.env.WDK_NETWORK;
      else process.env.WDK_NETWORK = previousNetwork;
      if (previousToken === undefined) delete process.env.WDK_TOKEN;
      else process.env.WDK_TOKEN = previousToken;
    });

    async function provisionWallet(): Promise<{
      userId: string;
      walletId: string;
    }> {
      const user = (
        await database.query<{ id: string }>(
          `INSERT INTO users (privy_did, display_name)
         VALUES ($1, 'DGC') ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
         RETURNING id`,
          [`did:privy:dgc-${randomUUID()}`],
        )
      ).rows[0]!.id;
      const walletId = (
        await database.query<{ id: string }>(
          `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
         VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
          [user, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
        )
      ).rows[0]!.id;
      return { userId: user, walletId };
    }

    async function createReadyGrant(
      userId: string,
      walletId: string,
      overrides: Partial<{
        maxPerTransfer: string;
        maxCumulative: string;
        state: string;
        providerPolicyId: string | null;
      }> = {},
    ): Promise<DelegatedGrantRow> {
      const grant = await grants.createGrant({
        userId,
        walletId,
        action: "transfer",
        chain: "solana",
        maxPerTransfer: overrides.maxPerTransfer ?? "10000000",
        maxCumulative: overrides.maxCumulative ?? "50000000",
        windowSeconds: 3600,
        recipients: [RECIPIENT],
        expiresAt: new Date(Date.now() + 7 * 86_400_000),
      });
      if (overrides.state) {
        await database.query(
          `UPDATE delegated_grants SET state = $2 WHERE id = $1`,
          [grant.id, overrides.state],
        );
      }
      if (overrides.providerPolicyId !== undefined) {
        await database.query(
          `UPDATE delegated_grants SET provider_policy_id = $2 WHERE id = $1`,
          [grant.id, overrides.providerPolicyId],
        );
      } else {
        await database.query(
          `UPDATE delegated_grants SET provider_policy_id = 'policy-x' WHERE id = $1`,
          [grant.id],
        );
      }
      const row = await database.query<Record<string, unknown>>(
        `SELECT * FROM delegated_grants WHERE id = $1`,
        [grant.id],
      );
      return row.rows[0] as unknown as DelegatedGrantRow;
    }

    function gateFor(userId: string, walletId: string) {
      return {
        async evaluate(input: {
          pendingTransfer: {
            network: string;
            token: string;
            recipient: string;
            amount: string;
          };
        }) {
          const listed = await grants.listGrants(userId);
          const decision = classifyGrantCoverage({
            request: {
              origin: "user_request",
              action: "transfer",
              chain: "solana",
              network: input.pendingTransfer.network,
              token: input.pendingTransfer.token,
              amount: input.pendingTransfer.amount,
              recipient: input.pendingTransfer.recipient,
              walletId,
              // Clock skew guard: Postgres INSERTs may carry a createdAt a few
              // ms ahead of the process clock; pin the classifier's now safely
              // after the inserts (grants expire in 7 days). Production Q1
              // rule is unchanged — this is test-injected time only.
              now: Date.now() + 5_000,
              intentBoundToOriginalText: true,
            },
            candidates: listed.map((grant) => ({
              id: grant.id,
              walletId: grant.walletId,
              action: grant.action,
              chain: grant.chain,
              maxPerTransfer: grant.maxPerTransfer,
              maxCumulative: grant.maxCumulative,
              recipients: grant.recipients,
              state: grant.state,
              providerPolicyId: grant.providerPolicyId,
              createdAt: grant.createdAt.getTime(),
              expiresAt: grant.expiresAt.getTime(),
            })),
            tokenDecimals: (network, token) =>
              network === "solana-devnet" && token === "SOL" ? 9 : null,
          });
          if (decision.outcome !== "covered") return null;
          return {
            covered: true,
            source: "delegated_grant" as const,
            grantId: decision.grantId,
            amountSmallestUnits: decision.amountSmallestUnits,
            orderedCandidates: decision.orderedCandidates,
          };
        },
      };
    }

    /** Durable-behavior repository spy (attempts + event sequence). */
    function repositoryWithSpy(): {
      repository: ConversationRepository;
      events: string[];
    } {
      type attempt = { id: string; status: string };
      const attempts: attempt[] = [];
      const events: string[] = [];
      let snapshot: any = {
        id: conversationId,
        userId: "",
        mode: "typed",
        createdAt: new Date(0).toISOString(),
        updatedAt: new Date(0).toISOString(),
        revision: 0,
        language: "es",
        generation: 1,
        messages: [],
      };
      const repository = {
        async create() {
          return snapshot;
        },
        async get(_userId?: string, _conversationId?: string) {
          return { ...snapshot, messages: [...snapshot.messages] };
        },
        async inspect() {
          return this.get("", conversationId);
        },
        async appendMessage(_u: string, _c: string, m: any) {
          snapshot.messages.push(m);
        },
        async saveSnapshot(_u: string, incoming: any) {
          let pending = incoming.pendingTransfer;
          if (pending && !pending.previewId) {
            const id = randomUUID();
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
        async updateState(_u: string, _c: string, _r: number, st: any) {
          snapshot = { ...snapshot, ...st };
          return snapshot.revision + 1;
        },
        async setProgress() {
          return snapshot.revision + 1;
        },
        async setPendingTransfer() {
          return snapshot.revision + 1;
        },
        async clearPendingTransfer() {
          snapshot = { ...snapshot, pendingTransfer: undefined };
          return snapshot;
        },
        async cancelPendingTransfer() {
          return "cancelled" as const;
        },
        async claimPendingTransfer() {
          const p = attempts.find((a) => a.status === "previewed");
          if (!p) return { status: "missing" as const };
          p.status = "broadcasting";
          events.push(`attempt:broadcasting:${p.id}`);
          if (!snapshot.pendingTransfer) return { status: "missing" as const };
          return {
            status: "claimed" as const,
            transfer: { ...snapshot.pendingTransfer, previewId: p.id },
          };
        },
        async releasePendingTransferClaim() {},
        async markPendingTransferUncertain() {},
        async setLastTransactionHash() {},
        async markTransferSubmitted(_u: string, _c: string, h: string) {
          events.push(`submitted:${h}`);
        },
        async finalizeTransfer(_u: string, _c: string, _r: any) {
          events.push("finalized");
          snapshot = { ...snapshot, pendingTransfer: undefined };
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
        repository: repository as unknown as ConversationRepository,
        events,
      };
    }

    it("full flow: first candidate rejected by window, service consumes the fallback, broadcasts once", async () => {
      const { userId, walletId } = await provisionWallet();
      // Both statically eligible; Q3 order: narrower cumulative first.
      const narrow = await createReadyGrant(userId, walletId, {
        maxCumulative: "10000000",
      });
      const fallback = await createReadyGrant(userId, walletId, {
        maxCumulative: "100000000",
      });

      // Exhaust the narrow candidate before this request. The classifier
      // remains static and still returns it first; the atomic claim rejects
      // it, so execution must fall back to the broader grant.
      const exhausted = await grants.claimConsumption({
        grantId: narrow.id,
        userId,
        amount: "10000000",
        idempotencyKey: `grant-exec:${userId}:${randomUUID()}`,
      });
      expect(exhausted.consumed).toBe(true);

      const { repository, events } = repositoryWithSpy();
      const gate = gateFor(userId, walletId);
      const wallet = new FixtureWalletProvider();
      const broadcast = vi.spyOn(wallet, "broadcastTransfer");
      const consumedGrants: string[] = [];
      const service = createWalletConversationService({
        conversations: repository,
        wallet,
        grantGate: gate,
        grantLedger: {
          claim: async (input) => {
            const result = await grants.claimConsumption(input);
            events.push(
              `ledger:${result.consumed ? "consumed" : "rejected"}:${input.grantId.slice(0, 8)}:${result.replay ? "replay" : (result.reason ?? "fresh")}`,
            );
            if (result.consumed) consumedGrants.push(input.grantId);
            return result;
          },
        },
      });

      for await (const _ of service.handleTurnStream({
        conversationId,
        userId,
        text: `Send 0.01 SOL to ${RECIPIENT}`,
      }))
        void _;

      // The narrower candidate's claim was rejected and audited; the service
      // consumed the fallback candidate only.
      expect(consumedGrants).toEqual([fallback.id]);
      expect(broadcast).toHaveBeenCalledOnce();
      const attemptBroadcasting = events.findIndex((e) =>
        e.startsWith("attempt:broadcasting:"),
      );
      const submitted = events.findIndex((e) => e.startsWith("submitted:"));
      expect(attemptBroadcasting).toBeGreaterThanOrEqual(0);
      expect(submitted).toBeGreaterThan(attemptBroadcasting);
      // The first rejection is audited by the ledger.
      const audit = await database.query<{ reason: string }>(
        `SELECT reason FROM grant_audit_log WHERE grant_id = $1 AND event = 'rejected'`,
        [narrow.id],
      );
      expect(audit.rows.length).toBeGreaterThan(0);
    });

    it("all candidates rejected: no broadcasting, preview+confirmation flow, rejections audited", async () => {
      const { userId, walletId } = await provisionWallet();
      const a = await createReadyGrant(userId, walletId, {
        maxCumulative: "10000000",
      });
      const b = await createReadyGrant(userId, walletId, {
        maxCumulative: "10000000",
      });
      // Exhaust both grants' cumulative budgets via direct claims.
      await grants.claimConsumption({
        grantId: a.id,
        userId,
        amount: "10000000",
        idempotencyKey: `grant-exec:${userId}:${randomUUID()}`,
      });
      await grants.claimConsumption({
        grantId: b.id,
        userId,
        amount: "10000000",
        idempotencyKey: `grant-exec:${userId}:${randomUUID()}`,
      });

      const { repository, events } = repositoryWithSpy();
      const gate = gateFor(userId, walletId);
      const wallet = new FixtureWalletProvider();
      const broadcast = vi.spyOn(wallet, "broadcastTransfer");
      const service = createWalletConversationService({
        conversations: repository,
        wallet,
        grantGate: gate,
        grantLedger: {
          claim: async (input) => {
            const result = await grants.claimConsumption(input);
            events.push(
              `ledger:${result.consumed ? "consumed" : "rejected"}:${input.grantId.slice(0, 8)}`,
            );
            return result;
          },
        },
      });

      let turnStatus = "";
      for await (const event of service.handleTurnStream({
        conversationId,
        userId,
        text: `Send 0.01 SOL to ${RECIPIENT}`,
      })) {
        if (event.type === "turn-completed") turnStatus = event.result.status;
      }

      expect(broadcast).not.toHaveBeenCalled();
      expect(events.some((e) => e.startsWith("attempt:broadcasting:"))).toBe(
        false,
      );
      // Degrades closed to the standard preview + confirmation flow (Q4).
      expect(turnStatus).toBe("confirmation_required");
      // Both rejections are audited.
      for (const g of [a, b]) {
        const audit = await database.query<{ reason: string }>(
          `SELECT reason FROM grant_audit_log WHERE grant_id = $1 AND event = 'rejected'`,
          [g.id],
        );
        expect(audit.rows.length).toBeGreaterThan(0);
      }
    });
  },
);
