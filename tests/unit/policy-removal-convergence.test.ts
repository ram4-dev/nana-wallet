/**
 * Contact REMOVAL must be able to converge (production defect).
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The composer used ONE array for two different questions: `contacts` fed both
 * the ordinary rule's allowlist (consent) and the provenance map (attribution).
 * A removal archives the contact (`status='inactive'`, PMU-011), so the address
 * left the ACTIVE read and with it the provenance map — while the remote policy
 * still held the address until the PATCH landed. Check (d) of the readback
 * comparator then refused the very PATCH that would have deleted it, with
 * `recipient_address_without_provenance`, on every retry: removal could not
 * converge, ever. Addition was unaffected (the row is active when it is added),
 * and that asymmetry is the proof this is a defect and not a deliberate refusal.
 *
 * WHAT THE FIX SEPARATES, AND WHAT IT MUST NOT MOVE
 * ------------------------------------------------
 *  - `contacts` (CONSENT) stays active-only and stays the ONLY source of the
 *    composed rules.
 *  - `contactProvenanceAddresses` (ATTRIBUTION) is the same rows regardless of
 *    `status`, and feeds ONLY the provenance map, so an address this wallet's own
 *    contact row holds is explainable — and therefore deletable — even after that
 *    contact was retired.
 *
 * The property that must NOT be weakened is the one the suite also pins: an
 * address that belongs to NO row of ours (and is not the retained baseline or a
 * grant recipient) is still unexplained and still blocks. See the mutation notes
 * in the task record: dropping the user scoping of the repository read (or
 * injecting a foreign address into the attribution set) flips that case from
 * `blocked_conflict` to `converge`, so the guard is load-bearing rather than
 * vacuously green.
 */
import { describe, expect, it } from "vitest";
import { SOLANA_MAX_PER_TRANSFER_LAMPORTS } from "../../src/wallet/embedded.js";
import {
  composePolicy,
  type ComposeInput,
  type GrantPolicyInput,
} from "../../src/wallet/policy/composer.js";
import { compareComposedRules } from "../../src/wallet/policy/readback.js";

const USER_ID = "4f1c0a52-3b8e-4a6f-9a7d-0f5a9c1e2b3d";
const WALLET_ID = "0d1b2c34-5678-49ab-8cde-000000000001";
const POLICY_ID = "pol_01HZYX00000000000000000001";

/** The wallet's own retained enrollment address (the consent baseline). */
const BASELINE = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
/** The contact the removal just archived: an `inactive` row of OUR OWN. */
const REMOVED_CONTACT = "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
/** A contact that is still active, for the coexistence cases. */
const ACTIVE_CONTACT = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const ACTIVE_CONTACT_ID = "3f7f2c9a-1d2b-4c3d-9e4f-5a6b7c8d9e0f";
/** A delegated grant recipient: conditioned authority, never the ordinary rule. */
const GRANT_ADDRESS = "So11111111111111111111111111111111111111112";
/** An address this wallet has NO contact row for: the security control. */
const FOREIGN = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1";

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

/**
 * The composition a removal produces on the apply path: the wallet has just
 * archived REMOVED_CONTACT, so the consent set no longer holds it while the
 * attribution set still names it — because the row is still ours.
 */
function removalComposition(overrides: Partial<ComposeInput> = {}): ComposeInput {
  return {
    walletId: WALLET_ID,
    userId: USER_ID,
    baseline: { addresses: [BASELINE], provenance: {} },
    contacts: [],
    contactProvenanceAddresses: [REMOVED_CONTACT],
    grants: [],
    ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
    emptyComposition: "unproven",
    ...overrides,
  };
}

/**
 * The ordinary rule as the remote policy still holds it, composed through the
 * real builder so the shape under comparison is the provider's, not a hand-typed
 * approximation that could drift from it.
 */
function remoteOrdinaryRule(allowlist: string[]) {
  const [rule] = composePolicy({
    walletId: WALLET_ID,
    userId: USER_ID,
    baseline: { addresses: [], provenance: {} },
    contacts: allowlist.map((address, index) => ({
      id: `00000000-0000-4000-8000-00000000000${index}`,
      version: 1,
      address,
    })),
    contactProvenanceAddresses: allowlist,
    grants: [],
    ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
    emptyComposition: "unproven",
  }).rules;
  return rule;
}

/** The readback decision for a remote allowlist, against the removal composition. */
function decisionFor(
  allowlist: string[],
  phase: "pristine" | "verification" = "pristine",
) {
  const composed = composePolicy(removalComposition());
  return compareComposedRules({
    phase,
    expectedPolicyId: POLICY_ID,
    composedRules: composed.rules,
    provenance: composed.provenance,
    readback: { id: POLICY_ID, rules: [remoteOrdinaryRule(allowlist)] },
  });
}

describe("removal converges on the address its own deactivated contact left behind", () => {
  it("converges the PATCH instead of blocking with recipient_address_without_provenance", () => {
    // RED before the fix: the remote policy still holds BASELINE ∪ REMOVED, the
    // composed rule holds BASELINE only, and REMOVED was unexplained — so this
    // was `blocked_conflict` / `recipient_address_without_provenance`, on every
    // retry, forever.
    expect(decisionFor([BASELINE, REMOVED_CONTACT])).toEqual({
      outcome: "converge",
    });
  });

  it("still refuses to delete the same remote rule on the verification readback", () => {
    // The fix authorizes the PATCH, not the promotion: a verification readback
    // that still shows the address after the apply is a failure, never a pass.
    const decision = decisionFor([BASELINE, REMOVED_CONTACT], "verification");

    expect(decision.outcome).toBe("blocked_conflict");
    if (decision.outcome !== "blocked_conflict") return;
    expect(decision.reason).toBe("rules_mismatch");
  });

  it("keeps the deactivated contact's address OUT of the composed rules", () => {
    const composed = composePolicy(removalComposition());

    // The cosmetic half of the fix: if the address stayed in the rules, the
    // comparator would no longer block but nothing would ever be removed.
    expect(composed.ordinaryRecipients).toEqual([BASELINE]);
    expect(composed.rules).toHaveLength(1);
    expect(composed.rules[0]!.conditions[0]!.value).toEqual([BASELINE]);
    // ...while it is still attributable to a contact row of ours.
    expect(composed.provenance[REMOVED_CONTACT]).toBe("contact");
  });

  it("never lets the attribution set widen the ordinary allowlist", () => {
    const composed = composePolicy(
      removalComposition({
        contactProvenanceAddresses: [REMOVED_CONTACT, FOREIGN],
        contacts: [
          { id: ACTIVE_CONTACT_ID, version: 1, address: ACTIVE_CONTACT },
        ],
      }),
    );

    // Only the ACTIVE contact joins the baseline; attribution adds no authority.
    expect(composed.ordinaryRecipients).toEqual([BASELINE, ACTIVE_CONTACT]);
  });

  it("does not change the composed hash, which covers the rules and not the provenance", () => {
    const withInactive = composePolicy(removalComposition());
    const withoutInactive = composePolicy(
      removalComposition({ contactProvenanceAddresses: [] }),
    );

    // Provenance is comparator input: widening it must not move the authoritative
    // `applied_rules_hash`, or every wallet would re-apply on this fix.
    expect(withInactive.hash).toBe(withoutInactive.hash);
  });
});

describe("the fail-closed property this fix must not weaken", () => {
  it("still blocks an address that belongs to no contact row of ours", () => {
    const decision = decisionFor([BASELINE, FOREIGN]);

    expect(decision).toEqual({
      outcome: "blocked_conflict",
      reason: "recipient_address_without_provenance",
      detail: {
        ruleName: "Solana transfer allowlist",
        observedAddress: FOREIGN,
      },
    });
  });

  it("blocks the foreign address in the verification phase too", () => {
    const decision = decisionFor([BASELINE, FOREIGN], "verification");

    expect(decision.outcome).toBe("blocked_conflict");
    if (decision.outcome !== "blocked_conflict") return;
    expect(decision.reason).toBe("recipient_address_without_provenance");
  });

  it("blocks the foreign address even when our own retired contact is explained", () => {
    // Both addresses in ONE remote rule: explaining REMOVED must not carry
    // FOREIGN along with it, and the reported address is the unexplained one.
    const decision = decisionFor([BASELINE, REMOVED_CONTACT, FOREIGN]);

    expect(decision.outcome).toBe("blocked_conflict");
    if (decision.outcome !== "blocked_conflict") return;
    expect(decision.reason).toBe("recipient_address_without_provenance");
    expect(decision.detail.observedAddress).toBe(FOREIGN);
  });
});

describe("the provenance universe stays an explanation, never an authority", () => {
  it("explains every address its own rules consent to", () => {
    const composed = composePolicy(
      removalComposition({
        contacts: [
          { id: ACTIVE_CONTACT_ID, version: 1, address: ACTIVE_CONTACT },
        ],
        grants: [grant()],
        ruleComposition: "union",
      }),
    );

    const consented = [
      ...composed.ordinaryRecipients,
      ...composed.grantRecipients.flatMap((entry) => entry.recipients),
    ];
    // The invariant check (d) depends on: nothing this composition consents to is
    // ever unexplained, so the fix can only ADD explanations, never remove one.
    expect(consented.filter((address) => !(address in composed.provenance))).toEqual(
      [],
    );
    expect(composed.provenance[REMOVED_CONTACT]).toBe("contact");
    expect(composed.provenance[GRANT_ADDRESS]).toBe("grant");
    expect(composed.provenance[BASELINE]).toBe("baseline");
  });
});
