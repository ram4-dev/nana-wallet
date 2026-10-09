import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const fakeUserRuntime = {
    userId: "resolved-user",
    service: { id: "memory-service" },
  };
  return {
    fakeUserRuntime,
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
  // Memory is always scoped to the resolved user: the fixed-tenant runtime the
  // demo mode needed is gone, so the worker wires the per-user resolver.
  getMemoryRuntimeForUser: vi.fn(() => h.fakeUserRuntime),
}));

vi.mock("../../src/db/client.js", () => ({
  createConfiguredDatabaseClient: vi.fn(() => ({})),
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

describe("createWorkerDependencies memory wiring", () => {
  beforeEach(() => {
    h.capturedServiceDeps = undefined;
    vi.clearAllMocks();
    delete process.env.CONVERSATION_MAX_INPUT_TOKENS;
    delete process.env.RECIPIENT_MEMORY_ENABLED;
    delete process.env.DATABASE_URL;
  });

  it("wires a defined memory service into the wallet conversation service", () => {
    const dependencies = createWorkerDependencies();

    expect(dependencies.conversationService).toBeDefined();
    const serviceDeps = h.capturedServiceDeps;
    expect(serviceDeps).toBeDefined();
    const memoryForUser = serviceDeps?.memoryForUser as
      | ((userId: string) => unknown)
      | undefined;
    expect(memoryForUser).toBeDefined();
    expect(memoryForUser?.("resolved-user")).toBe(h.fakeUserRuntime);
    expect(
      (memoryForUser?.("resolved-user") as { service?: { id: string } })?.service,
    ).toBeDefined();
  });
});
