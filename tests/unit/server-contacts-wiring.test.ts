import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The HTTP text surface's contact-list seam AS `buildServer` SUPPLIES IT.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * `buildServer` builds the conversation service the HTTP text agent runs on. If
 * it never supplied `contacts`, the tool would answer `unavailable` on every
 * HTTP turn while every hand-built-context test stayed green — the exact
 * declared-but-unwired shape this session keeps fixing. The conversation-service
 * constructor is the capture seam, so the object inspected here is the one
 * production builds inside `buildServer`, not a hand-built dependency object.
 *
 * The captured `contacts` is then CALLED, over the same (fake) database the
 * server wired, so the assertion is about an observable read.
 */

const h = vi.hoisted(() => {
  const dbProbe = { calls: [] as Array<{ userId: string; sql: string }> };
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
    async close() {},
  };
  return {
    dbProbe,
    fakeDatabase,
    capturedServiceDeps: undefined as Record<string, unknown> | undefined,
  };
});

vi.mock("../../src/db/client.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/db/client.js")>();
  return { ...actual, createConfiguredDatabaseClient: () => h.fakeDatabase };
});

vi.mock("../../src/conversations/service.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/conversations/service.js")>();
  return {
    ...actual,
    createWalletConversationService: vi.fn((deps: Record<string, unknown>) => {
      h.capturedServiceDeps = deps;
      return {
        handleTurn: vi.fn(),
        handleTurnStream: async function* () {},
        resolveDecision: async function* () {},
      };
    }),
  };
});

import { DemoIdentityProvider } from "../../src/auth/identity.js";
import { buildServer } from "../../src/server.js";

const TEST_USER_ID = "00000000-0000-4000-8000-000000000001";

type ListPort = { listActive(userId: string): Promise<unknown[]> };

describe("buildServer contact-list wiring", () => {
  const previousDatabaseUrl = process.env.DATABASE_URL;

  afterEach(async () => {
    h.capturedServiceDeps = undefined;
    h.dbProbe.calls.length = 0;
    vi.clearAllMocks();
    if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = previousDatabaseUrl;
  });

  it("hands the conversation service the contacts repository the contacts routes use", async () => {
    process.env.DATABASE_URL = "postgresql://test/contacts-wiring";
    const app = buildServer({ identity: new DemoIdentityProvider(TEST_USER_ID) });
    try {
      const contacts = h.capturedServiceDeps?.contacts as ListPort | undefined;
      expect(contacts).toBeDefined();
      expect(typeof contacts?.listActive).toBe("function");

      await contacts!.listActive(TEST_USER_ID);
      expect(h.dbProbe.calls).toHaveLength(1);
      expect(h.dbProbe.calls[0]!.userId).toBe(TEST_USER_ID);
      expect(h.dbProbe.calls[0]!.sql).toContain("FROM recipients");
    } finally {
      await app.close();
    }
  });
});
