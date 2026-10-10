import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  SOLANA_MAX_PER_TRANSFER_LAMPORTS,
  deterministicPolicyHash,
  type GrantInput,
} from "../../src/wallet/embedded.js";
import {
  composedRulesHash,
  composePolicy,
  type ComposeInput,
} from "../../src/wallet/policy/composer.js";
import type { GrantPolicyRule } from "../../src/wallet/grants/solana-policy-provisioner.js";

/**
 * The rule fixture is spelled out here with the design's declared key order, so
 * the pinned digest below is an independent reproduction of design §3.2
 * guarantee 5 (canonical = array of arrays, declared key order) rather than a
 * snapshot of whatever this module happens to emit.
 */
const ORDINARY_RULE: GrantPolicyRule = {
  name: "Solana transfer allowlist",
  method: "signAndSendTransaction",
  action: "ALLOW",
  conditions: [
    {
      field_source: "solana_system_program_instruction",
      field: "Transfer.to",
      operator: "in",
      value: ["AAA", "BBB"],
    },
    {
      field_source: "solana_system_program_instruction",
      field: "Transfer.lamports",
      operator: "lte",
      value: "10000000",
    },
  ],
};

const ORDINARY_RULE_DIGEST =
  "sha256:b6796fff34b61b2838f19f8f9d0b8e2bf0c65c4091270d74e2074fd5da1c6edd";
const EMPTY_RULES_DIGEST =
  "sha256:4f53cda18c2baa0c0354bb5f9a3ecbe5ed12ab4d8e11ba873c2f11161202b945";

describe("composedRulesHash — canonical encoding (design §3.2 guarantee 5)", () => {
  it("hashes the declared canonical form of the composed rule set", () => {
    expect(composedRulesHash([ORDINARY_RULE])).toBe(ORDINARY_RULE_DIGEST);
    expect(composedRulesHash([])).toBe(EMPTY_RULES_DIGEST);
  });

  it("emits a plain sha256 digest in a distinguishable format", () => {
    expect(composedRulesHash([ORDINARY_RULE])).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("is independent of the key insertion order of a rule and of a condition", () => {
    const reordered: GrantPolicyRule = {
      conditions: [
        {
          operator: "in",
          value: ["AAA", "BBB"],
          field: "Transfer.to",
          field_source: "solana_system_program_instruction",
        },
        {
          value: "10000000",
          operator: "lte",
          field_source: "solana_system_program_instruction",
          field: "Transfer.lamports",
        },
      ],
      action: "ALLOW",
      method: "signAndSendTransaction",
      name: "Solana transfer allowlist",
    };

    // Guards the discriminating power of the assertion below.
    expect(isDeepStrictEqual(reordered, ORDINARY_RULE)).toBe(true);
    expect(Object.keys(reordered)).not.toEqual(Object.keys(ORDINARY_RULE));

    expect(composedRulesHash([reordered])).toBe(
      composedRulesHash([ORDINARY_RULE]),
    );
  });

  it("is sensitive to a changed condition value", () => {
    const widened: GrantPolicyRule = {
      ...ORDINARY_RULE,
      conditions: [
        ORDINARY_RULE.conditions[0],
        {
          field_source: "solana_system_program_instruction",
          field: "Transfer.lamports",
          operator: "lte",
          value: "99000000",
        },
      ],
    };

    expect(composedRulesHash([widened])).not.toBe(
      composedRulesHash([ORDINARY_RULE]),
    );
  });

  it("is sensitive to an added or removed rule and to rule order", () => {
    const grantRule: GrantPolicyRule = {
      name: "solana-grant-11111111-1111-4111-8111-111111111111",
      method: "signAndSendTransaction",
      action: "ALLOW",
      conditions: [
        {
          field_source: "solana_system_program_instruction",
          field: "Transfer.to",
          operator: "in",
          value: ["CCC"],
        },
      ],
    };

    expect(composedRulesHash([ORDINARY_RULE, grantRule])).not.toBe(
      composedRulesHash([ORDINARY_RULE]),
    );
    expect(composedRulesHash([grantRule, ORDINARY_RULE])).not.toBe(
      composedRulesHash([ORDINARY_RULE, grantRule]),
    );
  });

  it("is sensitive to an extra condition key instead of silently dropping it", () => {
    const extraKey: GrantPolicyRule = {
      ...ORDINARY_RULE,
      conditions: [
        { ...ORDINARY_RULE.conditions[0], chain_id: "solana-devnet" },
        ORDINARY_RULE.conditions[1],
      ],
    };

    expect(composedRulesHash([extraKey])).not.toBe(
      composedRulesHash([ORDINARY_RULE]),
    );
  });
});

describe("applied_rules_hash is not the consent-envelope policy hash (design §0 C6)", () => {
  const consentInput: GrantInput = {
    recipients: ["AAA", "BBB"],
    perTransferAtomic6: "10000000",
    rollingTotalAtomic6: "50000000",
    rollingWindowSeconds: 86_400,
    gasCeiling: "5000000000000000",
  };

  it("differs from deterministicPolicyHash for the same wallet state", () => {
    const rulesHash = composedRulesHash([ORDINARY_RULE]);
    const consentHash = deterministicPolicyHash(consentInput);

    expect(consentHash).not.toBe(rulesHash);
    // The consent envelope hashes `limit|window|recipients`, not rules: the two
    // values cannot collide by formatting alone.
    expect(consentHash.startsWith("pol_")).toBe(true);
    expect(rulesHash.startsWith("sha256:")).toBe(true);
    expect(consentHash).not.toContain(rulesHash);
  });

  it("stays stable while the consent envelope moves for the same rules (positive control)", () => {
    const composed = composedRulesHash([ORDINARY_RULE]);

    expect(deterministicPolicyHash(consentInput)).not.toBe(
      deterministicPolicyHash(consentInput, { unit: "solana-lamports", amount: "10000000" }),
    );
    expect(composed).toBe(ORDINARY_RULE_DIGEST);
  });

  it("hashes the composed rules of composePolicy, not the caller's identity", () => {
    const base: ComposeInput = {
      walletId: "0d1b2c34-5678-49ab-8cde-000000000001",
      userId: "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d",
      baseline: { addresses: ["AAA", "BBB"], provenance: {} },
      contacts: [],
      grants: [],
      ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
      emptyComposition: "unproven",
    };

    const first = composedRulesHash(composePolicy(base).rules);
    const second = composedRulesHash(
      composePolicy({
        ...base,
        walletId: "0d1b2c34-5678-49ab-8cde-000000000002",
        userId: "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3e",
      }).rules,
    );

    expect(first).toBe(second);
    expect(first).toBe(ORDINARY_RULE_DIGEST);
  });
});
