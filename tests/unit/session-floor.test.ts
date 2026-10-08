import { describe, expect, it, vi } from "vitest";
import type { FastifyRequest } from "fastify";
import {
  createSessionFloorIdentity,
  createSessionFloorStore,
  isTokenRevoked,
  type IssuedAtIdentitySource,
  type SessionFloorStore,
} from "../../src/api/auth.js";
import { PrivyIdentityError } from "../../src/auth/privy-identity.js";

const USER_ID = "11111111-1111-4111-8111-111111111111";

function fakeRequest(): FastifyRequest {
  return { headers: {} } as unknown as FastifyRequest;
}

describe("isTokenRevoked (session floor comparison)", () => {
  it("accepts everything when there is no floor", () => {
    expect(isTokenRevoked(new Date("2026-01-01T00:00:00Z"), null)).toBe(false);
  });

  it("rejects a token issued before the floor", () => {
    expect(
      isTokenRevoked(
        new Date("2026-01-01T00:00:00Z"),
        new Date("2026-01-01T00:00:01Z"),
      ),
    ).toBe(true);
  });

  it("accepts a token issued after the floor (fresh login)", () => {
    expect(
      isTokenRevoked(
        new Date("2026-01-01T00:00:02Z"),
        new Date("2026-01-01T00:00:01Z"),
      ),
    ).toBe(false);
  });

  it("accepts a token issued exactly at the floor (not earlier)", () => {
    const at = new Date("2026-01-01T00:00:01Z");
    expect(isTokenRevoked(new Date(at), new Date(at))).toBe(false);
  });

  it("fails closed when a floor exists but the token carries no iat", () => {
    expect(isTokenRevoked(undefined, new Date("2026-01-01T00:00:01Z"))).toBe(
      true,
    );
  });
});

describe("session-floor enforcement wiring", () => {
  const FLOOR = new Date("2026-01-01T00:00:05Z");

  function source(issuedAt: Date | undefined): IssuedAtIdentitySource {
    return { resolve: vi.fn(async () => ({ userId: USER_ID, issuedAt })) };
  }

  function floors(value: Date | null): SessionFloorStore {
    return {
      readFloorAt: vi.fn(async () => value),
      markLoggedOut: vi.fn(async () => value ?? new Date()),
    };
  }

  it("rejects a token issued before the floor with the provider's unauthenticated error", async () => {
    const identity = createSessionFloorIdentity(
      source(new Date("2026-01-01T00:00:00Z")),
      floors(FLOOR),
    );
    try {
      await identity.resolve(fakeRequest());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PrivyIdentityError);
      expect((error as PrivyIdentityError).code).toBe("unauthenticated");
    }
  });

  it("accepts a token issued after the floor", async () => {
    const identity = createSessionFloorIdentity(
      source(new Date("2026-01-01T00:00:30Z")),
      floors(FLOOR),
    );
    await expect(identity.resolve(fakeRequest())).resolves.toEqual({
      userId: USER_ID,
    });
  });

  it("accepts any token when no floor is set", async () => {
    const identity = createSessionFloorIdentity(
      source(new Date("2020-01-01T00:00:00Z")),
      floors(null),
    );
    await expect(identity.resolve(fakeRequest())).resolves.toEqual({
      userId: USER_ID,
    });
  });

  it("reads the caller's floor (not a global value) before deciding", async () => {
    const store = floors(null);
    const identity = createSessionFloorIdentity(source(FLOOR), store);
    await identity.resolve(fakeRequest());
    expect(store.readFloorAt).toHaveBeenCalledWith(USER_ID);
  });
});

describe("createSessionFloorStore (Postgres)", () => {
  it("reads the caller's floor through the owner transaction", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _values?: unknown[]) => ({
        rows: [{ session_floor_at: new Date("2026-01-01T00:00:05Z") }],
      })),
    };
    const database = {
      withUserTransaction: vi.fn(
        async (_userId: string, operation: (client: never) => Promise<unknown>) =>
          operation(client as never),
      ),
    };
    const store = createSessionFloorStore(database as never);

    const value = await store.readFloorAt(USER_ID);

    expect(database.withUserTransaction).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Function),
    );
    expect(String(client.query.mock.calls[0]?.[0])).toContain(
      "session_floor_at",
    );
    expect(String(client.query.mock.calls[0]?.[0])).toMatch(
      /WHERE id = \$1/,
    );
    expect(client.query.mock.calls[0]?.[1]).toEqual([USER_ID]);
    expect(value?.toISOString()).toBe("2026-01-01T00:00:05.000Z");
  });

  it("returns null when the floor column is NULL", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _values?: unknown[]) => ({
        rows: [{ session_floor_at: null }],
      })),
    };
    const database = {
      withUserTransaction: vi.fn(
        async (_userId: string, operation: (client: never) => Promise<unknown>) =>
          operation(client as never),
      ),
    };
    const store = createSessionFloorStore(database as never);
    await expect(store.readFloorAt(USER_ID)).resolves.toBeNull();
  });

  it("sets the floor to now() scoped to the caller's own row", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _values?: unknown[]) => ({
        rows: [{ session_floor_at: new Date("2026-01-01T00:00:06Z") }],
      })),
    };
    const database = {
      withUserTransaction: vi.fn(
        async (_userId: string, operation: (client: never) => Promise<unknown>) =>
          operation(client as never),
      ),
    };
    const store = createSessionFloorStore(database as never);

    const value = await store.markLoggedOut(USER_ID);

    expect(database.withUserTransaction).toHaveBeenCalledWith(
      USER_ID,
      expect.any(Function),
    );
    const sql = String(client.query.mock.calls[0]?.[0]);
    expect(sql).toMatch(/UPDATE\s+users\s+SET\s+session_floor_at\s*=\s*now\(\)/i);
    expect(sql).toMatch(/WHERE id = \$1/);
    expect(client.query.mock.calls[0]?.[1]).toEqual([USER_ID]);
    expect(value.toISOString()).toBe("2026-01-01T00:00:06.000Z");
  });

  it("fails loudly when the caller's users row is missing", async () => {
    const client = {
      query: vi.fn(async (_sql: string, _values?: unknown[]) => ({ rows: [] })),
    };
    const database = {
      withUserTransaction: vi.fn(
        async (_userId: string, operation: (client: never) => Promise<unknown>) =>
          operation(client as never),
      ),
    };
    const store = createSessionFloorStore(database as never);
    await expect(store.markLoggedOut(USER_ID)).rejects.toThrow();
  });
});
