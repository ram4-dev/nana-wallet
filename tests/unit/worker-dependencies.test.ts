import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

import type { DatabaseClient } from "../../src/db/client.js";
import { createWorkerDependencies } from "../../src/runtime/dependencies.js";
import { PrivyServerClient } from "../../src/wallet/privy-server-client.js";
import { createGrantPolicySyncService } from "../../src/wallet/grants/privy-policy-runtime.js";

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

/**
 * Design §0 C4: the worker built its authorization signer and then never handed
 * it to `PrivyServerClient`, so `canSignAuthorizations()` was structurally false
 * in the worker even with a sidecar configured. These cases observe the two
 * outcomes that difference decides, through the real client instance the worker
 * constructs — not through a mocked constructor's argument list.
 */
describe("createWorkerDependencies signed-authorization capability", () => {
  const SIDECAR_ENV = {
    PRIVY_SIGNER_URL: "http://127.0.0.1:8789/sign",
    PRIVY_SIGNER_TOKEN: "worker-dependencies-token-0123456789",
  } satisfies NodeJS.ProcessEnv;
  const SERVER_ENV = {
    PRIVY_APP_ID: "app-id",
    PRIVY_APP_SECRET: "app-secret",
    PRIVY_AUTHORIZATION_KEY_QUORUM_ID: "quorum-id",
  } satisfies NodeJS.ProcessEnv;

  function withEnv(environment: NodeJS.ProcessEnv): void {
    for (const key of [
      ...Object.keys(SERVER_ENV),
      ...Object.keys(SIDECAR_ENV),
    ]) {
      delete process.env[key];
    }
    Object.assign(process.env, environment);
  }

  function captureWorkerClient(): {
    clients: PrivyServerClient[];
    restore(): void;
  } {
    const clients: PrivyServerClient[] = [];
    const original =
      PrivyServerClient.prototype.canSignAuthorizations;
    vi.spyOn(
      PrivyServerClient.prototype,
      "canSignAuthorizations",
    ).mockImplementation(function (this: PrivyServerClient) {
      clients.push(this);
      return original.call(this);
    });
    return { clients, restore: () => vi.restoreAllMocks() };
  }

  afterEach(() => {
    vi.restoreAllMocks();
    withEnv({});
  });

  it("hands the sidecar signer to the worker client, so grant policy sync is not unavailable", () => {
    withEnv({ ...SERVER_ENV, ...SIDECAR_ENV });
    const captured = captureWorkerClient();

    createWorkerDependencies();

    // Positive control first: the client that decided was really built, so the
    // assertions below cannot pass because nothing was observed.
    expect(captured.clients).toHaveLength(1);
    const client = captured.clients[0];
    expect(client.canSignAuthorizations()).toBe(true);
    expect(
      createGrantPolicySyncService({
        database: {} as DatabaseClient,
        privyServer: client,
        quorumId: SERVER_ENV.PRIVY_AUTHORIZATION_KEY_QUORUM_ID,
      }).kind,
    ).toBe("runtime");
  });

  it("stays fail-closed without a sidecar: no signer, and the grant policy write stays unavailable", () => {
    withEnv(SERVER_ENV);
    const captured = captureWorkerClient();

    createWorkerDependencies();

    expect(captured.clients).toHaveLength(1);
    const client = captured.clients[0];
    expect(client.canSignAuthorizations()).toBe(false);
    expect(
      createGrantPolicySyncService({
        database: {} as DatabaseClient,
        privyServer: client,
        quorumId: SERVER_ENV.PRIVY_AUTHORIZATION_KEY_QUORUM_ID,
      }).kind,
    ).toBe("unavailable");
  });
});
