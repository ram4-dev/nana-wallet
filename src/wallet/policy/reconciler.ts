/**
 * The recipient-policy reconciler (design §5.2, §5.3).
 *
 * A durable-intent worker: every pass enumerates due intents across wallets,
 * claims the wallet's `W1` lease, and runs design §3.5 steps 4-10 for the
 * recorded revision through the service seam — the same orchestration a mutation
 * runs, so there is exactly one apply path in the codebase.
 *
 * ## What is authoritative, and what is not
 *
 * Nothing in memory is authoritative. The composition is read from the RECORDED
 * revision (`recipient_policy_sync_intent.composed_rules`) instead of being
 * recomputed, so a process that dies after committing the intent and before the
 * readback is recovered by the next process rather than by a special case
 * (design §5.2, §10(d)). Restart recovery is therefore structural: the row is
 * still in flight, the lease that guarded it expired, and this pass reclaims it.
 *
 * ## Locks and transactions
 *
 * The canonical order (design §1.2, §1.3) gives the reconciler the chain
 * `W1 → tx{ W0(U) → L2 → L5 } → R`: the lease is acquired first, the transaction
 * that writes the applied revision is opened AFTER all provider I/O returns
 * (inside the service seam, step 10), and the lease is released in a `finally`.
 *
 * The lease IS held across steps 4-9 — that is what serializes two processes on
 * one wallet, and §10(d) shows it held from `acquire_policy_lease` to
 * `release lease`. What must never happen is holding it *while holding L1..L5*,
 * or holding any transaction open across provider I/O. Both are asserted against
 * a counting client in the integration suite, not promised in a comment.
 */
import type { DatabaseClient } from "../../db/client.js";
import { acquirePolicyLease, releasePolicyLease } from "./lease.js";
import {
  composedRulesHash,
  type GrantPolicyRule,
} from "./composer.js";
import type {
  PolicyIntentRecord,
  PolicyStateRecord,
  RecipientPolicyRepository,
} from "./repository.js";
import { normalizeProviderReadbackRules } from "./apply.js";
import type { PolicyApplyBookkeepingOptions } from "./service.js";

// ---------------------------------------------------------------------------
// Published constants (design §5.2)
// ---------------------------------------------------------------------------

/** The scheduling cadence: a `setInterval` loop, both processes, no extra primitive. */
export const RECONCILER_INTERVAL_MS = 30_000;
/** `attempt_count` cap: at the cap the status becomes `retryable_failure` and auto-retry stops. */
export const RECONCILER_ATTEMPT_CAP = 12;
/** `min(5 s × 2^attempt_count, 5 min)`, with ±20 % jitter. */
export const RECONCILER_BACKOFF_BASE_MS = 5_000;
export const RECONCILER_BACKOFF_MAX_MS = 300_000;
export const RECONCILER_BACKOFF_JITTER = 0.2;
/** How many due intents one pass examines (one per wallet, ascending revision). */
export const RECONCILER_DEFAULT_LIMIT = 25;

/**
 * The OUTCOME reasons (design §5.3) that mean "the write may have landed".
 *
 * The discriminator is the recorded reason, not the provider failure kind: a
 * `provider_timeout` on an owner-listing read sent no request at all, so
 * classifying by kind alone would divert a safe retry into a readback gate. These
 * five reasons are the service's own `unverified` arm — the mutations that may
 * have been sent, plus the verification reads that failed after one was.
 */
export const UNVERIFIED_OUTCOME_REASONS: readonly string[] = [
  "patch_unverified",
  "policy_create_unverified",
  "policy_attach_unverified",
  "verification_readback_unavailable",
  "verification_listing_unavailable",
];

/**
 * The published backoff: `min(5 s × 2^attempt_count, 5 min)` ±20 %.
 *
 * `random` is injected so the schedule and its bounds are assertable
 * deterministically instead of by wall-clock observation.
 */
export function reconcilerBackoffMs(
  attemptCount: number,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(
    0,
    Math.min(Math.trunc(attemptCount), RECONCILER_ATTEMPT_CAP),
  );
  const raw = Math.min(
    RECONCILER_BACKOFF_BASE_MS * 2 ** exponent,
    RECONCILER_BACKOFF_MAX_MS,
  );
  // `random()` is in [0, 1); map it to [-1, 1) so the jitter is symmetric.
  const jitter = 1 + (random() * 2 - 1) * RECONCILER_BACKOFF_JITTER;
  return Math.round(raw * jitter);
}

/**
 * The `RECIPIENT_POLICY_RECONCILER` switch now lives with its sibling
 * `RECIPIENT_POLICY_WRITER` in the config module (design §13, task 2.13), where
 * the startup matrix — fixture mode, an unrecognised value, and a frozen writer
 * that must be able to stop all writes — is expressed once and unit-proven.
 * Re-exported so the loop's own importers keep reading it from the loop.
 */
export { isRecipientPolicyReconcilerEnabled } from "../../config/recipient-policy.js";

// ---------------------------------------------------------------------------
// Seams
// ---------------------------------------------------------------------------

/** The apply seam the reconciler drives: the SINGLE apply path (design §3.5). */
export type PolicyRevisionApplier = {
  applyRecordedRevision(
    userId: string,
    walletId: string,
    options?: PolicyApplyBookkeepingOptions,
  ): Promise<{ permission: unknown; appliedPolicyId: string | null }>;
};

/** The §5.3 GET: the readback that decides an ambiguous PATCH without retrying blind. */
export type PolicyReconcileReadbackPort = {
  getPolicy(policyId: string): Promise<{ id: string; rules: readonly unknown[] }>;
};

export type PolicyReconcilerDependencies = {
  database: DatabaseClient;
  repository: RecipientPolicyRepository;
  service: PolicyRevisionApplier;
  /** The signed transport's GET. Without it an ambiguous outcome cannot be decided. */
  transport: PolicyReconcileReadbackPort;
  /** `W1` slot controls: the bounded wait and the diagnostic owner id. */
  lease?: {
    waitBudgetMs?: number;
    ownerId?: string;
    leaseSeconds?: number;
    now?: () => number;
    sleep?: (milliseconds: number) => Promise<void>;
  };
  now?: () => Date;
  random?: () => number;
  limit?: number;
};

export type PolicyReconcileOutcomeStatus =
  | "applied"
  | "retry_scheduled"
  | "syncing"
  | "blocked_conflict"
  | "failed"
  | "busy"
  | "unavailable"
  | "nothing_to_claim";

export type PolicyReconcileOutcome = {
  walletId: string;
  desiredRevision: number;
  status: PolicyReconcileOutcomeStatus;
  /** `true` when this pass reclaimed a dead holder's in-flight intent. */
  reclaimed: boolean;
  reason?: string;
};

export type PolicyReconcilePass = {
  examined: number;
  outcomes: PolicyReconcileOutcome[];
};

// ---------------------------------------------------------------------------
// The reconciler
// ---------------------------------------------------------------------------

export class PolicyReconciler {
  private readonly database: DatabaseClient;
  private readonly repository: RecipientPolicyRepository;
  private readonly service: PolicyRevisionApplier;
  private readonly transport: PolicyReconcileReadbackPort;
  private readonly lease: PolicyReconcilerDependencies["lease"];
  private readonly leaseOwnerId: string;
  private readonly now: () => Date;
  private readonly random: () => number;
  private readonly limit: number;

  public constructor(dependencies: PolicyReconcilerDependencies) {
    this.database = dependencies.database;
    this.repository = dependencies.repository;
    this.service = dependencies.service;
    this.transport = dependencies.transport;
    this.lease = dependencies.lease;
    this.leaseOwnerId = dependencies.lease?.ownerId ?? "policy-reconciler";
    this.now = dependencies.now ?? (() => new Date());
    this.random = dependencies.random ?? Math.random;
    this.limit = dependencies.limit ?? RECONCILER_DEFAULT_LIMIT;
  }

  /**
   * One pass: the due scan, then each wallet's due revision in ascending order
   * (design §5.2 step 2). A wallet gets one attempt per pass — re-running the
   * same wallet inside one pass would hot-loop a provider that just failed.
   */
  public async reconcileOnce(): Promise<PolicyReconcilePass> {
    const intents = await this.repository.listDueIntents({ limit: this.limit });
    const seen = new Set<string>();
    const outcomes: PolicyReconcileOutcome[] = [];
    for (const intent of intents) {
      if (seen.has(intent.walletId)) continue;
      seen.add(intent.walletId);
      outcomes.push(await this.reconcileIntent(intent));
    }
    return { examined: outcomes.length, outcomes };
  }

  public async reconcileWallet(walletId: string): Promise<PolicyReconcilePass> {
    const intents = await this.repository.listDueIntents({
      limit: this.limit,
      walletId,
    });
    const outcomes: PolicyReconcileOutcome[] = [];
    for (const intent of intents) outcomes.push(await this.reconcileIntent(intent));
    return { examined: outcomes.length, outcomes };
  }

  /** One wallet's one revision: `W1 → due intent → §3.5 steps 4-10 → release`. */
  private async reconcileIntent(
    intent: PolicyIntentRecord,
  ): Promise<PolicyReconcileOutcome> {
    const base = {
      walletId: intent.walletId,
      desiredRevision: intent.desiredRevision,
    };
    const lease = await acquirePolicyLease({
      database: this.database,
      walletId: intent.walletId,
      userId: intent.userId,
      ownerId: this.leaseOwnerId,
      ...(this.lease?.waitBudgetMs === undefined
        ? {}
        : { waitBudgetMs: this.lease.waitBudgetMs }),
      ...(this.lease?.leaseSeconds === undefined
        ? {}
        : { leaseSeconds: this.lease.leaseSeconds }),
      ...(this.lease?.now === undefined ? {} : { now: this.lease.now }),
      ...(this.lease?.sleep === undefined ? {} : { sleep: this.lease.sleep }),
    });
    // Step 1: `busy` returns WITHOUT touching state (design §5.2) — another
    // process owns this wallet, and recording anything here would be a lie about
    // an attempt this process never made.
    if (lease.status === "busy") return { ...base, status: "busy", reclaimed: false };
    if (lease.status === "unavailable") {
      return { ...base, status: "unavailable", reclaimed: false };
    }

    let reclaimed = false;
    try {
      const claimed = await this.repository.claimIntent({
        walletId: intent.walletId,
        desiredRevision: intent.desiredRevision,
      });
      if (!claimed) {
        return { ...base, status: "nothing_to_claim", reclaimed: false };
      }

      // Step 3 — restart recovery. The due scan saw this row in flight, so the
      // holder that set that marker is gone (this process holds the lease now).
      reclaimed = intent.state === "applying";
      if (reclaimed) {
        await this.recordLeaseReclaimed(intent, claimed);
      }

      // Steps 4-9, through the service seam. No transaction is open here and the
      // service's own step-10 transaction opens only after the provider returns.
      const state = await this.repository.readPolicyState(intent.userId, intent.walletId);
      const decision = await this.decideBeforeRetry(intent, state);
      if (decision.kind === "stalled") {
        await this.settle(intent, claimed, {
          status: "syncing",
          reason: decision.reason,
        });
        return { ...base, status: "syncing", reclaimed, reason: decision.reason };
      }
      if (decision.kind === "blocked") {
        await this.settle(intent, claimed, {
          status: "blocked_conflict",
          reason: decision.reason,
          failureClass: "blocked_conflict",
        });
        return {
          ...base,
          status: "blocked_conflict",
          reclaimed,
          reason: decision.reason,
        };
      }

      await this.service.applyRecordedRevision(
        intent.userId,
        intent.walletId,
        decision.confirmedBy ? { confirmedBy: decision.confirmedBy } : {},
      );

      const after = await this.repository.readPolicyState(intent.userId, intent.walletId);
      const applied =
        after?.status === "applied" &&
        after.appliedRevision === claimed.desiredRevision;
      if (applied) {
        await this.settle(intent, claimed, { status: "applied" });
        return { ...base, status: "applied", reclaimed };
      }
      if (
        after?.status === "blocked_conflict" ||
        after?.status === "blocked_configuration"
      ) {
        // A proven divergence the SERVICE already recorded: `applyRecordedRevision`
        // committed the blocked status AND ran design §4.3's binding invalidation
        // in its own step-10 transaction, so by the time this branch is reached the
        // bindings are already cleared. Only the intent transition is left here.
        await this.settle(intent, claimed, {
          status: "failed",
          reason: after.statusReason ?? after.status,
        });
        return {
          ...base,
          status: "failed",
          reclaimed,
          reason: after.statusReason ?? after.status,
        };
      }
      const reason = after?.statusReason ?? "apply_pending";
      await this.settle(intent, claimed, { status: "retry_scheduled", reason });
      return { ...base, status: "retry_scheduled", reclaimed, reason };
    } finally {
      await releasePolicyLease(
        { database: this.database },
        { walletId: intent.walletId, token: lease.token },
      );
    }
  }

  /**
   * Step 3: append `lease_reclaimed` and clear the dead holder's in-flight marker.
   *
   * One owner-scoped transaction, and the owner is resolved from the intent row
   * the system-scoped scan returned. That is deliberate: `recipient_policy_audit`
   * is owner-isolated (task 1.3 asserts a system-context append is REFUSED), so a
   * system-context audit write would be denied — and rather than add write
   * authority the design does not describe, this re-scopes to the owner, the
   * established `reconciliation-worker.ts:199-215` pattern.
   */
  private async recordLeaseReclaimed(
    intent: PolicyIntentRecord,
    claimed: PolicyIntentRecord,
  ): Promise<void> {
    await this.database.withUserTransaction(intent.userId, async (client) => {
      await this.repository.clearIntentInFlight(
        intent.userId,
        {
          walletId: intent.walletId,
          desiredRevision: claimed.desiredRevision,
        },
        client,
      );
      await this.repository.appendPolicyAudit(
        intent.userId,
        {
          walletId: intent.walletId,
          event: "lease_reclaimed",
          desiredRevision: claimed.desiredRevision,
          reason: "expired_holder",
          detail: {
            code: "lease_reclaimed",
            attemptCount: claimed.attemptCount,
            lastAttemptAt: claimed.lastAttemptAt,
          },
        },
        client,
      );
    });
  }

  /**
   * Design §5.3, the UNVERIFIED-outcome table. A previous attempt that recorded
   * an UNVERIFIED provider outcome may have landed, so the next pass performs a
   * GET first and decides — it never issues a second blind PATCH.
   *
   * `confirmedBy` is returned only for the "rules already equal the composed set"
   * branch, which the service then applies idempotently (its pristine-readback
   * equality skips the PATCH) while recording why the revision counts as applied.
   */
  private async decideBeforeRetry(
    intent: PolicyIntentRecord,
    state: PolicyStateRecord | null,
  ): Promise<
    | { kind: "proceed"; confirmedBy?: "get_after_timeout" }
    | { kind: "stalled"; reason: string }
    | { kind: "blocked"; reason: string }
  > {
    if (!state) return { kind: "proceed" };
    const reason = state.statusReason;
    if (reason === null || !UNVERIFIED_OUTCOME_REASONS.includes(reason)) {
      // Either no provider outcome is recorded, or the last one was definitive
      // (a 4xx rejection) or failed before anything was sent. Neither is an
      // ambiguous write, so there is nothing to decide.
      return { kind: "proceed" };
    }

    const expectedPolicyId = this.expectedPolicyId(state);
    if (!expectedPolicyId) {
      // A write that may have landed with nothing to read back cannot be decided
      // by evidence, so it must not be retried blind.
      return { kind: "stalled", reason: "readback_target_unavailable" };
    }

    let readback: { id: string; rules: readonly unknown[] };
    try {
      readback = await this.transport.getPolicy(expectedPolicyId);
    } catch {
      // "GET itself fails ⇒ syncing with next_attempt_at; no retry of the PATCH
      // until a GET succeeds" (design §5.3, §10(d)).
      return { kind: "stalled", reason: "readback_unavailable" };
    }
    if (readback.id !== expectedPolicyId) {
      return { kind: "stalled", reason: "readback_protocol_error" };
    }

    const observed = normalizeProviderReadbackRules(readback.rules) as GrantPolicyRule[];
    // Both branches compare HASHES of the recorded artifacts, not object identity:
    // the recorded `composed_rules` are a jsonb round-trip of the in-memory
    // composition, so a structural comparison would refuse to recognise the write
    // it is looking at. `composed_hash` is exactly the canonical form that makes
    // "the remote rules are this revision's rules" decidable.
    if (composedRulesHash(observed) === intent.composedHash) {
      return { kind: "proceed", confirmedBy: "get_after_timeout" };
    }
    if (
      state.appliedRulesHash !== null &&
      composedRulesHash(observed) === state.appliedRulesHash
    ) {
      // The remote policy is exactly the revision that was applied last, so the
      // ambiguous write did not land and the same revision is safe to retry.
      return { kind: "proceed" };
    }
    // A third, unexplained rule set: never deleted, never copied into desired
    // state, never overwritten (design §5.1 (c)/(d)).
    return { kind: "blocked", reason: "unexplained_readback_rules" };
  }

  /**
   * The policy the ambiguous write targeted. `applied_policy_id` is the verified
   * one; a first attach records the created policy id in the failure detail. With
   * neither, there is nothing to read back.
   */
  private expectedPolicyId(state: PolicyStateRecord): string | null {
    if (state.appliedPolicyId) return state.appliedPolicyId;
    const detailPolicyId = state.statusDetail?.policyId;
    return typeof detailPolicyId === "string" && detailPolicyId.length > 0
      ? detailPolicyId
      : null;
  }

  /**
   * Step 5: the intent's transition, the retry schedule, and the attempt budget.
   *
   * The counters live on the intent because the due scan reads that row, and the
   * cap is enforced here: at `RECONCILER_ATTEMPT_CAP` the wallet's status becomes
   * `retryable_failure` and the intent leaves the due set, so the loop stops
   * auto-retrying. The user-visible retry endpoint is a different path and keeps
   * working.
   */
  private async settle(
    intent: PolicyIntentRecord,
    claimed: PolicyIntentRecord,
    outcome:
      | { status: "applied" }
      | { status: "blocked_conflict"; reason: string; failureClass: "blocked_conflict" }
      | { status: "failed"; reason: string }
      | { status: "syncing"; reason: string }
      | { status: "retry_scheduled"; reason: string },
  ): Promise<void> {
    if (outcome.status === "applied") {
      await this.repository.settleIntent(intent.userId, {
        walletId: intent.walletId,
        desiredRevision: claimed.desiredRevision,
        state: "applied",
        lastError: null,
        recordAppliedAt: true,
      });
      return;
    }

    const nextAttempt = claimed.attemptCount + 1;
    const exhausted = nextAttempt >= RECONCILER_ATTEMPT_CAP;
    const terminal = outcome.status === "failed" || outcome.status === "blocked_conflict";

    await this.database.withUserTransaction(intent.userId, async (client) => {
      if (outcome.status === "blocked_conflict") {
        // A proven divergence, so this is design §4.3's fallback: one transaction
        // that records the blocked status, nulls BOTH rule hashes, clears every
        // active grant's stale `provider_policy_id` and audits one
        // `binding_invalidated` row per cleared grant. The `stalled` arm above
        // (an unreachable or unreadable readback) deliberately does not get here:
        // an unknown outcome records `syncing` and touches no binding.
        await this.repository.invalidateWalletBindings(
          intent.userId,
          {
            walletId: intent.walletId,
            status: "blocked_conflict",
            reason: outcome.reason,
            detail: { code: outcome.reason },
          },
          client,
        );
      }
      if (outcome.status === "syncing" || (exhausted && !terminal)) {
        // `syncing` is the honest status for an outcome that could not be decided;
        // an exhausted budget reports why auto-retry stopped.
        await this.repository.setPolicyStatus(
          intent.userId,
          {
            walletId: intent.walletId,
            status: exhausted && !terminal ? "retryable_failure" : "syncing",
            reason: exhausted && !terminal ? "attempt_budget_exhausted" : outcome.reason,
            detail: {
              code: exhausted && !terminal ? "attempt_budget_exhausted" : outcome.reason,
              policyId: null,
              appliedPolicyId: null,
            },
            nextAttemptAt:
              exhausted && !terminal
                ? null
                : new Date(this.now().getTime() + this.nextDelay(nextAttempt)),
          },
          client,
        );
      }
      await this.repository.settleIntent(
        intent.userId,
        {
          walletId: intent.walletId,
          desiredRevision: claimed.desiredRevision,
          state: terminal || exhausted ? "failed" : "pending",
          lastError: outcome.reason,
          nextAttemptAt:
            terminal || (exhausted && outcome.status !== "syncing")
              ? null
              : new Date(this.now().getTime() + this.nextDelay(nextAttempt)),
          incrementAttempt: true,
        },
        client,
      );
    });
  }

  private nextDelay(attemptCount: number): number {
    return reconcilerBackoffMs(attemptCount, this.random);
  }
}

/** The wiring entry point, mirroring every other service in this feature. */
export function createPolicyReconciler(
  dependencies: PolicyReconcilerDependencies,
): PolicyReconciler {
  return new PolicyReconciler(dependencies);
}

export interface PolicyReconcilerLoop {
  readonly running: boolean;
  stop(): Promise<void>;
}

/**
 * The 30 s `setInterval` loop (design §5.2). Started from `src/server.ts` and
 * `src/runtime/dependencies.ts` behind `RECIPIENT_POLICY_RECONCILER`.
 *
 * A pass never overlaps itself — the previous pass is awaited before the next
 * tick — and a pass that throws is swallowed and retried on the next tick, so one
 * unavailable wallet cannot stop every other wallet from being reconciled.
 */
export function startRecipientPolicyReconciler(
  dependencies: PolicyReconcilerDependencies & {
    intervalMs?: number;
    onError?: (error: unknown) => void;
  },
): PolicyReconcilerLoop {
  const reconciler = createPolicyReconciler(dependencies);
  const intervalMs = dependencies.intervalMs ?? RECONCILER_INTERVAL_MS;
  let running = true;
  let inFlight: Promise<void> = Promise.resolve();

  const tick = () => {
    if (!running) return;
    inFlight = inFlight.then(async () => {
      if (!running) return;
      try {
        await reconciler.reconcileOnce();
      } catch (error) {
        dependencies.onError?.(error);
      }
    });
  };

  const timer = setInterval(tick, intervalMs);
  // A reconciler tick must never hold the event loop open by itself.
  timer.unref?.();

  return {
    get running() {
      return running;
    },
    async stop() {
      running = false;
      clearInterval(timer);
      await inFlight;
    },
  };
}
