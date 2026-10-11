import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The worker's contact-list seam AS `createWorkerDependencies` BUILDS IT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * This session already fixed three production defects of exactly one shape: a
 * seam declared optional, with a fail-closed branch, that production never
 * supplied — invisible because every OTHER suite injected it (`resolveAlias` in
 * the voice worker, `supersedeUnpublished`, the text agent's `contactActions`).
 * `list_contacts` is the fourth candidate: if `createWorkerDependencies` never
 * puts `contacts` on `WorkerDependencies`, the voice tools and the voice
 * transcript path both answer `unavailable` forever and every hand-built-context
 * test stays green.
 *
 * HOW IT IS ASSERTED
 * ------------------
 * Over the REAL `createWorkerDependencies`: the conversation service constructor
 * is the capture seam, so the object this suite inspects is the one production
 * builds — not a hand-built dependency object. The captured `contacts` is then
 * CALLED, over the same (fake) database the factory wired, so the assertion is
 * about an observable read rather than the presence of a key.
 */

const h = vi.hoisted(() => {
  const fakeUserRuntime = {
    userId: "resolved-user",
    service: { id: "memory-service" },
  };
  const dbProbe = {
    calls: [] as Array<{ userId: string; sql: string }>,
  };
  const fakeDatabase = {
    async withUserTransaction(
      userId: string,
      run: (client: { query: (sql: string) => Promise<{ rows: unknown[] }> }) => Promise<unknown>,
    ) {
      return run({
        query: async (sql: string) => {
          dbProbe.calls.push({ userId, sql });
          return { rows: [] };
        },
      });
    },
  };
  return {
    fakeUserRuntime,
    fakeDatabase,
    dbProbe,
    capturedServiceDeps: undefined as Record<string, unknown> | undefined,
  };
});

vi.mock("../../src/conversations/service.js", () => ({
  createWalletConversationService: vi.fn((deps: Record<string, unknown>) => {
    h.capturedServiceDeps = deps;
    return {
      handleTurn: vi.fn(),
      handleTurnStream: async function* () {},
      resolveDecision: async function* () {},
    };
  }),
}));

vi.mock("../../src/memory/runtime.js", () => ({
  getMemoryRuntimeForUser: vi.fn(() => h.fakeUserRuntime),
}));

vi.mock("../../src/db/client.js", () => ({
  createConfiguredDatabaseClient: vi.fn(() => h.fakeDatabase),
}));

vi.mock("../../src/conversations/postgres-repository.js", () => ({
  PostgresConversationRepository: class {
    constructor(_database: unknown) {}
  },
}));

vi.mock("../../src/wallet/fixture-provider.js", () => ({
  FixtureWalletProvider: class {
    async close() {}
  },
}));

vi.mock("../../src/wallet/wdk-provider.js", () => ({
  WdkWalletProvider: class {
    async close() {}
  },
}));

vi.mock("../../src/agent/wdk-tools.js", () => ({
  getWdkTools: vi.fn(async () => ({})),
  closeWdkClient: vi.fn(async () => undefined),
  callWdkTool: vi.fn(async () => undefined),
}));

import { createWorkerDependencies } from "../../src/runtime/dependencies.js";

type ListPort = { listActive(userId: string): Promise<unknown[]> };

describe("createWorkerDependencies contact-list wiring", () => {
  beforeEach(() => {
    h.capturedServiceDeps = undefined;
    h.dbProbe.calls.length = 0;
    vi.clearAllMocks();
    delete process.env.CONVERSATION_MAX_INPUT_TOKENS;
    delete process.env.RECIPIENT_MEMORY_ENABLED;
    delete process.env.DATABASE_URL;
    delete process.env.RECIPIENT_POLICY_RECONCILER;
  });

  it("hands the conversation service a contact read that reads through the worker database", async () => {
    createWorkerDependencies();

    const contacts = h.capturedServiceDeps?.contacts as ListPort | undefined;
    // The port the voice transcript path enumerates through.
    expect(contacts).toBeDefined();
    expect(typeof contacts?.listActive).toBe("function");

    await contacts!.listActive("worker-user");
    expect(h.dbProbe.calls).toHaveLength(1);
    expect(h.dbProbe.calls[0]!.userId).toBe("worker-user");
    // It is the recipients projection, ordered for a stable human list.
    expect(h.dbProbe.calls[0]!.sql).toContain("FROM recipients");
    expect(h.dbProbe.calls[0]!.sql).toContain("status = 'active'");
  });

  it("exposes that same contact read on WorkerDependencies for the realtime tools", async () => {
    const dependencies = createWorkerDependencies();

    // Positive control: the conversation service got one, so a missing field
    // below is a wiring gap and not a factory that never ran.
    expect(h.capturedServiceDeps?.contacts).toBeDefined();
    expect(dependencies.contacts).toBe(h.capturedServiceDeps?.contacts);
    expect(typeof (dependencies.contacts as ListPort).listActive).toBe("function");
  });
});
