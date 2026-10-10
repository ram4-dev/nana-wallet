/**
 * U4 — empty composed policy / deny behaviour (design §11 U4).
 *
 * Nothing is inferred from a successful zero-rule PATCH. `proven_deny` requires
 * step (iii): a signed transfer against the empty-rules policy observed as
 * REFUSED. With step (iii) unavailable the outcome stays `unproven`, the composer
 * keeps refusing, and no policy is detached or deleted.
 */
import { describe, expect, it } from "vitest";
import { probeEmptyComposition } from "../../src/wallet/policy/probe.js";
import {
  ADDRESS_A,
  createFakeProbeEvidence,
  createFakeProbeTransport,
} from "./helpers/policy-probe-fakes.js";

const WALLET_ID = "wallet-u4";
const now = () => new Date("2026-10-05T12:00:00.000Z");

function deps(options: Parameters<typeof createFakeProbeTransport>[0]) {
  const { transport, calls } = createFakeProbeTransport(options);
  const { evidence, recorded } = createFakeProbeEvidence();
  return { transport, calls, evidence, recorded };
}

const run = (
  input: ReturnType<typeof deps> & { signedSend?: boolean },
) =>
  probeEmptyComposition({
    transport: input.transport,
    evidence: input.evidence,
    walletId: WALLET_ID,
    uncoveredAddress: ADDRESS_A,
    now,
  });

describe("probeEmptyComposition (U4)", () => {
  it("records unproven — never proven_deny — from a successful zero-rule PATCH alone", async () => {
    // Positive control: both writes really ran and the provider really returned
    // zero rules, so the refusal below is about the MISSING signed denial, not
    // about a step that never happened.
    const fixture = deps({
      signerAvailable: true,
      policyRules: { pol_probe_1: [] },
      // No signed-send port: step (iii) cannot run in this environment.
    });

    const result = await run(fixture);

    expect(fixture.calls.createPolicy).toEqual([
      { name: "Solana empty policy probe", rules: [] },
    ]);
    expect(fixture.calls.patchPolicy).toEqual([
      { policyId: "pol_probe_1", rules: [] },
    ]);
    expect(result.evidence.rulesAfterCreate).toBe(0);
    expect(result.evidence.rulesAfterPatch).toBe(0);

    expect(result.emptyComposition).toBe("unproven");
    expect(result.reason).toBe("signed_denial_unobserved");
    expect(result.evidence.signedDenialObserved).toBeNull();
    expect(result.policyDetached).toBe(false);
    expect(fixture.recorded.emptyComposition).toEqual([
      { walletId: WALLET_ID, value: "unproven" },
    ]);
  });

  it("records proven_deny when the signed transfer against the empty policy is refused", async () => {
    const fixture = deps({
      signerAvailable: true,
      policyRules: { pol_probe_1: [] },
      signedSend: () => ({ permitted: false }),
    });

    const result = await run(fixture);

    expect(result.emptyComposition).toBe("proven_deny");
    expect(result.reason).toBeNull();
    expect(result.evidence.signedDenialObserved).toBe(true);
    expect(fixture.calls.transfers).toEqual([
      { policyId: "pol_probe_1", to: ADDRESS_A, lamports: "1" },
    ]);
    expect(fixture.recorded.emptyComposition).toEqual([
      { walletId: WALLET_ID, value: "proven_deny" },
    ]);
  });

  it("fails closed when the empty policy would ALLOW an uncovered transfer", async () => {
    const fixture = deps({
      signerAvailable: true,
      policyRules: { pol_probe_1: [] },
      signedSend: () => ({ permitted: true }),
    });

    const result = await run(fixture);

    // An empty policy that permits is not a deny container: recording it as
    // proven_deny would be the most dangerous possible false positive.
    expect(result.emptyComposition).toBe("unproven");
    expect(result.reason).toBe("signed_transfer_permitted");
    expect(result.evidence.signedDenialObserved).toBe(false);
  });

  it("records unproven without any write when no signer capability exists", async () => {
    const fixture = deps({
      signerAvailable: false,
      signedSend: () => ({ permitted: false }),
    });

    const result = await run(fixture);

    expect(result.emptyComposition).toBe("unproven");
    expect(result.reason).toBe("signer_unavailable");
    expect(fixture.calls.createPolicy).toEqual([]);
    expect(fixture.calls.patchPolicy).toEqual([]);
    expect(fixture.calls.transfers).toEqual([]);
    // The recorded row value is the fail-closed one, not a fabricated deny.
    expect(fixture.recorded.emptyComposition).toEqual([
      { walletId: WALLET_ID, value: "unproven" },
    ]);
  });

  it("records unproven when the provider cannot be reached", async () => {
    const fixture = deps({
      signerAvailable: true,
      createPolicyError: new Error("connect ETIMEDOUT"),
      signedSend: () => ({ permitted: false }),
    });

    const result = await run(fixture);

    expect(result.emptyComposition).toBe("unproven");
    expect(result.reason).toBe("provider_unreachable");
    expect(result.evidence.createdPolicyId).toBeNull();
  });
});
