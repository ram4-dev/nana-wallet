/**
 * U1 — coexistence of several ALLOW rules in one policy (design §11 U1).
 *
 * The probe resolves U1 ONLY from an observed permit under a policy carrying two
 * ALLOW rules over disjoint allowlists. Everything else — no signer, no signed
 * send, an unreachable provider, a refusal — records `unproven` and leaves the
 * composer's refusal in force. These cases therefore assert the REFUSAL and the
 * recorded evidence; none of them asserts a provider semantic.
 */
import { describe, expect, it } from "vitest";
import { probeRuleComposition } from "../../src/wallet/policy/probe.js";
import {
  ADDRESS_A,
  ADDRESS_B,
  createFakeProbeEvidence,
  createFakeProbeTransport,
  recordedRuleUnion,
} from "./helpers/policy-probe-fakes.js";

const WALLET_ID = "wallet-u1";
const { now } = { now: () => new Date("2026-10-05T12:00:00.000Z") };

describe("probeRuleComposition (U1)", () => {
  it("records unproven without attempting any write when no signer capability exists", async () => {
    // Positive control for the negative below: the SAME fake transport is proven
    // live by the configured-signer case, so this case cannot pass because the
    // port is unreachable.
    const { transport, calls } = createFakeProbeTransport({
      signerAvailable: false,
      signedSend: () => ({ permitted: true }),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const result = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });

    expect(result.outcome).toBe("unproven");
    expect(result.reason).toBe("signer_unavailable");
    expect(result.evidence.before).toBeNull();
    expect(result.evidence.after).toBeNull();
    expect(result.evidence.permitted).toBeNull();
    expect(recordedRuleUnion(recorded)).toEqual(["unproven"]);
    // No write at all: a probe that cannot observe must not mutate the provider.
    expect(calls.createPolicy).toEqual([]);
    expect(calls.patchPolicy).toEqual([]);
    expect(calls.transfers).toEqual([]);
  });

  it("sends two ALLOW rules over disjoint Transfer.to allowlists and records both sets", async () => {
    const { transport, calls } = createFakeProbeTransport({
      signerAvailable: true,
      policyRules: {
        pol_probe_1: [
          {
            name: "Solana policy probe rule A",
            method: "signAndSendTransaction",
            action: "ALLOW",
            conditions: [
              { field: "Transfer.to", operator: "in", value: [ADDRESS_A] },
            ],
          },
          {
            name: "Solana policy probe rule B",
            method: "signAndSendTransaction",
            action: "ALLOW",
            conditions: [
              { field: "Transfer.to", operator: "in", value: [ADDRESS_B] },
            ],
          },
        ],
      },
      // No signed-send port: this deployment has no user-authorized wallet action.
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const result = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });

    expect(calls.createPolicy).toHaveLength(1);
    const sent = calls.createPolicy[0]!.rules;
    expect(sent).toHaveLength(2);
    expect(sent.map((rule) => rule.action)).toEqual(["ALLOW", "ALLOW"]);
    const allowlists = sent.map((rule) => {
      const condition = rule.conditions.find(
        (entry) => entry["field"] === "Transfer.to",
      )!;
      return condition["value"] as string[];
    });
    // Disjoint allowlists: the union and the intersection differ for this fixture.
    expect(allowlists).toEqual([[ADDRESS_A], [ADDRESS_B]]);
    expect(allowlists[0]).not.toEqual(allowlists[1]);

    // Step (ii) alone proves nothing, and the record says so.
    expect(result.outcome).toBe("unproven");
    expect(result.reason).toBe("signed_transfer_unavailable");
    expect(result.evidence.before).toEqual(sent);
    // The pristine readback is the observed "after" set, recorded verbatim.
    expect(result.evidence.after).toHaveLength(2);
    expect(
      (result.evidence.after as readonly { name: string }[]).map(
        (rule) => rule.name,
      ),
    ).toEqual(["Solana policy probe rule A", "Solana policy probe rule B"]);
    expect(result.evidence.permitted).toBeNull();
    expect(result.evidence.probePolicyId).toBe("pol_probe_1");
    expect(recordedRuleUnion(recorded)).toEqual(["unproven"]);
    expect(calls.patchPolicy).toEqual([]);
  });

  it("records union when a transfer covered by one rule is observed as permitted", async () => {
    const { transport, calls } = createFakeProbeTransport({
      signerAvailable: true,
      signedSend: () => ({ permitted: true }),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const result = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });

    expect(result.outcome).toBe("union");
    expect(result.reason).toBeNull();
    expect(result.evidence.permitted).toBe(true);
    expect(result.evidence.at).toBe("2026-10-05T12:00:00.000Z");
    expect(result.evidence.before).toHaveLength(2);
    expect(result.evidence.after).toEqual(result.evidence.before);
    // The transferred address is the one covered by a single rule only.
    expect(calls.transfers).toEqual([
      { policyId: "pol_probe_1", to: ADDRESS_A, lamports: "1" },
    ]);
    expect(recordedRuleUnion(recorded)).toEqual(["union"]);
    // Even the resolving run never patches a wallet policy: only its own probe
    // policy is created, and nothing is patched at all.
    expect(calls.patchPolicy).toEqual([]);
  });

  it("records unproven when the single-rule transfer is refused", async () => {
    const { transport } = createFakeProbeTransport({
      signerAvailable: true,
      signedSend: () => ({ permitted: false }),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const result = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });

    expect(result.outcome).toBe("unproven");
    expect(result.reason).toBe("transfer_not_permitted");
    expect(recordedRuleUnion(recorded)).toEqual(["unproven"]);
  });

  it("records unproven — never union — when the provider cannot be reached", async () => {
    const { transport } = createFakeProbeTransport({
      signerAvailable: true,
      createPolicyError: new Error("connect ECONNREFUSED"),
    });
    const { evidence, recorded } = createFakeProbeEvidence();

    const result = await probeRuleComposition({
      transport,
      evidence,
      walletId: WALLET_ID,
      ordinaryAddress: ADDRESS_A,
      grantAddress: ADDRESS_B,
      now,
    });

    expect(result.outcome).toBe("unproven");
    expect(result.reason).toBe("provider_unreachable");
    expect(result.evidence.before).toHaveLength(2);
    expect(result.evidence.after).toBeNull();
    expect(recordedRuleUnion(recorded)).toEqual(["unproven"]);
  });
});
