/**
 * The voice contact-list seam AS THE WORKER BUILDS IT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `list_contacts` is produced by the ONE shared definition, so both surfaces get
 * the tool. If the worker only received it but never forwarded the port, the
 * voice agent would own a tool that always answers `unavailable` — the same
 * declared-but-unwired shape as `resolveAlias`, `supersedeUnpublished` and the
 * text agent's `contactActions`. A hand-built dependency object proves the
 * CONSUMER works and proves nothing about production, so this suite drives the
 * real worker entry: `agent.entry` builds the real `createWorkerDependencies`
 * (its heavy primitives are mockable), the gate hands back the real per-binding
 * `startSession` the worker registered, that function runs, and the dependency
 * object PRODUCTION passes to `createRealtimeTools` is captured at the seam.
 *
 * WHAT IS FAKE, AND WHY THAT IS NOT THE POINT UNDER TEST: the database client,
 * the transport, the job context and the room/gate plumbing. The construction
 * inside `runJob` — including which dependencies it forwards — is the real code.
 */
import { describe, expect, it, vi } from "vitest";

const fixtures = vi.hoisted(() => ({
  SENTINEL: "voice-realtime-dependencies-captured",
  dbProbe: { calls: [] as Array<{ userId: string; sql: string }> },
}));

const fakeDatabase = vi.hoisted(() => ({
  async withUserTransaction(
    userId: string,
    run: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
  ) {
    return run({
      query: async (sql: string) => {
        fixtures.dbProbe.calls.push({ userId, sql });
        return { rows: [] };
      },
    });
  },
  async close() {},
}));

const probes = vi.hoisted(() => ({
  startSessions: [] as Array<
    (binding: { conversationId: string; userId: string }) => Promise<void>
  >,
  realtimeDependencies: [] as Array<Record<string, unknown>>,
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

vi.mock("../../../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/db/client.js")>();
  return { ...actual, createConfiguredDatabaseClient: () => fakeDatabase };
});

vi.mock("../../../src/conversations/postgres-repository.js", () => ({
  PostgresConversationRepository: class {
    constructor(_database: unknown) {}
  },
}));

vi.mock("../../../src/memory/runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/memory/runtime.js")>();
  return {
    ...actual,
    getConfiguredRecipientMemoryService: () => undefined,
    getMemoryRuntimeForUser: () => undefined,
  };
});

vi.mock("../../../src/wallet/fixture-provider.js", () => ({
  FixtureWalletProvider: class {
    async close() {}
  },
}));

vi.mock("../../../src/wallet/wdk-provider.js", () => ({
  WdkWalletProvider: class {
    async close() {}
  },
}));

vi.mock("../../../src/agent/wdk-tools.js", () => ({
  getWdkTools: vi.fn(async () => ({})),
  closeWdkClient: vi.fn(async () => undefined),
  callWdkTool: vi.fn(async () => undefined),
}));

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
    createSnsTransport: () => ({
      deriveNameAccount: () => ({ pubkey: "ignored" }),
      readNameRegistry: async () => null,
      readPrimaryDomain: async () => ({ kind: "none" as const }),
    }),
  };
});

vi.mock("../../../src/livekit/realtime-tools/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/livekit/realtime-tools/index.js")>();
  return {
    ...actual,
    createRealtimeTools: (dependencies: Record<string, unknown>) => {
      probes.realtimeDependencies.push(dependencies);
      // Abort the rest of the session start the moment the seam is built: the
      // remainder (agent session) needs a live provider and is irrelevant here.
      // Throwing AFTER the capture keeps the captured object the real one.
      throw new Error(fixtures.SENTINEL);
    },
  };
});

import agent from "../../../src/livekit/worker.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const CONVERSATION_ID = "22222222-2222-4222-8222-222222222222";
const IDENTITY = "participant-1";

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

/** Runs the worker entry and returns the object PRODUCTION passed to `createRealtimeTools`. */
async function captureProductionDependencies(): Promise<Record<string, unknown>> {
  const entry = agent.entry(fakeJobContext() as never);
  void entry;

  await vi.waitFor(() => expect(probes.startSessions.length).toBeGreaterThan(0));
  const startSession = probes.startSessions[probes.startSessions.length - 1]!;

  const before = probes.realtimeDependencies.length;
  await expect(
    startSession({ conversationId: CONVERSATION_ID, userId: USER_ID }),
  ).rejects.toThrow(fixtures.SENTINEL);
  await vi.waitFor(() => expect(probes.realtimeDependencies.length).toBe(before + 1));

  return probes.realtimeDependencies[probes.realtimeDependencies.length - 1]!;
}

describe("the voice contact-list seam as the worker builds it", () => {
  it("forwards a working contact read into the realtime tools, over the worker database", async () => {
    fixtures.dbProbe.calls.length = 0;
    const dependencies = await captureProductionDependencies();

    // Positive control: the seam ran for this session, so a missing `contacts`
    // below is a wiring gap and not a path that never executed.
    expect(typeof dependencies.contactActions).toBe("object");
    const contacts = dependencies.contacts as
      | { listActive(userId: string): Promise<unknown[]> }
      | undefined;
    expect(contacts).toBeDefined();
    expect(typeof contacts?.listActive).toBe("function");

    await contacts!.listActive(USER_ID);
    expect(fixtures.dbProbe.calls).toHaveLength(1);
    expect(fixtures.dbProbe.calls[0]!.userId).toBe(USER_ID);
    expect(fixtures.dbProbe.calls[0]!.sql).toContain("FROM recipients");
  });
});
