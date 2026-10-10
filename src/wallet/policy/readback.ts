/**
 * The readback comparator (design §5.1, §11 U2/U3).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The provider readback is the only evidence that a composed revision actually
 * became the applied policy. Treating a successful PATCH call as that evidence is
 * how the old writers could report "enabled" for a policy nobody had verified, so
 * this module is the single place where a readback is compared - and it is a pure
 * function, so every comparison is unit-provable without a database or a
 * provider (design §12.1).
 *
 * It answers two different questions with the same checks:
 *
 *  - the **pristine** readback (design §3.5 step 5) decides whether a PATCH is
 *    needed at all. Drift here is normal and repairable: the known `Test1` drift
 *    converges because that address HAS consent provenance, so the composer
 *    already emits it and the PATCH legitimately restores it.
 *  - the **verification** readback (step 9) decides whether a revision may be
 *    marked applied. Drift here is a failure, never a promotion.
 *
 * Two properties are load-bearing:
 *
 *  1. **It never returns a rule set derived from the readback.** An unexplained
 *    remote rule is classified (`unrecognized_rule`) and a rule whose allowlist
 *    cannot be enumerated is classified (`rule_conditions_unreadable`), never
 *    deleted to force convergence and never copied into desired state. That is
 *    what makes the spec's "unknown remote rules MUST block mutation"
 *    mechanical.
 *  2. **Checks (e)-(g) fail closed by default.** The owner-verified signer and
 *    wallet reads land in slice 2 (design §11 U2/U3), so an absent or explicit
 *    "not acquired" listing is itself the fail-closed `blocked_configuration`.
 *    No caller can reach `verified` by omitting evidence, and slice 1 asserts no
 *    resolved signer or ownership semantic.
 */
import { isDeepStrictEqual } from "node:util";
import type { ComposedProvenance } from "./composer.js";
import type { GrantPolicyRule } from "../grants/solana-policy-provisioner.js";

/** Which readback is being compared (design §5.1). */
export type PolicyReadbackPhase = "pristine" | "verification";

/** The `getPolicy` readback. The port already refuses a non-array `rules`. */
export type PolicyReadback = { id: string; rules: unknown[] };

/** One signer as the OWNER-VERIFIED listing reports it (design §11 U2). */
export type OwnerVerifiedSignerRecord = {
  signerId: string;
  /** A signer with no `override_policy_ids` is reported as carrying none. */
  overridePolicyIds: string[];
};

/**
 * The owner-verified signer listing (`privyDid(userId)` ->
 * `listWalletsForChain('solana')`), never the unfiltered `server.getWallet` read
 * (design §0 C5). `not_acquired` is a first-class value: the read is part of the
 * proof, so "we did not look" must be distinguishable from "we looked and it was
 * fine".
 */
export type OwnerVerifiedSignerListing =
  | { kind: "acquired"; signers: OwnerVerifiedSignerRecord[] }
  | { kind: "not_acquired"; reason: string };

/** The owner-verified wallet listing for the composition's `privyDid` (§11 U3). */
export type OwnerVerifiedWalletListing =
  | { kind: "acquired"; walletIds: string[] }
  | { kind: "not_acquired"; reason: string };

/** Failure class `blocked_conflict`: checks (a)-(d) (design §5.1). */
export type PolicyReadbackConflictReason =
  | "policy_id_mismatch"
  | "unrecognized_rule"
  | "recipient_address_without_provenance"
  | "rule_conditions_unreadable"
  | "rules_mismatch";

/** Failure class `blocked_configuration`: checks (e)-(g) (design §5.1). */
export type PolicyReadbackConfigurationReason =
  | "signer_attachment_unproven"
  | "sibling_signer_lost"
  | "ownership_unproven"
  | "ownership_drift";

/**
 * Bounded, secret-free evidence for `recipient_policy_state.status_detail`
 * (design §2.1): ids, counts and the one address that could not be proven. No
 * signature, token, key or transcript ever reaches this map.
 */
export type PolicyReadbackDetail = Record<
  string,
  string | number | boolean | string[]
>;

/** Checks (a)-(d): the policy id, the rule set, its names and its addresses. */
export type PolicyRuleComparison =
  | { outcome: "equal" }
  | { outcome: "converge" }
  | {
      outcome: "blocked_conflict";
      reason: PolicyReadbackConflictReason;
      detail: PolicyReadbackDetail;
    };

/** Checks (e)-(g): the canonical signer, its siblings and the ownership binding. */
export type PolicyReadbackBinding =
  | { outcome: "proven" }
  | {
      outcome: "blocked_configuration";
      reason: PolicyReadbackConfigurationReason;
      detail: PolicyReadbackDetail;
    };

/** The §5.1 decision the reconciler consumes. */
export type PolicyReadbackDecision =
  | { outcome: "verified" }
  | { outcome: "patch_required" }
  | {
      outcome: "blocked_conflict";
      reason: PolicyReadbackConflictReason;
      detail: PolicyReadbackDetail;
    }
  | {
      outcome: "blocked_configuration";
      reason: PolicyReadbackConfigurationReason;
      detail: PolicyReadbackDetail;
    };

export type PolicyRuleComparisonInput = {
  phase: PolicyReadbackPhase;
  expectedPolicyId: string;
  composedRules: readonly GrantPolicyRule[];
  provenance: ComposedProvenance;
  readback: PolicyReadback;
};

export type PolicyReadbackBindingInput = {
  expectedPolicyId: string;
  signer: {
    /** `user_wallets.provider_signer_id` through `resolvePolicyTarget` (§3.2 (6)). */
    canonicalSignerId: string;
    /** Absent means "not acquired", i.e. the fail-closed classification. */
    ownerVerifiedSigners?: OwnerVerifiedSignerListing;
  };
  /** `recipient_policy_state.applied_signer_ids` of the last verified readback. */
  appliedSignerIds: readonly string[];
  ownership: {
    /** `user_wallets.provider_wallet_id`, the recorded owner-verified binding. */
    providerWalletId: string;
    /** Absent means "not acquired", i.e. the fail-closed classification. */
    ownerVerifiedWallets?: OwnerVerifiedWalletListing;
  };
};

export type PolicyReadbackInput = PolicyRuleComparisonInput &
  PolicyReadbackBindingInput;

const DETAIL_MAX_LENGTH = 120;

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/** Bounded rendering for status_detail, so evidence can never grow unbounded. */
function bounded(value: unknown): string {
  const rendered = typeof value === "string" ? value : safeStringify(value);
  return rendered.length > DETAIL_MAX_LENGTH
    ? `${rendered.slice(0, DETAIL_MAX_LENGTH)}…`
    : rendered;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/**
 * How a rule's `Transfer.to` allowlist was read, or why it could not be.
 *
 * A tagged result, not an `addresses | unreadable` pair: with a pair, an
 * unreadable value of `undefined` (a `Transfer.to` condition with no `value`, or
 * a rule with no `conditions` at all) is indistinguishable from "nothing was
 * wrong", and the address check silently passed on a rule whose allowlist could
 * not be enumerated at all.
 */
type TransferToScan =
  | { kind: "enumerated"; addresses: string[] }
  | { kind: "unreadable"; observed: unknown };

/** Every `Transfer.to` allowlist entry a rule declares, or why it was unreadable. */
function scanTransferTo(rule: Record<string, unknown>): TransferToScan {
  const conditions = rule.conditions;
  if (!Array.isArray(conditions)) {
    // Not a shape we can enumerate, so not a rule we can prove. Treating it as
    // "no addresses" would let a malformed remote rule pass the provenance check
    // and then be overwritten by the PATCH, which is exactly the "never delete an
    // unknown remote rule to force convergence" property this comparator exists
    // to hold.
    return { kind: "unreadable", observed: conditions };
  }

  const addresses: string[] = [];
  for (const condition of conditions) {
    if (!isRecord(condition) || condition.field !== "Transfer.to") continue;
    const value = condition.value;
    if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
      // An allowlist we cannot enumerate is an allowlist we cannot prove.
      return { kind: "unreadable", observed: value };
    }
    addresses.push(...value);
  }
  return { kind: "enumerated", addresses };
}

/**
 * Design §5.1 checks (a)-(d), in the design's order with one documented hoist:
 * (c) and (d) run before (b) so a pristine drift with an unexplained rule or an
 * unconsumed address is refused instead of being "repaired" by overwriting it.
 * In the verification phase the relative order of (b)-(d) cannot change the
 * outcome, because all four classify as `blocked_conflict`.
 *
 * (d) fails closed on a rule whose allowlist cannot be enumerated
 * (`rule_conditions_unreadable`): PATCHing over such a rule would delete it,
 * which is the one thing this comparator must never allow.
 */
export function compareComposedRules(
  input: PolicyRuleComparisonInput,
): PolicyRuleComparison {
  // (a) the readback is the policy we composed for.
  if (input.readback.id !== input.expectedPolicyId) {
    return {
      outcome: "blocked_conflict",
      reason: "policy_id_mismatch",
      detail: {
        expectedPolicyId: input.expectedPolicyId,
        observedPolicyId: bounded(input.readback.id),
      },
    };
  }

  const composedNames = new Set(input.composedRules.map((rule) => rule.name));
  for (const [index, rule] of input.readback.rules.entries()) {
    // (c) no unknown rule name: a rule we cannot explain is never deleted to
    // force convergence, and never adopted into desired state. The early return
    // also narrows `rule` to a record, so (d) reads a real object.
    if (!isRecord(rule) || typeof rule.name !== "string" || !composedNames.has(rule.name)) {
      const name =
        isRecord(rule) && typeof rule.name === "string" ? rule.name : null;
      return {
        outcome: "blocked_conflict",
        reason: "unrecognized_rule",
        detail: { ruleIndex: index, ruleName: name ?? bounded(rule) },
      };
    }

    // (d) every `Transfer.to` entry has a consent provenance entry (baseline,
    // active confirmed contact, or active grant recipient).
    const scan = scanTransferTo(rule);
    if (scan.kind === "unreadable") {
      return {
        outcome: "blocked_conflict",
        reason: "rule_conditions_unreadable",
        detail: {
          ruleName: rule.name,
          observedConditions:
            scan.observed === undefined ? "absent" : bounded(scan.observed),
        },
      };
    }
    const explained = (address: string): boolean =>
      Object.prototype.hasOwnProperty.call(input.provenance, address);
    const unexplained = scan.addresses.find((address) => !explained(address));
    if (unexplained !== undefined) {
      return {
        outcome: "blocked_conflict",
        reason: "recipient_address_without_provenance",
        detail: { ruleName: rule.name, observedAddress: bounded(unexplained) },
      };
    }
  }

  // (b) structural rule equivalence, independent of object key order.
  if (!isDeepStrictEqual(input.readback.rules, input.composedRules)) {
    if (input.phase === "verification") {
      return {
        outcome: "blocked_conflict",
        reason: "rules_mismatch",
        detail: {
          composedRuleCount: input.composedRules.length,
          observedRuleCount: input.readback.rules.length,
        },
      };
    }
    return { outcome: "converge" };
  }

  return { outcome: "equal" };
}

/**
 * Design §5.1 checks (e)-(g). The owner-verified reads are the evidence, so an
 * absent or explicitly unacquired listing blocks: no caller reaches `proven`
 * without having performed the read.
 */
export function assertOwnerVerifiedBinding(
  input: PolicyReadbackBindingInput,
): PolicyReadbackBinding {
  const signers = input.signer.ownerVerifiedSigners;
  if (!signers || signers.kind !== "acquired") {
    return {
      outcome: "blocked_configuration",
      reason: "signer_attachment_unproven",
      detail: {
        canonicalSignerId: input.signer.canonicalSignerId,
        observedOccurrences: 0,
      },
    };
  }

  // (e) the canonical signer appears EXACTLY once and carries EXACTLY our policy.
  const occurrences = signers.signers.filter(
    (signer) => signer.signerId === input.signer.canonicalSignerId,
  );
  const observedPolicyIds = occurrences.flatMap((signer) =>
    signer.overridePolicyIds.map((policyId) => bounded(policyId)),
  );
  if (
    occurrences.length !== 1 ||
    observedPolicyIds.length !== 1 ||
    occurrences[0].overridePolicyIds[0] !== input.expectedPolicyId
  ) {
    return {
      outcome: "blocked_configuration",
      reason: "signer_attachment_unproven",
      detail: {
        canonicalSignerId: input.signer.canonicalSignerId,
        observedOccurrences: occurrences.length,
        observedPolicyIds,
      },
    };
  }

  // (f) unrelated signers: every id the last verified readback recorded must
  // still be attached. `additional_signers` is a complete-list mutation, so a
  // lost sibling would otherwise be silently accepted.
  const attached = new Set(signers.signers.map((signer) => signer.signerId));
  const missingSignerIds = Array.from(
    new Set(input.appliedSignerIds.filter((id) => !attached.has(id))),
  );
  if (missingSignerIds.length > 0) {
    return {
      outcome: "blocked_configuration",
      reason: "sibling_signer_lost",
      detail: {
        appliedSignerIds: [...input.appliedSignerIds],
        missingSignerIds,
      },
    };
  }

  // (g) ownership: the wallet is resolved only through the owner-verified
  // listing and compared with the recorded provider wallet id (design §11 U3).
  const wallets = input.ownership.ownerVerifiedWallets;
  if (!wallets || wallets.kind !== "acquired") {
    return {
      outcome: "blocked_configuration",
      reason: "ownership_unproven",
      detail: {
        expectedWalletId: input.ownership.providerWalletId,
        observedWalletCount: 0,
      },
    };
  }
  if (!wallets.walletIds.includes(input.ownership.providerWalletId)) {
    return {
      outcome: "blocked_configuration",
      reason: "ownership_drift",
      detail: {
        expectedWalletId: input.ownership.providerWalletId,
        observedWalletCount: wallets.walletIds.length,
      },
    };
  }

  return { outcome: "proven" };
}

/**
 * The §5.1 decision: rules first, then the binding, then whether a PATCH is
 * still needed. A `converge` can only come out of the pristine phase, so
 * `patch_required` is unreachable once a revision is being verified.
 */
export function comparePolicyReadback(
  input: PolicyReadbackInput,
): PolicyReadbackDecision {
  const comparison = compareComposedRules(input);
  if (comparison.outcome === "blocked_conflict") return comparison;

  const binding = assertOwnerVerifiedBinding(input);
  if (binding.outcome === "blocked_configuration") return binding;

  return comparison.outcome === "equal"
    ? { outcome: "verified" }
    : { outcome: "patch_required" };
}
