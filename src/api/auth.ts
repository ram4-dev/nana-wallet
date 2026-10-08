import type { FastifyInstance, FastifyRequest } from "fastify";
import type { DatabaseClient, Queryable } from "../db/client.js";
import type { RequestIdentityProvider } from "../auth/identity.js";
import { PrivyIdentityError } from "../auth/privy-identity.js";

/**
 * Server-side session invalidation (session floor).
 *
 * Privy access tokens are verified OFFLINE (signature, issuer, audience, exp),
 * so a client-side logout alone leaves a still-valid token accepted until its
 * `exp`. This module owns the durable, per-user floor that closes that gap:
 * `users.session_floor_at` (one column, no new table). Logout sets it to
 * `now()`, and every authenticated request rejects a token whose `iat` is
 * earlier than the floor. A token issued after the floor (a fresh login) passes.
 *
 * The floor is intentionally user-wide: logging out revokes every session of
 * the same user, which is the desired behaviour for a personal wallet. It is
 * durable so a process restart can never silently un-revoke tokens.
 *
 * Wiring note: rather than give `PrivyIdentityProvider` direct database access,
 * enforcement is a decorator (`createSessionFloorIdentity`) over the provider.
 * The provider keeps its single responsibility (offline verification, now also
 * surfacing `issuedAt`); this module decides whether the verified identity is
 * still live.
 */

/** Verified identity plus the access token's issue time (undefined when absent). */
export type IssuedAtIdentitySource = {
  resolve(
    request: FastifyRequest,
  ): Promise<{ userId: string; issuedAt: Date | undefined }>;
};

/** Durable per-user revocation floor. `null` means no session was ever revoked. */
export type SessionFloorStore = {
  readFloorAt(userId: string): Promise<Date | null>;
  /** Sets the floor to now() for the caller's own row and returns the new value. */
  markLoggedOut(userId: string): Promise<Date>;
};

/**
 * True when the token must be rejected: a floor exists and the token was issued
 * before it. A token with no `iat` fails closed once a floor exists (we cannot
 * prove it was issued after the revocation instant).
 */
export function isTokenRevoked(
  issuedAt: Date | undefined,
  floorAt: Date | null,
): boolean {
  if (!floorAt) return false;
  if (!issuedAt) return true;
  return issuedAt.getTime() < floorAt.getTime();
}

/**
 * Postgres-backed floor store. Every read and write runs inside the resolved
 * owner's transaction (`app.user_id`), so the `users` RLS policy restricts both
 * to the caller's own row — a caller can never read or affect another user.
 */
export function createSessionFloorStore(
  database: DatabaseClient,
): SessionFloorStore {
  return {
    async readFloorAt(userId: string): Promise<Date | null> {
      const result = await database.withUserTransaction(
        userId,
        (client: Queryable) =>
          client.query<{ session_floor_at: Date | null }>(
            "SELECT session_floor_at FROM users WHERE id = $1::uuid",
            [userId],
          ),
      );
      return result.rows[0]?.session_floor_at ?? null;
    },
    async markLoggedOut(userId: string): Promise<Date> {
      const result = await database.withUserTransaction(
        userId,
        (client: Queryable) =>
          client.query<{ session_floor_at: Date }>(
            "UPDATE users SET session_floor_at = now() WHERE id = $1::uuid RETURNING session_floor_at",
            [userId],
          ),
      );
      const row = result.rows[0];
      if (!row) throw new Error("logout: the caller's users row was not found");
      return row.session_floor_at;
    },
  };
}

/**
 * Wraps a verified-identity source with the session floor. Any token issued
 * before the caller's floor is rejected with the same unauthenticated error the
 * provider throws, so the API error shape is unchanged.
 */
export function createSessionFloorIdentity(
  source: IssuedAtIdentitySource,
  floors: SessionFloorStore,
): RequestIdentityProvider {
  return {
    async resolve(request: FastifyRequest): Promise<{ userId: string }> {
      const { userId, issuedAt } = await source.resolve(request);
      const floorAt = await floors.readFloorAt(userId);
      if (isTokenRevoked(issuedAt, floorAt)) {
        throw new PrivyIdentityError(
          "unauthenticated",
          "Session has been revoked.",
        );
      }
      return { userId };
    },
  };
}

export type AuthRouteDependencies = {
  resolveUserId(request: FastifyRequest): Promise<string>;
  floors: SessionFloorStore;
};

/**
 * POST /v1/auth/logout (authenticated): revokes every access token of the
 * caller issued before now by raising the caller's session floor. Idempotent —
 * raising an already-raised floor is a no-op with the same end state — and
 * scoped to the caller only (the user id comes from the verified token and the
 * write runs under the owner's RLS policy). An unauthenticated call, or one
 * bearing an already-revoked token, fails with the standard 401.
 */
export async function registerAuthRoutes(
  app: FastifyInstance,
  dependencies: AuthRouteDependencies,
): Promise<void> {
  app.post(
    "/v1/auth/logout",
    async (request): Promise<{ ok: true }> => {
      const userId = await dependencies.resolveUserId(request);
      await dependencies.floors.markLoggedOut(userId);
      return { ok: true as const };
    },
  );
}
