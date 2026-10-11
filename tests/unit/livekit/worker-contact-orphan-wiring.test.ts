/**
 * The unpublished-orphan cleanup AS PRODUCTION BUILDS THE VOICE SEAM.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `createVoiceContactActions` supersedes a conversation's unpublished orphan
 * before staging the retry, so a failed card delivery does not leave the user
 * unable to fix a torn card. The cleanup is an OPTIONAL dependency of the seam
 * (`VoiceContactActionDependencies.supersedeUnpublished`) that every other suite
 * INJECTS by hand (`tests/integration/contact-action-address.test.ts`,
 * `tests/integration/livekit-trusted-recipient.e2e.test.ts`), while the worker —
 * the only production caller, and the one the seam's own comment describes as
 * owning the cleanup — never supplied it. A seam whose every test injects the
 * dependency can be missing from production forever without a single test
 * noticing; this file is the same correction
 * `worker-contact-alias-wiring.test.ts` applies to the stage-time alias arm.
 *
 * HOW IT IS ASSERTED
 * ------------------
 * Over the real construction path and a real database. The worker entry is driven
 * with a fake job context, the room gate hands back the REAL per-binding
 * `startSession` the worker registered, that function runs, and the dependency
 * object PRODUCTION passes to `createVoiceContactActions` is captured at the seam.
 * Every assertion then runs against that captured object:
 *
 *  - the captured `supersedeUnpublished` is CALLED over an orphan row this suite
 *    seeded, so the assertion is about an observable row transition rather than
 *    about the presence of a key;
 *  - the retry is driven through a port built by the REAL
 *    `createVoiceContactActions` over those same dependencies, so the failing
 *    second attempt would be production's, not a hand-built port's.
 *
 * WHAT IS FAKE, AND WHY THAT IS NOT THE POINT UNDER TEST: the job context, the
 * room/gate plumbing, the SNS transport (no RPC), the recipient-memory runtime and
 * the delivery transport (the fake agent participant's `publishData`, which this
 * suite fails on purpose). `runJob`'s construction of the seam, the
 * `ContactActionService` it delegates to, and the Postgres partial unique index
 * that makes the retry collide are all real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { createDatabaseClient, type DatabaseClient } from "../../../src/db/client.js";
import { ContactActionService } from "../../../src/wallet/policy/contact-actions.js";
import { ContactActionProposalConflictError } from "../../../src/wallet/policy/repository.js";
import agent from "../../../src/livekit/worker.js";

const fixtures = vi.hoisted(() => ({
  /** Thrown by the seam capture below, once the dependency object is recorded. */
  SENTINEL: "voice-contact-dependencies-captured",
}));

/** The test database the worker's real dependencies are bound to. */
const runtime = vi.hoisted(() => ({ database: undefined as unknown }));

const probes = vi.hoisted(() => ({
  startSessions: [] as Array<
    (binding: { conversationId: string; userId: string }) => Promise<void>
  >,
  voiceContactDependencies: [] as Array<Record<string, unknown>>,
}));

vi.mock("../../../src/config/process.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/config/process.js")>();
  return {
    ...actual,
    readWorkerProcessConfig: () => ({
      url: "ws://livekit.invalid",
      apiKey: "test-key",
      apiSecret: "test-secret",
      publicKey: "test-public-key",
      shutdownTimeoutMs: 10,
      agentRuntime: "native-livekit" as const,
      databaseUrl: "postgres://unused",
    }),
  };
});

vi.mock("../../../src/runtime/dependencies.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/runtime/dependencies.js")>();
  return {
    ...actual,
    // The seam is captured before any other dependency is used for I/O; the
    // database is the only one the construction path under test reaches.
    createWorkerDependencies: () =>
      ({
        database: runtime.database,
        close: async () => {},
      }) as never,
  };
});

vi.mock("../../../src/memory/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/memory/runtime.js")>();
  // Orthogonal to the orphan wiring, and it would otherwise reach the ambient
  // `.env` of a developer checkout.
  return { ...actual, getConfiguredRecipientMemoryService: () => undefined };
});

vi.mock("../../../src/livekit/room-conversation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/livekit/room-conversation.js")>();
  return {
    ...actual,
    // The gate's only job here is to hand back the `startSession` the worker
    // registered, so the real construction inside it can be driven directly.
    createRoomConversationGate: (input: {
      startSession: (binding: { conversationId: string; userId: string }) => Promise<void>;
    }) => {
      probes.startSessions.push(input.startSession);
      return {
        bind: async () => ({ ok: false as const, code: "invalid_binding" as const }),
        handleFinalTranscript: async function* () {
          yield { ok: false as const, code: "not_bound" as const };
        },
      };
    },
  };
});

vi.mock("../../../src/wallet/sns/transport.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/wallet/sns/transport.js")>();
  return {
    ...actual,
    // No RPC endpoint: the alias arms are absent for this session, which is what
    // the orphan path is independent of.
    createSnsTransport: () => {
      throw new Error("no rpc endpoint configured");
    },
  };
});

vi.mock("../../../src/livekit/contact-proposal-publication.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/livekit/contact-proposal-publication.js")>();
  return {
    ...actual,
    createVoiceContactActions: (dependencies: Record<string, unknown>) => {
      probes.voiceContactDependencies.push(dependencies);
      // Abort the rest of the session start the moment the seam is built: the
      // remainder (realtime tools, agent session) needs a live provider and is
      // irrelevant here. Throwing AFTER the capture is what keeps the captured
      // object the one the real call site built.
      throw new Error(fixtures.SENTINEL);
    },
  };
});

const IDENTITY = "participant-1";

type ProposalRow = {
  id: string;
  version: number;
  status: string;
  supersedes_id: string | null;
  published_at: Date | null;
};

type CapturedSeam = {
  /** The dependency object PRODUCTION passed to `createVoiceContactActions`. */
  dependencies: Record<string, unknown>;
  /** The fake delivery transport behind production's `publish` dependency. */
  publishData: ReturnType<typeof vi.fn>;
};

function fakeJobContext() {
  const rpcMethods = new Map<string, unknown>();
  return {
    connect: vi.fn(async () => {}),
    waitForParticipant: vi.fn(async () => ({ identity: IDENTITY })),
    room: { remoteParticipants: new Map([[IDENTITY, {}]]) },
    agent: {
      publishData: vi.fn(async () => {}),
      registerRpcMethod: vi.fn((name: string, handler: unknown) => {
        rpcMethods.set(name, handler);
      }),
      unregisterRpcMethod: vi.fn((name: string) => {
        rpcMethods.delete(name);
      }),
    },
    workerId: "worker-1",
    addShutdownCallback: vi.fn(),
    shutdown: vi.fn(),
  };
}

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("the unpublished-orphan cleanup as production builds the voice seam", () => {
  let database: DatabaseClient;
  const userIds: string[] = [];

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    runtime.database = database;
  });

  afterAll(async () => {
    if (userIds.length > 0) {
      await database.query(
        "DELETE FROM contact_action_proposals WHERE user_id = ANY($1::uuid[])",
        [userIds],
      );
      await database.query("DELETE FROM users WHERE id = ANY($1::uuid[])", [userIds]);
    }
    await database.close();
  });

  /** A disposable owner. The shared demo user is never mutated by this suite. */
  async function provisionUser(): Promise<string> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) ON CONFLICT (privy_did) DO UPDATE SET last_seen_at = now()
       RETURNING id`,
      [`did:privy:cow-${randomUUID()}`, "Contact Orphan Wiring Test"],
    );
    const userId = user.rows[0]!.id;
    userIds.push(userId);
    return userId;
  }

  async function rows(userId: string, conversationId: string): Promise<ProposalRow[]> {
    const result = await database.query<ProposalRow>(
      `SELECT id, version, status, supersedes_id, published_at
         FROM contact_action_proposals
        WHERE user_id = $1 AND conversation_id = $2
        ORDER BY version ASC, created_at ASC, id ASC`,
      [userId, conversationId],
    );
    return result.rows;
  }

  /**
   * Runs the worker entry and returns the seam PRODUCTION built for one session,
   * bound to the real test database.
   */
  async function captureProductionSeam(input: {
    userId: string;
    conversationId: string;
  }): Promise<CapturedSeam> {
    const ctx = fakeJobContext();
    // Every earlier case leaves its own `entry` parked on the binding promise, so
    // this session is identified by the gate registration it ADDS — never by
    // "there is at least one", which would hand back an earlier session's
    // `startSession` (and therefore an earlier session's dependencies and
    // delivery transport).
    const sessionsBefore = probes.startSessions.length;
    // `entry` parks on the binding promise (the gate resolves it when a
    // participant binds), so it is deliberately never awaited to completion.
    const entry = agent.entry(ctx as never);
    void entry;

    await vi.waitFor(() => expect(probes.startSessions.length).toBe(sessionsBefore + 1));
    const startSession = probes.startSessions[probes.startSessions.length - 1]!;

    const before = probes.voiceContactDependencies.length;
    await expect(startSession(input)).rejects.toThrow(fixtures.SENTINEL);
    await vi.waitFor(() => expect(probes.voiceContactDependencies.length).toBe(before + 1));

    return {
      dependencies: probes.voiceContactDependencies[probes.voiceContactDependencies.length - 1]!,
      publishData: ctx.agent.publishData,
    };
  }

  /** The real seam implementation, bypassing this file's capture mock. */
  async function realCreateVoiceContactActions() {
    const actual = await vi.importActual<
      typeof import("../../../src/livekit/contact-proposal-publication.js")
    >("../../../src/livekit/contact-proposal-publication.js");
    return actual.createVoiceContactActions;
  }

  type Supersede = (input: { userId: string; conversationId: string }) => Promise<number>;

  it("passes the unpublished-orphan cleanup the port declares", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const seam = await captureProductionSeam({ userId, conversationId });

    // Positive control first: this session HAS a bound visual client, which is the
    // precondition for the seam to be built at all, so a missing cleanup below is
    // a wiring gap and not a block that never executed.
    expect(seam.dependencies.boundParticipantIdentity).toBe(IDENTITY);
    expect(typeof seam.dependencies.consume).toBe("function");

    expect(typeof seam.dependencies.supersedeUnpublished).toBe("function");

    // Behavioural, not key presence: the captured cleanup is CALLED over a real
    // orphan row and the row transitions.
    const seeder = new ContactActionService(database);
    const orphan = await seeder.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect((await rows(userId, conversationId)).map((row) => [row.version, row.status, row.published_at])).toEqual([
      [1, "open", null],
    ]);

    const superseded = await (seam.dependencies.supersedeUnpublished as Supersede)({
      userId,
      conversationId,
    });
    expect(superseded).toBe(1);
    const after = await rows(userId, conversationId);
    expect(after.map((row) => [row.version, row.status])).toEqual([[1, "superseded"]]);
    // The orphan is the row the retry could not get past.
    expect(after[0]!.id).toBe(orphan.proposalId);
  });

  it("stages the retry after a failed delivery instead of colliding with the one-open index", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const seam = await captureProductionSeam({ userId, conversationId });
    const createVoiceContactActions = await realCreateVoiceContactActions();

    // The port PRODUCTION's dependencies build: real service over the real
    // database, production's own `publish` (the fake agent participant) and the
    // production arbiter. Nothing here is hand-injected.
    const port = createVoiceContactActions(seam.dependencies as never);

    // First attempt: the card delivery rejects (participant gone). The row is
    // deliberately left behind and the window never opens.
    seam.publishData.mockRejectedValueOnce(new Error("participant gone"));
    const failed = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(failed).toEqual({
      status: "proposal_not_published",
      message: expect.any(String),
    });

    const orphan = await rows(userId, conversationId);
    expect(orphan.map((row) => [row.version, row.status, row.published_at])).toEqual([
      [1, "open", null],
    ]);

    // Why the orphan matters: on its own it trips the one-open-per-conversation
    // partial unique index, which has no expiry predicate, so nothing but a
    // supersede (or the row's own consumption) can free the conversation.
    await expect(
      new ContactActionService(database).stage({
        userId,
        conversationId,
        origin: "voice",
        action: "create",
        name: "Sofía",
      }),
    ).rejects.toBeInstanceOf(ContactActionProposalConflictError);

    // The retry: the orphan is superseded and a FRESH proposal is staged and
    // delivered. Without the wiring this is the exact call that threw
    // `ContactActionProposalConflictError` out of the seam.
    const staged = await port.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(staged.status).toBe("staged");
    expect(seam.publishData).toHaveBeenCalledTimes(2);

    const after = await rows(userId, conversationId);
    expect(after.map((row) => [row.version, row.status, row.published_at !== null])).toEqual([
      [1, "superseded", false],
      [1, "open", true],
    ]);
    // A row that was never published was never reviewed, so the retry is a fresh
    // proposal rather than a chained version of the orphan.
    expect(after[1]!.id).not.toBe(after[0]!.id);
    expect(after[1]!.supersedes_id).toBeNull();
  });

  it("never supersedes a row whose card was delivered", async () => {
    const userId = await provisionUser();
    const conversationId = randomUUID();
    const seam = await captureProductionSeam({ userId, conversationId });
    const seeder = new ContactActionService(database);

    // A published open row IS a live window, so the cleanup must leave it alone:
    // `published_at IS NULL` is the load-bearing half of the predicate.
    const live = await seeder.stage({
      userId,
      conversationId,
      origin: "voice",
      action: "create",
      name: "Sofía",
    });
    expect(await seeder.markPublished(userId, live.proposalId, live.proposalVersion)).not.toBeNull();

    const superseded = await (seam.dependencies.supersedeUnpublished as Supersede)({
      userId,
      conversationId,
    });
    expect(superseded).toBe(0);
    const after = await rows(userId, conversationId);
    expect(after.map((row) => [row.version, row.status, row.published_at !== null])).toEqual([
      [1, "open", true],
    ]);
  });
});
