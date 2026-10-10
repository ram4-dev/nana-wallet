/**
 * The single recipient-policy composer (design §3.1–§3.3).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * The code this replaces had three full-rule writers, and the two rule families
 * never coexisted: `preparePermission` created the enrollment policy from
 * `buildSolanaEnrollmentRules` and every delegated-grant PATCH sent grant-only
 * rules, so the enrollment allowlist was *overwritten* rather than merged
 * (design §0 C1). The composed rule set is therefore one value with one owner.
 *
 * Three properties this module guarantees by construction:
 *
 *  1. **It is a pure function.** `ComposeInput → ComposedPolicy`: no database, no
 *     clock, no provider, no environment. Every invariant below is unit-testable
 *     without a database, which is why slice 1 finishes and unit-proves it before
 *     any apply code exists (design §12.1).
 *  2. **It never widens consent.** The ordinary allowlist is `baseline ∪ active
 *     confirmed contacts`; grant recipients appear exclusively in their own
 *     conditioned rules. A grant recipient is never folded into the 0.01 SOL
 *     allowlist, and the ceiling itself can only come from the single lamport
 *     constant (design §3.2 guarantees 1–2).
 *  3. **It fails closed on unproven provider semantics.** An empty composition
 *     needs a recorded `proven_deny`, ordinary+grant coexistence needs a recorded
 *     `union` probe result, and every refusal is typed with the status class and
 *     reason it must be reported as (design §3.2 guarantee 8, §11 U1/U4).
 *
 * `applied_rules_hash` (this module's `ComposedPolicy.hash`) is the authoritative
 * rule hash and is deliberately NOT `deterministicPolicyHash`, which hashes the
 * consent envelope (`limit|window|recipients`) and stays a compatibility field
 * (design §0 C6, §3.2 guarantee 5).
 */
import { createHash } from "node:crypto";
import { SOLANA_MAX_PER_TRANSFER_LAMPORTS } from "../embedded.js";
import { buildSolanaEnrollmentRules } from "../grants/solana-enrollment-rules.js";
import {
  composeGrantRules,
  type GrantPolicyInput,
  type GrantPolicyRule,
} from "../grants/solana-policy-provisioner.js";
import {
  PolicyEmptyCompositionUnprovenError,
  PolicyOrdinaryCapUnsupportedError,
  PolicyRuleCompositionUnprovenError,
} from "./errors.js";

/**
 * Design §3.3: the composer is the only module allowed to build a full rule set,
 * so it re-exports the *existing* grant rule builder instead of restating it.
 * `composeGrantRules` is imported nowhere else once the legacy provisioner entry
 * points are deleted (task 1.8/1.10 assert that structurally).
 */
export { composeGrantRules };
export type { GrantPolicyInput, GrantPolicyRule };

/**
 * The `recipient_policy_state.consent_provenance` record for the retained
 * baseline (design §2.1), carried verbatim from the wallet's newest
 * `state='active'` `signer_grants` row.
 *
 * The composer does NOT interpret it: it is the durable evidence that the
 * baseline is consented, and the caller keeps it for the applied revision's
 * provenance. Deriving an address from a remote GET instead of from this record
 * is exactly what the spec forbids, and that choice belongs to the service that
 * assembles `ComposeInput` (task 1.6), not here.
 */
export type BaselineProvenance = Record<string, unknown>;

/** One active confirmed Solana contact, with the version a mutation must echo. */
export type ComposerContact = {
  id: string;
  version: number;
  address: string;
};

/**
 * The U1 rule-composition probe outcome (design §11 U1), read from
 * `recipient_policy_state.status_detail.rules_union`. Anything other than a
 * recorded `union` keeps the composer's fail-closed refusal.
 */
export type RuleCompositionEvidence = "union" | "unproven";

/**
 * Design §3.1. The frozen consent baseline, the active contacts and the active
 * delegated grants, all already resolved by the caller in owner scope.
 *
 * `walletId`/`userId` are identity context, not composition inputs: they are
 * never emitted into a rule and are deliberately excluded from the hash, so the
 * hash is a pure function of the rule set (two wallets with identical rules share
 * it). They are explicit inputs so the composer can never derive or substitute
 * the identity it composes for — deriving a policy target is
 * `resolvePolicyTarget`'s job, and the composer never selects a signer
 * (design §3.2 guarantee 6).
 */
export type ComposeInput = {
  walletId: string;
  userId: string;
  /** Frozen consent baseline, from `recipient_policy_state.consent_baseline`. */
  baseline: { addresses: string[]; provenance: BaselineProvenance };
  /** Active confirmed Solana contacts (`recipients.status='active'`). */
  contacts: ComposerContact[];
  /** Active delegated grants, ledger-shaped. */
  grants: GrantPolicyInput[];
  /** Always `SOLANA_MAX_PER_TRANSFER_LAMPORTS`; validated, never trusted. */
  ordinaryCapLamports: string;
  emptyComposition: "unproven" | "proven_deny" | "unsupported";
  /** Defaults to `unproven`, i.e. to the fail-closed refusal (design §11 U1). */
  ruleComposition?: RuleCompositionEvidence;
};

/** Where an address's consent comes from (design §3.1, §5.1(d)). */
export type ComposedProvenance = Record<
  string,
  "baseline" | "contact" | "grant"
>;

/** Design §3.2. The exact PATCH body and the exact readback comparator input. */
export type ComposedPolicy = {
  rules: GrantPolicyRule[];
  hash: string;
  ordinaryRecipients: string[];
  grantRecipients: Array<{ grantId: string; recipients: string[] }>;
  provenance: ComposedProvenance;
};

/** Declared key order for a canonical rule (design §3.2 guarantee 5). */
const RULE_KEY_ORDER = ["name", "method", "action", "conditions"] as const;
/** Declared key order for a canonical condition. */
const CONDITION_KEY_ORDER = [
  "field_source",
  "field",
  "operator",
  "value",
] as const;

/** JavaScript default string comparison: UTF-16 code-unit order. */
function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** Byte order, for identifiers the design orders as bytes. */
function compareBytes(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8"));
}

/**
 * Sorted, deduplicated copy. `localeCompare` is deliberately NOT used: it is
 * locale-sensitive and would make the composed hash depend on the runtime
 * environment (design §3.2 guarantee 4).
 */
function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort(compareCodeUnits);
}

/**
 * Canonical key/value pairs: declared keys first in declared order, then any
 * other key in code-unit order. Keys are never dropped, so two rules with
 * different key sets can never hash alike; and the encoding does not depend on
 * `Object.keys` insertion order.
 */
function canonicalEntries(
  value: Record<string, unknown>,
  declared: readonly string[],
): Array<[string, unknown]> {
  const declaredPresent = declared.filter((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
  const remaining = Object.keys(value)
    .filter((key) => !declaredPresent.includes(key))
    .sort(compareCodeUnits);
  return [...declaredPresent, ...remaining].map(
    (key): [string, unknown] => [key, value[key]],
  );
}

function canonicalCondition(condition: unknown): unknown {
  if (!condition || typeof condition !== "object") return condition;
  return canonicalEntries(
    condition as Record<string, unknown>,
    CONDITION_KEY_ORDER,
  );
}

function canonicalRules(
  rules: readonly GrantPolicyRule[],
): Array<Array<[string, unknown]>> {
  return rules.map((rule) =>
    canonicalEntries(
      {
        ...rule,
        conditions: rule.conditions.map(canonicalCondition),
      } as Record<string, unknown>,
      RULE_KEY_ORDER,
    ),
  );
}

/**
 * The authoritative `applied_rules_hash`: sha256 over the canonical form of the
 * composed rule set (design §3.2 guarantee 5). Exported because both the desired
 * and the applied revision must be hashed the same way, and because the pristine
 * readback is compared against it.
 */
export function composedRulesHash(rules: readonly GrantPolicyRule[]): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(canonicalRules(rules)), "utf8")
    .digest("hex")}`;
}

/**
 * Build the one authoritative rule set for a wallet (design §3.1–§3.3).
 *
 * Throws — never returns a partial or widened composition — when the input asks
 * for something this deployment cannot prove.
 */
export function composePolicy(input: ComposeInput): ComposedPolicy {
  if (input.ordinaryCapLamports !== SOLANA_MAX_PER_TRANSFER_LAMPORTS) {
    throw new PolicyOrdinaryCapUnsupportedError({
      ordinaryCapLamports: input.ordinaryCapLamports,
      supported: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
    });
  }

  const ordinaryRecipients = sortedUnique([
    ...input.baseline.addresses,
    ...input.contacts.map((contact) => contact.address),
  ]);

  // Grants ascending by `grantId` byte order, each with its own allowlist sorted
  // and deduplicated, so the composition cannot depend on ledger read order.
  const orderedGrants: GrantPolicyInput[] = [...input.grants]
    .sort(
      (a, b) =>
        compareBytes(a.grantId, b.grantId) ||
        compareBytes(a.walletId, b.walletId),
    )
    .map((grant) => ({
      ...grant,
      recipients: sortedUnique(grant.recipients),
    }));
  const grantRecipients = orderedGrants.map((grant) => ({
    grantId: grant.grantId,
    recipients: grant.recipients,
  }));

  const contactAddresses = new Set(
    input.contacts.map((contact) => contact.address),
  );
  const grantAddresses = new Set(
    orderedGrants.flatMap((grant) => grant.recipients),
  );
  const provenance: ComposedProvenance = {};
  for (const address of sortedUnique([
    ...input.baseline.addresses,
    ...contactAddresses,
    ...grantAddresses,
  ])) {
    // A grant address is tagged `grant` because it is the narrower, conditioned
    // rule that carries it; §5.1(d) only needs key membership, which is the same
    // union either way.
    provenance[address] = grantAddresses.has(address)
      ? "grant"
      : contactAddresses.has(address)
        ? "contact"
        : "baseline";
  }

  if (ordinaryRecipients.length === 0 && orderedGrants.length === 0) {
    if (input.emptyComposition !== "proven_deny") {
      throw new PolicyEmptyCompositionUnprovenError(input.emptyComposition);
    }
    return {
      rules: [],
      hash: composedRulesHash([]),
      ordinaryRecipients,
      grantRecipients,
      provenance,
    };
  }

  const grantRules =
    orderedGrants.length === 0 ? [] : composeGrantRules(orderedGrants);

  if (ordinaryRecipients.length === 0) {
    return {
      rules: grantRules,
      hash: composedRulesHash(grantRules),
      ordinaryRecipients,
      grantRecipients,
      provenance,
    };
  }

  const ordinaryRule = buildSolanaEnrollmentRules({
    recipients: ordinaryRecipients,
    maxLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
  });

  if (grantRules.length === 0) {
    return {
      rules: ordinaryRule,
      hash: composedRulesHash(ordinaryRule),
      ordinaryRecipients,
      grantRecipients,
      provenance,
    };
  }

  // Two rule families in one policy is a new provider reliance: Privy must treat
  // several ALLOW rules as a union. Documentation is not proof on this
  // deployment, so only a recorded probe result may authorize it (design §11 U1).
  if ((input.ruleComposition ?? "unproven") !== "union") {
    throw new PolicyRuleCompositionUnprovenError({
      ordinaryRecipients: ordinaryRecipients.length,
      grantRules: grantRules.length,
    });
  }

  const rules = [...ordinaryRule, ...grantRules];
  return {
    rules,
    hash: composedRulesHash(rules),
    ordinaryRecipients,
    grantRecipients,
    provenance,
  };
}
