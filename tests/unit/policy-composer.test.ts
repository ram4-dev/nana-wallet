import { describe, expect, it } from "vitest";
import { buildSolanaEnrollmentRules } from "../../src/wallet/grants/solana-enrollment-rules.js";
import {
  composeGrantRules,
  type GrantPolicyInput,
} from "../../src/wallet/grants/solana-policy-provisioner.js";
import { SOLANA_MAX_PER_TRANSFER_LAMPORTS } from "../../src/wallet/embedded.js";
import {
  composeGrantRules as reExportedComposeGrantRules,
  composePolicy,
  type ComposeInput,
} from "../../src/wallet/policy/composer.js";
import {
  PolicyComposerRequiredError,
  PolicyCompositionRefusalError,
  PolicyEmptyCompositionUnprovenError,
  PolicyOrdinaryCapUnsupportedError,
  PolicyRuleCompositionUnprovenError,
} from "../../src/wallet/policy/errors.js";

const USER_ID = "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d";
const WALLET_ID = "0d1b2c34-5678-49ab-8cde-000000000001";

/** The wallet's own retained enrollment address (consent baseline). */
const BASELINE_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** An active confirmed trusted contact. */
const CONTACT_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const CONTACT_ID = "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f";
/** A delegated grant recipient, never a consent allowlist member. */
const GRANT_ADDRESS = "So11111111111111111111111111111111111111112";

function grant(overrides: Partial<GrantPolicyInput> = {}): GrantPolicyInput {
  return {
    grantId: "11111111-1111-4111-8111-111111111111",
    walletId: WALLET_ID,
    recipients: [GRANT_ADDRESS],
    maxPerTransfer: "5000000",
    expiresAt: 1_800_000_000,
    ...overrides,
  };
}

function composeInput(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    walletId: WALLET_ID,
    userId: USER_ID,
    baseline: { addresses: [BASELINE_ADDRESS], provenance: {} },
    contacts: [],
    grants: [],
    ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
    emptyComposition: "unproven",
    ...overrides,
  };
}

function rulesJson(value: unknown): string {
  return JSON.stringify(value);
}

describe("composePolicy — ordinary rule (design §3.2 guarantee 1)", () => {
  it("caps the ordinary transfer rule at exactly 10000000 lamports", () => {
    const composed = composePolicy(composeInput());

    expect(SOLANA_MAX_PER_TRANSFER_LAMPORTS).toBe("10000000");
    expect(composed.rules).toHaveLength(1);
    expect(composed.rules[0].conditions[1]).toEqual({
      field_source: "solana_system_program_instruction",
      field: "Transfer.lamports",
      operator: "lte",
      value: "10000000",
    });
  });

  it("emits an ordinary rule byte-identical to the enrollment builder's output", () => {
    const composed = composePolicy(composeInput());

    const expected = buildSolanaEnrollmentRules({
      recipients: composed.ordinaryRecipients,
      maxLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
    });

    expect(rulesJson(composed.rules[0])).toBe(rulesJson(expected[0]));
    expect(composed.rules[0].name).toBe("Solana transfer allowlist");
  });

  it("refuses an ordinary cap that does not come from the single lamport constant", () => {
    const widening = () =>
      composePolicy(composeInput({ ordinaryCapLamports: "10000001" }));
    const narrowing = () =>
      composePolicy(composeInput({ ordinaryCapLamports: "9999999" }));

    expect(widening).toThrow(PolicyOrdinaryCapUnsupportedError);
    // A narrower cap is refused too: the composer must not silently re-authorize
    // a ceiling the applied policy does not carry.
    expect(narrowing).toThrow(PolicyOrdinaryCapUnsupportedError);
    expect(widening).toThrow(/10000000/u);
  });
});

describe("composePolicy — consent boundary (design §3.2 guarantee 2)", () => {
  it("keeps the baseline and the active contacts in the ordinary allowlist", () => {
    const composed = composePolicy(
      composeInput({
        contacts: [
          { id: CONTACT_ID, version: 3, address: CONTACT_ADDRESS },
        ],
      }),
    );

    expect(composed.ordinaryRecipients).toEqual([
      BASELINE_ADDRESS,
      CONTACT_ADDRESS,
    ]);
    expect(composed.rules[0].conditions[0].value).toEqual([
      BASELINE_ADDRESS,
      CONTACT_ADDRESS,
    ]);
    expect(composed.provenance[BASELINE_ADDRESS]).toBe("baseline");
    expect(composed.provenance[CONTACT_ADDRESS]).toBe("contact");
  });

  it("never folds a grant recipient into the ordinary allowlist", () => {
    const composed = composePolicy(
      composeInput({
        contacts: [
          { id: CONTACT_ID, version: 1, address: CONTACT_ADDRESS },
        ],
        grants: [grant()],
        ruleComposition: "union",
      }),
    );

    expect(composed.ordinaryRecipients).not.toContain(GRANT_ADDRESS);
    expect(composed.rules[0].conditions[0].value).not.toContain(GRANT_ADDRESS);
    // The grant recipient is composed — exclusively in its own conditioned rule.
    expect(composed.grantRecipients).toEqual([
      { grantId: "11111111-1111-4111-8111-111111111111", recipients: [GRANT_ADDRESS] },
    ]);
    expect(composed.provenance[GRANT_ADDRESS]).toBe("grant");
  });
});

describe("composePolicy — delegated limits (design §3.2 guarantee 3)", () => {
  it("emits one rule per active grant carrying the ledger's own cap and stored expiry", () => {
    const composed = composePolicy(
      composeInput({
        baseline: { addresses: [], provenance: {} },
        grants: [
          grant({
            grantId: "11111111-1111-4111-8111-111111111111",
            maxPerTransfer: "7000000",
            expiresAt: 1_900_000_000,
          }),
          grant({
            grantId: "22222222-2222-4222-8222-222222222222",
            recipients: ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"],
            maxPerTransfer: "3000000",
            expiresAt: 1_910_000_000,
          }),
        ],
      }),
    );

    expect(composed.rules.map((rule) => rule.name)).toEqual([
      "solana-grant-11111111-1111-4111-8111-111111111111",
      "solana-grant-22222222-2222-4222-8222-222222222222",
    ]);
    expect(composed.rules[0].conditions[1].value).toBe("7000000");
    expect(composed.rules[0].conditions[2]).toEqual({
      field_source: "system",
      field: "current_unix_timestamp",
      operator: "lt",
      value: 1_900_000_000,
    });
    expect(composed.rules[1].conditions[1].value).toBe("3000000");
    expect(composed.rules[1].conditions[2].value).toBe(1_910_000_000);
    expect(rulesJson(composed.rules)).toBe(
      rulesJson(
        composeGrantRules([
          grant({
            grantId: "11111111-1111-4111-8111-111111111111",
            maxPerTransfer: "7000000",
            expiresAt: 1_900_000_000,
          }),
          grant({
            grantId: "22222222-2222-4222-8222-222222222222",
            recipients: ["5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1"],
            maxPerTransfer: "3000000",
            expiresAt: 1_910_000_000,
          }),
        ]),
      ),
    );
  });

  it("accepts a single-family grant-only composition without the union probe", () => {
    const composed = composePolicy(
      composeInput({
        baseline: { addresses: [], provenance: {} },
        grants: [grant()],
        emptyComposition: "unproven",
      }),
    );

    expect(composed.rules).toHaveLength(1);
    expect(composed.rules[0].name).toBe(
      "solana-grant-11111111-1111-4111-8111-111111111111",
    );
    expect(composed.ordinaryRecipients).toEqual([]);
  });
});

describe("composePolicy — determinism (design §3.2 guarantee 4)", () => {
  const ORDERED_TOKENS = ["zzz", "AAA", "bbb", "Zzz", "aaa", "BBB"];

  it("orders addresses by code-unit order, never by a locale comparator", () => {
    const composed = composePolicy(
      composeInput({
        baseline: { addresses: ORDERED_TOKENS, provenance: {} },
      }),
    );

    const codeUnitOrder = [...ORDERED_TOKENS].sort((a, b) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    const localeOrder = [...ORDERED_TOKENS].sort((a, b) => a.localeCompare(b));

    // Guards the fixture's discriminating power: if these ever agreed, the
    // assertion below would no longer prove which comparator the composer uses.
    expect(localeOrder).not.toEqual(codeUnitOrder);
    expect(composed.ordinaryRecipients).toEqual(codeUnitOrder);
    expect(composed.ordinaryRecipients).not.toEqual(localeOrder);
  });

  it("composes identically and hashes identically across runs and input orders", () => {
    const contacts = [
      { id: "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f", version: 1, address: "ccc" },
      { id: "4f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e10", version: 1, address: "aaa" },
      { id: "5f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e11", version: 1, address: "bbb" },
    ];
    const grants = [
      grant({ grantId: "22222222-2222-4222-8222-222222222222", recipients: ["zzz", "aaa"] }),
      grant({ grantId: "11111111-1111-4111-8111-111111111111", recipients: ["bbb"] }),
    ];

    const first = composePolicy(
      composeInput({ contacts, grants, ruleComposition: "union" }),
    );
    const second = composePolicy(
      composeInput({
        contacts: [...contacts].reverse(),
        grants: [...grants].reverse(),
        ruleComposition: "union",
      }),
    );

    expect(second).toEqual(first);
    expect(second.hash).toBe(first.hash);
    expect(second.rules.map((rule) => rule.name)).toEqual([
      "Solana transfer allowlist",
      "solana-grant-11111111-1111-4111-8111-111111111111",
      "solana-grant-22222222-2222-4222-8222-222222222222",
    ]);
    // Input order is not an input to the composition: the grant's own allowlist
    // is sorted and deduplicated before it reaches the rule builder.
    expect(second.rules[2].conditions[0].value).toEqual(["aaa", "zzz"]);
  });
});

describe("composePolicy — empty composition (design §3.2 guarantee 8, §11 U4)", () => {
  it("refuses an empty composition unless empty_composition is proven_deny", () => {
    const unproven = () =>
      composePolicy(
        composeInput({
          baseline: { addresses: [], provenance: {} },
          emptyComposition: "unproven",
        }),
      );
    const unsupported = () =>
      composePolicy(
        composeInput({
          baseline: { addresses: [], provenance: {} },
          emptyComposition: "unsupported",
        }),
      );

    expect(unproven).toThrow(PolicyEmptyCompositionUnprovenError);
    expect(unsupported).toThrow(PolicyEmptyCompositionUnprovenError);
    try {
      unproven();
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyCompositionRefusalError);
      expect((error as PolicyEmptyCompositionUnprovenError).failureClass).toBe(
        "blocked_configuration",
      );
      expect((error as PolicyEmptyCompositionUnprovenError).reason).toBe(
        "empty_composition_unproven",
      );
      expect(
        (error as PolicyEmptyCompositionUnprovenError).emptyComposition,
      ).toBe("unproven");
    }
  });

  it("composes the empty deny representation only once the probe recorded proven_deny", () => {
    const composed = composePolicy(
      composeInput({
        baseline: { addresses: [], provenance: {} },
        emptyComposition: "proven_deny",
      }),
    );

    expect(composed.rules).toEqual([]);
    expect(composed.ordinaryRecipients).toEqual([]);
    expect(composed.grantRecipients).toEqual([]);
    expect(composed.provenance).toEqual({});
    expect(composed.hash).toBe(
      "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945",
    );
  });

  it("refuses nothing when a single ordinary recipient exists (positive control)", () => {
    expect(() => composePolicy(composeInput())).not.toThrow();
  });
});

describe("composePolicy — the two rule families (design §11 U1)", () => {
  it("refuses ordinary + grant coexistence until the probe records union", () => {
    const omitted = () =>
      composePolicy(composeInput({ grants: [grant()] }));
    const declaredUnproven = () =>
      composePolicy(
        composeInput({ grants: [grant()], ruleComposition: "unproven" }),
      );

    expect(omitted).toThrow(PolicyRuleCompositionUnprovenError);
    expect(declaredUnproven).toThrow(PolicyRuleCompositionUnprovenError);
    try {
      omitted();
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyCompositionRefusalError);
      expect(
        (error as PolicyRuleCompositionUnprovenError).failureClass,
      ).toBe("blocked_configuration");
      expect((error as PolicyRuleCompositionUnprovenError).reason).toBe(
        "rule_composition_semantics_unproven",
      );
    }
  });

  it("composes both families once the probe records union (positive control)", () => {
    const composed = composePolicy(
      composeInput({ grants: [grant()], ruleComposition: "union" }),
    );

    expect(composed.rules).toHaveLength(2);
    expect(composed.rules[0].name).toBe("Solana transfer allowlist");
    expect(composed.rules[0].conditions[0].value).toEqual([BASELINE_ADDRESS]);
    expect(composed.rules[1].name).toBe(
      "solana-grant-11111111-1111-4111-8111-111111111111",
    );
  });
});

describe("composePolicy — metadata edits never broaden permission (spec)", () => {
  it("is rule-identical and hash-identical when only contact metadata changed", () => {
    const before = composePolicy(
      composeInput({
        contacts: [{ id: CONTACT_ID, version: 1, address: CONTACT_ADDRESS }],
      }),
    );
    const after = composePolicy(
      composeInput({
        contacts: [
          {
            id: "99999999-9999-4999-8999-999999999999",
            version: 7,
            address: CONTACT_ADDRESS,
          },
        ],
      }),
    );

    expect(rulesJson(after.rules)).toBe(rulesJson(before.rules));
    expect(after.hash).toBe(before.hash);
  });

  it("changes the hash when the address itself changes (falsifiable pair)", () => {
    const before = composePolicy(
      composeInput({
        contacts: [{ id: CONTACT_ID, version: 1, address: CONTACT_ADDRESS }],
      }),
    );
    const after = composePolicy(
      composeInput({
        contacts: [{ id: CONTACT_ID, version: 2, address: GRANT_ADDRESS }],
      }),
    );

    expect(after.hash).not.toBe(before.hash);
    expect(after.rules[0].conditions[0].value).toEqual([
      BASELINE_ADDRESS,
      GRANT_ADDRESS,
    ]);
  });
});

describe("composePolicy — address identity across the three families", () => {
  it("deduplicates an address that is both the baseline and a contact", () => {
    const composed = composePolicy(
      composeInput({
        contacts: [{ id: CONTACT_ID, version: 1, address: BASELINE_ADDRESS }],
      }),
    );

    expect(composed.ordinaryRecipients).toEqual([BASELINE_ADDRESS]);
    expect(composed.rules[0].conditions[0].value).toEqual([BASELINE_ADDRESS]);
    expect(composed.provenance[BASELINE_ADDRESS]).toBe("contact");
  });

  it("composes an address that is both a contact and a grant recipient in both rules", () => {
    const composed = composePolicy(
      composeInput({
        contacts: [{ id: CONTACT_ID, version: 1, address: GRANT_ADDRESS }],
        grants: [grant({ recipients: [GRANT_ADDRESS] })],
        ruleComposition: "union",
      }),
    );

    expect(composed.rules[0].conditions[0].value).toEqual([
      BASELINE_ADDRESS,
      GRANT_ADDRESS,
    ]);
    expect(composed.rules[1].conditions[0].value).toEqual([GRANT_ADDRESS]);
    expect(composed.provenance[GRANT_ADDRESS]).toBe("grant");
  });

  it("publishes exactly the provenance union the readback comparator checks against", () => {
    const composed = composePolicy(
      composeInput({
        contacts: [{ id: CONTACT_ID, version: 1, address: CONTACT_ADDRESS }],
        grants: [grant()],
        ruleComposition: "union",
      }),
    );

    const expectedKeys = [
      ...composed.ordinaryRecipients,
      ...composed.grantRecipients.flatMap((entry) => entry.recipients),
    ].sort();

    expect(Object.keys(composed.provenance).sort()).toEqual(expectedKeys);
    expect(new Set(Object.values(composed.provenance))).toEqual(
      new Set(["baseline", "contact", "grant"]),
    );
  });
});

describe("composer module boundary (design §3.3)", () => {
  it("re-exports the existing grant rule builder instead of restating it", () => {
    expect(reExportedComposeGrantRules).toBe(composeGrantRules);

    const composed = composePolicy(
      composeInput({
        baseline: { addresses: [], provenance: {} },
        grants: [grant()],
      }),
    );
    expect(rulesJson(composed.rules)).toBe(rulesJson(composeGrantRules([grant()])));
  });
});

describe("composition refusals carry their status class and reason", () => {
  it("classifies a path that cannot route through the composer as blocked configuration", () => {
    const error = new PolicyComposerRequiredError("legacy provisionPolicy path");

    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(PolicyCompositionRefusalError);
    expect(error.name).toBe("PolicyComposerRequiredError");
    expect(error.failureClass).toBe("blocked_configuration");
    expect(error.reason).toBe("composer_required");
    expect(error.message).toContain("legacy provisionPolicy path");
  });

  it("keeps every refusal reason distinct and fail-closed", () => {
    const reasons = new Set([
      new PolicyComposerRequiredError("path").reason,
      new PolicyEmptyCompositionUnprovenError("unproven").reason,
      new PolicyRuleCompositionUnprovenError({
        ordinaryRecipients: 1,
        grantRules: 1,
      }).reason,
      new PolicyOrdinaryCapUnsupportedError({
        ordinaryCapLamports: "1",
        supported: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
      }).reason,
    ]);

    expect(reasons.size).toBe(4);
    for (const error of [
      new PolicyComposerRequiredError("path"),
      new PolicyEmptyCompositionUnprovenError("unsupported"),
      new PolicyRuleCompositionUnprovenError({
        ordinaryRecipients: 1,
        grantRules: 1,
      }),
      new PolicyOrdinaryCapUnsupportedError({
        ordinaryCapLamports: "1",
        supported: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
      }),
    ]) {
      expect(["blocked_conflict", "blocked_configuration"]).toContain(
        error.failureClass,
      );
    }
  });
});
