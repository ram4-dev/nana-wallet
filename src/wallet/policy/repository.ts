/**
 * The recipient policy repository (design §2.1–§2.5, §1.5).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Slice 1 collapses three full-rule writers into one composer. That only works
 * if the *state* around the composer lives in one place, because the state is
 * where the current code is allowed to lie:
 *
 *   * "enabled" can be reported from a successful call with no verified
 *     readback → `recipient_policy_state` keeps desired and applied apart, and
 *     the compare-and-set of §1.5 is the only writer of an applied revision;
 *   * a retry can re-derive rules from mutable tables and drift → the intent row
 *     stores the exact composed rules and hash it was built from;
 *   * a second authorizer can consume the same spoken "sí" → the proposal row is
 *     consumed by one conditional UPDATE, once;
 *   * `signer_grants` can disagree with the policy actually attached → the
 *     verified readback refreshes both representations in one transaction.
 *
 * Two rules the whole module obeys:
 *
 *  1. **Every statement is bind-parameterized.** No value is ever interpolated
 *     into SQL text; only column lists (module constants) are.
 *  2. **Authority is explicit and minimal.** Owner paths run inside
 *     `withUserTransaction` (so `app.user_id` is set and row isolation applies);
 *     the ONLY anonymous system paths are `listDueIntents` and `claimIntent`,
 *     which the `015` migration already grants `FOR ALL` on
 *     `recipient_policy_sync_intent` because the reconciler must enumerate due
 *     intents across wallets and resolve each intent's owner.
 *
 *     Notably, `appendPolicyAudit` is owner-scoped and the suite asserts that a
 *     system-context audit append is REFUSED. Task 1.2 learned this the hard way:
 *     an audit/state silent-zero from a system context looks exactly like success.
 *     Rather than add write authority the design does not describe, this unit
 *     proves the boundary and hands the decision to the task that actually needs
 *     it (the `lease_reclaimed` append in slice 2).
 *
 * Methods take an optional `client` so a caller can run several steps in ONE
 * transaction (the §1.6 removal, the §1.5 apply CAS, the §5.4 bookkeeping); when
 * it is omitted the repository opens its own `withUserTransaction`.
 */
import type { DatabaseClient, Queryable } from "../../db/client.js";
import type { GrantPolicyRule } from "../grants/solana-policy-provisioner.js";

export type PolicyStateStatus =
  | "saved_not_configured"
  | "pending"
  | "syncing"
  | "applied"
  | "retryable_failure"
  | "blocked_conflict"
  | "blocked_configuration";

export type PolicyEmptyComposition = "unproven" | "proven_deny" | "unsupported";

export type PolicyIntentOrigin =
  | "screen"
  | "text"
  | "voice"
  | "reconciler"
  | "enrollment"
  | "grant_create"
  | "grant_revoke"
  | "grant_expiry"
  | "migration_backfill";

export type PolicyIntentAction =
  | "create"
  | "edit"
  | "rename"
  | "address_change"
  | "remove";

export type PolicyIntentState =
  | "pending"
  | "applying"
  | "applied"
  | "superseded"
  | "failed";

/** The full `recipient_policy_audit.event` CHECK vocabulary (migration 015). */
export type PolicyAuditEvent =
  | "intent_recorded"
  | "revocation_disclosed"
  | "lease_acquired"
  | "lease_reclaimed"
  | "apply_attempt"
  | "applied"
  | "readback_mismatch"
  | "apply_failed"
  | "superseded"
  | "blocked_conflict"
  | "blocked_configuration"
  | "drift_repaired"
  | "binding_invalidated"
  | "proposal_published"
  | "proposal_consumed"
  | "evidence_refused";

export type ContactProposalKind = "contact" | "transfer";
export type ContactProposalAction = PolicyIntentAction;
export type ContactProposalOrigin = "screen" | "text" | "voice";
export type ContactProposalStatus =
  | "open"
  | "consumed"
  | "expired"
  | "cancelled"
  | "superseded";

/** One wallet's desired-vs-applied policy state (design §2.1). */
export interface PolicyStateRecord {
  walletId: string;
  userId: string;
  desiredRevision: number;
  appliedRevision: number;
  desiredRulesHash: string | null;
  appliedRulesHash: string | null;
  appliedPolicyId: string | null;
  appliedSignerId: string | null;
  appliedSignerIds: string[];
  appliedRecipients: string[];
  consentBaseline: string[];
  consentProvenance: Record<string, unknown>;
  emptyComposition: PolicyEmptyComposition;
  status: PolicyStateStatus;
  statusReason: string | null;
  statusDetail: Record<string, unknown>;
  attemptCount: number;
  nextAttemptAt: string | null;
  verifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** One durable desired intent (design §2.2). */
export interface PolicyIntentRecord {
  id: string;
  walletId: string;
  userId: string;
  desiredRevision: number;
  origin: PolicyIntentOrigin;
  action: PolicyIntentAction | null;
  contactId: string | null;
  contactVersion: number | null;
  composedRules: GrantPolicyRule[];
  composedHash: string;
  idempotencyKey: string | null;
  state: PolicyIntentState;
  attemptCount: number;
  lastError: string | null;
  lastAttemptAt: string | null;
  nextAttemptAt: string | null;
  appliedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** The composer's contact input (design §3.1). */
export interface ComposerContact {
  id: string;
  version: number;
  address: string;
}

/** One immutable proposal version (design §2.3). */
export interface ContactProposalRecord {
  id: string;
  userId: string;
  walletId: string | null;
  conversationId: string | null;
  kind: ContactProposalKind;
  action: ContactProposalAction;
  contactId: string | null;
  contactVersion: number | null;
  address: string;
  previousAddress: string | null;
  revokedGrantIds: string[];
  version: number;
  supersedesId: string | null;
  proposalHash: string;
  origin: ContactProposalOrigin;
  status: ContactProposalStatus;
  createdAt: string;
  expiresAt: string;
  publishedAt: string | null;
  confirmedUserTurn: number | null;
  consumedAt: string | null;
  consumedByTool: string | null;
  consumedBySession: string | null;
}

export interface BumpDesiredRevisionInput {
  walletId: string;
  /** The composed rules hash this desired revision was built from. */
  desiredRulesHash: string;
}

export interface CommitAppliedRevisionInput {
  walletId: string;
  /** The revision the composition was built from. The CAS predicate. */
  desiredRevision: number;
  appliedRulesHash: string;
  appliedPolicyId: string;
  appliedSignerId: string;
  appliedSignerIds: string[];
  appliedRecipients: string[];
}

export interface SetPolicyStatusInput {
  walletId: string;
  status: PolicyStateStatus;
  /** Reason code for the status; `null`/omitted clears it. */
  reason?: string | null;
  /** Bounded evidence only — never a secret, signature, token or transcript. */
  detail?: Record<string, unknown>;
  nextAttemptAt?: Date | null;
  /** Relative bookkeeping for design §5.2 step 5 (`attempt_count + 1`). */
  incrementAttempt?: boolean;
}

export interface InsertPolicyIntentInput {
  walletId: string;
  desiredRevision: number;
  origin: PolicyIntentOrigin;
  action?: PolicyIntentAction | null;
  contactId?: string | null;
  contactVersion?: number | null;
  composedRules: GrantPolicyRule[];
  composedHash: string;
  idempotencyKey?: string | null;
}

export interface ListDueIntentsInput {
  limit: number;
  /** Narrow the scan to one wallet (the per-wallet reconciler pass). */
  walletId?: string;
}

export interface ClaimPolicyIntentInput {
  walletId: string;
  desiredRevision: number;
}

export interface SupersedePolicyIntentInput {
  walletId: string;
  intentId: string;
}

export interface AppendPolicyAuditInput {
  walletId: string;
  event: PolicyAuditEvent;
  desiredRevision?: number | null;
  appliedRevision?: number | null;
  reason?: string | null;
  detail?: Record<string, unknown> | null;
}

export interface InsertContactProposalInput {
  walletId?: string | null;
  conversationId?: string | null;
  kind?: ContactProposalKind;
  action: ContactProposalAction;
  contactId?: string | null;
  contactVersion?: number | null;
  address: string;
  previousAddress?: string | null;
  revokedGrantIds?: string[];
  version?: number;
  supersedesId?: string | null;
  proposalHash: string;
  origin: ContactProposalOrigin;
  expiresAt: Date;
  /** Audit only (design §4.5): the turn ordinal that carried the affirmative. */
  confirmedUserTurn?: number | null;
}

export interface ConsumeContactProposalInput {
  proposalId: string;
  /** The immutable version being consumed; a stale version consumes nothing. */
  version: number;
  consumedByTool: string;
  consumedBySession?: string | null;
}

export interface RefreshSignerGrantProjectionInput {
  walletId: string;
  /** The verified readback's address union (design §5.4). */
  allowlistedRecipients: string[];
  policyHash: string;
}

/**
 * No visible `recipient_policy_state` row for this user and wallet. Raised
 * instead of returning a fabricated default, so a caller can never serialize or
 * bump a wallet the transaction cannot see.
 */
export class PolicyStateMissingError extends Error {}

/**
 * The `(wallet_id, desired_revision)` intent index rejected the row: the same
 * revision was already recorded for this wallet. A retry must load the existing
 * intent instead of composing a second one.
 */
export class PolicyIntentRevisionConflictError extends Error {}

/**
 * The one-in-flight rule rejected the row: this wallet already has an intent in
 * `pending`/`applying`. The caller must supersede it explicitly (design §2.2).
 */
export class PolicyIntentInFlightError extends Error {}

/** The `(wallet_id, idempotency_key)` index rejected the row: a replayed key. */
export class PolicyIntentIdempotencyConflictError extends Error {}

/** The one-open-proposal rule rejected the row: a window is already open. */
export class ContactActionProposalConflictError extends Error {}

/**
 * The named wallet is not owned by the acting user. Raised by every write that
 * names a `wallet_id`, because row isolation alone cannot check this: an
 * `INSERT` policy validates `user_id = app.user_id`, which a caller satisfies
 * trivially by naming itself, so without this guard a foreign wallet id could be
 * planted inside the caller's own scope.
 */
export class PolicyWalletNotOwnedError extends Error {}

const STATE_COLUMNS = `wallet_id, user_id, desired_revision, applied_revision,
  desired_rules_hash, applied_rules_hash, applied_policy_id, applied_signer_id,
  applied_signer_ids, applied_recipients, consent_baseline, consent_provenance,
  empty_composition, status, status_reason, status_detail, attempt_count,
  next_attempt_at, verified_at, created_at, updated_at`;

const INTENT_COLUMNS = `id, wallet_id, user_id, desired_revision, origin, action,
  contact_id, contact_version, composed_rules, composed_hash, idempotency_key,
  state, attempt_count, last_error, last_attempt_at, next_attempt_at, applied_at,
  created_at, updated_at`;

const PROPOSAL_COLUMNS = `id, user_id, wallet_id, conversation_id, kind, action,
  contact_id, contact_version, address, previous_address, revoked_grant_ids,
  version, supersedes_id, proposal_hash, origin, status, created_at, expires_at,
  published_at, confirmed_user_turn, consumed_at, consumed_by_tool,
  consumed_by_session`;

// Unique-index names, so a violation names the guard it broke instead of leaking
// a driver error to the caller.
const INTENT_REVISION_INDEX = "recipient_policy_sync_intent_revision_idx";
const INTENT_INFLIGHT_INDEX = "recipient_policy_sync_intent_inflight_idx";
const INTENT_IDEMPOTENCY_INDEX = "recipient_policy_sync_intent_idempotency_idx";
const PROPOSAL_ONE_OPEN_INDEX = "contact_action_proposals_one_open_idx";

type PolicyStateRow = {
  wallet_id: string;
  user_id: string;
  desired_revision: string | number;
  applied_revision: string | number;
  desired_rules_hash: string | null;
  applied_rules_hash: string | null;
  applied_policy_id: string | null;
  applied_signer_id: string | null;
  applied_signer_ids: string[] | null;
  applied_recipients: string[] | null;
  consent_baseline: string[] | null;
  consent_provenance: Record<string, unknown> | null;
  empty_composition: string;
  status: string;
  status_reason: string | null;
  status_detail: Record<string, unknown> | null;
  attempt_count: string | number;
  next_attempt_at: string | Date | null;
  verified_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type PolicyIntentRow = {
  id: string;
  wallet_id: string;
  user_id: string;
  desired_revision: string | number;
  origin: string;
  action: string | null;
  contact_id: string | null;
  contact_version: string | number | null;
  composed_rules: GrantPolicyRule[];
  composed_hash: string;
  idempotency_key: string | null;
  state: string;
  attempt_count: string | number;
  last_error: string | null;
  last_attempt_at: string | Date | null;
  next_attempt_at: string | Date | null;
  applied_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
};

type ContactProposalRow = {
  id: string;
  user_id: string;
  wallet_id: string | null;
  conversation_id: string | null;
  kind: string;
  action: string;
  contact_id: string | null;
  contact_version: string | number | null;
  address: string;
  previous_address: string | null;
  revoked_grant_ids: string[] | null;
  version: string | number;
  supersedes_id: string | null;
  proposal_hash: string;
  origin: string;
  status: string;
  created_at: string | Date;
  expires_at: string | Date;
  published_at: string | Date | null;
  confirmed_user_turn: string | number | null;
  consumed_at: string | Date | null;
  consumed_by_tool: string | null;
  consumed_by_session: string | null;
};

function iso(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function isoOrNull(value: string | Date | null): string | null {
  return value === null ? null : iso(value);
}

function mapState(row: PolicyStateRow): PolicyStateRecord {
  return {
    walletId: row.wallet_id,
    userId: row.user_id,
    desiredRevision: Number(row.desired_revision),
    appliedRevision: Number(row.applied_revision),
    desiredRulesHash: row.desired_rules_hash,
    appliedRulesHash: row.applied_rules_hash,
    appliedPolicyId: row.applied_policy_id,
    appliedSignerId: row.applied_signer_id,
    appliedSignerIds: row.applied_signer_ids ?? [],
    appliedRecipients: row.applied_recipients ?? [],
    consentBaseline: row.consent_baseline ?? [],
    consentProvenance: row.consent_provenance ?? {},
    emptyComposition: row.empty_composition as PolicyEmptyComposition,
    status: row.status as PolicyStateStatus,
    statusReason: row.status_reason,
    statusDetail: row.status_detail ?? {},
    attemptCount: Number(row.attempt_count),
    nextAttemptAt: isoOrNull(row.next_attempt_at),
    verifiedAt: isoOrNull(row.verified_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapIntent(row: PolicyIntentRow): PolicyIntentRecord {
  return {
    id: row.id,
    walletId: row.wallet_id,
    userId: row.user_id,
    desiredRevision: Number(row.desired_revision),
    origin: row.origin as PolicyIntentOrigin,
    action: row.action as PolicyIntentAction | null,
    contactId: row.contact_id,
    contactVersion:
      row.contact_version === null ? null : Number(row.contact_version),
    composedRules: row.composed_rules,
    composedHash: row.composed_hash,
    idempotencyKey: row.idempotency_key,
    state: row.state as PolicyIntentState,
    attemptCount: Number(row.attempt_count),
    lastError: row.last_error,
    lastAttemptAt: isoOrNull(row.last_attempt_at),
    nextAttemptAt: isoOrNull(row.next_attempt_at),
    appliedAt: isoOrNull(row.applied_at),
    createdAt: iso(row.created_at),
    updatedAt: iso(row.updated_at),
  };
}

function mapProposal(row: ContactProposalRow): ContactProposalRecord {
  return {
    id: row.id,
    userId: row.user_id,
    walletId: row.wallet_id,
    conversationId: row.conversation_id,
    kind: row.kind as ContactProposalKind,
    action: row.action as ContactProposalAction,
    contactId: row.contact_id,
    contactVersion:
      row.contact_version === null ? null : Number(row.contact_version),
    address: row.address,
    previousAddress: row.previous_address,
    revokedGrantIds: row.revoked_grant_ids ?? [],
    version: Number(row.version),
    supersedesId: row.supersedes_id,
    proposalHash: row.proposal_hash,
    origin: row.origin as ContactProposalOrigin,
    status: row.status as ContactProposalStatus,
    createdAt: iso(row.created_at),
    expiresAt: iso(row.expires_at),
    publishedAt: isoOrNull(row.published_at),
    confirmedUserTurn:
      row.confirmed_user_turn === null ? null : Number(row.confirmed_user_turn),
    consumedAt: isoOrNull(row.consumed_at),
    consumedByTool: row.consumed_by_tool,
    consumedBySession: row.consumed_by_session,
  };
}

/** The unique-index name a `23505` error broke, if it was one. */
function uniqueViolationIndex(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as { code?: unknown; constraint?: unknown };
  return candidate.code === "23505" && typeof candidate.constraint === "string"
    ? candidate.constraint
    : undefined;
}

/**
 * Owner-scoped and system-scoped access to the recipient policy sync state.
 * See the module header for the authority contract of each access path.
 */
export class RecipientPolicyRepository {
  public constructor(private readonly database: DatabaseClient) {}

  // -------------------------------------------------------------------------
  // recipient_policy_state — design §2.1, §1.5
  // -------------------------------------------------------------------------

  /** Read the wallet's state row for its owner; `null` when it does not exist. */
  public async readPolicyState(
    userId: string,
    walletId: string,
    client?: Queryable,
  ): Promise<PolicyStateRecord | null> {
    const run = async (query: Queryable) => {
      const result = await query.query<PolicyStateRow>(
        `SELECT ${STATE_COLUMNS}
           FROM recipient_policy_state
          WHERE wallet_id = $1 AND user_id = $2`,
        [walletId, userId],
      );
      return result.rows[0] ? mapState(result.rows[0]) : null;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  /**
   * The `W0(U)` slot of the canonical lock order: create the wallet's state row
   * if it is absent and lock it `FOR UPDATE` for the rest of the caller's
   * transaction. Requires an explicit `client`, because a lock taken in a
   * transaction the repository opened itself would be released before the caller
   * could use it.
   *
   * Throws {@link PolicyStateMissingError} when the row is not visible to this
   * user, which is the honest outcome for a foreign wallet: the owner-isolation
   * policy hides it, so there is nothing to serialize.
   */
  public async lockPolicyState(
    userId: string,
    walletId: string,
    client: Queryable,
  ): Promise<PolicyStateRecord> {
    await this.assertWalletOwned(client, userId, walletId);
    await client.query(
      `INSERT INTO recipient_policy_state (wallet_id, user_id, desired_revision)
       VALUES ($1, $2, 0)
       ON CONFLICT (wallet_id) DO NOTHING`,
      [walletId, userId],
    );
    const result = await client.query<PolicyStateRow>(
      `SELECT ${STATE_COLUMNS}
         FROM recipient_policy_state
        WHERE wallet_id = $1 AND user_id = $2
        FOR UPDATE`,
      [walletId, userId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PolicyStateMissingError(
        `recipient_policy_state for wallet ${walletId} is not visible to this user`,
      );
    }
    return mapState(row);
  }

  /**
   * Record a new desired revision and return it.
   *
   * The status moves to `pending` in the SAME statement on purpose: the additive
   * `recipient_policy_state_applied_complete_ck` from task 1.1 requires
   * `applied_revision = desired_revision` whenever the status is `applied`, so a
   * bump that left the status alone would be a database-level lie — and would be
   * rejected. The applied evidence (`applied_*`) is deliberately NOT cleared
   * here: only a proven divergence destroys it (design §4.3).
   */
  public async bumpDesiredRevision(
    userId: string,
    input: BumpDesiredRevisionInput,
    client?: Queryable,
  ): Promise<number> {
    const run = async (query: Queryable) => {
      const result = await query.query<{ desired_revision: string | number }>(
        `UPDATE recipient_policy_state
            SET desired_revision = desired_revision + 1,
                desired_rules_hash = $3,
                status = 'pending',
                status_reason = NULL,
                updated_at = now()
          WHERE wallet_id = $1 AND user_id = $2
          RETURNING desired_revision`,
        [input.walletId, userId, input.desiredRulesHash],
      );
      const row = result.rows[0];
      if (!row) {
        throw new PolicyStateMissingError(
          `recipient_policy_state for wallet ${input.walletId} is not visible to this user`,
        );
      }
      return Number(row.desired_revision);
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  /**
   * The §1.5 compare-and-set. Returns `true` when the applied revision was
   * committed, `false` when ZERO rows matched — i.e. the desired revision moved
   * while this holder was composing, so the stale writer must record its intent
   * as `superseded` and recompose instead of overwriting.
   *
   * The predicate is what makes a downgrade impossible: `applied_revision` can
   * only ever be written together with the CURRENT desired revision, and desired
   * revisions are monotone.
   *
   * `applied_recipients` is written here with the rest of the verified evidence
   * (§2.1 keeps it so §5.4 can refresh `signer_grants.allowlisted_recipients`
   * from one authoritative place); §1.5's statement is about the revision guard,
   * not an exhaustive column list.
   */
  public async commitAppliedRevision(
    userId: string,
    input: CommitAppliedRevisionInput,
    client?: Queryable,
  ): Promise<boolean> {
    const run = async (query: Queryable) => {
      const result = await query.query(
        `UPDATE recipient_policy_state
            SET applied_revision = $3,
                applied_rules_hash = $4,
                applied_policy_id = $5,
                applied_signer_id = $6,
                applied_signer_ids = $7::jsonb,
                applied_recipients = $8::jsonb,
                status = 'applied',
                status_reason = NULL,
                verified_at = now(),
                updated_at = now()
          WHERE wallet_id = $1 AND user_id = $2 AND desired_revision = $3
          RETURNING wallet_id`,
        [
          input.walletId,
          userId,
          input.desiredRevision,
          input.appliedRulesHash,
          input.appliedPolicyId,
          input.appliedSignerId,
          JSON.stringify(input.appliedSignerIds),
          JSON.stringify(input.appliedRecipients),
        ],
      );
      return result.rowCount === 1;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  /**
   * Record a non-`applied` status transition with its bounded evidence. Returns
   * the updated row, or `null` when the wallet is not visible to this user.
   *
   * `applied` is intentionally reachable only through
   * {@link commitAppliedRevision}: this method can set the status but never the
   * applied revision, so it cannot manufacture a verified readback.
   */
  public async setPolicyStatus(
    userId: string,
    input: SetPolicyStatusInput,
    client?: Queryable,
  ): Promise<PolicyStateRecord | null> {
    const run = async (query: Queryable) => {
      const result = await query.query<PolicyStateRow>(
        `UPDATE recipient_policy_state
            SET status = $3,
                status_reason = $4,
                status_detail = $5::jsonb,
                next_attempt_at = $6,
                attempt_count = attempt_count + $7,
                updated_at = now()
          WHERE wallet_id = $1 AND user_id = $2
          RETURNING ${STATE_COLUMNS}`,
        [
          input.walletId,
          userId,
          input.status,
          input.reason ?? null,
          JSON.stringify(input.detail ?? {}),
          input.nextAttemptAt ?? null,
          input.incrementAttempt ? 1 : 0,
        ],
      );
      return result.rows[0] ? mapState(result.rows[0]) : null;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  // -------------------------------------------------------------------------
  // recipient_policy_sync_intent — design §2.2, §5.2
  // -------------------------------------------------------------------------

  /**
   * Record the durable desired intent for one revision. Owner-scoped: the
   * mutation path knows whose wallet it is composing.
   */
  public async insertIntent(
    userId: string,
    input: InsertPolicyIntentInput,
    client?: Queryable,
  ): Promise<PolicyIntentRecord> {
    const run = async (query: Queryable) => {
      await this.assertWalletOwned(query, userId, input.walletId);
      try {
        const result = await query.query<PolicyIntentRow>(
          `INSERT INTO recipient_policy_sync_intent
             (wallet_id, user_id, desired_revision, origin, action, contact_id,
              contact_version, composed_rules, composed_hash, idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)
           RETURNING ${INTENT_COLUMNS}`,
          [
            input.walletId,
            userId,
            input.desiredRevision,
            input.origin,
            input.action ?? null,
            input.contactId ?? null,
            input.contactVersion ?? null,
            JSON.stringify(input.composedRules),
            input.composedHash,
            input.idempotencyKey ?? null,
          ],
        );
        return mapIntent(result.rows[0]!);
      } catch (error) {
        throw asIntentConflict(error, input.walletId, input.desiredRevision);
      }
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  /**
   * The reconciler's due scan. Runs in the ANONYMOUS system context (no
   * `app.user_id`), because it enumerates intents for every wallet and needs
   * each row's `user_id` to resolve the owner before any owner-scoped work. The
   * `recipient_policy_sync_intent_system_access` policy from `015` exists for
   * exactly this and is the whole authority this method uses.
   *
   * `next_attempt_at IS NULL` is due now (a fresh intent); a future deadline is
   * the backoff the reconciler itself set, so it is excluded rather than
   * hot-looped. Ordering matches the partial due index.
   */
  public async listDueIntents(
    input: ListDueIntentsInput,
    client?: Queryable,
  ): Promise<PolicyIntentRecord[]> {
    const run = async (query: Queryable) => {
      const result = await query.query<PolicyIntentRow>(
        `SELECT ${INTENT_COLUMNS}
           FROM recipient_policy_sync_intent
          WHERE state IN ('pending', 'applying')
            AND (next_attempt_at IS NULL OR next_attempt_at <= now())
            AND ($2::uuid IS NULL OR wallet_id = $2)
          ORDER BY next_attempt_at ASC, desired_revision ASC
          LIMIT $1`,
        [input.limit, input.walletId ?? null],
      );
      return result.rows.map(mapIntent);
    };
    return client ? run(client) : this.systemTransaction(run);
  }

  /**
   * Claim a due intent for applying: mark it `applying` and stamp
   * `last_attempt_at`. System-scoped for the same reason as the due scan.
   *
   * `null` means there was nothing to claim for that revision — never a
   * fabricated claim. Re-claiming a row already in `applying` is allowed and
   * idempotent: the lease (W1) is what serializes holders, and restart recovery
   * must be able to re-claim a row whose holder died.
   */
  public async claimIntent(
    input: ClaimPolicyIntentInput,
    client?: Queryable,
  ): Promise<PolicyIntentRecord | null> {
    const run = async (query: Queryable) => {
      const result = await query.query<PolicyIntentRow>(
        `UPDATE recipient_policy_sync_intent
            SET state = 'applying',
                last_attempt_at = now(),
                updated_at = now()
          WHERE wallet_id = $1
            AND desired_revision = $2
            AND state IN ('pending', 'applying')
          RETURNING ${INTENT_COLUMNS}`,
        [input.walletId, input.desiredRevision],
      );
      return result.rows[0] ? mapIntent(result.rows[0]) : null;
    };
    return client ? run(client) : this.systemTransaction(run);
  }

  /**
   * Supersede an in-flight intent so the next mutation can record its revision.
   * Owner-scoped, and part of the caller's transaction: the supersede and the
   * insert that replaces it must commit together, otherwise the one-in-flight
   * index would either reject the new intent or leave a window with none.
   *
   * Returns `false` when nothing was superseded (foreign, already terminal).
   */
  public async supersedeIntent(
    userId: string,
    input: SupersedePolicyIntentInput,
    client?: Queryable,
  ): Promise<boolean> {
    const run = async (query: Queryable) => {
      const result = await query.query(
        `UPDATE recipient_policy_sync_intent
            SET state = 'superseded', updated_at = now()
          WHERE id = $1 AND wallet_id = $2 AND user_id = $3
            AND state IN ('pending', 'applying')
          RETURNING id`,
        [input.intentId, input.walletId, userId],
      );
      return result.rowCount === 1;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  // -------------------------------------------------------------------------
  // Composer contact input — design §3.1
  // -------------------------------------------------------------------------

  /**
   * The contacts the composer may place in the ordinary rule: active,
   * Solana-scoped, with the version a caller must echo back on a mutation.
   *
   * `recipients.address_confirmed_at` is NOT NULL by schema (migration 001), so
   * there is no extra "confirmed" predicate to add — the confirmation axis for a
   * policy rule is the chain scope (`network = 'solana-devnet'`) plus active
   * status. Legacy rows with a NULL network are EVM contacts (migration 012) and
   * have no Solana policy semantics, so they are never composed.
   */
  public async listComposerContacts(
    userId: string,
    client?: Queryable,
  ): Promise<ComposerContact[]> {
    const run = async (query: Queryable) => {
      const result = await query.query<{
        id: string;
        version: string | number;
        address: string;
      }>(
        `SELECT id, version, address
           FROM recipients
          WHERE user_id = $1 AND status = 'active' AND network = 'solana-devnet'
          ORDER BY id ASC`,
        [userId],
      );
      return result.rows.map((row) => ({
        id: row.id,
        version: Number(row.version),
        address: row.address,
      }));
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  // -------------------------------------------------------------------------
  // recipient_policy_audit — design §2.5
  // -------------------------------------------------------------------------

  /**
   * Append one audit row and return its id. Owner-scoped by construction: the
   * table is append-only (BEFORE UPDATE OR DELETE guard) and owner-isolated, and
   * this repository deliberately holds no authority to write it from a system
   * context. See the module header.
   */
  public async appendPolicyAudit(
    userId: string,
    input: AppendPolicyAuditInput,
    client?: Queryable,
  ): Promise<string> {
    const run = async (query: Queryable) => {
      await this.assertWalletOwned(query, userId, input.walletId);
      const result = await query.query<{ id: string }>(
        `INSERT INTO recipient_policy_audit
           (wallet_id, user_id, desired_revision, applied_revision, event, reason, detail)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
         RETURNING id`,
        [
          input.walletId,
          userId,
          input.desiredRevision ?? null,
          input.appliedRevision ?? null,
          input.event,
          input.reason ?? null,
          input.detail ? JSON.stringify(input.detail) : null,
        ],
      );
      return result.rows[0]!.id;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  // -------------------------------------------------------------------------
  // contact_action_proposals — design §2.3, §4.5
  // -------------------------------------------------------------------------

  /**
   * Persist an immutable proposal version. The identity columns
   * (`address`, `action`, `version`, `revoked_grant_ids`) are never updated
   * afterwards; a changed address is a NEW row with an incremented version.
   *
   * The one-open-per-conversation rule is the database's: a second open proposal
   * for the same `(user_id, conversation_id)` raises
   * {@link ContactActionProposalConflictError} rather than silently racing.
   */
  public async insertProposal(
    userId: string,
    input: InsertContactProposalInput,
    client?: Queryable,
  ): Promise<ContactProposalRecord> {
    const run = async (query: Queryable) => {
      // `wallet_id` is nullable here (a transfer-shaped proposal may not name
      // one), so the guard applies exactly when a wallet is named.
      if (input.walletId) {
        await this.assertWalletOwned(query, userId, input.walletId);
      }
      try {
        const result = await query.query<ContactProposalRow>(
          `INSERT INTO contact_action_proposals
             (user_id, wallet_id, conversation_id, kind, action, contact_id,
              contact_version, address, previous_address, revoked_grant_ids,
              version, supersedes_id, proposal_hash, origin, expires_at,
              confirmed_user_turn)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::uuid[], $11, $12,
                   $13, $14, $15, $16)
           RETURNING ${PROPOSAL_COLUMNS}`,
          [
            userId,
            input.walletId ?? null,
            input.conversationId ?? null,
            input.kind ?? "contact",
            input.action,
            input.contactId ?? null,
            input.contactVersion ?? null,
            input.address,
            input.previousAddress ?? null,
            input.revokedGrantIds ?? [],
            input.version ?? 1,
            input.supersedesId ?? null,
            input.proposalHash,
            input.origin,
            input.expiresAt,
            input.confirmedUserTurn ?? null,
          ],
        );
        return mapProposal(result.rows[0]!);
      } catch (error) {
        if (uniqueViolationIndex(error) === PROPOSAL_ONE_OPEN_INDEX) {
          throw new ContactActionProposalConflictError(
            "another contact action proposal is already open for this conversation",
          );
        }
        throw error;
      }
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  /** Read one proposal row for its owner; `null` for a foreign or missing row. */
  public async readProposal(
    userId: string,
    proposalId: string,
    client?: Queryable,
  ): Promise<ContactProposalRecord | null> {
    const run = async (query: Queryable) => {
      const result = await query.query<ContactProposalRow>(
        `SELECT ${PROPOSAL_COLUMNS}
           FROM contact_action_proposals
          WHERE id = $1 AND user_id = $2`,
        [proposalId, userId],
      );
      return result.rows[0] ? mapProposal(result.rows[0]) : null;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  /**
   * Consume one proposal version exactly once (design §4.5). The whole predicate
   * is in the statement: the id AND the version AND the owner AND `status='open'`
   * AND `consumed_at IS NULL` AND a live `expires_at`. A second consumer with the
   * same tuple blocks on the row lock, re-evaluates the predicate against the
   * committed row and matches nothing, so it receives `null`.
   *
   * A stale version, an expired proposal and a foreign proposal are all the same
   * answer — `null` — because in every one of those cases there is nothing to
   * consume and the caller must not proceed.
   */
  public async consumeProposal(
    userId: string,
    input: ConsumeContactProposalInput,
    client?: Queryable,
  ): Promise<ContactProposalRecord | null> {
    const run = async (query: Queryable) => {
      const result = await query.query<ContactProposalRow>(
        `UPDATE contact_action_proposals
            SET status = 'consumed',
                consumed_at = now(),
                consumed_by_tool = $4,
                consumed_by_session = $5
          WHERE id = $1 AND user_id = $2 AND version = $3
            AND status = 'open'
            AND consumed_at IS NULL
            AND expires_at > now()
          RETURNING ${PROPOSAL_COLUMNS}`,
        [
          input.proposalId,
          userId,
          input.version,
          input.consumedByTool,
          input.consumedBySession ?? null,
        ],
      );
      return result.rows[0] ? mapProposal(result.rows[0]) : null;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  // -------------------------------------------------------------------------
  // signer_grants projection — design §5.4
  // -------------------------------------------------------------------------

  /**
   * Refresh the wallet's newest `state='active'` `signer_grants` row so the two
   * representations of the same intent agree: `allowlisted_recipients` becomes
   * the verified address union and `policy_hash` the hash the caller verified
   * with. Returns the refreshed grant id, or `null` when the wallet has no active
   * enrollment — nothing to refresh is an honest no-op, never a fabricated row.
   *
   * Older active grants and revoked grants are left untouched: the projection
   * follows the newest active enrollment only.
   */
  public async refreshSignerGrantProjection(
    userId: string,
    input: RefreshSignerGrantProjectionInput,
    client?: Queryable,
  ): Promise<string | null> {
    const run = async (query: Queryable) => {
      const result = await query.query<{ id: string }>(
        `UPDATE signer_grants
            SET allowlisted_recipients = $3::jsonb,
                policy_hash = $4,
                updated_at = now()
          WHERE id = (
            SELECT id FROM signer_grants
             WHERE user_id = $1 AND wallet_id = $2 AND state = 'active'
             ORDER BY created_at DESC, id DESC
             LIMIT 1
          )
          RETURNING id`,
        [
          userId,
          input.walletId,
          JSON.stringify(input.allowlistedRecipients),
          input.policyHash,
        ],
      );
      return result.rows[0]?.id ?? null;
    };
    return client ? run(client) : this.ownerTransaction(userId, run);
  }

  // -------------------------------------------------------------------------
  // Transaction helpers
  // -------------------------------------------------------------------------

  /**
   * Prove the acting user really owns the wallet this statement names, inside
   * the caller's transaction (so the check and the write cannot be split).
   *
   * This is the narrow place where the repository enforces something row
   * isolation cannot express. See {@link PolicyWalletNotOwnedError}.
   */
  private async assertWalletOwned(
    client: Queryable,
    userId: string,
    walletId: string,
  ): Promise<void> {
    const result = await client.query(
      `SELECT 1 FROM user_wallets WHERE id = $1 AND user_id = $2`,
      [walletId, userId],
    );
    if (result.rowCount === 0) {
      throw new PolicyWalletNotOwnedError(
        `wallet ${walletId} is not owned by the acting user`,
      );
    }
  }

  /** The owner path: `app.user_id` is set, so row isolation applies. */
  private ownerTransaction<T>(
    userId: string,
    operation: (client: Queryable) => Promise<T>,
  ): Promise<T> {
    return this.database.withUserTransaction(userId, operation);
  }

  /**
   * The reconciler path: no `app.user_id`, so only the system-access policies
   * apply. Used by the due scan and the in-flight claim, and by nothing else.
   */
  private systemTransaction<T>(
    operation: (client: Queryable) => Promise<T>,
  ): Promise<T> {
    return this.database.withSystemTransaction(operation);
  }
}

/**
 * Translate a unique-index violation into the guard it broke. The index names
 * come from `015`; anything else is rethrown untouched so a real defect is never
 * disguised as a domain conflict.
 */
function asIntentConflict(
  error: unknown,
  walletId: string,
  desiredRevision: number,
): Error {
  switch (uniqueViolationIndex(error)) {
    case INTENT_REVISION_INDEX:
      return new PolicyIntentRevisionConflictError(
        `wallet ${walletId} already recorded a desired revision ${desiredRevision} intent`,
      );
    case INTENT_INFLIGHT_INDEX:
      return new PolicyIntentInFlightError(
        `wallet ${walletId} already has an intent in flight; supersede it before recording another`,
      );
    case INTENT_IDEMPOTENCY_INDEX:
      return new PolicyIntentIdempotencyConflictError(
        `wallet ${walletId} already recorded an intent with this idempotency key`,
      );
    default:
      return error instanceof Error ? error : new Error(String(error));
  }
}
