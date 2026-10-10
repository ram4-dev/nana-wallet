/**
 * Typed, fail-closed refusals for the recipient-policy composition domain
 * (design §3.2 guarantee 8, §3.3, §11 U1/U4).
 *
 * WHY A REFUSAL CARRIES ITS STATUS CLASS
 * --------------------------------------
 * Every refusal below has to land on `recipient_policy_state.status` with a
 * bounded reason the product surface reports instead of a fabricated outcome
 * (spec "Stops are recorded, not silently assumed"). A plain `Error` would force
 * the service to pattern-match message text to decide between `blocked_conflict`
 * and `blocked_configuration`, so each refusal carries the status class and the
 * stable reason code it must be persisted with.
 *
 * A refusal is never a mutation. The composer throws before any rule set exists,
 * so no PATCH body can be derived from a refused composition and a previously
 * attached policy is left exactly as it is (design §11: "no PATCH is issued and
 * the previously attached policy stays exactly as it is").
 */
import type {
  PolicyEmptyComposition,
  PolicyStateStatus,
} from "./repository.js";

/** The two `recipient_policy_state.status` values a refusal may map onto. */
export type PolicyBlockedStatus = Extract<
  PolicyStateStatus,
  "blocked_conflict" | "blocked_configuration"
>;

/**
 * The stable, secret-free reason codes a refused composition is recorded with
 * (`recipient_policy_state.status_reason`).
 *
 * `empty_composition_unproven` and `rule_composition_semantics_unproven` are the
 * reason codes design §11 names for the U4 and U1 blocking stops.
 */
export type PolicyCompositionRefusalReason =
  | "empty_composition_unproven"
  | "rule_composition_semantics_unproven"
  | "ordinary_cap_unsupported"
  | "composer_required"
  /**
   * Task 2.8. A path that needs a verified remote rule set but is wired without a
   * signed apply capability stops here. It replaces
   * `apply_capability_unwired`, which named a slice-1 implementation stage and is
   * DELETED (not relaxed) by the unit that supplied the implementation: this code
   * names the actual deployment fact, so it stays true after the implementation
   * exists.
   */
  | "provider_unavailable";

/** Base class for every refusal the composition domain raises. */
export class PolicyCompositionRefusalError extends Error {
  /** The status this refusal must be recorded as. */
  readonly failureClass: PolicyBlockedStatus;
  /** The reason code this refusal must be recorded with. */
  readonly reason: PolicyCompositionRefusalReason;
  /**
   * The HTTP status and stable code the caller stops visibly with. Carried on the
   * refusal so a route maps a stop from its typed class instead of matching
   * message text, which is what makes each blocking stop assertable by name.
   */
  readonly httpStatus: number;
  readonly stopCode: string;

  constructor(
    reason: PolicyCompositionRefusalReason,
    failureClass: PolicyBlockedStatus,
    message: string,
    stop: { httpStatus?: number; code?: string } = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.reason = reason;
    this.failureClass = failureClass;
    this.httpStatus = stop.httpStatus ?? 409;
    this.stopCode = stop.code ?? "CONFLICTO_POLITICA";
  }
}

/**
 * Design §11 U4. The composed recipient set would be empty and no deployment
 * probe has established a supported deny representation, so `rules: []` must not
 * be emitted: detaching or emptying the policy would leave the signer
 * unrestricted (spec "Empty composition never broadens authority"). The last
 * recipient stays composed and the caller stops visibly with
 * `409 COMPOSICION_VACIA_NO_SOPORTADA`.
 */
export class PolicyEmptyCompositionUnprovenError extends PolicyCompositionRefusalError {
  /** The `recipient_policy_state.empty_composition` value observed. */
  readonly emptyComposition: PolicyEmptyComposition;

  constructor(emptyComposition: PolicyEmptyComposition) {
    super(
      "empty_composition_unproven",
      "blocked_configuration",
      `Refusing to compose an empty rule set: empty_composition is '${emptyComposition}' and only a recorded 'proven_deny' probe result may emit rules: []. The previous restrictive policy stays attached and the last recipient is kept.`,
      // Design §11 U4 names the exact visible stop, so it is carried on the
      // refusal rather than reassembled by whichever route happens to catch it.
      { httpStatus: 409, code: "COMPOSICION_VACIA_NO_SOPORTADA" },
    );
    this.emptyComposition = emptyComposition;
  }
}

/**
 * Design §11 U1. The enrollment allowlist rule and at least one delegated-grant
 * rule would coexist in one policy and the deployment has not recorded a `union`
 * rule-composition probe result. Only a recorded observation may authorize that
 * reliance; documentation is not proof, so this is the shipped default.
 */
export class PolicyRuleCompositionUnprovenError extends PolicyCompositionRefusalError {
  constructor(input: { ordinaryRecipients: number; grantRules: number }) {
    super(
      "rule_composition_semantics_unproven",
      "blocked_configuration",
      `Refusing to compose ${input.ordinaryRecipients} ordinary allowlist recipient(s) and ${input.grantRules} delegated-grant rule(s) into one policy: this deployment has no recorded 'union' rule-composition probe result. No PATCH is issued and the previously attached policy stays exactly as it is.`,
    );
  }
}

/**
 * Design §3.2 guarantee 1. The ordinary ceiling has exactly one source
 * (`SOLANA_MAX_PER_TRANSFER_LAMPORTS`); a caller-supplied ceiling that would
 * widen — or silently narrow — the consented 0.01 SOL allowlist is refused
 * rather than composed.
 */
export class PolicyOrdinaryCapUnsupportedError extends PolicyCompositionRefusalError {
  constructor(input: { ordinaryCapLamports: string; supported: string }) {
    super(
      "ordinary_cap_unsupported",
      "blocked_configuration",
      `Refusing to compose an ordinary transfer ceiling of '${input.ordinaryCapLamports}' lamports: the only supported ceiling is '${input.supported}' and it must come from the single lamport constant.`,
    );
  }
}

/**
 * Design §3.3. A policy-writing path that cannot route through the composer
 * fails visibly with a typed configuration error instead of issuing an
 * independent full-rule replacement (spec "Unsupported writer path fails
 * visibly").
 */
export class PolicyComposerRequiredError extends PolicyCompositionRefusalError {
  constructor(attemptedPath: string) {
    super(
      "composer_required",
      "blocked_configuration",
      `Policy composition was attempted through '${attemptedPath}', which cannot route through the single composer. Refusing: no independent full-rule replacement may be issued.`,
    );
  }
}

/**
 * Task 2.8. A caller that needs the remote rule set to have been verified, in a
 * deployment whose signed apply capability is not configured, stops visibly
 * here.
 *
 * This is the DELIBERATE successor of slice 1's
 * `PolicyApplyCapabilityUnwiredError`, which task 2.8 removed: that class
 * reported an implementation stage ("unwired") that no longer exists, so keeping
 * it would have made a wiring fact look like unfinished work. The refusal itself
 * is not relaxed — it still refuses, still as `blocked_configuration`, and still
 * never fabricates a policy id (spec "Unsupported writer path fails visibly").
 * What changed is that the reason now names why THIS deployment cannot apply
 * instead of claiming the code has not been written.
 */
export class PolicyApplyUnavailableError extends PolicyCompositionRefusalError {
  /** The capability the caller needed, for the operator-facing message. */
  readonly availability: string;

  constructor(availability: string, cause: string) {
    super(
      "provider_unavailable",
      "blocked_configuration",
      `Refusing to bind a policy for '${availability}': this deployment has no signed apply capability (${cause}). The desired revision is recorded and the reconciler applies it once the capability is configured.`,
    );
    this.availability = availability;
  }
}

/**
 * The failure vocabulary of the recipient-policy service seam (design §9.2).
 * Each code is a stable HTTP error code the contract already publishes, so a
 * caller maps a typed failure onto a response without matching message text.
 */
export type RecipientPolicySeamErrorCode =
  | "DATOS_INVALIDOS"
  | "CONFLICTO_POLITICA"
  | "REVISION_POLITICA_OBSOLETA"
  | "VERSION_OBSOLETA"
  | "CONTACTO_NO_ENCONTRADO";

/** One bounded validation issue: the path and the code, never the value. */
export type RecipientPolicyValidationIssue = {
  path: string;
  code: string;
};

/** Base class for every typed failure the service seam raises. */
export class RecipientPolicySeamError extends Error {
  readonly code: RecipientPolicySeamErrorCode;

  constructor(input: { code: RecipientPolicySeamErrorCode; message: string }) {
    super(input.message);
    this.name = new.target.name;
    this.code = input.code;
  }
}

/**
 * A request body that does not match the strict service seam (design §9.2, spec
 * "Server owns identity, wallet, and network"). The issues carry paths and codes
 * only: a rejection must not reflect an attacker-supplied identifier back.
 */
export class RecipientPolicyValidationError extends RecipientPolicySeamError {
  readonly issues: RecipientPolicyValidationIssue[];

  constructor(issues: RecipientPolicyValidationIssue[]) {
    super({
      code: "DATOS_INVALIDOS",
      message: `The request did not match the strict recipient policy contract: ${issues
        .map((issue) => `${issue.path || "body"} (${issue.code})`)
        .join(", ")}`,
    });
    this.issues = issues;
  }
}

/**
 * Spec "Denying permission broadening is a validation failure, not a merge": a
 * metadata-only edit whose recomposition would change the wallet's recorded rule
 * set stops as a blocked conflict. Nothing is merged and the edit is not applied.
 *
 * It carries the status class and the reason it must be recorded with, so the
 * stop becomes durable evidence instead of a response the caller discards.
 */
export class RecipientPolicyConflictError extends RecipientPolicySeamError {
  readonly failureClass: PolicyBlockedStatus = "blocked_conflict";
  readonly reason: string = "metadata_edit_changes_rules";
  /** Bounded evidence: the reference and the two hashes it disagrees with. */
  readonly detail: Record<string, unknown>;

  constructor(detail: Record<string, unknown>) {
    super({
      code: "CONFLICTO_POLITICA",
      message:
        "The edit would change the wallet's recorded policy rule set. Refusing to merge or widen it: the recorded revision must be made to converge first.",
    });
    this.detail = detail;
  }
}

/**
 * The edit was composed against a desired revision the caller has not seen, so
 * applying it would silently fold an unseen change into this one. A client-side
 * conflict: no policy stop is recorded, because no composition was reached.
 */
export class RecipientPolicyRevisionConflictError extends RecipientPolicySeamError {
  readonly detail: Record<string, unknown>;

  constructor(detail: Record<string, unknown>) {
    super({
      code: "REVISION_POLITICA_OBSOLETA",
      message:
        "The wallet's desired policy revision moved since the caller read it; refusing to compose over a revision the caller has not seen.",
    });
    this.detail = detail;
  }
}

/**
 * Design §1.6 step 6 (task 1.7). The affected scope widened under lock: the
 * alias set the removal was planned from changed, or a grant that was not locked
 * in the `L1`/`L2` slots now contains the address. The transaction is rolled back
 * and the operation restarted; after the bounded attempt budget it stops here
 * rather than revoking a scope the planning read never saw.
 *
 * It carries the status class and reason it must be recorded with, so an
 * exhausted retry budget becomes durable evidence instead of a lost error.
 */
export class RecipientPolicyRemovalConflictError extends RecipientPolicySeamError {
  readonly failureClass: PolicyBlockedStatus = "blocked_conflict";
  readonly reason: string = "revocation_set_widened";
  readonly detail: Record<string, unknown>;

  constructor(detail: Record<string, unknown>) {
    super({
      code: "CONFLICTO_POLITICA",
      message:
        "The set of grants affected by this removal changed while it was locked, and the bounded restart budget is exhausted. Nothing was removed.",
    });
    this.detail = detail;
  }
}

/**
 * Design §1.4/§1.6 step 1 (task 1.7). `W1` could not be acquired, so this
 * operation is not the wallet's serialized writer and must not mutate: a removal
 * that proceeded without the lease could compose and commit concurrently with the
 * applying writer and revoke a scope the apply read as active.
 *
 * `busy` (another holder) and `unavailable` (the lease could not be read) are
 * different reasons with the same answer — do nothing and say so.
 */
export class RecipientPolicyNotSerializedError extends RecipientPolicySeamError {
  readonly failureClass: PolicyBlockedStatus = "blocked_conflict";
  readonly reason: "policy_lease_busy" | "policy_lease_unavailable";

  constructor(reason: "policy_lease_busy" | "policy_lease_unavailable") {
    super({
      code: "CONFLICTO_POLITICA",
      message:
        "Another writer holds this wallet's policy lease (or it could not be read); refusing to mutate outside the wallet's serialized writer.",
    });
    this.reason = reason;
  }
}

/**
 * The contact-mutation port's refusal vocabulary (design §9.2). Declared here so
 * the service can translate the port's failures into the seam's typed codes
 * without depending on the concrete contacts repository.
 */
export class RecipientContactVersionConflictError extends RecipientPolicySeamError {
  constructor() {
    super({
      code: "VERSION_OBSOLETA",
      message:
        "The contact changed since the caller read it; refusing to overwrite a newer version.",
    });
  }
}

/** The named contact does not exist (or is not active) for this user. */
export class RecipientContactMissingError extends RecipientPolicySeamError {
  constructor() {
    super({
      code: "CONTACTO_NO_ENCONTRADO",
      message: "The contact does not exist for this user.",
    });
  }
}
