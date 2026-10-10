import { describe, expect, it, vi } from "vitest";
import { createGrantGate } from "../../src/conversations/grant-gate.js";
import type { GrantGatePolicyEvidence } from "../../src/conversations/grant-gate.js";
import type {
  DelegatedGrantService,
  DelegatedGrantRow,
} from "../../src/wallet/grants/consumption.js";
import type { WalletProvider } from "../../src/wallet/provider.js";

/**
 * Task 2.10 — the wallet-level coverage gate (design §4.1).
 *
 * A bound `provider_policy_id` is required at the claim but is NO LONGER
 * sufficient: unless ALL SIX §4.1 predicates hold for the wallet's
 * `recipient_policy_state` row, every grant of that wallet degrades — including
 * a sibling grant for another recipient — with mode `not_covered` and reason
 * `policy_unverified`. The pure classifier and its unit suite are untouched;
 * the wallet-level check lives in the adapter's database read, taken AFTER the
 * wallet resolves and BEFORE the grants are listed.
 */

const userId = "11111111-1111-4111-8111-111111111111";
const walletId = "33333333-3333-4333-8333-333333333333";
const grantId = "22222222-2222-4222-8222-222222222222";
const siblingGrantId = "33333333-3333-4333-8333-333333333333";
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const SIBLING_RECIPIENT = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const NOW = Date.parse("2026-10-05T00:00:00.000Z");

/** The verified positive control: every §4.1 predicate holds. */
const VERIFIED_EVIDENCE: GrantGatePolicyEvidence = {
  status: "applied",
  desiredRevision: 7,
  appliedRevision: 7,
  desiredRulesHash: "sha256:aaaa",
  appliedRulesHash: "sha256:aaaa",
  appliedPolicyId: "policy_1",
  appliedSignerId: "signer_1",
  verifiedAt: "2026-10-05T00:00:00.000Z",
};

function grantRow(overrides: Partial<DelegatedGrantRow> = {}): DelegatedGrantRow {
  const recipients = overrides.recipients ?? [RECIPIENT];
  return {
    id: grantId,
    userId,
    walletId,
    action: "transfer",
    chain: "solana",
    maxPerTransfer: "10000000",
    maxCumulative: "50000000",
    windowSeconds: 86400,
    recipients,
    state: "active",
    providerPolicyId: "policy_1",
    createdAt: new Date(NOW - 60_000),
    expiresAt: new Date(NOW + 7 * 86_400_000),
    revokedAt: null,
    ...overrides,
  } as DelegatedGrantRow;
}

function fixtures(options: {
  grants?: DelegatedGrantRow[];
  evidence?: GrantGatePolicyEvidence | null;
  readError?: boolean;
}) {
  const grants = {
    resolveWalletId: vi.fn(async () => walletId),
    listGrants: vi.fn(async () => options.grants ?? []),
  } as unknown as DelegatedGrantService;
  const provider = {
    listTokens: vi.fn(async () => [
      { network: "solana-devnet", token: "SOL", decimals: 9 },
    ]),
  } as unknown as WalletProvider;
  const readPolicyCoverage = vi.fn(async () => {
    if (options.readError) throw new Error("state unreadable");
    return options.evidence === undefined ? VERIFIED_EVIDENCE : options.evidence;
  });
  const gate = createGrantGate({
    grants,
    walletForUser: vi.fn(async () => provider),
    readPolicyCoverage,
  });
  return { gate, grants, readPolicyCoverage };
}

function inputFor(recipient: string, amount = "0.01") {
  return {
    userId,
    conversationId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    text: `send ${amount} SOL to ${recipient}`,
    language: "es",
    requestAt: NOW,
    pendingTransfer: {
      network: "solana-devnet",
      token: "SOL",
      recipient,
      amount,
    },
  };
}

describe("grant gate — wallet-level coverage (design §4.1)", () => {
  it("a verified wallet still allows the covered candidate (positive control)", async () => {
    const { gate, grants, readPolicyCoverage } = fixtures({
      grants: [grantRow()],
    });
    const decision = await gate.evaluate(inputFor(RECIPIENT));
    expect(decision).toEqual({
      covered: true,
      source: "delegated_grant",
      grantId,
      amountSmallestUnits: "10000000",
      orderedCandidates: [{ grantId, amountSmallestUnits: "10000000" }],
    });
    // Positive control that makes the negative cases mean something: the read
    // really happened, for the resolved wallet, and the grants were listed.
    expect(readPolicyCoverage).toHaveBeenCalledWith({ userId, walletId });
    expect(grants.listGrants).toHaveBeenCalledTimes(1);
  });

  it("an unverified wallet degrades the evaluated grant and its sibling for another recipient", async () => {
    const grants = [
      grantRow(),
      grantRow({ id: siblingGrantId, recipients: [SIBLING_RECIPIENT] }),
    ];
    const { gate, grants: ledger, readPolicyCoverage } = fixtures({
      grants,
      evidence: { ...VERIFIED_EVIDENCE, appliedRevision: 6 },
    });
    // Control for the wallet-level (not grant-level) nature of the gate: the
    // sibling's grant DOES carry a provider policy id and DOES cover its own
    // recipient, and is still refused together with the evaluated one.
    expect(grants[0]?.providerPolicyId).toBe("policy_1");
    expect(grants[1]?.providerPolicyId).toBe("policy_1");

    await expect(gate.evaluate(inputFor(RECIPIENT))).resolves.toEqual({
      covered: false,
      mode: "not_covered",
      reason: "policy_unverified",
    });
    await expect(gate.evaluate(inputFor(SIBLING_RECIPIENT))).resolves.toEqual({
      covered: false,
      mode: "not_covered",
      reason: "policy_unverified",
    });
    // The gate is decided from the wallet's state and taken BEFORE listing:
    // an unverified wallet never even enumerates the grants it just refused.
    expect(readPolicyCoverage).toHaveBeenCalledTimes(2);
    expect(ledger.listGrants).not.toHaveBeenCalled();
  });

  it("a grant bound only by provider_policy_id is refused", async () => {
    const { gate, readPolicyCoverage } = fixtures({
      grants: [grantRow({ providerPolicyId: "policy_1" })],
      evidence: { ...VERIFIED_EVIDENCE, status: "saved_not_configured", appliedPolicyId: null },
    });
    await expect(gate.evaluate(inputFor(RECIPIENT))).resolves.toEqual({
      covered: false,
      mode: "not_covered",
      reason: "policy_unverified",
    });
    expect(readPolicyCoverage).toHaveBeenCalledTimes(1);
  });

  it("a missing state row fails closed", async () => {
    const { gate } = fixtures({ grants: [grantRow()], evidence: null });
    await expect(gate.evaluate(inputFor(RECIPIENT))).resolves.toEqual({
      covered: false,
      mode: "not_covered",
      reason: "policy_unverified",
    });
  });

  it("fails closed on every single missing predicate", async () => {
    const broken = [
      { status: "pending" },
      { appliedRevision: 6 },
      { desiredRulesHash: "sha256:bbbb" },
      { appliedRulesHash: null },
      { appliedPolicyId: null },
      { appliedSignerId: null },
      { verifiedAt: null },
    ];
    for (const override of broken) {
      const { gate } = fixtures({
        grants: [grantRow()],
        evidence: { ...VERIFIED_EVIDENCE, ...override },
      });
      await expect(
        gate.evaluate(inputFor(RECIPIENT)),
        `override ${JSON.stringify(override)} must be refused`,
      ).resolves.toEqual({
        covered: false,
        mode: "not_covered",
        reason: "policy_unverified",
      });
    }
  });

  it("degrades closed when the state read itself fails", async () => {
    const { gate } = fixtures({ grants: [grantRow()], readError: true });
    const decision = await gate.evaluate(inputFor(RECIPIENT));
    expect(decision?.covered).toBe(false);
  });

  it("never reads the wallet state for an unsupported network (positive control kept)", async () => {
    const { gate, readPolicyCoverage } = fixtures({ grants: [grantRow()] });
    const decision = await gate.evaluate({
      ...inputFor(RECIPIENT),
      pendingTransfer: {
        ...inputFor(RECIPIENT).pendingTransfer,
        network: "sepolia",
      },
    });
    expect(decision).toBeNull();
    expect(readPolicyCoverage).not.toHaveBeenCalled();
  });
});
