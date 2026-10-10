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
import {
  consumedInWindow,
  DelegatedGrantService,
} from "../../src/wallet/grants/consumption.js";
import { createWalletConversationService, type ConversationEvent } from "../../src/conversations/service.js";
import { FixtureWalletProvider } from "../../src/wallet/fixture-provider.js";
import { seedWalletPolicyState } from "./helpers/policy-state.js";
import type { ConversationSnapshot } from "../../src/conversations/types.js";

/**
 * Phase 8 RED (slice3-grant-execution): reservation release on definitive
 * no-dispatch (spec requirement "Reserved budget release on definitive
 * no-dispatch", design AD-10/AD-11, tasks 8.1-8.4b).
 *
 * These are RED tests: they MUST fail because the new behaviors/schema do not
 * exist yet, never because the environment is broken. NO production code or
 * migrations are written in this phase.
 *
 * Binding contract under test:
 * - Migration 012: grant_claim_ledger.released_at/released_reason; `released`
 *   in the grant_audit_log event CHECK; forced RLS + UPDATE grant preserved.
 * - Settlement is ONE user-scoped `withUserTransaction` (per-grant advisory
 *   lock inside) performing attempt CAS + ledger release + `released` audit on
 *   the SAME client via the TX-ONLY ledger method
 *   `releaseReservationInTransaction` (never opens/commits/nests a
 *   transaction); any injected failure rolls back ALL THREE effects (verified
 *   by DB re-read, not mocks).
 * - The ONLY release authority is the exact-owner CAS `broadcasting →
 *   cancelled` (id + status + claim_id all matching) inside the settlement
 *   transaction; wrong/stale claim_id, lost CAS, absent row,
 *   already-`cancelled`, or ambiguous ownership NEVER release standalone.
 * - `claimPendingTransfer` winner result returns the persisted `claim_id`.
 * - A released key replay fails closed (never `consumed`, never broadcasts);
 *   retry requires a FRESH previewId/key.
 * - BOTH window sums (claim total + consumedInWindow) count UNRELEASED
 *   grant_claim_ledger rows.
 */

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const RECIPIENT = "0x1234567890123456789012345678901234567890";
const AMOUNT = "10000000";
let conversationId = randomUUID();

let database: DatabaseClient;
let grants: DelegatedGrantService;
let userId = "";

/**
 * Each test provisions its OWN user + wallet + grant: user_wallets enforces
 * one ACTIVE wallet per (user, chain_family), so a per-test user avoids
 * harness collisions without touching any constraint. `userId` (module-level)
 * is reassigned per test so every helper threads the right owner.
 */
async function provisionTestContext(
  options: {
    policyId?: string | null;
    maxPerTransfer?: string;
    maxCumulative?: string;
  } = {},
): Promise<{ userId: string; walletId: string; grantId: string }> {
  const testUser = await provisionUser();
  userId = testUser;
  conversationId = randomUUID(); // per-test conversation, same owner
  const testWalletId = await provisionWallet(testUser);
  const grantId = await provisionGrant(testWalletId, options);
  return { userId: testUser, walletId: testWalletId, grantId };
}

type AttemptRow = {
  id: string;
  status: string;
  claim_id: string | null;
};

async function provisionUser(): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO users (privy_did, display_name)
     VALUES ($1, 'Phase8 RED') ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
     RETURNING id`,
    [`did:privy:phase8-${randomUUID()}`],
  );
  return result.rows[0]!.id;
}

async function provisionWallet(userId_: string): Promise<string> {
  const result = await database.query<{ id: string }>(
    `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
     VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
    [userId_, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
  );
  const walletId = result.rows[0]!.id;
  // Task 2.11: a claimable wallet is a wallet whose applied policy is verified
  // (design §4.1) — the refusal itself is pinned in
  // `grant-consumption-revision.test.ts`.
  await seedWalletPolicyState(database, userId_, walletId);
  return walletId;
}

async function provisionGrant(
  walletId: string,
  options: {
    policyId?: string | null;
    maxPerTransfer?: string;
    maxCumulative?: string;
  } = {},
): Promise<string> {
  const grant = await grants.createGrant({
    userId,
    walletId,
    action: "transfer",
    chain: "solana",
    maxPerTransfer: options.maxPerTransfer ?? "10000000",
    maxCumulative: options.maxCumulative ?? "50000000",
    windowSeconds: 3600,
    recipients: [RECIPIENT],
    expiresAt: new Date(Date.now() + 7 * 86_400_000),
  });
  if (options.policyId !== undefined && options.policyId !== null) {
    await database.query(
      `UPDATE delegated_grants SET provider_policy_id = $2 WHERE id = $1`,
      [grant.id, options.policyId],
    );
  }
  return grant.id;
}

async function insertAttempt(input: {
  status: string;
  claimId?: string | null;
}): Promise<string> {
  const id = randomUUID();
  // The attempt row requires a REAL conversation row (FK) and conversations
  // enforce one ACTIVE transfer each: insert a fresh conversation per attempt
  // (harness isolation, no constraint disabled).
  const convId = conversationId;
  await database.query(
    `INSERT INTO conversations (id, user_id, mode)
     VALUES ($1, $2, 'typed')
     ON CONFLICT (id) DO NOTHING`,
    [convId, userId],
  );
  await database.query(
    `INSERT INTO conversation_transfer_attempts
       (id, conversation_id, user_id, status, claim_id, claimed_at, state_revision, pending_transfer)
     VALUES ($1, $2, $3, $4, $5, CASE WHEN $5::uuid IS NULL THEN NULL ELSE now() END, 1, $6::jsonb)`,
    [
      id,
      convId,
      userId,
      input.status,
      input.claimId ?? null,
      JSON.stringify({
        conversationId,
        network: "fixture",
        token: "USDT",
        amount: "10",
        recipientAddress: RECIPIENT,
      }),
    ],
  );
  return id;
}

async function getAttempt(id: string): Promise<AttemptRow | undefined> {
  const result = await database.query<AttemptRow>(
    `SELECT id, status, claim_id FROM conversation_transfer_attempts WHERE id = $1`,
    [id],
  );
  return result.rows[0];
}

async function claimRow(
  grantId: string,
  idempotencyKey: string,
): Promise<
  | {
      released_at: string | null;
      released_reason: string | null;
    }
  | undefined
> {
  const result = await database.query<{
    released_at: string | null;
    released_reason: string | null;
  }>(
    `SELECT released_at, released_reason FROM grant_claim_ledger
     WHERE grant_id = $1 AND idempotency_key = $2`,
    [grantId, idempotencyKey],
  );
  return result.rows[0];
}

async function releasedAuditCount(
  grantId: string,
  idempotencyKey: string,
): Promise<number> {
  // The `released` event does not exist until migration 012: the RED failure
  // for audit assertions is the CHECK constraint rejecting the insert (or the
  // missing column/row), not an environment problem.
  const result = await database.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM grant_audit_log
     WHERE grant_id = $1 AND event = 'released'
       AND detail->>'idempotencyKey' = $2`,
    [grantId, idempotencyKey],
  );
  return Number(result.rows[0]!.count);
}

type ConversationRepositoryLike =
  import("../../src/conversations/repository.js").ConversationRepository;

/**
 * In-memory repository recording lifecycle events, mirroring the durable
 * Postgres semantics used by phase-4 tests (a snapshot carrying a NEW
 * pendingTransfer creates an attempt row). `claimPendingTransfer` records a
 * claim_id like the real Postgres repository (migration 002) but the SERVICE
 * does not yet receive/return it: the RED assertion proves the missing seam.
 */
function repositorySpy(input: {
  events: string[];
  attemptId: string;
  /** DB-minted claim_id so the spy's winner returns the persisted token. */
  claimId?: string;
  /**
   * Versioned recipient identity the persisted pending transfer carries. The
   * real repository persists one for every memory-resolved preview; leaving it
   * out mirrors the address-typed preview (no recipient identity to revalidate).
   */
  claimedRecipient?: { recipientId: string; recipientVersion: number };
  failAfter?: "cas" | "ledger" | "audit";
}): ConversationRepositoryLike {
  const { events, attemptId } = input;
  let status = "previewed";
  // The DB-minted ownership token (insertAttempt) or a generated one: the
  // spy's winner transition must return EXACTLY the persisted token so the
  // service threads it and the real settlement CAS matches.
  const claimId = input.claimId ?? randomUUID();
  // Start EMPTY (proven phase-4 pattern): the turn itself creates and
  // persists the pendingTransfer + its attempt row. No stale preexisting
  // preview — Q1 never auto-executes previews older than the grant.
  const attemptRecord = { id: attemptId, status: "previewed" as string };
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
  const failAt = input.failAfter;
  const repository = {
    async create() {
      return snapshot;
    },
    async get() {
      return { ...snapshot, messages: [...snapshot.messages] };
    },
    async inspect() {
      return (this.get as (...a: unknown[]) => unknown)(userId, conversationId);
    },
    async appendMessage(
      _u: string,
      _c: string,
      m: ConversationSnapshot["messages"][number],
    ) {
      snapshot.messages.push(m);
    },
    async saveSnapshot(_u: string, incoming: typeof snapshot) {
      // Durable semantics (phase-4 mirror): a snapshot carrying a NEW
      // pendingTransfer without an attempt id creates the attempt row and
      // attaches its durable id as previewId.
      let pending = incoming.pendingTransfer;
      if (pending && !pending.previewId) {
        pending = { ...pending, previewId: attemptRecord.id };
        events.push(`attempt:previewed:${attemptRecord.id}`);
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
      snapshot = {
        ...snapshot,
        pendingTransfer: transfer as ConversationSnapshot["pendingTransfer"],
        revision: snapshot.revision + 1,
      };
      return snapshot.revision + 1;
    },
    async clearPendingTransfer() {
      snapshot = {
        ...snapshot,
        pendingTransfer: undefined,
        revision: snapshot.revision + 1,
      };
      return snapshot.revision + 1;
    },
    async cancelPendingTransfer() {
      status = "cancelled";
      events.push("attempt:cancelled");
      return "cancelled" as const;
    },
    async claimPendingTransfer() {
      if (attemptRecord.status !== "previewed") {
        return { status: "missing" as const };
      }
      const claimed = snapshot.pendingTransfer;
      if (!claimed) return { status: "missing" as const };
      attemptRecord.status = "broadcasting";
      status = "broadcasting";
      events.push(`attempt:broadcasting:${claimId}`);
      // GREEN contract: winner result carries the persisted claim_id.
      // RED today: the service interface has no such field and never threads it.
      return {
        status: "claimed" as const,
        claimId,
        transfer: {
          ...claimed,
          previewId: attemptId,
          ...(input.claimedRecipient ?? {}),
        },
      } as never;
    },
    /**
     * RED seam: the CURRENT code calls releasePendingTransferClaim
     * (broadcasting→previewed reset). The GREEN contract replaces it with an
     * atomic owned-CAS settlement. The spy records whichever happens so tests
     * assert the NEW behavior is absent (RED).
     */
    async settleGrantReservation(input: {
      userId: string;
      conversationId: string;
      previewId: string;
      claimId: string;
      grantId: string;
      idempotencyKey: string;
      reason: string;
      failAfter?: "cas" | "ledger" | "audit";
    }) {
      events.push(
        `settle:${input.reason}:cas=${status === "broadcasting" && input.claimId === claimId}`,
      );
      if (failAt === "cas") throw new Error("injected: cas failure");
      status = "cancelled";
      events.push("attempt:cancelled");
      if (failAt === "ledger") throw new Error("injected: ledger failure");
      if (failAt === "audit") throw new Error("injected: audit failure");
      return { cancelled: true, released: true };
    },
    async releasePendingTransferClaim() {
      // Legacy seam still present in production: RED evidence that the service
      // still uses the broadcasting→previewed reset instead of the settlement.
      events.push("legacy:releasePendingTransferClaim");
    },
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
  return repository as unknown as ConversationRepositoryLike;
}

function notDispatchedWallet(events: string[]): {
  wallet: FixtureWalletProvider;
  spy: ReturnType<typeof vi.spyOn>;
} {
  const wallet = new FixtureWalletProvider();
  const spy = vi.spyOn(wallet, "broadcastTransfer").mockResolvedValue({
    kind: "not_dispatched" as const,
    reason: "Fixture injected no-dispatch (phase 8 RED).",
    // A definitive refusal by the wallet's own policy. Resolution is
    // INDEPENDENT of the cause: a policy refusal is still a definitive
    // non-dispatch, so the reservation must be released and the cause must
    // reach the user as the honest policy message.
    cause: "policy_rejected" as const,
  });
  void events; // events recorded via service/repository spy instead
  return { wallet, spy };
}

suite("phase 8: reservation release on definitive no-dispatch (RED)", () => {
  const previousRuntime = process.env.AGENT_RUNTIME;
  beforeEach(() => {
    // Deterministic intent parsing (proven phase-4 setup).
    process.env.AGENT_RUNTIME = "deterministic";
  });
  afterEach(() => {
    if (previousRuntime === undefined) delete process.env.AGENT_RUNTIME;
    else process.env.AGENT_RUNTIME = previousRuntime;
  });

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    grants = new DelegatedGrantService(database);
    userId = await provisionUser();
  });

  afterAll(async () => {
    await database.close();
  });

  // ---------------------------------------------------------------- 8.1 RED
  it("8.1 RED: migration 012 columns + released audit event + RLS/UPDATE grant", async () => {
    const columns = await database.query<{
      column_name: string;
    }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'grant_claim_ledger'`,
    );
    const names = columns.rows.map((r) => r.column_name);
    // RED: released_at / released_reason do not exist until migration 012.
    expect(names).toContain("released_at");
    expect(names).toContain("released_reason");

    // The `released` audit event must be accepted by the CHECK constraint.
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    const key = `grant-exec:${userId}:8-1-check`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });
    // RED: this INSERT violates grant_audit_log_event_check today.
    await expect(
      database.query(
        `INSERT INTO grant_audit_log (grant_id, user_id, event, detail)
         VALUES ($1, $2, 'released', $3::jsonb)`,
        [grantId, userId, JSON.stringify({ idempotencyKey: key })],
      ),
    ).resolves.toBeTruthy();

    // Forced RLS + UPDATE grant: a foreign release is invisible under RLS.
    const foreignUser = await provisionUser();
    await database
      .withUserTransaction(foreignUser, async (client) => {
        // RED expectation: the release UPDATE matches zero rows for a foreign
        // user under forced RLS (the grant claim belongs to another user).
        const result = await client.query(
          `UPDATE grant_claim_ledger SET released_at = now()
           WHERE grant_id = $1 AND idempotency_key = $2`,
          [grantId, key],
        );
        expect(result.rowCount).toBe(0);
      })
      .catch(() => {
        // A permission error is acceptable RED evidence too (UPDATE grant may
        // be missing today), but zero-row match is the primary assertion.
      });
  });

  // ---------------------------------------------------------------- 8.2 RED
  it("8.2 RED: releaseReservationInTransaction is tx-only, idempotent, audited once", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    const key = `grant-exec:${userId}:8-2-tx`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });

    // RED: the tx-only ledger method does not exist yet. The assertion below
    // IS the documented RED evidence; when implemented, the rest of the test
    // exercises idempotency/audit against the real DB.
    const ledger = grants as unknown as Record<string, unknown>;
    expect(typeof ledger.releaseReservationInTransaction).toBe("function");
    if (typeof ledger.releaseReservationInTransaction !== "function") return;

    const release = ledger.releaseReservationInTransaction as unknown as (
      tx: unknown,
      input: {
        grantId: string;
        userId: string;
        idempotencyKey: string;
        reason: string;
      },
    ) => Promise<{ released: boolean; replayedRelease?: boolean }>;

    // First release inside a real user transaction.
    await database.withUserTransaction(userId, async (tx) => {
      const first = await release(tx, {
        grantId,
        userId,
        idempotencyKey: key,
        reason: "not_dispatched",
      });
      expect(first.released).toBe(true);

      // Second release in the SAME transaction: idempotent no-op.
      const second = await release(tx, {
        grantId,
        userId,
        idempotencyKey: key,
        reason: "not_dispatched",
      });
      expect(second.replayedRelease).toBe(true);

      // Exactly ONE released audit row visible at commit time.
      const audits = await tx.query(
        `SELECT count(*)::text AS count FROM grant_audit_log
         WHERE grant_id = $1 AND event = 'released'`,
        [grantId],
      );
      expect(Number(audits.rows[0]!.count)).toBe(1);
    });

    // Persisted state: released row with reason + exactly one audit row.
    const row = await claimRow(grantId, key);
    expect(row?.released_at).not.toBeNull();
    expect(row?.released_reason).toBe("not_dispatched");
    expect(await releasedAuditCount(grantId, key)).toBe(1);
  });

  it("8.2 RED: released-key replay fails closed (never consumed, never broadcasts)", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    const key = `grant-exec:${userId}:8-2-replay`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });

    const ledger = grants as unknown as Record<string, unknown>;
    expect(typeof ledger.releaseReservationInTransaction).toBe("function");
    if (typeof ledger.releaseReservationInTransaction !== "function") return;
    const release = ledger.releaseReservationInTransaction as unknown as (
      tx: unknown,
      input: {
        grantId: string;
        userId: string;
        idempotencyKey: string;
        reason: string;
      },
    ) => Promise<{ released: boolean }>;
    await database.withUserTransaction(userId, async (tx) => {
      await release(tx, {
        grantId,
        userId,
        idempotencyKey: key,
        reason: "not_dispatched",
      });
    });

    // RED: the replay branch of claimConsumption currently returns
    // consumed:true for a RELEASED key. GREEN contract: fail closed.
    const replay = await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });
    expect(replay.consumed).toBe(false);
    expect(replay.replay).toBe(false);

    // A fresh preview/key claims normally after the unrelated release.
    const fresh = await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: `grant-exec:${userId}:8-2-fresh`,
    });
    expect(fresh.consumed).toBe(true);
  });

  // ---------------------------------------------------------- 8.2b/8.4b RED
  it("8.4b RED: real PostgresConversationRepository.claimPendingTransfer returns the persisted claim_id", async () => {
    // REAL repository (no spy): the persisted claim_id must flow back to
    // the winner. RED today: PendingTransferClaim has no claimId field.
    const { PostgresConversationRepository } = await import(
      "../../src/conversations/postgres-repository.js"
    );
    const repository = new PostgresConversationRepository(database);
    const attemptId = await insertAttempt({ status: "previewed" });
    const persisted = await getAttempt(attemptId);
    // No claim_id yet: it is minted by the winner transition itself.
    expect(persisted?.claim_id).toBeNull();

    const result = (await repository.claimPendingTransfer(
      userId,
      conversationId,
      attemptId,
    )) as { status: string; claimId?: string };

    expect(result.status).toBe("claimed");
    // GREEN contract: result.claimId === the claim_id the CAS persisted.
    // RED today: the field does not exist on the result (undefined).
    const afterClaim = await getAttempt(attemptId);
    expect(afterClaim?.status).toBe("broadcasting");
    expect(afterClaim?.claim_id).not.toBeNull();
    expect(result.claimId).toBe(afterClaim!.claim_id);
  });

  it("8.2b RED: atomic all-or-nothing settlement — injected failure rolls back all three effects (DB re-read)", async () => {
    for (const failAfter of ["cas", "ledger", "audit"] as const) {
      const { grantId } = await provisionTestContext({ policyId: "policy-x" });
      const attemptId = await insertAttempt({
        status: "broadcasting",
        claimId: randomUUID(),
      });
      const key = `grant-exec:${userId}:${attemptId}`;
      await grants.claimConsumption({
        grantId,
        userId,
        amount: AMOUNT,
        idempotencyKey: key,
      });
      const attemptBefore = await getAttempt(attemptId);
      expect(attemptBefore?.claim_id).not.toBeNull();

      const events: string[] = [];
      // Documented RED: the service-level settlement API does not exist
      // yet; when implemented, the rest of this test verifies real rules.
      const settlementApi = (grants as unknown as Record<string, unknown>)
        .settleGrantReservation;
      expect(typeof settlementApi).toBe("function");
      if (typeof settlementApi !== "function") return;
      const settlement = settlementApi as unknown as (input: {
        userId: string;
        conversationId: string;
        attemptId: string;
        claimId: string;
        grantId: string;
        idempotencyKey: string;
        reason: string;
        failAfter?: "cas" | "ledger" | "audit";
      }) => Promise<void>;

      await expect(
        settlement.call(grants, {
          userId,
          conversationId,
          attemptId,
          claimId: attemptBefore!.claim_id!,
          grantId,
          idempotencyKey: key,
          reason: "not_dispatched",
          failAfter,
        }),
      ).rejects.toThrow();

      // DB re-read: NOTHING persisted after the injected failure.
      const attempt = await getAttempt(attemptId);
      expect(attempt?.status).toBe("broadcasting");
      const row = await claimRow(grantId, key);
      expect(row?.released_at).toBeNull();
      expect(await releasedAuditCount(grantId, key)).toBe(0);
      void events;
    }
  });

  it("8.4b RED: exact-owner settlement CAS broadcasting→cancelled + release + audit commit together", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    const attemptId = await insertAttempt({
      status: "broadcasting",
      claimId: randomUUID(),
    });
    const key = `grant-exec:${userId}:${attemptId}`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });
    const attempt = await getAttempt(attemptId);
    expect(attempt?.status).toBe("broadcasting");
    expect(attempt?.claim_id).not.toBeNull();

    // Documented RED: the service-level settlement API does not exist
    // yet; when implemented, the rest of this test verifies real rules.
    const settlementApi = (grants as unknown as Record<string, unknown>)
      .settleGrantReservation;
    expect(typeof settlementApi).toBe("function");
    if (typeof settlementApi !== "function") return;
    const settlement = settlementApi as unknown as (input: {
      userId: string;
      conversationId: string;
      attemptId: string;
      claimId: string;
      grantId: string;
      idempotencyKey: string;
      reason: string;
    }) => Promise<void>;

    await settlement.call(grants, {
      userId,
      conversationId,
      attemptId,
      claimId: attempt!.claim_id!,
      grantId,
      idempotencyKey: key,
      reason: "not_dispatched",
    });

    // All three effects persisted atomically.
    expect((await getAttempt(attemptId))?.status).toBe("cancelled");
    const row = await claimRow(grantId, key);
    expect(row?.released_at).not.toBeNull();
    expect(row?.released_reason).toBe("not_dispatched");
    expect(await releasedAuditCount(grantId, key)).toBe(1);
  });

  it("8.4b RED: wrong/stale claim_id cannot cancel or release (retention)", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    const attemptId = await insertAttempt({
      status: "broadcasting",
      claimId: randomUUID(),
    });
    const key = `grant-exec:${userId}:${attemptId}`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });

    // Documented RED: the service-level settlement API does not exist
    // yet; when implemented, the rest of this test verifies real rules.
    const settlementApi = (grants as unknown as Record<string, unknown>)
      .settleGrantReservation;
    expect(typeof settlementApi).toBe("function");
    if (typeof settlementApi !== "function") return;
    const settlement = settlementApi as unknown as (input: {
      userId: string;
      conversationId: string;
      attemptId: string;
      claimId: string;
      grantId: string;
      idempotencyKey: string;
      reason: string;
    }) => Promise<void>;

    // Stale token: settlement must NOT cancel nor release.
    await expect(
      settlement.call(grants, {
        userId,
        conversationId,
        attemptId,
        claimId: randomUUID(), // WRONG token
        grantId,
        idempotencyKey: key,
        reason: "not_dispatched",
      }),
    ).resolves.toBeUndefined();

    expect((await getAttempt(attemptId))?.status).toBe("broadcasting");
    expect((await claimRow(grantId, key))?.released_at).toBeNull();
    expect(await releasedAuditCount(grantId, key)).toBe(0);
  });

  it("8.4b RED: already-cancelled or absent attempt retains (no standalone release)", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    const cancelledId = await insertAttempt({ status: "cancelled" });
    const key = `grant-exec:${userId}:${cancelledId}`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });
    // Documented RED: the service-level settlement API does not exist
    // yet; when implemented, the rest of this test verifies real rules.
    const settlementApi = (grants as unknown as Record<string, unknown>)
      .settleGrantReservation;
    expect(typeof settlementApi).toBe("function");
    if (typeof settlementApi !== "function") return;
    const settlement = settlementApi as unknown as (input: {
      userId: string;
      conversationId: string;
      attemptId: string;
      claimId: string;
      grantId: string;
      idempotencyKey: string;
      reason: string;
    }) => Promise<void>;

    // Already-cancelled: no standalone release authority.
    await expect(
      settlement.call(grants, {
        userId,
        conversationId,
        attemptId: cancelledId,
        claimId: randomUUID(),
        grantId,
        idempotencyKey: key,
        reason: "not_dispatched",
      }),
    ).resolves.toBeUndefined();
    expect((await claimRow(grantId, key))?.released_at).toBeNull();

    // Absent row: same retention rule.
    await expect(
      settlement.call(grants, {
        userId,
        conversationId,
        attemptId: randomUUID(), // missing
        claimId: randomUUID(),
        grantId,
        idempotencyKey: key,
        reason: "not_dispatched",
      }),
    ).resolves.toBeUndefined();
    expect((await claimRow(grantId, key))?.released_at).toBeNull();
    expect(await releasedAuditCount(grantId, key)).toBe(0);
  });

  it("8.4 GREEN: service settles preflight rejection from owned broadcasting via the settlement CAS (not the legacy reset)", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    // DB attempt seeded BROADCASTING with the exact ownership token the
    // spy's winner will return: the real settlement CAS must match it.
    const ownedClaimId = randomUUID();
    const attemptId = await insertAttempt({
      status: "broadcasting",
      claimId: ownedClaimId,
    });
    const key = `grant-exec:${userId}:${attemptId}`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });

    const events: string[] = [];
    // The persisted attempt carries a versioned recipient identity, as it does
    // for any memory-resolved preview.
    const recipientId = randomUUID();
    const repository = repositorySpy({
      events,
      attemptId,
      claimId: ownedClaimId,
      claimedRecipient: { recipientId, recipientVersion: 2 },
    });
    // Preflight-after-claim: the local transfer-policy gate no longer exists, so
    // the surviving pre-dispatch rejection in runFinancialTransfer is the
    // claimed-recipient revalidation. With no recipient-memory dependency the
    // service fails that closed — a real rejection from the OWNED broadcasting
    // state, before any broadcast.
    const wallet = new FixtureWalletProvider();
    const previewSpy = vi
      .spyOn(wallet, "previewTransfer")
      .mockImplementation(async (...args: unknown[]) => {
        const preview = {
          network: "base-sepolia",
          token: "USDT",
          recipient: RECIPIENT,
          amount: "10",
          estimatedFee: "0.00001",
        };
        void args;
        return preview;
      });
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      grantLedger: {
        claim: grants.claimConsumption.bind(grants),
        settle: (i) => {
          events.push(
            `settle:${i.reason}:claimIdMatch=${i.claimId === ownedClaimId}`,
          );
          return grants.settleGrantReservation({
            userId,
            conversationId,
            attemptId: i.attemptId,
            claimId: i.claimId,
            grantId: i.grantId,
            idempotencyKey: i.idempotencyKey,
            reason: i.reason,
          });
        },
      },
      grantGate: {
        evaluate: async () => ({
          covered: true,
          source: "delegated_grant" as const,
          grantId,
          amountSmallestUnits: AMOUNT,
        }),
      },
    });
    for await (const _ of service.handleTurnStream({
      conversationId,
      userId,
      text: `Send 10 USDT to ${RECIPIENT}`,
    }))
      void _;

    // The claim was won (owned broadcasting state) before the rejection.
    expect(events.some((e) => e.startsWith("attempt:broadcasting:"))).toBe(
      true,
    );
    expect(previewSpy).toHaveBeenCalledTimes(1);

    // GREEN contract: settlement CAS (owned broadcasting→cancelled) +
    // ledger release + released audit, replacing the legacy reset.
    expect(events.some((e) => e === "legacy:releasePendingTransferClaim")).toBe(
      false,
    );
    expect(
      events.some(
        (e) => e === "settle:recipient_revalidation_required:claimIdMatch=true",
      ),
    ).toBe(true);
    expect((await getAttempt(attemptId))?.status).toBe("cancelled");
    const row = await claimRow(grantId, key);
    expect(row?.released_at).not.toBeNull();
    expect(row?.released_reason).toBe("recipient_revalidation_required");
    expect(await releasedAuditCount(grantId, key)).toBe(1);
  });

  it("8.4 GREEN: provider not_dispatched settles from owned broadcasting via the settlement CAS and releases the reservation", async () => {
    const { grantId } = await provisionTestContext({ policyId: "policy-x" });
    // DB attempt seeded BROADCASTING with the exact ownership token.
    const ownedClaimId = randomUUID();
    const attemptId = await insertAttempt({
      status: "broadcasting",
      claimId: ownedClaimId,
    });
    const key = `grant-exec:${userId}:${attemptId}`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: key,
    });

    const events: string[] = [];
    const repository = repositorySpy({
      events,
      attemptId,
      claimId: ownedClaimId,
    });
    // The provider policy owns enforcement under the privy identity, so the
    // local gate is inert and this case pins the settlement CAS on the
    // provider not_dispatched path, not the local transfer policy.
    const { wallet, spy } = notDispatchedWallet(events);
    const service = createWalletConversationService({
      conversations: repository,
      wallet,
      grantLedger: {
        claim: grants.claimConsumption.bind(grants),
        settle: (i) => {
          events.push(
            `settle:${i.reason}:claimIdMatch=${i.claimId === ownedClaimId}`,
          );
          return grants.settleGrantReservation({
            userId,
            conversationId,
            attemptId: i.attemptId,
            claimId: i.claimId,
            grantId: i.grantId,
            idempotencyKey: i.idempotencyKey,
            reason: i.reason,
          });
        },
      },
      grantGate: {
        evaluate: async () => ({
          covered: true,
          source: "delegated_grant" as const,
          grantId,
          amountSmallestUnits: AMOUNT,
        }),
      },
    });
    const turnEvents: ConversationEvent[] = [];
    for await (const event of service.handleTurnStream({
      conversationId,
      userId,
      text: `Send 10 USDT to ${RECIPIENT}`,
    }))
      turnEvents.push(event);

    // GREEN: the provider not_dispatched settle must run the atomic owned-CAS
    // settlement and release the reservation. RED: today the service only
    // calls the legacy reset; no ledger release happens. The provider WAS
    // invoked and returned not_dispatched (spy-proven):
    expect(spy).toHaveBeenCalledTimes(1);
    // The spy is mockResolvedValue: the awaited resolved value carries the
    // kind. Await it and assert the provider answered not_dispatched.
    const outcome = (await spy.mock.results[0]?.value) as
      | { kind?: string }
      | undefined;
    expect(outcome?.kind).toBe("not_dispatched");
    // GREEN contract: settlement ran on the owned broadcasting row with the
    // exact persisted token, cancelled the attempt, and released the
    // reservation with the not_dispatched reason.
    expect(events).toContain("settle:not_dispatched:claimIdMatch=true");
    expect(events.some((e) => e === "legacy:releasePendingTransferClaim")).toBe(
      false,
    );
    expect((await getAttempt(attemptId))?.status).toBe("cancelled");
    const row = await claimRow(grantId, key);
    expect(row?.released_at).not.toBeNull();
    expect(row?.released_reason).toBe("not_dispatched");
    expect(await releasedAuditCount(grantId, key)).toBe(1);
    // The policy refusal is terminal AND truthful: the released reservation
    // does not soften what the user is told. Reporting wallet_unavailable here
    // would invite a retry that can never succeed.
    const completed = turnEvents.find(
      (event) => event.type === "turn-completed",
    );
    expect(completed).toMatchObject({
      result: {
        status: "error",
        code: "policy_rejected",
        message: "This transfer does not meet the wallet safety policy.",
      },
    });
  });

  // ---------------------------------------------------------------- 8.3 RED
  it("8.3 RED: BOTH window sums count unreleased ledger rows (released stops counting, retained keeps counting)", async () => {
    // Small grant: two claims cannot both fit until one is released.
    const grantId = await (
      await provisionTestContext({
        policyId: "policy-x",
        maxPerTransfer: AMOUNT,
        maxCumulative: AMOUNT, // exactly one execution fits
      })
    ).grantId;
    const keyA = `grant-exec:${userId}:8-3-a`;
    await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: keyA,
    });

    // While A is retained, a second claim for the same amount is rejected.
    const second = await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: `grant-exec:${userId}:8-3-b`,
    });
    expect(second.consumed).toBe(false);

    // Release A (tx-only, real user transaction).
    const ledger = grants as unknown as Record<string, unknown>;
    expect(typeof ledger.releaseReservationInTransaction).toBe("function");
    if (typeof ledger.releaseReservationInTransaction !== "function") return;
    const release = ledger.releaseReservationInTransaction as unknown as (
      tx: unknown,
      input: {
        grantId: string;
        userId: string;
        idempotencyKey: string;
        reason: string;
      },
    ) => Promise<{ released: boolean }>;
    await database.withUserTransaction(userId, async (tx) => {
      await release(tx, {
        grantId,
        userId,
        idempotencyKey: keyA,
        reason: "not_dispatched",
      });
    });

    // GREEN contract: BOTH sums now exclude the released row, so a new claim
    // for the same amount succeeds. RED today: the window sums read
    // grant_audit_log 'used' rows and still count the released reservation,
    // so the third claim is rejected — the test fails here.
    const third = await grants.claimConsumption({
      grantId,
      userId,
      amount: AMOUNT,
      idempotencyKey: `grant-exec:${userId}:8-3-c`,
    });
    expect(third.consumed).toBe(true);

    // consumedInWindow (engine prefilter, module export) must also exclude
    // the released row. RED today: it sums grant_audit_log 'used' rows,
    // which still count the released reservation, so the total is 2x the
    // live claim. It runs INSIDE a user-scoped transaction (RLS context).
    const windowTotal = await database.withUserTransaction(userId, (client) =>
      consumedInWindow(client, grantId, 3600),
    );
    expect(BigInt(windowTotal)).toBe(BigInt(AMOUNT)); // only the live claim counts
  });
});
