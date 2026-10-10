/**
 * DGC-3: PostgreSQL-backed delegated grant lifecycle, rolling-window
 * consumption accounting, and append-only audit.
 *
 * The ledger (delegated_grants + grant_audit_log) is the single decision
 * authority per the approved hybrid D-4: Privy policies enforce per-tx
 * ceilings/destinations in enclave; this layer enforces cumulative
 * rolling-window caps, TTL/expiration, revocation, and audit.
 *
 * All user-scoped access flows through withUserTransaction (LOCAL ROLE
 * recipient_app + app.user_id) so RLS is exercised exactly like production.
 * Consumption is atomic at the DB level (advisory lock + re-read + audit append
 * in one transaction); in-memory counters are never a source of truth.
 */

import type { DatabaseClient, Queryable } from "../../db/client.js";

export type DelegatedGrantRow = {
  id: string;
  userId: string;
  walletId: string;
  action: "transfer";
  chain: string;
  maxPerTransfer: string;
  maxCumulative: string;
  windowSeconds: number;
  recipients: string[];
  state: "active" | "revoked" | "expired";
  providerPolicyId: string | null;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
};

export type GrantAuditEvent =
  | "created"
  | "used"
  | "released"
  | "rejected"
  | "revoked"
  | "expired"
  | "policy_synced"
  | "policy_sync_failed";

export type CreateGrantInput = {
  userId: string;
  walletId: string;
  action: "transfer";
  chain: string;
  maxPerTransfer: string;
  maxCumulative: string;
  windowSeconds: number;
  recipients: string[];
  expiresAt: Date;
};

export class InvalidGrantInputError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "InvalidGrantInputError";
  }
}

export type ClaimConsumptionResult = {
  /** True when budget was consumed by this call, including an idempotent replay. */
  consumed: boolean;
  /**
   * Present on an idempotency replay: the claim already existed, so the ORIGINAL
   * result is returned instead of consuming a second time.
   */
  replay?: boolean;
  /** Consumed amount: this claim's amount, or the original amount on a replay. */
  amount?: string;
  /**
   * Rejection reason code. Every rejection that has a visible grant row also
   * appends a `rejected` audit row inside the same transaction.
   */
  reason?: string;
};

/** Result of the tx-only reservation release (AD-10). */
export type ReleaseReservationResult = {
  /** True when THIS call released the reservation. */
  released: boolean;
  /** True when the reservation was already released (idempotent no-op). */
  replayedRelease?: boolean;
};

const GRANT_COLUMNS =
  "id, user_id, wallet_id, action, chain, max_per_transfer, max_cumulative, window_seconds, recipients, state, provider_policy_id, created_at, expires_at, revoked_at";

type GrantSqlRow = {
  id: string;
  user_id: string;
  wallet_id: string;
  action: string;
  chain: string;
  max_per_transfer: string;
  max_cumulative: string;
  window_seconds: number;
  recipients: unknown;
  state: string;
  provider_policy_id: string | null;
  created_at: Date;
  expires_at: Date;
  revoked_at: Date | null;
};

function mapGrant(row: GrantSqlRow): DelegatedGrantRow {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    action: "transfer",
    chain: row.chain,
    maxPerTransfer: row.max_per_transfer,
    maxCumulative: row.max_cumulative,
    windowSeconds: row.window_seconds,
    recipients: Array.isArray(row.recipients)
      ? (row.recipients as string[])
      : [],
    state: row.state as DelegatedGrantRow["state"],
    providerPolicyId: row.provider_policy_id,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function normalizeDecimal(value: string): string {
  return value.replaceAll("_", "");
}

/**
 * DGC-8.7 (R4): parse a claim amount as a positive decimal integer in smallest
 * units BEFORE any BigInt arithmetic runs on it. The raw value must be either
 * plain digits or correctly underscore-grouped thousands (1_000_000); leading,
 * trailing, or doubled underscores (e.g. `_1`, `1__0`, `1_`) are rejected
 * before any separator stripping. Anything that is not a positive decimal
 * integer — empty, fractional, negative, non-numeric, malformed grouping, or
 * zero — is rejected. Returns the canonical decimal string, or null when the
 * amount is malformed or non-positive; the caller must fail closed with
 * `invalid_amount` and must never feed the raw value to BigInt.
 */
function parsePositiveAmount(raw: unknown): string | null {
  // Runtime guard: malformed JavaScript callers (non-string amounts) must fail
  // closed here instead of throwing before the `invalid_amount` rejection path.
  if (typeof raw !== "string") {
    return null;
  }
  const plainDigits = /^\d+$/;
  const groupedThousands = /^\d{1,3}(_\d{3})+$/;
  if (!plainDigits.test(raw) && !groupedThousands.test(raw)) {
    return null;
  }
  const normalized = raw.replaceAll("_", "");
  // Safe: the validators above guarantee digits only, so BigInt cannot throw.
  const value = BigInt(normalized);
  if (value <= 0n) {
    return null;
  }
  return value.toString();
}

/**
 * Sum of UNRELEASED `grant_claim_ledger` reservations for a grant inside its
 * rolling window (claimed_at > now - window; released_at IS NULL). AD-10: the
 * window counts held reservations from the LEDGER, not audit rows, so a
 * released reservation stops counting and its budget returns to the window.
 * Uses the passed clock so tests can pin time.
 */
export async function consumedInWindow(
  database: DatabaseClient | Queryable,
  grantId: string,
  windowSeconds: number,
  now: Date = new Date(),
): Promise<string> {
  const run = (executor: Queryable) =>
    executor.query<{ total: string | null }>(
      `SELECT COALESCE(SUM(amount), 0)::text AS total FROM grant_claim_ledger
       WHERE grant_id = $1
         AND released_at IS NULL
         AND claimed_at > $2`,
      [grantId, new Date(now.getTime() - windowSeconds * 1_000)],
    );
  // A DatabaseClient has no user context: RLS hides rows unless app.user_id is
  // set, so raw client use here is only valid when the caller already provides
  // a user-scoped Queryable (the production path). The fallback anonymous tx
  // exists for fixtures and returns 0 by design (no user context → no rows).
  if (isQueryable(database)) {
    const result = await run(database);
    return result.rows[0]?.total ?? "0";
  }
  let total = "0";
  await (database as DatabaseClient).withUserTransactionAnonymous(
    async (client) => {
      const result = await run(client);
      total = result.rows[0]?.total ?? "0";
    },
  );
  return total;
}

function isQueryable(value: DatabaseClient | Queryable): value is Queryable {
  return typeof (value as DatabaseClient).withUserTransaction !== "function";
}

/**
 * Append an immutable audit row. Must be called inside the same transaction as
 * the decision it records (never after an on-chain side effect).
 */
export async function appendGrantAudit(
  database: DatabaseClient | Queryable,
  input: {
    grantId: string;
    userId: string;
    event: GrantAuditEvent;
    reason?: string;
    amount?: string;
    detail?: Record<string, unknown>;
  },
  executor?: Queryable,
): Promise<void> {
  const run = (client: Queryable) =>
    client.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason, amount, detail)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        input.grantId,
        input.userId,
        input.event,
        input.reason ?? null,
        input.amount !== undefined ? normalizeDecimal(input.amount) : null,
        input.detail ? JSON.stringify(input.detail) : null,
      ],
    );
  if (executor) {
    await run(executor);
    return;
  }
  // No executor given: the caller accepts the anonymous (no app.user_id)
  // context. RLS will reject user-scoped writes; valid only for system-level
  // rows that carry their own user_id with a matching policy.
  await (database as DatabaseClient).withUserTransactionAnonymous((client) =>
    run(client),
  );
}

export class DelegatedGrantService {
  public constructor(private readonly database: DatabaseClient) {}

  /**
   * Resolve the sole ready embedded wallet for this user's requested chain.
   * Wallet identity is never selected by the client; ambiguity or absence
   * fails closed under D-2's one-wallet model.
   */
  public async resolveWalletId(userId: string, chain: string): Promise<string> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<{ id: string; chain_family: string }>(
        `SELECT id, chain_family FROM user_wallets
         WHERE user_id = $1 AND state = 'ready'
         ORDER BY updated_at DESC
         LIMIT 2`,
        [userId],
      );
      if (result.rows.length !== 1 || result.rows[0]?.chain_family !== chain) {
        throw new GrantWalletUnavailableError(
          result.rows.length > 1
            ? "More than one ready wallet is available for this user."
            : `No ready ${chain} wallet is available for this user.`,
        );
      }
      return result.rows[0]!.id;
    });
  }

  public async createGrant(
    input: CreateGrantInput,
  ): Promise<DelegatedGrantRow> {
    const perTransfer = normalizeDecimal(input.maxPerTransfer);
    if (
      input.chain === "solana" &&
      (!/^\d+$/.test(perTransfer) || BigInt(perTransfer) > 10_000_000n)
    ) {
      throw new InvalidGrantInputError(
        "Solana maxPerTransfer cannot exceed 0.01 SOL (10,000,000 lamports).",
      );
    }
    return this.database.withUserTransaction(input.userId, (client) =>
      this.createGrantInTransaction(input, client),
    );
  }

  private async createGrantInTransaction(
    input: CreateGrantInput,
    client: Queryable,
  ): Promise<DelegatedGrantRow> {
    const result = await client.query<GrantSqlRow>(
      `INSERT INTO delegated_grants
       (user_id, wallet_id, action, chain, max_per_transfer, max_cumulative,
        window_seconds, recipients, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
       RETURNING ${GRANT_COLUMNS}`,
      [
        input.userId,
        input.walletId,
        input.action,
        input.chain,
        normalizeDecimal(input.maxPerTransfer),
        normalizeDecimal(input.maxCumulative),
        input.windowSeconds,
        JSON.stringify(input.recipients),
        input.expiresAt,
      ],
    );
    const grant = mapGrant(result.rows[0]!);
    await client.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason)
       VALUES ($1, $2, 'created', NULL)`,
      [grant.id, input.userId],
    );
    // D-4 hybrid: provisioning the provider enforcement surface is a separate,
    // post-commit step (PrivyPolicySyncService) because it performs provider I/O
    // and must not run inside this transaction. Until it succeeds the grant has
    // no provider_policy_id, so `policyReady` stays false and neither the engine
    // nor claimConsumption will treat it as executable. This method therefore
    // records NO policy_synced row: that event belongs exclusively to a real
    // sync outcome.
    return grant;
  }

  public async listGrants(userId: string): Promise<DelegatedGrantRow[]> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<GrantSqlRow>(
        `SELECT ${GRANT_COLUMNS} FROM delegated_grants
         WHERE user_id = $1 ORDER BY created_at DESC`,
        [userId],
      );
      return result.rows.map(mapGrant);
    });
  }

  public async getGrant(
    grantId: string,
    userId: string,
  ): Promise<DelegatedGrantRow | null> {
    return this.database.withUserTransaction(userId, async (client) => {
      const result = await client.query<GrantSqlRow>(
        `SELECT ${GRANT_COLUMNS} FROM delegated_grants WHERE id = $1 AND user_id = $2`,
        [grantId, userId],
      );
      return result.rows[0] ? mapGrant(result.rows[0]) : null;
    });
  }

  public async revokeGrant(
    grantId: string,
    userId: string,
  ): Promise<DelegatedGrantRow> {
    return this.database.withUserTransaction(userId, async (client) => {
      // Serialize concurrent revoke/claim on the same grant.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${grantId}`,
      ]);
      const result = await client.query<GrantSqlRow>(
        `UPDATE delegated_grants
         SET state = 'revoked', revoked_at = now(), updated_at = now()
         WHERE id = $1 AND user_id = $2 AND state = 'active'
         RETURNING ${GRANT_COLUMNS}`,
        [grantId, userId],
      );
      if (!result.rows[0]) {
        throw new Error(
          `Grant ${grantId} is not active or does not exist for this user.`,
        );
      }
      await client.query(
        `INSERT INTO grant_audit_log (grant_id, user_id, event)
         VALUES ($1, $2, 'revoked')`,
        [grantId, userId],
      );
      return mapGrant(result.rows[0]);
    });
  }

  /**
   * Atomically claim budget for one execution. Runs the cap checks against a
   * locked grant row and appends the `used` audit row in the SAME transaction, so
   * two concurrent claims cannot both fit under a cap that only has room for one.
   * Idempotency: a repeated key returns the ORIGINAL result without a second audit
   * row or consumption (DB unique constraint).
   *
   * Every rejection is audited in the same transaction with its reason code, so a
   * refused execution is never invisible in the trail.
   */
  public async claimConsumption(input: {
    grantId: string;
    userId: string;
    amount: string;
    idempotencyKey: string;
  }): Promise<ClaimConsumptionResult> {
    return this.database.withUserTransaction(input.userId, async (client) => {
      // W0(S) — the state slot of the canonical lock order, taken FIRST
      // (`docs/architecture.md` §"Wallet policy lock order", design §1.2).
      //
      // WHY IT IS FIRST AND NOT LAST: the apply and removal transactions take
      // `W0(U)` on this row and *then* the grant rows (`L1`/`L2`). A claim takes
      // the grant rows and would then need this row, which is the classic cycle
      // (apply: state → grant row; claim: grant row → state). Prepending the
      // read makes every writer monotone in one global order, so no cycle can
      // form. Moving this statement below the advisory lock below reintroduces
      // the deadlock — `tests/unit/lock-order-vector.test.ts` fails if it moves.
      //
      // WHAT IT IS NOT: this read is a lock, not yet a gate. The wallet's state
      // row is resolved through the grant's own `wallet_id`, so no new input is
      // needed, and a wallet with NO state row locks nothing and stays claimable
      // exactly as it is today. Deciding what an absent or unverified row means
      // for the claim is task 2.11; turning that into a refusal here would be a
      // behaviour regression this task must not introduce.
      //
      // The statement resolves the wallet through the grant itself, so no new
      // input is needed and the claim cannot be pointed at another wallet: the
      // join binds exactly the caller's own grant row (RLS-scoped) and locks
      // only the state row (`FOR SHARE OF state`).
      await client.query(
        `SELECT 1
           FROM recipient_policy_state AS state
           JOIN delegated_grants AS grant_row
             ON grant_row.wallet_id = state.wallet_id
          WHERE grant_row.id = $1
            AND grant_row.user_id = $2
            AND state.user_id = $2
          FOR SHARE OF state`,
        [input.grantId, input.userId],
      );

      // L1 — serialize all consumption decisions for this grant across app
      // instances. Same advisory key the removal transaction takes.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${input.grantId}`,
      ]);

      // Idempotency replay: the unique index on grant_id+idempotency_key decides.
      // The original result is returned verbatim; no second consumption, no second
      // audit row, no state mutation.
      // AD-10 retry contract: a RELEASED key is permanently retired — the
      // replay NEVER returns consumed:true; it fails closed so a released
      // reservation cannot authorize a broadcast. A retry of the request
      // creates a FRESH persisted previewId (fresh key/reservation).
      const replay = await client.query<{
        amount: string;
        released_at: Date | null;
      }>(
        `SELECT amount, released_at FROM grant_claim_ledger
             WHERE grant_id = $1 AND idempotency_key = $2`,
        [input.grantId, input.idempotencyKey],
      );
      const replayed = replay.rows[0];
      if (replayed) {
        if (replayed.released_at !== null) {
          // Released key: fail closed. No consumption, no broadcast
          // authorization, and NEVER flagged as a replay (a released
          // reservation must not look like the original claim returning).
          await this.appendRejection(
            client,
            input,
            "reservation_released",
            null,
          );
          return {
            consumed: false,
            replay: false,
            reason: "reservation_released",
          };
        }
        return {
          consumed: true,
          replay: true,
          amount: normalizeDecimal(replayed.amount),
        };
      }

      const grantResult = await client.query<GrantSqlRow>(
        `SELECT ${GRANT_COLUMNS}
             FROM delegated_grants
             WHERE id = $1 AND user_id = $2 FOR UPDATE`,
        [input.grantId, input.userId],
      );
      const grantRow = grantResult.rows[0];
      if (!grantRow) {
        // RLS hides a foreign or missing grant, so there is no row to audit
        // against and no state to reject.
        return { consumed: false, reason: "grant_not_found" };
      }
      const grant = mapGrant(grantRow);
      // DGC-8.7 (R4): validate the amount before ANY integer math. A malformed
      // or non-positive amount is rejected as `invalid_amount`, audited with a
      // NULL amount (the malformed value is never persisted), creates no
      // claim-ledger row, and never throws from BigInt parsing.
      const amount = parsePositiveAmount(input.amount);
      if (amount === null) {
        await this.appendRejection(client, input, "invalid_amount", null);
        return { consumed: false, reason: "invalid_amount" };
      }

      if (grant.state !== "active") {
        const reason =
          grant.state === "expired" ? "grant_expired" : "grant_revoked";
        await this.appendRejection(client, input, reason, amount);
        return { consumed: false, reason };
      }
      // Expiration is re-checked on the LOCKED row against the DATABASE clock, so
      // a grant that expired between the engine evaluation and this claim cannot
      // slip through. clock_timestamp() is used instead of now(), which is fixed
      // at transaction start and could be stale after waiting for the row lock.
      // Per the spec, the grant state is not mutated here.
      const expiry = await client.query<{ is_expired: boolean }>(
        `SELECT expires_at <= clock_timestamp() AS is_expired
         FROM delegated_grants WHERE id = $1 AND user_id = $2`,
        [input.grantId, input.userId],
      );
      if (expiry.rows[0]?.is_expired) {
        await this.appendRejection(client, input, "grant_expired", amount);
        return { consumed: false, reason: "grant_expired" };
      }
      // D-4 hybrid: both planes must hold. Without the provider policy binding the
      // enclave enforces nothing, so the ledger refuses to consume budget.
      if (!grant.providerPolicyId) {
        await this.appendRejection(client, input, "policy_not_ready", amount);
        return { consumed: false, reason: "policy_not_ready" };
      }

      const consumedResult = await client.query<{ total: string | null }>(
        `SELECT COALESCE(SUM(amount), 0)::text AS total FROM grant_claim_ledger
             WHERE grant_id = $1 AND released_at IS NULL
               AND claimed_at > $2`,
        [input.grantId, new Date(Date.now() - grant.windowSeconds * 1_000)],
      );
      const consumed = consumedResult.rows[0]?.total ?? "0";
      const projected = BigInt(consumed) + BigInt(amount);
      if (BigInt(amount) > BigInt(grant.maxPerTransfer)) {
        await this.appendRejection(
          client,
          input,
          "per_transfer_cap_exceeded",
          amount,
        );
        return { consumed: false, reason: "per_transfer_cap_exceeded" };
      }
      if (projected > BigInt(grant.maxCumulative)) {
        await this.appendRejection(
          client,
          input,
          "cumulative_cap_exceeded",
          amount,
        );
        return { consumed: false, reason: "cumulative_cap_exceeded" };
      }

      await client.query(
        `INSERT INTO grant_claim_ledger (grant_id, user_id, idempotency_key, amount)
             VALUES ($1, $2, $3, $4)`,
        [input.grantId, input.userId, input.idempotencyKey, amount],
      );
      await client.query(
        `INSERT INTO grant_audit_log (grant_id, user_id, event, amount, detail)
             VALUES ($1, $2, 'used', $3, $4)`,
        [
          input.grantId,
          input.userId,
          amount,
          JSON.stringify({ idempotencyKey: input.idempotencyKey }),
        ],
      );
      return { consumed: true, amount };
    });
  }

  /** Append the `rejected` audit row for one refused claim (same transaction). */
  private async appendRejection(
    client: Queryable,
    input: { grantId: string; userId: string; idempotencyKey: string },
    reason: string,
    amount: string | null,
  ): Promise<void> {
    await client.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason, amount, detail)
               VALUES ($1, $2, 'rejected', $3, $4, $5)`,
      [
        input.grantId,
        input.userId,
        reason,
        amount,
        JSON.stringify({ idempotencyKey: input.idempotencyKey }),
      ],
    );
  }

  /**
   * AD-10: the atomic grant settlement. ONE user-scoped transaction
   * (`withUserTransaction` + per-grant advisory lock) performs ALL THREE
   * effects on the SAME client: (1) the exact-owner attempt CAS
   * `broadcasting → cancelled` (id + conversation + user + status +
   * persisted claim_id must ALL match), (2) the ledger release via the
   * tx-only method, (3) the compensating `released` audit row is written
   * by that method. Any injected/real failure rolls back ALL THREE — no
   * partial commits ever.
   *
   * Retention rules: a lost CAS (wrong/stale claimId, moved status,
   * absent row, already-`cancelled`) returns WITHOUT releasing — the
   * reservation is retained. The `failAfter` seam is TEST-ONLY (phase 8
   * rollback proof): production callers must never pass it.
   */
  public async settleGrantReservation(input: {
    userId: string;
    conversationId: string;
    attemptId: string;
    claimId: string;
    grantId: string;
    idempotencyKey: string;
    reason: string;
    /** TEST-ONLY injection point for rollback proof. Never in production. */
    failAfter?: "cas" | "ledger" | "audit";
  }): Promise<void> {
    return this.database.withUserTransaction(input.userId, async (client) => {
      // Serialize all settlement decisions for this grant across instances.
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [
        `dgc-grant-${input.grantId}`,
      ]);

      // (1) Exact-owner CAS on the attempt row.
      const cas = await client.query<{ id: string }>(
        `UPDATE conversation_transfer_attempts
                 SET status = 'cancelled', updated_at = now()
               WHERE id = $1 AND conversation_id = $2 AND user_id = $3
                 AND status = 'broadcasting' AND claim_id = $4
               RETURNING id`,
        [input.attemptId, input.conversationId, input.userId, input.claimId],
      );
      if (!cas.rowCount) {
        // Lost CAS: retain, never release, never mutate anything else.
        return;
      }

      if (input.failAfter === "cas") {
        throw new Error("injected: after attempt CAS");
      }

      // (2)+(3) Ledger release + compensating audit on the SAME client,
      // via the TX-ONLY method (single implementation of release
      // semantics; the settlement owns the transaction). The
      // failAfter:'ledger' test-only hook lives INSIDE that method,
      // between the ledger UPDATE and the audit INSERT, to prove that
      // boundary rolls back too.
      await this.releaseReservationInTransaction(client, {
        grantId: input.grantId,
        userId: input.userId,
        idempotencyKey: input.idempotencyKey,
        reason: input.reason,
        failAfter: input.failAfter === "ledger" ? "ledger" : undefined,
      });

      // Distinct boundary: the tx-only method returned having committed
      // (inside this tx) BOTH the ledger UPDATE and the audit INSERT —
      // test-only injection proves the post-audit edge rolls back too.
      if (input.failAfter === "audit") {
        throw new Error("injected: after audit insert");
      }
    });
  }

  /**
   * AD-10: mark the EXACT reservation (grant + idempotency key) released
   * with its reason and append the compensating `released` audit row —
   * BOTH on the caller-provided transaction client. TX-ONLY: this method
   * never opens, commits, or nests a transaction; the settlement caller
   * owns the user-scoped transaction and the per-grant advisory lock, so
   * any failure rolls back every settlement effect together.
   *
   * Idempotent: re-releasing an already-released row is a no-op that
   * returns `replayedRelease: true` with the original timestamp/reason
   * preserved (no second audit row). A replayed LIVE claim is never
   * released by this path — release requires a settled definitive
   * non-dispatch for THIS execution (the settlement caller's duty).
   */
  public async releaseReservationInTransaction(
    tx: Queryable,
    input: {
      grantId: string;
      userId: string;
      idempotencyKey: string;
      reason: string;
      /** TEST-ONLY injection point: after the ledger UPDATE, before the audit INSERT. */
      failAfter?: "ledger";
    },
  ): Promise<ReleaseReservationResult> {
    // CAS on the exact row: only an UNRELEASED reservation can be marked
    // released; the WHERE guards against double-release races.
    const released = await tx.query<{ id: string }>(
      `UPDATE grant_claim_ledger
               SET released_at = now(), released_reason = $3
             WHERE grant_id = $1 AND idempotency_key = $2 AND released_at IS NULL
             RETURNING id`,
      [input.grantId, input.idempotencyKey, input.reason],
    );
    if (!released.rowCount) {
      // Already released (or no such claim row): idempotent no-op. Verify
      // which one — a missing row is still a no-op for this tx-only path.
      const existing = await tx.query<{ released_at: Date | null }>(
        `SELECT released_at FROM grant_claim_ledger
                 WHERE grant_id = $1 AND idempotency_key = $2`,
        [input.grantId, input.idempotencyKey],
      );
      if (existing.rows[0]?.released_at !== null && existing.rows[0]) {
        return { released: false, replayedRelease: true };
      }
      return { released: false };
    }
    // Compensating audit: one `released` row per actual release, keyed by
    // the idempotency key in detail for correlation.
    // TEST-ONLY boundary (failAfter:'ledger'): injected here — AFTER the
    // exact ledger UPDATE above, BEFORE the audit INSERT — to prove that
    // this edge rolls back the whole settlement in the real DB.
    if (input.failAfter === "ledger") {
      throw new Error("injected: after ledger release, before audit");
    }
    await tx.query(
      `INSERT INTO grant_audit_log (grant_id, user_id, event, reason, detail)
               VALUES ($1, $2, 'released', $3, $4)`,
      [
        input.grantId,
        input.userId,
        input.reason,
        JSON.stringify({ idempotencyKey: input.idempotencyKey }),
      ],
    );
    return { released: true };
  }
}

export class GrantWalletUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "GrantWalletUnavailableError";
  }
}

/**
 * DGC-6: the caller supplies the grant limits and lifetime; wallet identity and
 * the `transfer` action are resolved/derived by the creator, never by a model.
 */
export type GrantCreatorInput = Omit<CreateGrantInput, "walletId" | "action">;

/** Result of one ledger creation plus its provider policy projection. */
export type GrantCreatorResult = {
  grantId: string;
  /**
   * True ONLY when the provider enforcement surface was provisioned. A created
   * grant whose policy sync failed is still recorded, but non-executable.
   */
  policyReady: boolean;
  /** Provider failure message when `policyReady` is false. Informational only. */
  policyError?: string;
};

/** Narrow creation port shared by the HTTP lifecycle and the Nani conversation seam. */
export interface GrantCreator {
  create(input: GrantCreatorInput): Promise<GrantCreatorResult>;
}

/** The minimal policy-sync surface the creator needs (PrivyPolicySyncService). */
export type GrantPolicySyncer = {
  syncGrant(
    grantId: string,
    userId: string,
    walletId: string,
  ): Promise<{ policyId: string | null; error?: string }>;
};

/**
 * Compose the provider-facing creation sequence from an existing ledger service
 * and policy-sync service: resolve the user's sole ready wallet for the chain,
 * commit the ledger row + audit, then project the provider policy AFTER the
 * transaction (never inside it). A provider failure keeps the grant created but
 * non-executable (`policyReady: false`) and is surfaced honestly.
 */
export function composeGrantCreator(
  grants: DelegatedGrantService,
  policySync: GrantPolicySyncer,
): GrantCreator {
  return {
    async create(input) {
      const walletId = await grants.resolveWalletId(input.userId, input.chain);
      const grant = await grants.createGrant({
        ...input,
        walletId,
        action: "transfer",
      });
      const sync = await policySync.syncGrant(grant.id, input.userId, walletId);
      return {
        grantId: grant.id,
        policyReady: sync.policyId !== null,
        ...(sync.error ? { policyError: sync.error } : {}),
      };
    },
  };
}
