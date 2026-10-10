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
  | "composer_required";

/** Base class for every refusal the composition domain raises. */
export class PolicyCompositionRefusalError extends Error {
  /** The status this refusal must be recorded as. */
  readonly failureClass: PolicyBlockedStatus;
  /** The reason code this refusal must be recorded with. */
  readonly reason: PolicyCompositionRefusalReason;

  constructor(
    reason: PolicyCompositionRefusalReason,
    failureClass: PolicyBlockedStatus,
    message: string,
  ) {
    super(message);
    this.name = new.target.name;
    this.reason = reason;
    this.failureClass = failureClass;
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
