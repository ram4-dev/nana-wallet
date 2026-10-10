/**
 * The recipient policy lease (design §1.4).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Composing and applying a revision spans remote provider I/O, and §1.2 of the
 * design forbids holding a database lock across that I/O. The only thing left
 * that can serialize two processes for one wallet is a short-lived row outside
 * any transaction: `recipient_policy_leases` (the `W1` slot of the canonical
 * lock order). This module is the API over it.
 *
 * The three rules that keep it honest:
 *
 *  1. **Bounded wait, never unbounded.** Acquisition retries on the documented
 *     `100 ms × 2^n` schedule capped at 1 s, up to `waitBudgetMs` (default
 *     3 000 ms). Exhaustion returns `busy`, which the caller records as pending
 *     with `next_attempt_at` — never a fabricated success (design §1.4, §5.2).
 *  2. **Token-guarded writes.** Renewal and release carry the token the holder
 *     received, so a holder whose lease was reclaimed after expiry learns it
 *     lost the lease (`false`) instead of writing blind. The hard hold ceiling
 *     (300 s) is enforced by the same authority that owns the row, so no caller
 *     can renew forever.
 *  3. **Fail closed.** A database failure reports `unavailable` (acquire) and
 *     `false` (renew): "we do not hold it" is always the safe answer. Nothing
 *     here reports an acquisition it did not observe.
 *
 * The lease is *not* a correctness boundary by itself: every write is
 * revision-verified (§1.5) and every apply is a full recomposition from the
 * persisted intent (§5.2), so the worst case after a crash is a recomposition,
 * never a partial rule set. Reclaim happens only through `expires_at`.
 */
import type { Queryable } from "../../db/client.js";

/** TTL of an acquired lease, in seconds. */
export const POLICY_LEASE_TTL_SECONDS = 60;
/**
 * Renewal cadence while the composition/apply sequence runs: a holder renews
 * well inside the TTL, so a slow provider call does not lose the lease.
 */
export const POLICY_LEASE_RENEWAL_INTERVAL_MS = 10_000;
/**
 * Hard hold ceiling, in seconds. Past it the holder releases and re-acquires
 * rather than renewing forever: a lease that can be extended indefinitely is a
 * lock, and a lock across remote I/O is exactly what §1.2 forbids.
 */
export const POLICY_LEASE_MAX_HOLD_SECONDS = 300;
/** The same ceiling in milliseconds, for the holder's own timer. */
export const POLICY_LEASE_MAX_HOLD_MS = POLICY_LEASE_MAX_HOLD_SECONDS * 1_000;
/** Default bounded wait budget before `busy`, in milliseconds. */
export const POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS = 3_000;
/** First backoff step; doubles per attempt, capped by the constant below. */
export const POLICY_LEASE_FIRST_BACKOFF_MS = 100;
/** Backoff cap. */
export const POLICY_LEASE_MAX_BACKOFF_MS = 1_000;

/**
 * The database surface the lease needs: an anonymous system transaction, which
 * is the same context the ingestion pattern uses (`013`'s reconciliation lease)
 * and the only context `recipient_policy_leases` is reachable from.
 */
export interface PolicyLeaseTransactionRunner {
  withSystemTransaction<T>(
    operation: (client: Queryable) => Promise<T>,
  ): Promise<T>;
}

export interface AcquirePolicyLeaseInput {
  database: PolicyLeaseTransactionRunner;
  walletId: string;
  userId: string;
  /** Who is asking (`backend`, `voice-worker`, …), recorded for diagnostics. */
  ownerId: string;
  /** TTL override; defaults to `POLICY_LEASE_TTL_SECONDS`. */
  leaseSeconds?: number;
  /** Bounded wait budget; defaults to `POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS`. */
  waitBudgetMs?: number;
  /**
   * Injected clock/sleep. The bounded-wait schedule is a published contract, so
   * it is proven deterministically instead of by wall-clock timing.
   */
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export type AcquirePolicyLeaseResult =
  | { status: "acquired"; token: string }
  | { status: "busy" }
  | { status: "unavailable" };

/** The transaction runner a renew/release call needs (design §1.4's `deps`). */
export interface PolicyLeaseRef {
  database: PolicyLeaseTransactionRunner;
}

export interface RenewPolicyLeaseInput {
  walletId: string;
  token: string;
  /** TTL written on renewal; defaults to `POLICY_LEASE_TTL_SECONDS`. */
  leaseSeconds?: number;
  /** Hard hold ceiling; defaults to `POLICY_LEASE_MAX_HOLD_SECONDS`. */
  maxHoldSeconds?: number;
}

export interface ReleasePolicyLeaseInput {
  walletId: string;
  token: string;
}

/**
 * Acquire the wallet lease, waiting a bounded time for a live holder to go
 * away. Returns `acquired` with the holder's token, `busy` when the budget is
 * exhausted, or `unavailable` when the database could not be reached.
 */
export async function acquirePolicyLease(
  input: AcquirePolicyLeaseInput,
): Promise<AcquirePolicyLeaseResult> {
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? defaultSleep;
  const budgetMs = input.waitBudgetMs ?? POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS;
  const leaseSeconds = input.leaseSeconds ?? POLICY_LEASE_TTL_SECONDS;
  const startedAt = now();
  let attempt = 0;

  for (;;) {
    let token: string | null;
    try {
      const result = await input.database.withSystemTransaction((client) =>
        client.query<{ lease_token: string | null }>(
          `SELECT lease_token FROM acquire_recipient_policy_lease($1, $2, $3, $4)`,
          [input.walletId, input.userId, input.ownerId, leaseSeconds],
        ),
      );
      token = result.rows[0]?.lease_token ?? null;
    } catch {
      // We did not acquire anything, and we will not claim otherwise. An
      // unreachable database is not contention: retrying it inside the wait
      // budget would only delay the honest answer.
      return { status: "unavailable" };
    }

    if (token) return { status: "acquired", token };

    const elapsedMs = now() - startedAt;
    if (elapsedMs >= budgetMs) return { status: "busy" };

    const backoffMs = Math.min(
      POLICY_LEASE_FIRST_BACKOFF_MS * 2 ** attempt,
      POLICY_LEASE_MAX_BACKOFF_MS,
    );
    // Sleeping past the caller's budget would make the budget a lie.
    await sleep(Math.min(backoffMs, budgetMs - elapsedMs));
    attempt += 1;
  }
}

/**
 * Renew the lease the holder still owns. `false` means the lease is no longer
 * ours (reclaimed after expiry, or past the hard hold ceiling) and the holder
 * must stop and release. A database failure also answers `false`: the safe
 * direction is "assume we lost it".
 */
export async function renewPolicyLease(
  ref: PolicyLeaseRef,
  input: RenewPolicyLeaseInput,
): Promise<boolean> {
  try {
    const result = await ref.database.withSystemTransaction((client) =>
      client.query<{ renew_recipient_policy_lease: boolean }>(
        `SELECT renew_recipient_policy_lease($1, $2, $3, $4)`,
        [
          input.walletId,
          input.token,
          input.leaseSeconds ?? POLICY_LEASE_TTL_SECONDS,
          input.maxHoldSeconds ?? POLICY_LEASE_MAX_HOLD_SECONDS,
        ],
      ),
    );
    return result.rows[0]?.renew_recipient_policy_lease === true;
  } catch {
    return false;
  }
}

/**
 * Release the lease. Token-guarded, so a stale holder cannot evict the holder
 * that reclaimed it. Always safe to call in a `finally`: a release that fails
 * leaves the row to expire, which only ever costs the next holder a wait.
 */
export async function releasePolicyLease(
  ref: PolicyLeaseRef,
  input: ReleasePolicyLeaseInput,
): Promise<void> {
  try {
    await ref.database.withSystemTransaction((client) =>
      client.query(`SELECT release_recipient_policy_lease($1, $2)`, [
        input.walletId,
        input.token,
      ]),
    );
  } catch {
    // Best effort by design: TTL bounds a leaked row (see the module docs).
  }
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
