import { describe, expect, it } from "vitest";
import { SOLANA_MAX_PER_TRANSFER_LAMPORTS } from "../../src/wallet/embedded.js";
import { composePolicy } from "../../src/wallet/policy/composer.js";
import {
  assertOwnerVerifiedBinding,
  compareComposedRules,
  comparePolicyReadback,
  type OwnerVerifiedSignerRecord,
  type PolicyReadbackConfigurationReason,
  type PolicyReadbackConflictReason,
  type PolicyReadbackDecision,
} from "../../src/wallet/policy/readback.js";

const USER_ID = "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d";
const WALLET_ID = "0d1b2c34-5678-49ab-8cde-000000000001";

/** The wallet's own retained enrollment address. */
const BASELINE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** The active confirmed trusted contact behind the known `Test1` drift. */
const TEST1 = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
/** An address with no consent record anywhere: never adopted, never deleted. */
const UNEXPLAINED = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

const POLICY_ID = "pol_01HZYX00000000000000000001";
const OTHER_POLICY_ID = "pol_01HZYX00000000000000000002";
const CANONICAL_SIGNER = "signer_01HZYX00000000000000000001";
const SIBLING_SIGNER = "signer_01HZYX00000000000000000002";
const THIRD_SIGNER = "signer_01HZYX00000000000000000003";
const PROVIDER_WALLET_ID = "wallet_01HZYX00000000000000000001";

/** The consent-derived composition for this wallet: baseline + Test1. */
const composed = composePolicy({
  walletId: WALLET_ID,
  userId: USER_ID,
  baseline: { addresses: [BASELINE], provenance: {} },
  contacts: [
    { id: "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f", version: 1, address: TEST1 },
  ],
  grants: [],
  ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
  emptyComposition: "unproven",
});

/** The same ordinary rule, with a different allowlist and/or a different cap. */
function ordinaryRule(input: { allowlist: string[]; maxLamports?: string }) {
  const [rule] = composePolicy({
    walletId: WALLET_ID,
    userId: USER_ID,
    baseline: { addresses: [], provenance: {} },
    contacts: input.allowlist.map((address, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      version: 1,
      address,
    })),
    grants: [],
    ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
    emptyComposition: "unproven",
  }).rules;

  if (!input.maxLamports) return rule;
  return {
    ...rule,
    conditions: [
      rule.conditions[0],
      {
        field_source: "solana_system_program_instruction",
        field: "Transfer.lamports",
        operator: "lte",
        value: input.maxLamports,
      },
    ],
  };
}

const UNEXPLAINED_RULE = {
  name: "solana-grant-00000000-0000-4000-8000-000000000000",
  method: "signAndSendTransaction",
  action: "ALLOW",
  conditions: [
    {
      field_source: "solana_system_program_instruction",
      field: "Transfer.to",
      operator: "in",
      value: [UNEXPLAINED],
    },
  ],
};

const ACQUIRED_SIGNERS: OwnerVerifiedSignerRecord[] = [
  { signerId: CANONICAL_SIGNER, overridePolicyIds: [POLICY_ID] },
  { signerId: SIBLING_SIGNER, overridePolicyIds: [] },
];

/** An owner-verified signer listing that does NOT fail check (e) or (f). */
const REACHABLE_SIGNER = {
  canonicalSignerId: CANONICAL_SIGNER,
  ownerVerifiedSigners: { kind: "acquired" as const, signers: ACQUIRED_SIGNERS },
};

/** An owner-verified wallet listing that disproves the recorded binding. */
const OWNERSHIP_DRIFT = {
  providerWalletId: PROVIDER_WALLET_ID,
  ownerVerifiedWallets: {
    kind: "acquired" as const,
    walletIds: ["wallet_01HZYX0000000000000000000f"],
  },
};

function ruleComparison(
  overrides: Partial<Parameters<typeof compareComposedRules>[0]> = {},
): Parameters<typeof compareComposedRules>[0] {
  return {
    phase: "pristine",
    expectedPolicyId: POLICY_ID,
    composedRules: composed.rules,
    provenance: composed.provenance,
    readback: { id: POLICY_ID, rules: composed.rules },
    ...overrides,
  };
}

function binding(overrides: {
  signer?: Parameters<typeof assertOwnerVerifiedBinding>[0]["signer"];
  appliedSignerIds?: string[];
  ownership?: Parameters<typeof assertOwnerVerifiedBinding>[0]["ownership"];
} = {}): Parameters<typeof assertOwnerVerifiedBinding>[0] {
  return {
    expectedPolicyId: POLICY_ID,
    signer: overrides.signer ?? { canonicalSignerId: CANONICAL_SIGNER },
    appliedSignerIds: overrides.appliedSignerIds ?? [],
    ownership: overrides.ownership ?? { providerWalletId: PROVIDER_WALLET_ID },
  };
}

function decision(
  overrides: Partial<Parameters<typeof comparePolicyReadback>[0]> = {},
): PolicyReadbackDecision {
  return comparePolicyReadback({ ...ruleComparison(), ...binding(), ...overrides });
}

type BlockedOutcome = "blocked_conflict" | "blocked_configuration";
type BlockedReason = PolicyReadbackConflictReason | PolicyReadbackConfigurationReason;

/**
 * Asserts the decision is a block with that exact reason, and fails LOUDLY (not
 * with a redundant negation) when it is a resolved outcome instead. That is the
 * "no PATCH decision" requirement: `verified` and `patch_required` are both
 * failures here, and the failure names the outcome that was wrongly reached.
 */
function expectBlocked(
  value: PolicyReadbackDecision,
  outcome: BlockedOutcome,
  reason: BlockedReason,
): void {
  expect(value.outcome).toBe(outcome);
  if (value.outcome === "blocked_conflict" || value.outcome === "blocked_configuration") {
    expect(value.reason).toBe(reason);
    return;
  }
  throw new Error(
    `expected a ${outcome}/${reason} block, but the decision resolved as ${value.outcome}`,
  );
}

/** Deep-freezes a value so an in-place mutation throws instead of passing. */
function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("readback (a) — policy id equality", () => {
  it("reads a matching policy id as equal (positive control)", () => {
    expect(compareComposedRules(ruleComparison())).toEqual({ outcome: "equal" });
  });

  it("classifies a different readback policy id as blocked_conflict", () => {
    const comparison = compareComposedRules(
      ruleComparison({ readback: { id: OTHER_POLICY_ID, rules: composed.rules } }),
    );

    expect(comparison.outcome).toBe("blocked_conflict");
    if (comparison.outcome !== "blocked_conflict") return;
    expect(comparison.reason).toBe("policy_id_mismatch");
    expect(comparison.detail).toEqual({
      expectedPolicyId: POLICY_ID,
      observedPolicyId: OTHER_POLICY_ID,
    });
  });
});

describe("readback (c) — no unknown rule name", () => {
  it("classifies an extra unexplained rule as blocked_conflict in both phases", () => {
    const rules = [...composed.rules, UNEXPLAINED_RULE];

    for (const phase of ["pristine", "verification"] as const) {
      const comparison = compareComposedRules(
        ruleComparison({ phase, readback: { id: POLICY_ID, rules } }),
      );

      expect(comparison.outcome).toBe("blocked_conflict");
      if (comparison.outcome !== "blocked_conflict") continue;
      expect(comparison.reason).toBe("unrecognized_rule");
      expect(comparison.detail.ruleName).toBe(UNEXPLAINED_RULE.name);
    }
  });

  it("classifies without emitting a rule set, so nothing is ever copied from the readback", () => {
    const rules = [...composed.rules, UNEXPLAINED_RULE];
    const comparison = compareComposedRules(
      ruleComparison({ readback: { id: POLICY_ID, rules } }),
    );

    // The whole classification is pinned, including the rule index: an
    // implementation that returned a rule set (or a repaired composition) would
    // not equal this, and the union type has no `rules` member at all.
    expect(comparison).toEqual({
      outcome: "blocked_conflict",
      reason: "unrecognized_rule",
      detail: { ruleIndex: composed.rules.length, ruleName: UNEXPLAINED_RULE.name },
    });
  });

  it("reports the unknown rule name before the addresses inside that same rule", () => {
    // The hoist is deliberate (see the comparator's doc comment): (c) runs before
    // (d), so a rule we cannot explain by name is reported as an unknown rule
    // rather than as an address problem, and the address list is never "read".
    const comparison = compareComposedRules(
      ruleComparison({
        readback: { id: POLICY_ID, rules: [{ ...UNEXPLAINED_RULE, action: "DENY" }] },
      }),
    );

    expect(comparison.outcome).toBe("blocked_conflict");
    if (comparison.outcome !== "blocked_conflict") return;
    expect(comparison.reason).toBe("unrecognized_rule");
  });
});

describe("readback (d) — every Transfer.to address has consent provenance", () => {
  it("classifies an address with no consent provenance as blocked_conflict", () => {
    const comparison = compareComposedRules(
      ruleComparison({
        readback: {
          id: POLICY_ID,
          rules: [ordinaryRule({ allowlist: [BASELINE, UNEXPLAINED] })],
        },
      }),
    );

    expect(comparison.outcome).toBe("blocked_conflict");
    if (comparison.outcome !== "blocked_conflict") return;
    expect(comparison.reason).toBe("recipient_address_without_provenance");
    expect(comparison.detail).toEqual({
      ruleName: "Solana transfer allowlist",
      observedAddress: UNEXPLAINED,
    });
  });

  it("does not block the Test1 address, which does have provenance (the exact A/B twin)", () => {
    // Byte-identical to the blocking case above except for the address: Test1 is
    // an active confirmed contact, so it is in `provenance` and nothing blocks.
    const comparison = compareComposedRules(
      ruleComparison({
        readback: { id: POLICY_ID, rules: [ordinaryRule({ allowlist: [BASELINE, TEST1] })] },
      }),
    );

    expect(comparison).toEqual({ outcome: "equal" });
  });

  it("converges on the Test1 drift's remaining structural difference (a narrowed cap)", () => {
    // The same consented address set, with the remote cap narrowed to 0.001 SOL:
    // nothing is unexplained, so this is a repairable drift and the PATCH the
    // reconciler derives from `composed.rules` legitimately converges it.
    const comparison = compareComposedRules(
      ruleComparison({
        readback: {
          id: POLICY_ID,
          rules: [ordinaryRule({ allowlist: [BASELINE, TEST1], maxLamports: "1000000" })],
        },
      }),
    );

    expect(comparison.outcome).toBe("converge");
  });

  describe("a rule whose allowlist cannot be enumerated", () => {
    const ordinary = composed.rules[0];

    const unenumerable: Array<{ label: string; conditions: unknown }> = [
      { label: "a rule with no conditions at all", conditions: undefined },
      {
        label: "conditions that are not an array",
        conditions: { field: "Transfer.to" },
      },
      {
        label: "a Transfer.to condition with no value",
        conditions: [
          {
            field_source: "solana_system_program_instruction",
            field: "Transfer.to",
            operator: "in",
          },
        ],
      },
      {
        label: "a Transfer.to value that is not an array",
        conditions: [
          {
            field_source: "solana_system_program_instruction",
            field: "Transfer.to",
            operator: "in",
            value: BASELINE,
          },
        ],
      },
      {
        label: "a Transfer.to value with a non-string entry",
        conditions: [
          {
            field_source: "solana_system_program_instruction",
            field: "Transfer.to",
            operator: "in",
            value: [BASELINE, 42],
          },
        ],
      },
    ];

    for (const { label, conditions } of unenumerable) {
      it(`classifies ${label} as blocked_conflict, never as a repairable drift`, () => {
        const readback = { id: POLICY_ID, rules: [{ ...ordinary, conditions }] };

        const comparison = compareComposedRules(ruleComparison({ readback }));

        expect(comparison.outcome).toBe("blocked_conflict");
        if (comparison.outcome !== "blocked_conflict") return;
        expect(comparison.reason).toBe("rule_conditions_unreadable");
        expect(comparison.detail.ruleName).toBe(ordinary.name);

        // An allowlist we cannot enumerate is an allowlist we cannot prove: this
        // must never become a PATCH, because overwriting the rule would delete an
        // unknown remote allowlist instead of preserving it.
        expect(decision({ readback }).outcome).toBe("blocked_conflict");
      });
    }
  });
});

describe("readback (b) — structural rule equality and the Test1 drift", () => {
  it("converges on the pristine drift that has provenance, and blocks it on verification", () => {
    const drifted = {
      id: POLICY_ID,
      rules: [ordinaryRule({ allowlist: [BASELINE, TEST1], maxLamports: "1000000" })],
    };

    expect(compareComposedRules(ruleComparison({ readback: drifted }))).toEqual({
      outcome: "converge",
    });

    const verification = compareComposedRules(
      ruleComparison({ phase: "verification", readback: drifted }),
    );

    expect(verification.outcome).toBe("blocked_conflict");
    if (verification.outcome !== "blocked_conflict") return;
    expect(verification.reason).toBe("rules_mismatch");
    expect(verification.detail).toEqual({
      composedRuleCount: composed.rules.length,
      observedRuleCount: 1,
    });
  });

  it("reads an unchanged rule set as equal in the verification phase too (positive control)", () => {
    expect(
      compareComposedRules(
        ruleComparison({ phase: "verification", readback: { id: POLICY_ID, rules: composed.rules } }),
      ),
    ).toEqual({ outcome: "equal" });
  });

  it("is key-order independent, like the existing comparator", () => {
    const reordered = composed.rules.map((rule) => ({
      conditions: rule.conditions.map((condition) => ({
        value: condition.value,
        operator: condition.operator,
        field: condition.field,
        field_source: condition.field_source,
      })),
      action: rule.action,
      method: rule.method,
      name: rule.name,
    }));

    expect(
      compareComposedRules(ruleComparison({ readback: { id: POLICY_ID, rules: reordered } })),
    ).toEqual({ outcome: "equal" });
  });

  it("classifies frozen inputs by reading them, never by rewriting them", () => {
    // Freezing both the composed rules and the readback makes any in-place sort,
    // dedupe or normalisation throw, so "the comparator never derives a rule set"
    // is asserted as behaviour rather than as the absence of a property.
    const composedRules = deepFreeze(structuredClone(composed.rules));
    const readbackRules = deepFreeze([
      ...structuredClone(composed.rules),
      structuredClone(UNEXPLAINED_RULE),
    ]);
    const before = JSON.stringify(composedRules);

    const comparison = compareComposedRules(
      ruleComparison({
        composedRules,
        readback: { id: POLICY_ID, rules: readbackRules },
      }),
    );

    expect(comparison.outcome).toBe("blocked_conflict");
    expect(JSON.stringify(composedRules)).toBe(before);
    expect(readbackRules).toHaveLength(composed.rules.length + 1);
  });
});

describe("readback (e) — the canonical signer attachment", () => {
  const cases: Array<{ label: string; signers: OwnerVerifiedSignerRecord[] }> = [
    { label: "missing", signers: [ACQUIRED_SIGNERS[1]] },
    {
      label: "duplicated",
      signers: [ACQUIRED_SIGNERS[0], ACQUIRED_SIGNERS[0], ACQUIRED_SIGNERS[1]],
    },
    {
      // The only case the "exactly once" clause can catch on its own: two
      // occurrences whose combined `override_policy_ids` is exactly one entry, so
      // the policy-id count check passes and only the occurrence count blocks.
      label: "duplicated with only one entry carrying our policy id",
      signers: [
        { signerId: CANONICAL_SIGNER, overridePolicyIds: [POLICY_ID] },
        { signerId: CANONICAL_SIGNER, overridePolicyIds: [] },
        ACQUIRED_SIGNERS[1],
      ],
    },
    {
      label: "carrying another policy id",
      signers: [{ signerId: CANONICAL_SIGNER, overridePolicyIds: [OTHER_POLICY_ID] }],
    },
    {
      label: "carrying our policy id and another",
      signers: [{ signerId: CANONICAL_SIGNER, overridePolicyIds: [POLICY_ID, OTHER_POLICY_ID] }],
    },
  ];

  for (const { label, signers } of cases) {
    it(`classifies a ${label} canonical signer as blocked_configuration`, () => {
      const result = assertOwnerVerifiedBinding(
        binding({
          signer: {
            canonicalSignerId: CANONICAL_SIGNER,
            ownerVerifiedSigners: { kind: "acquired", signers },
          },
        }),
      );

      expect(result.outcome).toBe("blocked_configuration");
      if (result.outcome !== "blocked_configuration") return;
      expect(result.reason).toBe("signer_attachment_unproven");
      expect(result.detail.canonicalSignerId).toBe(CANONICAL_SIGNER);
    });
  }

  it("fails closed when the owner-verified signer read has not been acquired", () => {
    const omitted = assertOwnerVerifiedBinding(binding());
    const explicit = assertOwnerVerifiedBinding(
      binding({
        signer: {
          canonicalSignerId: CANONICAL_SIGNER,
          ownerVerifiedSigners: { kind: "not_acquired", reason: "slice 2 read" },
        },
      }),
    );

    for (const result of [omitted, explicit]) {
      expect(result.outcome).toBe("blocked_configuration");
      if (result.outcome !== "blocked_configuration") continue;
      expect(result.reason).toBe("signer_attachment_unproven");
    }
    // The absent form and the explicit form are the same classification.
    expect(omitted).toEqual(explicit);
  });

  it("reports the occurrence count so the anomalies are distinguishable", () => {
    const counts = cases.map(({ signers }) => {
      const result = assertOwnerVerifiedBinding(
        binding({
          signer: {
            canonicalSignerId: CANONICAL_SIGNER,
            ownerVerifiedSigners: { kind: "acquired", signers },
          },
        }),
      );
      return result.outcome === "blocked_configuration"
        ? result.detail.observedOccurrences
        : null;
    });

    expect(counts).toEqual([0, 2, 2, 1, 1]);
  });
});

describe("readback (f) — unrelated sibling signers", () => {
  it("classifies a lost sibling signer as blocked_configuration", () => {
    const result = assertOwnerVerifiedBinding(
      binding({
        signer: {
          canonicalSignerId: CANONICAL_SIGNER,
          ownerVerifiedSigners: {
            kind: "acquired",
            signers: [ACQUIRED_SIGNERS[0]],
          },
        },
        appliedSignerIds: [CANONICAL_SIGNER, SIBLING_SIGNER],
      }),
    );

    expect(result.outcome).toBe("blocked_configuration");
    if (result.outcome !== "blocked_configuration") return;
    expect(result.reason).toBe("sibling_signer_lost");
    expect(result.detail.missingSignerIds).toEqual([SIBLING_SIGNER]);
  });

  it("reports a missing canonical signer before a lost sibling in the same readback", () => {
    const result = assertOwnerVerifiedBinding(
      binding({
        signer: {
          canonicalSignerId: CANONICAL_SIGNER,
          ownerVerifiedSigners: { kind: "acquired", signers: [ACQUIRED_SIGNERS[1]] },
        },
        appliedSignerIds: [CANONICAL_SIGNER, SIBLING_SIGNER, THIRD_SIGNER],
      }),
    );

    // (e) is evaluated before (f), exactly as design §5.1 orders them: the
    // attachment is the primary assertion and the sibling list is secondary.
    expect(result.outcome).toBe("blocked_configuration");
    if (result.outcome !== "blocked_configuration") return;
    expect(result.reason).toBe("signer_attachment_unproven");
  });

  it("moves past (e) and (f) to the ownership check when no sibling is lost (positive control)", () => {
    const result = assertOwnerVerifiedBinding(
      binding({
        signer: {
          canonicalSignerId: CANONICAL_SIGNER,
          ownerVerifiedSigners: { kind: "acquired", signers: ACQUIRED_SIGNERS },
        },
        appliedSignerIds: [CANONICAL_SIGNER, SIBLING_SIGNER],
      }),
    );

    // The canonical signer and the sibling are both accounted for, so the only
    // remaining fail-closed stop is ownership — which is still unproven here.
    expect(result.outcome).toBe("blocked_configuration");
    if (result.outcome !== "blocked_configuration") return;
    expect(result.reason).toBe("ownership_unproven");
  });
});

describe("readback (g) — the wallet resolved from the owner-verified listing", () => {
  /**
   * The signer listing is supplied only so the ownership check is reachable: a
   * missing canonical signer would be reported by check (e) first. The asserted
   * outcome is still a fail-closed block, and no case here asserts a resolved
   * signer or ownership semantic (that proof lands in slice 2, design §11 U2/U3).
   */
  const reachable = REACHABLE_SIGNER;

  it("fails closed when the owner-verified wallet listing has not been acquired", () => {
    const result = assertOwnerVerifiedBinding(binding({ signer: reachable }));

    expect(result.outcome).toBe("blocked_configuration");
    if (result.outcome !== "blocked_configuration") return;
    expect(result.reason).toBe("ownership_unproven");
  });

  it("classifies owner drift as blocked_configuration", () => {
    const result = assertOwnerVerifiedBinding(
      binding({
        signer: reachable,
        ownership: {
          providerWalletId: PROVIDER_WALLET_ID,
          ownerVerifiedWallets: { kind: "acquired", walletIds: [] },
        },
      }),
    );

    expect(result.outcome).toBe("blocked_configuration");
    if (result.outcome !== "blocked_configuration") return;
    expect(result.reason).toBe("ownership_drift");
    expect(result.detail.expectedWalletId).toBe(PROVIDER_WALLET_ID);
    expect(result.detail.observedWalletCount).toBe(0);
  });

  it("distinguishes an unproven ownership read from a proven mismatch", () => {
    const unproven = assertOwnerVerifiedBinding(binding({ signer: reachable }));
    const drift = assertOwnerVerifiedBinding(
      binding({
        signer: reachable,
        ownership: {
          providerWalletId: PROVIDER_WALLET_ID,
          ownerVerifiedWallets: { kind: "acquired", walletIds: ["wallet_other"] },
        },
      }),
    );

    // Two different inputs, two different reasons: a single catch-all default
    // could not tell a never-performed read from a read that disproves the owner.
    expect(unproven).not.toEqual(drift);
    expect(unproven.outcome === "blocked_configuration" && unproven.reason).toBe(
      "ownership_unproven",
    );
    expect(drift.outcome === "blocked_configuration" && drift.reason).toBe(
      "ownership_drift",
    );
  });
});

describe("the §5.1 decision the reconciler consumes", () => {
  it("never returns a PATCH decision while the owner-verified binding is unproven", () => {
    const drifted = {
      id: POLICY_ID,
      rules: [ordinaryRule({ allowlist: [BASELINE, TEST1], maxLamports: "1000000" })],
    };

    const result = decision({ readback: drifted });

    expectBlocked(result, "blocked_configuration", "signer_attachment_unproven");
    expect(result.outcome).not.toBe("patch_required");
  });

  it("reports a conflict before it reports a configuration stop", () => {
    const result = decision({
      readback: {
        id: OTHER_POLICY_ID,
        rules: [ordinaryRule({ allowlist: [BASELINE, TEST1] })],
      },
    });

    expectBlocked(result, "blocked_conflict", "policy_id_mismatch");
  });

  it("classifies every (a)–(d) failure as blocked_conflict and every (e)–(g) failure as blocked_configuration", () => {
    const cases: Array<[string, PolicyReadbackDecision, BlockedOutcome, BlockedReason]> = [
      [
        "(a) another policy id",
        decision({ readback: { id: OTHER_POLICY_ID, rules: composed.rules } }),
        "blocked_conflict",
        "policy_id_mismatch",
      ],
      [
        "(c) an extra unexplained rule",
        decision({ readback: { id: POLICY_ID, rules: [...composed.rules, UNEXPLAINED_RULE] } }),
        "blocked_conflict",
        "unrecognized_rule",
      ],
      [
        "(d) an address with no consent provenance",
        decision({
          readback: { id: POLICY_ID, rules: [ordinaryRule({ allowlist: [BASELINE, UNEXPLAINED] })] },
        }),
        "blocked_conflict",
        "recipient_address_without_provenance",
      ],
      [
        "(d) an allowlist that cannot be enumerated",
        decision({
          readback: {
            id: POLICY_ID,
            rules: [{ ...composed.rules[0], conditions: undefined }],
          },
        }),
        "blocked_conflict",
        "rule_conditions_unreadable",
      ],
      [
        "(b) a rule mismatch while verifying",
        decision({
          phase: "verification",
          readback: {
            id: POLICY_ID,
            rules: [ordinaryRule({ allowlist: [BASELINE, TEST1], maxLamports: "1000000" })],
          },
        }),
        "blocked_conflict",
        "rules_mismatch",
      ],
      [
        "(e) an unacquired signer read",
        decision(),
        "blocked_configuration",
        "signer_attachment_unproven",
      ],
      [
        "(e) a duplicated canonical signer",
        decision({
          signer: {
            canonicalSignerId: CANONICAL_SIGNER,
            ownerVerifiedSigners: {
              kind: "acquired",
              signers: [ACQUIRED_SIGNERS[0], ACQUIRED_SIGNERS[0], ACQUIRED_SIGNERS[1]],
            },
          },
        }),
        "blocked_configuration",
        "signer_attachment_unproven",
      ],
      [
        "(e) a duplicated canonical signer carrying our policy id only once",
        decision({
          signer: {
            canonicalSignerId: CANONICAL_SIGNER,
            ownerVerifiedSigners: {
              kind: "acquired",
              signers: [
                { signerId: CANONICAL_SIGNER, overridePolicyIds: [POLICY_ID] },
                { signerId: CANONICAL_SIGNER, overridePolicyIds: [] },
                ACQUIRED_SIGNERS[1],
              ],
            },
          },
        }),
        "blocked_configuration",
        "signer_attachment_unproven",
      ],
      [
        "(f) a lost sibling signer",
        decision({
          appliedSignerIds: [CANONICAL_SIGNER, SIBLING_SIGNER],
          signer: {
            canonicalSignerId: CANONICAL_SIGNER,
            ownerVerifiedSigners: { kind: "acquired", signers: [ACQUIRED_SIGNERS[0]] },
          },
        }),
        "blocked_configuration",
        "sibling_signer_lost",
      ],
      [
        "(g) an unproven ownership read",
        decision({ signer: REACHABLE_SIGNER }),
        "blocked_configuration",
        "ownership_unproven",
      ],
      [
        "(g) owner drift",
        decision({ signer: REACHABLE_SIGNER, ownership: OWNERSHIP_DRIFT }),
        "blocked_configuration",
        "ownership_drift",
      ],
    ];

    for (const [label, value, outcome, reason] of cases) {
      // `expectBlocked` throws when the decision resolved as verified or
      // patch_required, so every row is also the "no PATCH decision" assertion
      // task 1.5 requires for owner drift, the missing/duplicated canonical
      // signer and the lost sibling signer.
      expectBlocked(value, outcome, reason);
    }
    expect(cases).toHaveLength(11);
    expect(new Set(cases.map(([, , , reason]) => reason)).size).toBe(9);
  });
});
