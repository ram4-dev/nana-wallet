/**
 * `RecipientPolicyService` — the single writer of trusted-recipient intent
 * (design §3.1, §3.5, §1.6, §12.1).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Slice 1 collapses three full-rule writers into one composer. This is the module
 * that decides *what a caller is allowed to say* and *what the composer is given*,
 * so that every other path — screen, text agent, voice agent, grant create,
 * revoke, expiry, retry — can only ask for a mutation instead of assembling a
 * rule set of its own.
 *
 * Three properties this module guarantees:
 *
 *  1. **Identity, wallet and network are server-owned.** The strict seam schemas
 *     below are `.strict()`: a body carrying `policyId`, `signerId`, a cap, a
 *     wallet id or an unknown `network` is rejected with a typed validation error
 *     before anything is persisted (spec "Server owns identity, wallet, and
 *     network"). The wallet comes from `user_wallets` for the acting user, and
 *     the chain scope comes from the product's single configuration — never from
 *     the body.
 *  2. **The composer gets consent-derived input only.** `ComposeInput` is
 *     assembled from the RLS-scoped contacts read, the ledger-shaped active
 *     grants and `recipient_policy_state`, whose `consent_baseline` /
 *     `consent_provenance` are captured ONCE from the newest active
 *     `signer_grants` enrollment row and never re-derived (design §2.1). A remote
 *     readback is never a consent source, so nothing here can copy observed state
 *     into desired state.
 *  3. **Slice 1 performs no live policy write.** The apply port is a seam slice 2
 *     fills; the only capability this slice can be wired with is `unavailable`,
 *     and a signed one is refused at construction rather than driven (design
 *     §12.1). The durable intent is what makes that honest instead of lossy: the
 *     mutation records the exact rules and hash it composed, so the reconciler
 *     applies THAT revision later instead of recomputing one from mutable tables.
 *
 * STATUS HONESTY
 * --------------
 * `readContactPermission` is the only surface the API has, so it is a pure
 * projection that fails closed: a row may claim `applied` only when the verified
 * readback exists and the applied revision is current (spec "Effective status
 * vocabulary and no premature success"). No secret, signature, token or key
 * material can reach it, because its key set is closed.
 */
import { z } from "zod";
import type { DatabaseClient, Queryable } from "../../db/client.js";
import {
  isRecipientPolicyWriterFrozen,
  RECIPIENT_POLICY_WRITER_FROZEN_REASON,
} from "../../config/recipient-policy.js";
import { isValidRecipientAddress, CONFIGURED_RECIPIENT_NETWORK } from "../../memory/address.js";
import { SOLANA_MAX_PER_TRANSFER_LAMPORTS } from "../embedded.js";
import { appendGrantAudit } from "../grants/consumption.js";
import {
  composePolicy,
  type ComposedPolicy,
  type ComposedProvenance,
  type GrantPolicyInput,
  type GrantPolicyRule,
} from "./composer.js";
import {
  PolicyCompositionRefusalError,
  RecipientContactMissingError,
  RecipientPolicyConflictError,
  RecipientPolicyNotSerializedError,
  RecipientPolicyRemovalConflictError,
  RecipientPolicyRevisionConflictError,
  RecipientPolicyValidationError,
  type RecipientPolicyValidationIssue,
} from "./errors.js";
import {
  acquirePolicyLease,
  releasePolicyLease,
  POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS,
} from "./lease.js";
import {
  RecipientPolicyRepository,
  type PolicyIntentAction,
  type PolicyIntentOrigin,
  type PolicyStateRecord,
  type PolicyStateStatus,
} from "./repository.js";

/**
 * The refusal vocabulary a caller of this service must map: the composition
 * refusals reported as `blocked_configuration` and the seam's own typed failures.
 * Re-exported here — the module seam — so a caller has one import surface and the
 * slice-2 apply path maps the same types it will raise.
 */
export {
  PolicyComposerRequiredError,
  PolicyCompositionRefusalError,
  PolicyEmptyCompositionUnprovenError,
  PolicyOrdinaryCapUnsupportedError,
  PolicyRuleCompositionUnprovenError,
  RecipientContactMissingError,
  RecipientContactVersionConflictError,
  RecipientPolicyConflictError,
  RecipientPolicyNotSerializedError,
  RecipientPolicyRemovalConflictError,
  RecipientPolicyRevisionConflictError,
  RecipientPolicySeamError,
  RecipientPolicyValidationError,
} from "./errors.js";
export type { PolicyCompositionRefusalReason } from "./errors.js";
export type {
  RecipientPolicySeamErrorCode,
  RecipientPolicyValidationIssue,
} from "./errors.js";

/**
 * The single configuration's chain scope: the product runs Solana devnet only,
 * and it is not a switch a body or a query can set (AGENTS.md). The literal
 * lives in `src/memory/address.ts` so the recipient validator and this policy
 * scope cannot drift apart.
 */
export const SOLANA_POLICY_NETWORK = CONFIGURED_RECIPIENT_NETWORK;

/**
 * The ledger chain FAMILY the active grants are read by. It is the same value
 * `privy-policy-runtime.ts` passes, and `listActiveGrants` already refuses any
 * other value — so a wrong constant here fails closed instead of reading a
 * different family's grants.
 */
const SOLANA_LEDGER_CHAIN = "solana";

/** Bounded validation evidence: a body may not turn its own rejection into a dump. */
const MAX_VALIDATION_ISSUES = 8;

// ---------------------------------------------------------------------------
// The strict service seam (design §9.2)
// ---------------------------------------------------------------------------

/**
 * The Solana recipient scope every contact is validated and written with. The
 * network is NOT a parameter: it is the derived scope, and the shared validator is
 * asked about that scope rather than about whatever the body claimed.
 */
const derivedAddressSchema = z
  .string()
  .trim()
  .min(1)
  .refine((value) => isValidRecipientAddress(value, SOLANA_POLICY_NETWORK), {
    message: `address must be a canonical ${SOLANA_POLICY_NETWORK} address`,
  });

const derivedNetworkSchema = z.literal(SOLANA_POLICY_NETWORK);

/**
 * `POST /v1/contacts` (design §9.2). `.strict()` — precedent `src/memory/tools.ts`
 * — so an extra key is a rejection rather than a silently ignored field: the
 * contract's whole point is that identity, cap and chain scope cannot be supplied.
 */
export const recipientCreateInputSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().default(""),
    address: derivedAddressSchema,
    network: derivedNetworkSchema.optional(),
  })
  .strict();

/**
 * `PATCH /v1/contacts/:id` (design §9.2). `expectedVersion` is required: an edit
 * that does not say which version it read is an overwrite, and the service must be
 * able to refuse it. At least one editable field must be present, so an edit is
 * never a no-op that still advances a revision.
 */
export const recipientEditInputSchema = z
  .object({
    name: z.string().trim().min(1).optional(),
    description: z.string().trim().optional(),
    address: derivedAddressSchema.optional(),
    network: derivedNetworkSchema.optional(),
    expectedVersion: z.number().int().positive(),
    expectedPolicyRevision: z.number().int().nonnegative().optional(),
  })
  .strict()
  .refine(
    (value) =>
      value.name !== undefined ||
      value.description !== undefined ||
      value.address !== undefined,
    {
      message: "an edit must carry at least one of name, description or address",
      path: [],
    },
  );

export type RecipientCreateInput = z.output<typeof recipientCreateInputSchema>;
export type RecipientEditInput = z.output<typeof recipientEditInputSchema>;

/**
 * `DELETE /v1/contacts/:id` (design §1.6, §9.2). `expectedVersion` is the
 * version-CAS the archive statement carries, so a removal that did not say which
 * version it read cannot overwrite a newer one. `idempotencyKey` is the optional
 * `Idempotency-Key` header, made durable on the intent row in the same
 * transaction (detecting the replay is the contract vertical's unit).
 */
export const recipientRemovalInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    idempotencyKey: z.string().trim().min(1).max(200).nullish(),
  })
  .strict();

/**
 * The route parameter and the wallet identifier, validated before either can
 * reach a UUID-typed query: a malformed identifier must be a typed refusal, not a
 * driver error.
 */
const uuidSchema = z.string().uuid();

/**
 * The route parameter wrapped so its refusal names the field it came from. A
 * top-level scalar schema reports an empty path, which would leave the caller
 * unable to tell a bad contact id from a bad body.
 */
const contactIdInputSchema = z.object({ contactId: uuidSchema }).strict();

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

/** One contact as the mutation port reports it back. */
export type RecipientContactRecord = {
  id: string;
  name: string;
  description: string;
  address: string;
  network: typeof SOLANA_POLICY_NETWORK | null;
  version: number;
};

/** The create shape the port writes. The network is always the derived scope. */
export type RecipientContactWriteInput = {
  name: string;
  description: string;
  address: string;
  network: typeof SOLANA_POLICY_NETWORK;
};

/** The patch shape the port writes; `expectedVersion` is its compare-and-set. */
export type RecipientContactPatchInput = {
  name?: string;
  description?: string;
  address?: string;
  network?: typeof SOLANA_POLICY_NETWORK;
  expectedVersion: number;
};

/**
 * The contact-mutation port (design §3.3, §1.6 step 7): the ONLY way this service
 * writes a contact.
 *
 * It receives the caller's transaction `client`, so the contact write, the
 * desired revision, the durable intent and the audit rows commit together. That
 * is not a convenience: a mutation that persisted a contact without its revision
 * would leave the policy silently behind the user's intent, and one that recorded
 * a revision without the contact would compose a rule set the user never asked
 * for.
 *
 * The production adapter lives with the HTTP vertical (it needs the embedding
 * provider that `recipients.embedding` requires); this port is the seam, and it
 * is also why nothing in `src/wallet/policy/**` imports `ContactsRepository`.
 */
export type RecipientContactMutationPort = {
  create(
    userId: string,
    input: RecipientContactWriteInput,
    client: Queryable,
  ): Promise<RecipientContactRecord>;
  update(
    userId: string,
    contactId: string,
    input: RecipientContactPatchInput,
    client: Queryable,
  ): Promise<RecipientContactRecord>;
  /**
   * Design §1.6 step 7: the version-CAS archive
   * (`SET status='inactive' WHERE user_id=$1 AND id=$2 AND version=$3`).
   *
   * Zero rows means the contact moved or disappeared since the caller read it,
   * and that is a conflict — never a silent success. The port reports it as
   * {@link RecipientContactVersionConflictError} (the seam's `409 VERSION_OBSOLETA`),
   * exactly as `update` reports its own version CAS; the production adapter is
   * where `ContactsRepository`'s `ContactsConflictError` is translated.
   */
  archive(
    userId: string,
    contactId: string,
    expectedVersion: number,
    client: Queryable,
  ): Promise<RecipientContactRecord>;
  /** Owner-scoped read, inside the caller's transaction when one is given. */
  readActive(
    userId: string,
    contactId: string,
    client?: Queryable,
  ): Promise<RecipientContactRecord | null>;
};

/**
 * The ledger-shaped active grants read (design §3.1). The existing
 * `PrivyPolicyAdminClient.listActiveGrants` satisfies it, including its refusal
 * to read any chain family other than this one.
 */
export type ActiveGrantLister = (
  walletId: string,
  userId: string,
  chain: string,
) => Promise<GrantPolicyInput[]>;

/**
 * What the signed apply capability receives (design §3.5 steps 4-9).
 *
 * The owner-verified binding is NOT a positional guess: `providerWalletId` and
 * `canonicalSignerId` are the recorded `user_wallets` binding, and the adapter is
 * what re-reads them through the owner-verified listing (checks (e)-(g), §5.1).
 * `appliedSignerIds` is the last verified readback's signer set, so a lost
 * sibling signer is detectable. `provenance` is the recorded consent map the
 * address check (d) is decided against.
 */
export type PolicyApplyRequest = {
  userId: string;
  walletId: string;
  /** `user_wallets.provider_wallet_id` for the owner-verified comparison. */
  providerWalletId: string;
  /** `user_wallets.provider_signer_id` through `resolvePolicyTarget`. */
  canonicalSignerId: string;
  desiredRevision: number;
  /** The policy the revision is expected to be attached to, when one is known. */
  appliedPolicyId: string | null;
  /** `recipient_policy_state.applied_signer_ids` of the last verified readback. */
  appliedSignerIds: string[];
  composedHash: string;
  rules: GrantPolicyRule[];
  provenance: ComposedProvenance;
};

/** Bounded, secret-free evidence for `status_detail` (never a signature). */
export type PolicyApplyDetail = Record<
  string,
  string | number | boolean | null
>;

/**
 * What the signed apply capability reports back, and nothing else.
 *
 * `unverified` and `retryable_failure` are DIFFERENT answers (design §5.3,
 * spec "Timeout is reported as unverified"): an `unverified` outcome means the
 * remote write may have landed and only a GET can decide, while `retryable_-
 * failure` means nothing was sent or the provider rejected the request outright.
 * Collapsing them would either retry a landed write or refuse a safe one.
 */
export type PolicyApplyOutcome =
  | {
      readonly kind: "verified";
      readonly appliedPolicyId: string;
      readonly appliedSignerId: string;
      readonly appliedSignerIds: string[];
      readonly appliedRulesHash: string;
      readonly appliedRecipients: string[];
      readonly detail: PolicyApplyDetail;
    }
  | {
      readonly kind: "unverified";
      readonly reason: string;
      readonly detail: PolicyApplyDetail;
    }
  | {
      readonly kind: "retryable_failure";
      readonly reason: string;
      readonly detail: PolicyApplyDetail;
    }
  | {
      readonly kind: "blocked";
      /** §5.1 failure class: a conflict about the remote rules or the binding. */
      readonly failureClass: "blocked_conflict" | "blocked_configuration";
      readonly reason: string;
      readonly detail: PolicyApplyDetail;
    };

/**
 * The apply seam (design §3.5 steps 4-10).
 *
 * Two arms, and the difference is a deployment fact, not a test convenience:
 * `unavailable` is a deployment whose signed-authorization capability is not
 * configured (no sidecar), so the durable intent is left for the reconciler and
 * the recorded status says so. `signed` is the real path
 * (`src/wallet/policy/apply.ts`), which performs steps 4-9 over the provider and
 * returns the evidence step 10 commits.
 *
 * Slice 1 refused the `signed` arm at construction because no implementation
 * existed. Task 2.8 supplies it, so that refusal is DELETED — not relaxed: the
 * unimplemented state is no longer representable at all.
 */
export type PolicyApplyUnavailablePort = {
  readonly kind: "unavailable";
  /** Why this deployment cannot apply: recorded as the pending status reason. */
  readonly reason: string;
};

export type PolicyApplySignedPort = {
  readonly kind: "signed";
  apply(request: PolicyApplyRequest): Promise<PolicyApplyOutcome>;
};

export type PolicyApplyPort = PolicyApplyUnavailablePort | PolicyApplySignedPort;

/** The shipped slice-1 capability: the durable intent is left for the reconciler. */
export function createUnavailablePolicyApplyPort(
  reason: string,
): PolicyApplyUnavailablePort {
  return { kind: "unavailable", reason };
}

/**
 * Task 2.13 / design §13: resolve the apply port from `RECIPIENT_POLICY_WRITER`.
 *
 * `frozen` returns the `unavailable` port — the one arm of `PolicyApplyPort` with
 * NO mutation method at all — so "issues no PATCH, leaves the attached policy
 * intact" is structural rather than a condition buried inside the apply path. A
 * frozen writer also resolves the reconciler switch off (see
 * `src/config/recipient-policy.ts`), because a loop that cannot apply anything
 * would only write statuses nobody asked for.
 *
 * Non-destructive in both directions: freezing cannot delete a policy, clear a
 * binding, or widen authority — it can only remove the capability to write.
 */
export function selectPolicyApplyPort<TPort extends PolicyApplySignedPort>(input: {
  environment: NodeJS.ProcessEnv;
  signed: TPort;
}): PolicyApplyUnavailablePort | TPort {
  if (isRecipientPolicyWriterFrozen(input.environment)) {
    return createUnavailablePolicyApplyPort(
      RECIPIENT_POLICY_WRITER_FROZEN_REASON,
    );
  }
  return input.signed;
}

export type RecipientPolicyServiceDependencies = {
  database: DatabaseClient;
  repository: RecipientPolicyRepository;
  contacts: RecipientContactMutationPort;
  listActiveGrants: ActiveGrantLister;
  provider: PolicyApplyPort;
  /**
   * The `W1` slot's bounded wait (design §1.4/§1.6 step 1). Injectable so the
   * lease budget is asserted deterministically and so a test can contend for the
   * wallet without paying the production 3 000 ms budget.
   */
  policyLease?: { waitBudgetMs?: number; ownerId?: string };
};

/** Per-mutation context a caller owns (the HTTP layer supplies the header value). */
export type RecipientMutationOptions = {
  /** Design §2.2 `origin`: which surface asked for the mutation. */
  origin?: PolicyIntentOrigin;
  /**
   * Design §9.1: stored on the intent so a replay can be answered from durable
   * state. Detecting the replay and returning the stored result is the contract
   * vertical's unit — this service only makes the key durable in the same
   * transaction as the intent it names.
   */
  idempotencyKey?: string | null;
  /** Runs inside the same committed mutation transaction (for proposal CAS). */
  beforeCommit?: (client: Queryable) => Promise<void>;
  /** Immutable disclosure supplied by a proposal/UI preflight. */
  expectedRevokedGrantIds?: readonly string[];
};

/**
 * Bookkeeping a caller may attach to the apply path (design §3.5 step 10).
 *
 * `confirmedBy` exists for exactly one caller: the reconciler's §5.3
 * GET-before-retry, where the composition was never observed being written and
 * the readback is what proves it landed. Persisting that provenance is the
 * difference between a verified apply and a promoted one.
 */
export type PolicyApplyBookkeepingOptions = {
  confirmedBy?: "get_after_timeout";
};
// ---------------------------------------------------------------------------
// Read projection (design §9.1)
// ---------------------------------------------------------------------------

/**
 * The closed `permission` shape the contract publishes (design §9.1). Nothing
 * else may appear: no policy id, no signer, no signature, no token.
 */
export type ContactPermissionSnapshot = {
  state: PolicyStateStatus;
  desiredRevision: number;
  appliedRevision: number;
  retryable: boolean;
  reason?: string;
};

/** The readiness values that mean "the reconciler still has work to do". */
const RETRIABLE_STATUSES: readonly PolicyStateStatus[] = [
  "pending",
  "syncing",
  "retryable_failure",
];

/**
 * Project a state row onto the contract's `permission` (design §9.1).
 *
 * Fail closed on `applied`: the row may only report it when a verified readback
 * exists (`verified_at`) AND the applied revision is the current desired one.
 * A successful call is not evidence, so a row claiming otherwise is reported as
 * `pending` — never as success (spec "Status honesty is contractual").
 */
export function projectContactPermission(
  state: PolicyStateRecord | null,
): ContactPermissionSnapshot {
  if (!state) {
    return {
      state: "saved_not_configured",
      desiredRevision: 0,
      appliedRevision: 0,
      retryable: false,
    };
  }

  const base = {
    state: state.status,
    desiredRevision: state.desiredRevision,
    appliedRevision: state.appliedRevision,
  };

  if (state.status === "applied") {
    if (state.verifiedAt === null) {
      return {
        ...base,
        state: "pending",
        retryable: true,
        reason: "unverified_applied_readback",
      };
    }
    if (state.appliedRevision !== state.desiredRevision) {
      return {
        ...base,
        state: "pending",
        retryable: true,
        reason: "applied_revision_behind_desired",
      };
    }
    return { ...base, retryable: false };
  }

  const reason = state.statusReason;
  return {
    ...base,
    retryable: RETRIABLE_STATUSES.includes(state.status),
    ...(reason ? { reason } : {}),
  };
}

/** What a mutation returns: the persisted contact and the honest status. */
export type RecipientMutationResult = {
  contact: RecipientContactRecord;
  permission: ContactPermissionSnapshot;
  /** The desired revision this mutation recorded; `0` when none was recorded. */
  policyRevision: number;
};

/**
 * Design §9.2's `revocation` object: which grants the removal revoked, and how far
 * the REMOTE revocation has got. The vocabulary has no "verified" shortcut —
 * `applied` means a signed readback confirmed the new rules and the signer
 * attachment, which is why it can only be reached through
 * {@link projectContactPermission}'s already-fail-closed projection.
 */
export type RecipientRevocationDisclosure = {
  grantIds: string[];
  state: "pending" | "applied" | "retryable_failure";
};

/**
 * Project the revoked grant ids and the wallet's permission onto the disclosure
 * the removal reports (design §9.2, §12, spec "A pending removal is not announced
 * as a verified revocation").
 *
 * This is the ONE place the `applied` claim can be produced, and it defers
 * entirely to {@link projectContactPermission}: a state row that claims `applied`
 * without `verified_at`, or whose applied revision is behind the desired one, has
 * already collapsed to `pending` there — so a removal can never report its
 * revocation as verified before a readback, no matter what the row says about
 * itself.
 */
export function projectRevocationDisclosure(
  grantIds: readonly string[],
  permission: ContactPermissionSnapshot,
): RecipientRevocationDisclosure {
  const ids = [...grantIds];
  if (permission.state === "applied") {
    return { grantIds: ids, state: "applied" };
  }
  if (permission.state === "retryable_failure") {
    return { grantIds: ids, state: "retryable_failure" };
  }
  return { grantIds: ids, state: "pending" };
}

/** What a removal returns: the archived contact, the status, and the disclosure. */
export type RecipientRemovalResult = RecipientMutationResult & {
  revocation: RecipientRevocationDisclosure;
};

/**
 * The immutable Phase A proposal payload (design §1.6 step 5).
 *
 * It is built from the UNLOCKED read on purpose: it is what the user is shown
 * before the mutation runs, so it must be a frozen statement of what was planned,
 * not something the transaction can move. The locked re-derivation is compared
 * against it (see {@link RecipientPolicyService.remove}) and a difference aborts
 * the transaction instead of revoking a scope the disclosure never named.
 */
type RemovalProposalPayload = {
  action: "remove";
  contactId: string;
  contactVersion: number;
  address: string;
  affectedGrantIds: string[];
};

/** The Phase A read the transaction is planned from and audited against. */
type RemovalPlan = {
  address: string;
  aliasIds: string[];
  lastAlias: boolean;
  affectedGrantIds: string[];
  payload: RemovalProposalPayload;
};

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

export class RecipientPolicyService {
  private readonly database: DatabaseClient;
  private readonly repository: RecipientPolicyRepository;
  private readonly contacts: RecipientContactMutationPort;
  private readonly listActiveGrants: ActiveGrantLister;
  /**
   * Either arm (design §3.5). Task 2.8 supplies the signed implementation, so
   * the constructor no longer refuses it; the two arms differ only in whether
   * steps 4-9 can run in this deployment.
   */
  private readonly provider: PolicyApplyPort;
  /** The `W1` slot's bounded wait (design §1.4). */
  private readonly leaseWaitBudgetMs: number;
  /** Who is asking, recorded on the lease row for diagnostics. */
  private readonly leaseOwnerId: string;

  public constructor(dependencies: RecipientPolicyServiceDependencies) {
    this.database = dependencies.database;
    this.repository = dependencies.repository;
    this.contacts = dependencies.contacts;
    this.listActiveGrants = dependencies.listActiveGrants;
    this.provider = dependencies.provider;
    this.leaseWaitBudgetMs =
      dependencies.policyLease?.waitBudgetMs ?? POLICY_LEASE_DEFAULT_WAIT_BUDGET_MS;
    this.leaseOwnerId = dependencies.policyLease?.ownerId ?? "backend";
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /**
   * Design §3.5 step 1-3 for a new trusted recipient: validate strictly, resolve
   * the wallet server-side, then compose and record one desired revision.
   *
   * A user with no ready Solana wallet still gets the contact persisted, saved and
   * not enabled, with no state row, no intent and no policy write (spec "Wallet
   * without a ready permission stays saved and not enabled").
   */
  /**
   * Run the apply path for a revision this caller just recorded and report what
   * the database says afterwards (design §3.5 steps 4-10). The enrollment path
   * needs exactly this: record the intent, apply it, then report the recorded
   * result rather than a hoped-for one.
   */
  public async applyRecordedRevision(
    userId: string,
    walletId: string,
    options: PolicyApplyBookkeepingOptions = {},
  ): Promise<{
    permission: ContactPermissionSnapshot;
    appliedPolicyId: string | null;
  }> {
    await this.applyRevision(userId, walletId, options);
    const state = await this.repository.readPolicyState(userId, walletId);
    return {
      permission: projectContactPermission(state),
      // Read back from the row, never carried over from the composition: a caller
      // building a response body must not be able to assemble it from a revision
      // nobody verified.
      appliedPolicyId: state?.appliedPolicyId ?? null,
    };
  }

  public async create(
    userId: string,
    body: unknown,
    options: RecipientMutationOptions = {},
  ): Promise<RecipientMutationResult> {
    const input = parseStrict(recipientCreateInputSchema, body);
    const contactInput: RecipientContactWriteInput = {
      name: input.name,
      description: input.description,
      address: input.address,
      // The derived scope, never the body's: the body may only agree with it.
      network: SOLANA_POLICY_NETWORK,
    };

    const wallet = await this.repository.readReadySolanaWallet(userId);
    if (!wallet) {
      const contact = await this.database.withUserTransaction(userId, (client) =>
        this.contacts.create(userId, contactInput, client),
      );
      return {
        contact,
        permission: projectContactPermission(null),
        policyRevision: 0,
      };
    }

    return this.withPolicyLease(userId, wallet.walletId, async () => {
      const outcome = await this.runMutation(
        userId,
        wallet.walletId,
        options,
        async (client) => {
          const contact = await this.contacts.create(userId, contactInput, client);
          return { contact, action: "create" as const };
        },
      );
      if (outcome.kind === "blocked") throw outcome.error;

      await this.applyRevision(userId, wallet.walletId);
      return {
        contact: outcome.contact,
        permission: await this.readContactPermission(userId, wallet.walletId),
        policyRevision: outcome.revision,
      };
    });
  }

  /**
   * Design §3.5 for an existing trusted recipient, plus the spec's metadata rule:
   * an edit that changes only a name or a description MUST NOT change the
   * composed rule set, and one whose recomposition WOULD change it is a
   * `blocked_conflict` validation failure, never a silent merge.
   *
   * An address edit is a real composition change and recomposes both addresses'
   * semantics from the recorded consent (the old address leaves the allowlist
   * because the contact no longer carries it).
   */
  public async edit(
    userId: string,
    contactId: string,
    body: unknown,
    options: RecipientMutationOptions = {},
  ): Promise<RecipientMutationResult> {
    const input = parseStrict(recipientEditInputSchema, body);
    const targetId = parseStrict(contactIdInputSchema, { contactId }).contactId;
    const patch: RecipientContactPatchInput = {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.address !== undefined ? { address: input.address } : {}),
      network: SOLANA_POLICY_NETWORK,
      expectedVersion: input.expectedVersion,
    };
    const metadataOnly = input.address === undefined;

    const wallet = await this.repository.readReadySolanaWallet(userId);
    if (!wallet) {
      const contact = await this.database.withUserTransaction(userId, (client) =>
        this.contacts.update(userId, targetId, patch, client),
      );
      return {
        contact,
        permission: projectContactPermission(null),
        policyRevision: 0,
      };
    }

    return this.withPolicyLease(userId, wallet.walletId, async () => {
      const outcome = await this.runMutation(
        userId,
        wallet.walletId,
        options,
        async (client, state) => {
        if (
          input.expectedPolicyRevision !== undefined &&
          input.expectedPolicyRevision !== state.desiredRevision
        ) {
          throw new RecipientPolicyRevisionConflictError({
            expectedPolicyRevision: input.expectedPolicyRevision,
            desiredRevision: state.desiredRevision,
          });
        }
        const contact = await this.contacts.update(userId, targetId, patch, client);
        return {
          contact,
          action: metadataOnly ? ("rename" as const) : ("address_change" as const),
          // Only a metadata-only edit has to prove rule-identity; an address edit
          // is expected to change the rule set.
          ruleReference: metadataOnly ? recordedRuleReference(state) : undefined,
        };
        },
      );
      if (outcome.kind === "blocked") throw outcome.error;

      await this.applyRevision(userId, wallet.walletId);
      return {
        contact: outcome.contact,
        permission: await this.readContactPermission(userId, wallet.walletId),
        policyRevision: outcome.revision,
      };
    });
  }

  /**
   * The wallet's serialized writer for the two non-removal mutations.
   *
   * WHY `create` AND `edit` NEED IT TOO
   * ----------------------------------
   * A create promotes the whole allowlist and an edit rewrites one address's
   * semantics, and both compose from the grants and the contacts they read. Two
   * writers that interleave would each compose from the other's stale snapshot,
   * so the composed revision, its intent and the provider apply would describe a
   * rule set that no read ever saw.
   *
   * The lease is therefore acquired the same way `remove` acquires it: `W1`, held
   * OUTSIDE the transaction, with the bounded wait and never across provider I/O.
   * A wallet this caller cannot serialize is left untouched and reports the typed
   * refusal instead of mutating on an unproven snapshot.
   */
  private async withPolicyLease<T>(
    userId: string,
    walletId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    const lease = await acquirePolicyLease({
      database: this.database,
      walletId,
      userId,
      ownerId: this.leaseOwnerId,
      waitBudgetMs: this.leaseWaitBudgetMs,
    });
    if (lease.status !== "acquired") {
      const reason =
        lease.status === "busy"
          ? ("policy_lease_busy" as const)
          : ("policy_lease_unavailable" as const);
      await this.recordStop(userId, walletId, {
        failureClass: "blocked_conflict",
        reason,
        detail: { code: reason },
      });
      throw new RecipientPolicyNotSerializedError(reason);
    }

    try {
      return await run();
    } finally {
      // The lease is always released, success or failure: a stuck holder would
      // make the wallet unwritable for a full TTL.
      await releasePolicyLease(
        { database: this.database },
        { walletId, token: lease.token },
      );
    }
  }

  // -------------------------------------------------------------------------
  // The removal transaction (design §1.6)
  // -------------------------------------------------------------------------

  /**
   * Design §1.6. Remove one trusted recipient, revoking every grant the address
   * was reachable through when it was the address's LAST active alias.
   *
   * WHY THIS IS NOT `edit` WITH A DIFFERENT ACTION
   * ---------------------------------------------
   * A removal is the only mutation that DESTROYS authorization, and it destroys
   * two different kinds of it: the contact (its version-CAS archive) and the
   * delegated grants whose allowlist contains the address (whole-grant revoke).
   * Both, their audits, the desired revision and the durable intent commit in ONE
   * transaction, and the bounded remote apply happens only after that commit — so
   * no database lock is ever held across provider I/O and no partial removal can
   * exist.
   *
   * Phase A reads what the user is about to lose (unlocked) and freezes it as the
   * proposal payload; Phase B re-derives it under the canonical chain
   * `W1 → tx{ W0(U) → L1(asc) → L2 → L3 → L5 } → R`. A Phase B that finds MORE
   * affected grants than Phase A disclosed aborts and restarts instead of
   * revoking a scope the disclosure never named; after the bounded budget the
   * operation stops as `blocked_conflict` with `revocation_set_widened`.
   */
  public async remove(
    userId: string,
    contactId: string,
    expectedVersion: unknown,
    idempotencyKey?: string | null,
    options: RecipientMutationOptions = {},
  ): Promise<RecipientRemovalResult> {
    const input = parseStrict(recipientRemovalInputSchema, {
      expectedVersion,
      idempotencyKey: idempotencyKey ?? null,
    });
    const targetId = parseStrict(contactIdInputSchema, { contactId }).contactId;

    // Phase A step 1: the target contact (its address is what the alias and grant
    // reads are keyed on) and the server-owned wallet.
    const target = await this.contacts.readActive(userId, targetId);
    if (!target) throw new RecipientContactMissingError();
    const wallet = await this.repository.readReadySolanaWallet(userId);
    if (!wallet) {
      // No ready permission: there is no wallet to serialize, so there is no
      // grant that could be revoked and no remote policy to update. The contact is
      // archived and reported saved-not-enabled (spec "Wallet without a ready
      // permission stays saved and not enabled").
      const contact = await this.database.withUserTransaction(userId, (client) =>
        this.contacts.archive(userId, targetId, input.expectedVersion, client),
      );
      return {
        contact,
        permission: projectContactPermission(null),
        policyRevision: 0,
        revocation: { grantIds: [], state: "pending" },
      };
    }

    // W1: the wallet's serialized writer, held OUTSIDE the transaction (bounded
    // wait, never held across provider I/O). Without it this removal would not be
    // the wallet's writer at all, so nothing is mutated.
    const lease = await acquirePolicyLease({
      database: this.database,
      walletId: wallet.walletId,
      userId,
      ownerId: this.leaseOwnerId,
      waitBudgetMs: this.leaseWaitBudgetMs,
    });
    if (lease.status !== "acquired") {
      const reason =
        lease.status === "busy"
          ? ("policy_lease_busy" as const)
          : ("policy_lease_unavailable" as const);
      await this.recordStop(userId, wallet.walletId, {
        failureClass: "blocked_conflict",
        reason,
        detail: { code: reason },
      });
      throw new RecipientPolicyNotSerializedError(reason);
    }

    try {
      for (
        let attempt = 1;
        attempt <= RECIPIENT_REMOVAL_MAX_ATTEMPTS;
        attempt += 1
      ) {
        const plan = await this.readRemovalPlan(userId, wallet.walletId, target);
        let outcome: RemovalOutcome;
        try {
          outcome = await this.database.withUserTransaction(userId, (client) =>
            this.applyRemoval(
              userId,
              wallet.walletId,
              targetId,
              input.expectedVersion,
              input.idempotencyKey ?? null,
              options,
              plan,
              client,
            ),
          );
        } catch (error) {
          if (!(error instanceof RemovalRetrySignal)) throw error;
          if (attempt < RECIPIENT_REMOVAL_MAX_ATTEMPTS) continue;
          break;
        }
        // A composition refusal is a STOP, not a rollback: the removal and its
        // revocations are the safe direction (they destroy authority) and are
        // already committed with the stop recorded. Throwing here means the caller
        // reports a blocked status, never a success.
        if (outcome.kind === "blocked") throw outcome.error;
        await this.applyRevision(userId, wallet.walletId);
        const permission = await this.readContactPermission(userId, wallet.walletId);
        return {
          contact: outcome.contact,
          permission,
          policyRevision: outcome.revision,
          revocation: projectRevocationDisclosure(
            outcome.revokedGrantIds,
            permission,
          ),
        };
      }

      const conflict = new RecipientPolicyRemovalConflictError({
        attempts: RECIPIENT_REMOVAL_MAX_ATTEMPTS,
        contactId: targetId,
      });
      await this.recordStop(userId, wallet.walletId, {
        failureClass: conflict.failureClass,
        reason: conflict.reason,
        detail: conflict.detail,
      });
      throw conflict;
    } finally {
      // The lease is always released, success or failure: a stuck holder would
      // make the wallet unwritable for a full TTL.
      await releasePolicyLease(
        { database: this.database },
        { walletId: wallet.walletId, token: lease.token },
      );
    }
  }

  /** Read-only removal preflight used to bind a UI/voice proposal to its effect. */
  public async previewRemoval(
    userId: string,
    contactId: string,
    expectedVersion: unknown,
  ): Promise<{ contact: RecipientContactRecord; revokedGrantIds: string[]; lastAlias: boolean }> {
    const parsed = parseStrict(recipientRemovalInputSchema, { expectedVersion });
    const targetId = parseStrict(contactIdInputSchema, { contactId }).contactId;
    const contact = await this.contacts.readActive(userId, targetId);
    if (!contact || contact.version !== parsed.expectedVersion) throw new RecipientContactMissingError();
    const wallet = await this.repository.readReadySolanaWallet(userId);
    if (!wallet) return { contact, revokedGrantIds: [], lastAlias: false };
    const plan = await this.readRemovalPlan(userId, wallet.walletId, contact);
    return { contact, revokedGrantIds: plan.lastAlias ? plan.affectedGrantIds : [], lastAlias: plan.lastAlias };
  }

  /**
   * Phase A (design §1.6 steps 2-5), read with NO locks.
   *
   * The result is both the disclosure the user sees and the invariant Phase B is
   * checked against, which is why the payload lists the affected grants only when
   * this is the last alias: a grant covered by a second active alias is not
   * affected at all and must not appear in a disclosure.
   */
  private async readRemovalPlan(
    userId: string,
    walletId: string,
    target: RecipientContactRecord,
  ): Promise<RemovalPlan> {
    const aliases = await this.repository.listActiveAliases(userId, target.address);
    const affected = await this.repository.listAffectedActiveGrants(
      userId,
      walletId,
      target.address,
    );
    const aliasIds = aliases.map((alias) => alias.id);
    const lastAlias = aliasIds.length === 1;
    const affectedGrantIds = affected.map((grant) => grant.id);
    return {
      address: target.address,
      aliasIds,
      lastAlias,
      affectedGrantIds,
      payload: {
        action: "remove",
        contactId: target.id,
        contactVersion: target.version,
        address: target.address,
        affectedGrantIds: lastAlias ? affectedGrantIds : [],
      },
    };
  }

  /**
   * Phase B (design §1.6 steps 2-7), all inside ONE transaction, in the canonical
   * order. A throw rolls the whole thing back: contact, revocations, audits,
   * revision and intent move together or not at all.
   */
  private async applyRemoval(
    userId: string,
    walletId: string,
    contactId: string,
    expectedVersion: number,
    idempotencyKey: string | null,
    options: RecipientMutationOptions,
    plan: RemovalPlan,
    client: Queryable,
  ): Promise<RemovalOutcome> {
    // W0(U): the wallet's state row, locked for the rest of this transaction.
    await this.repository.lockPolicyState(userId, walletId, client);
    // Parity with `runMutation`: a pristine wallet captures its consent baseline
    // here too, so a removal can never compose from a missing baseline.
    await this.captureConsentBaselineOnce(userId, walletId, client);

    // L1: one advisory lock per affected grant, ascending — the SAME key the
    // claim path takes, so a claim and this removal serialize on one lock.
    await this.repository.lockGrantAdvisoryKeys(plan.affectedGrantIds, client);
    // L2: the affected rows, locked ascending.
    const locked = await this.repository.lockAffectedGrants(
      userId,
      walletId,
      plan.affectedGrantIds,
      client,
    );
    // L3: the aliases, locked ascending.
    const aliasesUnderLock = await this.repository.lockActiveAliases(
      userId,
      plan.address,
      client,
    );

    // Re-derive under lock and abort if the plan moved. Widening is the dangerous
    // direction: a grant that Phase A never named would be revoked without ever
    // being disclosed. (Grant creation must hold `W1`, which this transaction
    // holds, so in practice this is a cheap invariant assertion.)
    const affectedUnderLock = await this.repository.listAffectedActiveGrants(
      userId,
      walletId,
      plan.address,
      client,
    );
    const lockedIds = new Set(locked.map((grant) => grant.id));
    if (
      !sameIdSet(aliasesUnderLock.map((alias) => alias.id), plan.aliasIds) ||
      affectedUnderLock.some((grant) => !lockedIds.has(grant.id))
    ) {
      throw new RemovalRetrySignal();
    }
    const finalAffectedIds = aliasesUnderLock.length === 1
      ? affectedUnderLock.map((grant) => grant.id)
      : [];
    if (
      options.expectedRevokedGrantIds &&
      !sameIdSet([...options.expectedRevokedGrantIds], finalAffectedIds)
    ) {
      throw new RecipientPolicyConflictError({
        reference: "revocation_disclosure",
        expectedGrantIds: [...options.expectedRevokedGrantIds],
        actualGrantIds: finalAffectedIds,
      });
    }

    // The version-CAS archive. Zero rows means the contact moved or disappeared
    // since the caller read it, and the port raises the seam's version conflict —
    // which rolls back the revocations below with everything else.
    const archived = await this.contacts.archive(
      userId,
      contactId,
      expectedVersion,
      client,
    );

    // Whole-grant revocation, only when the alias set under lock is this one
    // fresh alias. Each revocation appends its immutable `revoked` audit row in
    // THIS transaction (design §1.6 step 7, spec "Whole-grant revocation with
    // audit in one transaction").
    const revokedGrantIds: string[] = [];
    if (aliasesUnderLock.length === 1) {
      for (const grant of affectedUnderLock) {
        const revoked = await this.repository.revokeGrantWhole(
          userId,
          grant.id,
          client,
        );
        // Already revoked by a concurrent revoke/claim: the scope is gone, but
        // this call did not revoke it, so it is not audited as its own.
        if (!revoked) continue;
        await appendGrantAudit(
          this.database,
          {
            grantId: grant.id,
            userId,
            event: "revoked",
            reason: "last_active_alias_removed",
            detail: {
              contactId,
              contactVersion: archived.version,
              address: plan.address,
              grantRecipients: grant.recipients,
            },
          },
          client,
        );
        revokedGrantIds.push(grant.id);
      }
    }

    // The composition reads the POST-mutation projection on THIS client: the
    // grants just revoked are no longer active, so the recorded revision cannot
    // re-compose a rule for a scope that was revoked.
    let composed: ComposedPolicy;
    try {
      const grants = await this.repository.listActiveLedgerGrants(
        userId,
        walletId,
        SOLANA_LEDGER_CHAIN,
        client,
      );
      composed = await this.composeRevision(userId, walletId, { client, grants });
    } catch (error) {
      if (!(error instanceof PolicyCompositionRefusalError)) throw error;
      await this.recordStop(
        userId,
        walletId,
        {
          failureClass: error.failureClass,
          reason: error.reason,
          detail: { code: error.reason },
        },
        client,
      );
      return { kind: "blocked", contact: archived, revokedGrantIds, error };
    }

    const revision = await this.repository.bumpDesiredRevision(
      userId,
      { walletId, desiredRulesHash: composed.hash },
      client,
    );
    // One intent in flight per wallet: the previous revision is superseded in the
    // same transaction, so the wallet is never left with two, or with none.
    await this.supersedeInFlightIntent(userId, walletId, client);
    await this.repository.insertIntent(
      userId,
      {
        walletId,
        desiredRevision: revision,
        origin: options.origin ?? "screen",
        action: "remove",
        contactId,
        contactVersion: archived.version,
        composedRules: composed.rules,
        composedHash: composed.hash,
        idempotencyKey,
      },
      client,
    );
    await this.repository.appendPolicyAudit(
      userId,
      {
        walletId,
        event: "intent_recorded",
        desiredRevision: revision,
        detail: {
          origin: options.origin ?? "screen",
          action: "remove",
          revokedGrantIds,
        },
      },
      client,
    );
    // The immutable Phase A payload plus the grants this transaction actually
    // revoked: the disclosure is durable evidence, not just a response body.
    await this.repository.appendPolicyAudit(
      userId,
      {
        walletId,
        event: "revocation_disclosed",
        desiredRevision: revision,
        detail: { ...plan.payload, revokedGrantIds },
      },
      client,
    );

    await options.beforeCommit?.(client);

    return { kind: "recorded", contact: archived, revision, revokedGrantIds };
  }

  /**
   * Design §3.4 step 1. The enrollment consent intent: compose the wallet's
   * desired revision and record it as a durable
   * `recipient_policy_sync_intent` with `origin='enrollment'` — and NOTHING
   * else. This method deliberately does not create, attach or PATCH a policy,
   * and it returns no policy id, so a caller can never mistake it for a
   * completed enrollment: the policy exists only once the composer's apply path
   * (slice 2) has verified it.
   *
   * Retry-idempotency of `prepare` is preserved here rather than by a policy: a
   * retried prepare recomposes the SAME desired revision and supersedes the
   * previous in-flight intent in one transaction, so the wallet is never left
   * with two intents or with none.
   */
  public async recordEnrollmentIntent(
    userId: string,
    walletId: string,
  ): Promise<{ revision: number; composedHash: string }> {
    return this.database.withUserTransaction(userId, async (client) => {
      // W0(U): the wallet's own state row, locked for the rest of this
      // transaction, created if this is its first mutation.
      await this.repository.lockPolicyState(userId, walletId, client);
      await this.captureConsentBaselineOnce(userId, walletId, client);
      const composed = await this.composeRevision(userId, walletId, { client });
      const revision = await this.repository.bumpDesiredRevision(
        userId,
        { walletId, desiredRulesHash: composed.hash },
        client,
      );
      await this.supersedeInFlightIntent(userId, walletId, client);
      await this.repository.insertIntent(
        userId,
        {
          walletId,
          desiredRevision: revision,
          origin: "enrollment",
          action: "create",
          // The EXACT rules this revision was composed from, so the reconciler
          // compares two persisted artifacts instead of recomputing (design §2.2).
          composedRules: composed.rules,
          composedHash: composed.hash,
          idempotencyKey: null,
        },
        client,
      );
      await this.repository.appendPolicyAudit(
        userId,
        {
          walletId,
          event: "intent_recorded",
          desiredRevision: revision,
          detail: { origin: "enrollment", action: "create" },
        },
        client,
      );
      return { revision, composedHash: composed.hash };
    });
  }

  // -------------------------------------------------------------------------
  // The composition seam (design §3.1, §3.5 step 2/step 7)
  // -------------------------------------------------------------------------

  /**
   * Assemble `ComposeInput` and compose the wallet's one rule set.
   *
   * Public because it is the seam every other writer must route through: the
   * removal transaction composes from this, and the reconciler re-uses the same
   * assembly when it re-applies a recorded revision. Pass the caller's `client`
   * to compose inside an open transaction; omit it to open a read transaction.
   *
   * The consent baseline is read from `recipient_policy_state`, never from the
   * enrollment row directly and never from a remote readback: a wallet that has
   * been composed with captures it once, and this method is not allowed to bypass
   * that record (design §2.1).
   *
   * KNOWN BOUNDARY: `listActiveGrants` opens its own user transaction (it is the
   * existing ledger read and validates the owner scope itself), so the grants are
   * read outside an enclosing mutation transaction's snapshot. Nothing in this
   * unit mutates grants, and the apply path that does owns moving the read onto
   * the caller's client.
   */
  public async composeRevision(
    userId: string,
    walletId: string,
    options: { client?: Queryable; grants?: GrantPolicyInput[] } = {},
  ): Promise<ComposedPolicy> {
    const grants =
      options.grants ??
      (await this.listActiveGrants(walletId, userId, SOLANA_LEDGER_CHAIN));

    const read = async (client: Queryable) => {
      const contacts = await this.repository.listComposerContacts(userId, client);
      const state = await this.repository.readPolicyState(userId, walletId, client);
      return { contacts, state };
    };
    const { contacts, state } = options.client
      ? await read(options.client)
      : await this.database.withUserTransaction(userId, read);

    return composePolicy({
      walletId,
      userId,
      baseline: {
        addresses: state?.consentBaseline ?? [],
        provenance: state?.consentProvenance ?? {},
      },
      contacts,
      grants,
      // The single lamport ceiling; the composer refuses anything else, so a
      // caller here cannot re-author the consented 0.01 SOL cap.
      ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
      // Both probe results are read from the wallet's recorded evidence and
      // default to the fail-closed value (design §11 U1/U4).
      emptyComposition: state?.emptyComposition ?? "unproven",
      ruleComposition: recordedRuleComposition(state),
    });
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  /**
   * Design §9.1. The owner scope is explicit (`userId`) so the design's shorthand
   * `readContactPermission(walletId)` is always executed with the server-owned
   * identity bound to it — a caller can never read a wallet it does not own.
   */
  public async readContactPermission(
    userId: string,
    walletId: string,
  ): Promise<ContactPermissionSnapshot> {
    if (!uuidSchema.safeParse(walletId).success) {
      // Not an identifier this database could hold: there is no such wallet, and
      // the honest answer is the same one a stranger gets.
      return projectContactPermission(null);
    }
    return projectContactPermission(
      await this.repository.readPolicyState(userId, walletId),
    );
  }

  /** Resolve the user's ready Solana wallet internally for HTTP projections. */
  public async readPermissionForUser(
    userId: string,
  ): Promise<ContactPermissionSnapshot> {
    const wallet = await this.repository.readReadySolanaWallet(userId);
    return wallet
      ? this.readContactPermission(userId, wallet.walletId)
      : projectContactPermission(null);
  }

  /** Retry the current recorded revision for the user's ready Solana wallet. */
  public async retryForUser(userId: string): Promise<ContactPermissionSnapshot> {
    const wallet = await this.repository.readReadySolanaWallet(userId);
    if (!wallet) return projectContactPermission(null);
    await this.applyRevision(userId, wallet.walletId);
    return this.readContactPermission(userId, wallet.walletId);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * The one mutation transaction (design §1.6 step 7 / §3.5 steps 2-3):
   * `W0(U)` → consent capture → the contact write → composition → revision,
   * durable intent and audit, all in ONE transaction.
   *
   * Two stops are distinguished, and the difference is the whole point of
   * separating them:
   *
   *   * a **composition refusal** (`blocked_configuration`) happens after the
   *     contact write and the transaction COMMITS — the recipient change is
   *     persisted as saved-not-enabled (design §11 U1) with the stop recorded and
   *     no revision, no intent and no PATCH.
   *   * a **metadata conflict** (`blocked_conflict`) means the edit itself must
   *     not be applied, so it is thrown from inside the transaction: the contact
   *     write rolls back with everything else, and only the recorded stop
   *     survives — in its own transaction. Nothing is merged.
   */
  private async runMutation(
    userId: string,
    walletId: string,
    options: RecipientMutationOptions,
    step: (
      client: Queryable,
      state: PolicyStateRecord,
    ) => Promise<MutationStepResult>,
  ): Promise<MutationOutcome> {
    try {
      return await this.database.withUserTransaction(userId, async (client) => {
        // W0(U): the wallet's own state row, locked for the rest of this
        // transaction, created if this is its first mutation.
        const state = await this.repository.lockPolicyState(
          userId,
          walletId,
          client,
        );
        // Before the contact write: an unreadable consent record must not be able
        // to leave a half-mutated wallet behind, so it throws here and the whole
        // transaction rolls back.
        await this.captureConsentBaselineOnce(userId, walletId, client);

        const mutated = await step(client, state);

        let composed: ComposedPolicy;
        try {
          composed = await this.composeRevision(userId, walletId, { client });
        } catch (error) {
          if (!(error instanceof PolicyCompositionRefusalError)) throw error;
          const stop = {
            failureClass: error.failureClass,
            reason: error.reason,
            detail: { code: error.reason },
          };
          await this.recordStop(userId, walletId, stop, client);
          return {
            kind: "blocked",
            contact: mutated.contact,
            error,
          };
        }

        // Spec "Denying permission broadening is a validation failure, not a
        // merge": a metadata-only edit must leave the RECORDED rule set exactly
        // as it is. The comparison runs on the post-mutation composition, so a
        // change that landed between the read and this transaction is caught by
        // the same guard.
        const reference = mutated.ruleReference;
        if (reference && reference.hash !== composed.hash) {
          throw new RecipientPolicyConflictError({
            reference: reference.source,
            referenceHash: reference.hash,
            composedHash: composed.hash,
          });
        }

        const revision = await this.repository.bumpDesiredRevision(
          userId,
          { walletId, desiredRulesHash: composed.hash },
          client,
        );
        // The one-in-flight index allows a single intent per wallet: the previous
        // revision is superseded in the SAME transaction, so the wallet is never
        // left with two in-flight intents or with none.
        await this.supersedeInFlightIntent(userId, walletId, client);
        await this.repository.insertIntent(
          userId,
          {
            walletId,
            desiredRevision: revision,
            origin: options.origin ?? "screen",
            action: mutated.action,
            contactId: mutated.contact.id,
            contactVersion: mutated.contact.version,
            // The EXACT rules this revision was composed from: recovery re-applies
            // these instead of recomputing from mutable tables (design §2.2).
            composedRules: composed.rules,
            composedHash: composed.hash,
            idempotencyKey: options.idempotencyKey ?? null,
          },
          client,
        );
        await this.repository.appendPolicyAudit(
          userId,
          {
            walletId,
            event: "intent_recorded",
            desiredRevision: revision,
            detail: {
              origin: options.origin ?? "screen",
              action: mutated.action,
            },
          },
          client,
        );

        await options.beforeCommit?.(client);

        return { kind: "recorded", contact: mutated.contact, revision };
      });
    } catch (error) {
      if (error instanceof RecipientPolicyConflictError) {
        // The transaction is gone; the stop must not be. Record it separately so
        // the caller's conflict is visible on the next status read instead of
        // being assumed away.
        await this.database.withUserTransaction(userId, (client) =>
          this.recordStop(
            userId,
            walletId,
            {
              failureClass: error.failureClass,
              reason: error.reason,
              detail: error.detail,
            },
            client,
          ),
        );
      }
      throw error;
    }
  }

  /**
   * Capture the consent baseline, once, and only while the wallet is still
   * pristine.
   *
   * {@link needsConsentRead} decides whether to look at all — a wallet that already
   * holds a baseline is never read again, so a later malformed enrollment cannot
   * break it. The repository's predicate independently decides whether the write
   * itself is allowed.
   */
  private async captureConsentBaselineOnce(
    userId: string,
    walletId: string,
    client: Queryable,
  ): Promise<void> {
    const state = await this.repository.readPolicyState(userId, walletId, client);
    if (!state || !needsConsentRead(state)) return;

    const consent = await this.repository.readActiveEnrollmentConsent(
      userId,
      walletId,
      client,
    );
    if (!consent) return;
    await this.repository.captureConsentBaselineOnce(
      userId,
      walletId,
      consent,
      client,
    );
  }

  private async supersedeInFlightIntent(
    userId: string,
    walletId: string,
    client: Queryable,
  ): Promise<void> {
    const inFlight = await this.repository.readInFlightIntent(
      userId,
      walletId,
      client,
    );
    if (!inFlight) return;
    await this.repository.supersedeIntent(
      userId,
      { walletId, intentId: inFlight.id },
      client,
    );
  }

  /** Record a stop in `recipient_policy_state` and append-only audit evidence. */
  private async recordStop(
    userId: string,
    walletId: string,
    stop: { failureClass: StopStatus; reason: string; detail: Record<string, unknown> },
    client?: Queryable,
  ): Promise<void> {
    const updated = await this.repository.setPolicyStatus(
      userId,
      {
        walletId,
        status: stop.failureClass,
        reason: stop.reason,
        detail: stop.detail,
      },
      client,
    );
    // No visible state row means there is nothing to record the stop against;
    // never fabricate one.
    if (!updated) return;
    await this.repository.appendPolicyAudit(
      userId,
      {
        walletId,
        event: stop.failureClass,
        reason: stop.reason,
        detail: stop.detail,
      },
      client,
    );
  }

  /**
   * The post-mutation apply step, design §3.5 steps 4-10.
   *
   * Step 10 is the ONLY transaction this method opens, and it is opened after the
   * provider work has returned: no transaction is held across steps 4-9 (the unit
   * suite asserts this against a counting client, so an edit that wraps the PATCH
   * in a transaction fails by name instead of by review).
   *
   * A deployment without a signed capability stays in the durable-intent path:
   * the recorded revision is left `pending` with the reason, which is the honest
   * answer rather than anything resembling success (spec "Timeout is reported as
   * unverified").
   */
  private async applyRevision(
    userId: string,
    walletId: string,
    options: PolicyApplyBookkeepingOptions = {},
  ): Promise<void> {
    const provider = this.provider;
    if (provider.kind !== "signed") {
      await this.recordApplyPending(userId, walletId, provider.reason);
      return;
    }

    const state = await this.repository.readPolicyState(userId, walletId);
    if (!state) {
      // No recorded revision means there is nothing to apply; never invent one.
      await this.recordApplyPending(userId, walletId, "no_recorded_revision");
      return;
    }
    // The recorded binding, resolved fail-closed: a wallet whose canonical signer
    // was never verified has no policy target, and inventing one would be the
    // exact inference design §0 C5 forbids. No provider I/O happens on this path.
    let target: { providerWalletId: string; providerSignerId: string };
    try {
      const { resolvePolicyTarget } = await import(
        "../grants/privy-policy-admin.js"
      );
      target = await resolvePolicyTarget(this.database, walletId);
    } catch {
      await this.recordApplyPending(userId, walletId, "signer_binding_unavailable");
      return;
    }
    // Composed from the RECORDED state (consent baseline, contacts, grants), which
    // is the same authority the mutation used and the same input the reconciler
    // recomposes from — never from a remote readback (design §5.1 (c)/(d)).
    const composed = await this.composeRevision(userId, walletId);

    const outcome = await provider.apply({
      userId,
      walletId,
      providerWalletId: target.providerWalletId,
      canonicalSignerId: target.providerSignerId,
      desiredRevision: state.desiredRevision,
      appliedPolicyId: state.appliedPolicyId,
      appliedSignerIds: [...state.appliedSignerIds],
      composedHash: composed.hash,
      rules: composed.rules,
      provenance: composed.provenance as ComposedProvenance,
    });

    await this.commitApplyOutcome(
      userId,
      walletId,
      state.desiredRevision,
      outcome,
      options,
    );
  }

  /**
   * Step 10: one transaction that either commits the verified revision with its
   * compare-and-set (§1.5) and refreshes `signer_grants` (§5.4), or records the
   * outcome without ever writing an applied revision.
   *
   * `status_detail` MERGES (`jsonb ||`), so every transition below names the keys
   * it owns explicitly — including the `null`s that clear a previous
   * transition's stale evidence, which would otherwise survive as if it still
   * described this outcome.
   */
  private async commitApplyOutcome(
    userId: string,
    walletId: string,
    desiredRevision: number,
    outcome: PolicyApplyOutcome,
    options: PolicyApplyBookkeepingOptions = {},
  ): Promise<void> {
    await this.database.withUserTransaction(userId, async (client) => {
      if (outcome.kind === "verified") {
        const committed = await this.repository.commitAppliedRevision(
          userId,
          {
            walletId,
            desiredRevision,
            appliedRulesHash: outcome.appliedRulesHash,
            appliedPolicyId: outcome.appliedPolicyId,
            appliedSignerId: outcome.appliedSignerId,
            appliedSignerIds: [...outcome.appliedSignerIds],
            appliedRecipients: [...outcome.appliedRecipients],
          },
          client,
        );
        if (!committed) {
          // §1.5: zero rows means the desired revision moved while this holder was
          // applying. The stale writer records `superseded` and writes NO applied
          // revision, so it cannot downgrade `applied_revision`.
          const inFlight = await this.repository.readInFlightIntent(
            userId,
            walletId,
            client,
          );
          if (inFlight) {
            await this.repository.supersedeIntent(
              userId,
              { walletId, intentId: inFlight.id },
              client,
            );
          }
          await this.repository.appendPolicyAudit(
            userId,
            {
              walletId,
              event: "superseded",
              desiredRevision,
              reason: "desired_revision_moved",
              detail: { code: "desired_revision_moved", desiredRevision },
            },
            client,
          );
          return;
        }
        // §5.4 post-apply bookkeeping, in the SAME transaction as the CAS: the
        // two representations of one intent agree or neither moves.
        await this.repository.refreshSignerGrantProjection(
          userId,
          {
            walletId,
            allowlistedRecipients: [...outcome.appliedRecipients],
            policyHash: outcome.appliedRulesHash,
          },
          client,
        );
        // Design §4.4: the verified apply is the ONLY way a §4.3-cleared binding
        // comes back, and it re-binds every active grant of the wallet to the
        // policy the readback just proved — in this same transaction, so a grant
        // can never be bound to a revision that was not committed.
        await this.repository.rebindActiveWalletGrants(
          userId,
          walletId,
          outcome.appliedPolicyId,
          client,
        );
        await this.repository.appendPolicyAudit(
          userId,
          {
            walletId,
            event: "applied",
            desiredRevision,
            appliedRevision: desiredRevision,
            detail: {
              ...outcome.detail,
              // Design §5.3: the one path allowed to record `applied` without
              // having observed the write itself says so, by name.
              ...(options.confirmedBy
                ? { confirmedBy: options.confirmedBy }
                : {}),
              appliedPolicyId: outcome.appliedPolicyId,
              // Clears a stale provider failure left by an earlier attempt.
              operation: null,
              status: null,
              message: null,
            },
          },
          client,
        );
        return;
      }

      if (outcome.kind === "unverified" || outcome.kind === "retryable_failure") {
        // Neither class touches a binding or the applied revision: an unknown
        // remote outcome must not clear a binding (design §4.3), and only the
        // reconciler may retry (§5.2/§5.3).
        await this.repository.setPolicyStatus(
          userId,
          {
            walletId,
            status: "pending",
            reason: outcome.reason,
            detail: { ...outcome.detail, policyId: null, appliedPolicyId: null },
          },
          client,
        );
        await this.repository.appendPolicyAudit(
          userId,
          {
            walletId,
            event: "apply_failed",
            desiredRevision,
            reason: outcome.reason,
            detail: outcome.detail,
          },
          client,
        );
        return;
      }

      // Proven divergence: recorded as the stop class the comparator returned.
      // Design §4.3/§4.4 run together here, in this one transaction: the status
      // change, both hash nulls, the whole wallet's stale grant bindings and
      // their audits commit or none of them do. An UNKNOWN outcome never reaches
      // this branch (the `unverified`/`retryable_failure` arm above returns
      // first), which is what keeps a timeout from destroying a working grant.
      await this.repository.invalidateWalletBindings(
        userId,
        {
          walletId,
          status: outcome.failureClass,
          reason: outcome.reason,
          detail: outcome.detail,
        },
        client,
      );
    });
  }

  /**
   * The `unavailable` arm's honest record: the revision stays `pending` with the
   * reason this deployment could not apply it, and the durable intent is left for
   * the reconciler.
   */
  private async recordApplyPending(
    userId: string,
    walletId: string,
    reason: string,
  ): Promise<void> {
    await this.repository.setPolicyStatus(userId, {
      walletId,
      status: "pending",
      reason,
      detail: {
        code: reason === "provider_unavailable" ? "provider_unavailable" : reason,
        // Both keys are named explicitly: `status_detail` merges (`jsonb ||`), so
        // a previous transition's evidence would otherwise survive as if it
        // still described this outcome.
        policyId: null,
        appliedPolicyId: null,
      },
    });
  }
}

/** The service's documented wiring entry point. */
export function createRecipientPolicyService(
  dependencies: RecipientPolicyServiceDependencies,
): RecipientPolicyService {
  return new RecipientPolicyService(dependencies);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

type StopStatus = Extract<
  PolicyStateStatus,
  "blocked_conflict" | "blocked_configuration"
>;

type MutationStepResult = {
  contact: RecipientContactRecord;
  action: PolicyIntentAction;
  /**
   * Present only when the mutation must prove it left the recorded rule set
   * alone. `undefined` means "not applicable", `null` means "no recorded revision
   * exists to compare against" (there is no deployed rule set a metadata edit
   * could broaden).
   */
  ruleReference?: { source: string; hash: string } | null;
};

type MutationOutcome =
  | {
      kind: "recorded";
      contact: RecipientContactRecord;
      revision: number;
    }
  | {
      kind: "blocked";
      contact: RecipientContactRecord;
      error: PolicyCompositionRefusalError;
    };

/**
 * The removal transaction's outcome. `revokedGrantIds` is carried on BOTH arms:
 * a composition refusal still commits the revocations, so the caller can still
 * disclose what was actually revoked.
 */
type RemovalOutcome =
  | {
      kind: "recorded";
      contact: RecipientContactRecord;
      revision: number;
      revokedGrantIds: string[];
    }
  | {
      kind: "blocked";
      contact: RecipientContactRecord;
      revokedGrantIds: string[];
      error: PolicyCompositionRefusalError;
    };

/**
 * The abort half of design §1.6 step 6: thrown from inside the transaction so the
 * rollback is the database's, never a compensating write.
 */
class RemovalRetrySignal extends Error {}

/**
 * Design §1.6 step 6's bounded budget: three attempts, then `blocked_conflict`.
 * Each attempt re-reads Phase A and re-locks, so the budget bounds LIVENESS under
 * a pathological writer, not correctness.
 */
const RECIPIENT_REMOVAL_MAX_ATTEMPTS = 3;

/** Order-independent id-set equality: the alias/affected comparisons are about
 * membership, and both sides are already read in a deterministic order. */
function sameIdSet(left: readonly string[], right: readonly string[]): boolean {
  if (left.length !== right.length) return false;
  const seen = new Set(left);
  return right.every((id) => seen.has(id));
}

/**
 * Whether the enrollment row still needs to be READ to capture the baseline.
 *
 * This is the read-aversion decision, not the write authority: every recorded
 * composition outcome moves the status off `saved_not_configured` (a revision
 * leaves `pending`; a stop leaves a blocked status), so a wallet that already
 * holds a baseline is never read again. The write itself is guarded by the
 * repository's own `desired_revision = 0 AND applied_revision = 0` predicate, so
 * a wallet cannot be re-captured even by a caller that skips this check —
 * deliberately a different clause in a different place, so each one is provable on
 * its own instead of masking the other.
 */
function needsConsentRead(state: PolicyStateRecord): boolean {
  return state.status === "saved_not_configured";
}

/**
 * The recorded rule set a metadata-only edit must not change (spec "Renaming an
 * existing contact changes no rule").
 *
 * The settled applied revision is preferred: when nothing is in flight, "the
 * previously applied rules" IS the applied hash. While a revision is in flight the
 * applied hash is a stale comparison for a metadata-only edit — a rename would be
 * blocked by an unrelated pending change — so the recorded desired revision is the
 * reference instead. With neither recorded there is no deployed rule set to
 * broaden, so the guard does not apply.
 */
function recordedRuleReference(
  state: PolicyStateRecord,
): { source: string; hash: string } | null {
  if (
    state.appliedRevision > 0 &&
    state.appliedRevision === state.desiredRevision &&
    state.appliedRulesHash
  ) {
    return { source: "applied_revision", hash: state.appliedRulesHash };
  }
  if (state.desiredRevision > 0 && state.desiredRulesHash) {
    return { source: "desired_revision", hash: state.desiredRulesHash };
  }
  return null;
}

/**
 * The U1 rule-composition probe result (design §11 U1), read from the wallet's
 * recorded evidence. Anything other than a recorded `union` keeps the composer's
 * fail-closed refusal, so this can only ever relax a stop that was explicitly
 * proven.
 */
function recordedRuleComposition(
  state: PolicyStateRecord | null,
): "union" | "unproven" {
  const observed = state?.statusDetail?.["rules_union"];
  return observed === "union" ? "union" : "unproven";
}

/** The slice of a zod issue this module reads: never its message or its input. */
type ZodIssueLike = {
  path: ReadonlyArray<PropertyKey>;
  code: string;
  /** Present on `unrecognized_keys`: a rejected key carries an EMPTY path. */
  keys?: unknown;
};

/**
 * Bounded, value-free evidence for a rejected body: the paths and codes of at most
 * {@link MAX_VALIDATION_ISSUES} issues.
 *
 * A rejected unknown key is reported at the path of the key itself — zod reports
 * it on the OBJECT with an empty path and the key names in `keys`, which would
 * otherwise make every forbidden field look like the same body-level failure.
 */
function validationIssues(error: {
  issues: ReadonlyArray<ZodIssueLike>;
}): RecipientPolicyValidationIssue[] {
  const collected: RecipientPolicyValidationIssue[] = [];
  for (const issue of error.issues) {
    const base = issue.path.map((segment) => String(segment)).join(".");
    const keys = Array.isArray(issue.keys) ? issue.keys.map((key) => String(key)) : [];
    if (keys.length === 0) {
      collected.push({ path: base, code: issue.code });
      continue;
    }
    for (const key of keys) {
      collected.push({
        path: base.length > 0 ? `${base}.${key}` : key,
        code: issue.code,
      });
    }
  }
  return collected.slice(0, MAX_VALIDATION_ISSUES);
}

/**
 * Reject a body that does not match the strict seam. Only paths and codes are
 * reported: a rejection must never reflect a supplied value back.
 */
function parseStrict<T extends z.ZodType>(schema: T, body: unknown): z.output<T> {
  const parsed = schema.safeParse(body);
  if (parsed.success) return parsed.data;
  throw new RecipientPolicyValidationError(validationIssues(parsed.error));
}
