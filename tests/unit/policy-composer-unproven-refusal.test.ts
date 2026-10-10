/**
 * The composer's fail-closed refusal against an UNPROVEN deployment (design §11
 * U1/U4, §3.2 guarantee 8).
 *
 * This is the case the whole probe module exists for: a probe that could not
 * observe a provider semantic must leave the refusal in force. The assertion is
 * deliberately about the REFUSAL — no test here claims a provider behaviour that
 * was never observed.
 */
import { describe, expect, it } from "vitest";
import { composePolicy } from "../../src/wallet/policy/composer.js";
import type { PolicyEmptyComposition } from "../../src/wallet/policy/repository.js";
import {
  PolicyEmptyCompositionUnprovenError,
  PolicyRuleCompositionUnprovenError,
} from "../../src/wallet/policy/errors.js";
import {
  probeEmptyComposition,
  probeRuleComposition,
} from "../../src/wallet/policy/probe.js";
import {
  ADDRESS_A,
  ADDRESS_B,
  createFakeProbeEvidence,
  createFakeProbeTransport,
  recordedRuleUnion,
} from "./helpers/policy-probe-fakes.js";

const WALLET_ID = "wallet-refusal";
const USER_ID = "user-refusal";
const now = () => new Date("2026-10-05T12:00:00.000Z");
const ATTACHED_POLICY_ID = "pol_applied_refusal";

/** The composed input a mutation would use: one contact AND one active grant. */
function composeInput(input: {
  ruleComposition: "union" | "unproven" | undefined;
  emptyComposition: PolicyEmptyComposition;
  contacts: Array<{ id: string; version: number; address: string }>;
}) {
  return {
    walletId: WALLET_ID,
    userId: USER_ID,
    baseline: { addresses: [], provenance: {} },
    contacts: input.contacts,
    grants: [
      {
        grantId: "grant-1",
        walletId: WALLET_ID,
        recipients: [ADDRESS_B],
        maxPerTransfer: "5000000",
        expiresAt: 1_900_000_000,
      },
    ],
    ordinaryCapLamports: "10000000",
    emptyComposition: input.emptyComposition,
    ruleComposition: input.ruleComposition,
  };
}

/**
 * The U4 input: NO contact and NO grant, i.e. the composition that would be
 * empty. The last recipient is kept by refusing this composition, so the fixture
 * must genuinely have nothing to compose.
 */
function composeEmptyInput(input: {
  emptyComposition: PolicyEmptyComposition;
  contacts: Array<{ id: string; version: number; address: string }>;
}) {
  return {
    ...composeInput({
      ruleComposition: "union",
      emptyComposition: input.emptyComposition,
      contacts: input.contacts,
    }),
    grants: [],
  };
}

describe("the composer refuses multi-family composition until U1 records union", () => {
  it("never issues a PATCH and leaves the attached policy byte-for-byte unchanged", async () => {
    const { transport, calls } = createFakeProbeTransport({
      signerAvailable: false,
      // The policy the wallet has attached today.
      policyRules: {
        [ATTACHED_POLICY_ID]: [
          {
            name: "Solana transfer allowlist",
            method: "signAndSendTransaction",
            action: "ALLOW",
            conditions: [],
          },
        ],
      },
      signedSend: () => ({ permitted: true }),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const attachmentBefore = await transport.getPolicy(ATTACHED_POLICY_ID);

    // 1. The probe runs and cannot observe the semantic.
    const probe = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });
    expect(probe.outcome).toBe("unproven");
    expect(recordedRuleUnion(recorded)).toEqual(["unproven"]);

    // 2. The recorded value is what the composer is given (wire-through, not a
    //    hard-coded default).
    const recordedEvidence = recordedRuleUnion(recorded)[0];
    expect(recordedEvidence).toBe("unproven");

    // 3. The mutation refuses, visibly and by name.
    try {
      composePolicy(
        composeInput({
          ruleComposition: recordedEvidence as "unproven",
          emptyComposition: "unproven",
          contacts: [{ id: "contact-1", version: 1, address: ADDRESS_A }],
        }),
      );
      throw new Error(
        "the composer must not compose an unproven multi-family set",
      );
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyRuleCompositionUnprovenError);
      expect(error).toMatchObject({
        failureClass: "blocked_configuration",
        reason: "rule_composition_semantics_unproven",
        httpStatus: 409,
        stopCode: "CONFLICTO_POLITICA",
      });
    }

    // 4. No PATCH was issued anywhere and the attached policy is unchanged.
    expect(calls.patchPolicy).toEqual([]);
    expect(calls.createPolicy).toEqual([]);
    expect(await transport.getPolicy(ATTACHED_POLICY_ID)).toEqual(attachmentBefore);
  });

  it("composes both families once the probe records an observed union (positive control)", async () => {
    const { transport } = createFakeProbeTransport({
      signerAvailable: true,
      signedSend: () => ({ permitted: true }),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const probe = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });
    expect(probe.outcome).toBe("union");
    const recordedEvidence = recordedRuleUnion(recorded)[0];
    expect(recordedEvidence).toBe("union");

    const composed = composePolicy(
      composeInput({
        ruleComposition: recordedEvidence as "union",
        emptyComposition: "unproven",
        contacts: [{ id: "contact-1", version: 1, address: ADDRESS_A }],
      }),
    );

    expect(composed.rules.length).toBeGreaterThan(1);
    expect(composed.ordinaryRecipients).toEqual([ADDRESS_A]);
    expect(composed.grantRecipients).toEqual([
      { grantId: "grant-1", recipients: [ADDRESS_B] },
    ]);
  });
});

describe("the composer keeps the last recipient until U4 records proven_deny", () => {
  it("stops with 409 COMPOSICION_VACIA_NO_SOPORTADA and issues no write when unproven", async () => {
    const { transport, calls } = createFakeProbeTransport({
      signerAvailable: true,
      policyRules: { [ATTACHED_POLICY_ID]: [] },
      // No signed-send port: step (iii) cannot run, so nothing is inferred.
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const probe = await probeEmptyComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      uncoveredAddress: ADDRESS_A,
      now,
    });
    expect(probe.emptyComposition).toBe("unproven");
    const recordedValue = recorded.emptyComposition[0]!.value;
    expect(recordedValue).toBe("unproven");

    const attachedBefore = await transport.getPolicy(ATTACHED_POLICY_ID);
    const writesBefore = calls.patchPolicy.length;

    try {
      composePolicy(
        composeEmptyInput({
          emptyComposition: recordedValue,
          contacts: [],
        }),
      );
      throw new Error("the composer must not emit rules: [] while unproven");
    } catch (error) {
      expect(error).toBeInstanceOf(PolicyEmptyCompositionUnprovenError);
      expect(error).toMatchObject({
        failureClass: "blocked_configuration",
        reason: "empty_composition_unproven",
        httpStatus: 409,
        stopCode: "COMPOSICION_VACIA_NO_SOPORTADA",
      });
    }

    // The policy is never detached, deleted or left with an absent rule: the
    // probe has no such capability and the refusal issued no write.
    expect(calls.patchPolicy).toHaveLength(writesBefore);
    expect(await transport.getPolicy(ATTACHED_POLICY_ID)).toEqual(attachedBefore);
    expect(probe.policyDetached).toBe(false);

    // The last recipient is still composed when it exists: the stop keeps it
    // instead of silently dropping it.
    const kept = composePolicy(
      composeEmptyInput({
        emptyComposition: recordedValue,
        contacts: [{ id: "last-contact", version: 3, address: ADDRESS_A }],
      }),
    );
    expect(kept.ordinaryRecipients).toEqual([ADDRESS_A]);
  });

  it("emits rules: [] only after the signed denial was observed (positive control)", async () => {
    const { transport } = createFakeProbeTransport({
      signerAvailable: true,
      policyRules: { pol_probe_1: [] },
      signedSend: () => ({ permitted: false }),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const probe = await probeEmptyComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      uncoveredAddress: ADDRESS_A,
      now,
    });

    expect(recorded.emptyComposition).toEqual([
      { walletId: WALLET_ID, value: "proven_deny" },
    ]);
    const composed = composePolicy(
      composeEmptyInput({
        emptyComposition: probe.emptyComposition,
        contacts: [],
      }),
    );
    expect(composed.rules).toEqual([]);
    expect(composed.ordinaryRecipients).toEqual([]);
  });
});
