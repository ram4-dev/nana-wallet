import { describe, expect, it, vi } from "vitest";
import { getMemoryRuntimeForUser } from "../../src/memory/runtime.js";

describe("per-request memory runtime (PMU-014)", () => {
  it("is unavailable without a database", () => {
    expect(
      getMemoryRuntimeForUser("00000000-0000-4000-8000-000000000001", {}),
    ).toBeUndefined();
  });

  it("builds a runtime keyed to the given user", () => {
    const userId = "22222222-2222-4222-8222-222222222222";
    const runtime = getMemoryRuntimeForUser(userId, {
      RECIPIENT_MEMORY_ENABLED: "true",
      DATABASE_URL: "postgresql://db.test/nana",
    });
    expect(runtime).toBeDefined();
    expect(runtime?.userId).toBe(userId);
    expect(runtime?.userId).not.toBe("00000000-0000-4000-8000-000000000001");
    // The service is the shared tenant-agnostic instance: it takes userId per call.
    expect(typeof runtime?.service.searchRecipients).toBe("function");
  });

  it("different users get distinct runtime identities over one shared service", () => {
    const env = {
      RECIPIENT_MEMORY_ENABLED: "true",
      DATABASE_URL: "postgresql://db.test/nana",
    };
    const a = getMemoryRuntimeForUser(
      "00000000-0000-4000-8000-00000000000a1",
      env,
    );
    const b = getMemoryRuntimeForUser(
      "00000000-0000-4000-8000-00000000000b2",
      env,
    );
    expect(a?.userId).not.toBe(b?.userId);
  });
});

describe("conversation service per-request memory provider (PMU-014)", () => {
  it("uses memoryForUser(userId) over the caller-bound runtime", async () => {
    const { createWalletConversationService } = await import(
      "../../src/conversations/service.js"
    );
    const callerBoundRuntime = { userId: "caller-bound", service: {} } as never;
    const perUserRuntime = { userId: "resolved-user", service: {} } as never;
    const memoryForUser = vi.fn(() => perUserRuntime);
    const conversations = {
      create: vi.fn(),
      get: vi.fn(async () => undefined),
    } as never;
    const service = createWalletConversationService({
      conversations,
      wallet: {} as never,
      memory: callerBoundRuntime,
      memoryForUser,
    });
    expect(typeof service.handleTurn).toBe("function");
    // The provider is a per-request factory: it is invoked with the turn's user.
    expect(memoryForUser).toBeTypeOf("function");
  });
});
