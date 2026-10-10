/**
 * U2 — signer attachment asserted by a signed readback (design §11 U2).
 *
 * The evidence must come from the OWNER-VERIFIED listing
 * (`privyDid(userId)` + `listWalletsForChain(did,'solana')`), never from the
 * unfiltered `server.getWallet` the runtime uses today (design §0 C5). Every
 * failure is the blocking stop `blocked_configuration` /
 * `signer_attachment_unproven`, with no policy write.
 */
import { describe, expect, it } from "vitest";
import { assertPolicyTargetCapability } from "../../src/wallet/policy/probe.js";
import {
  createFakeProbeEvidence,
  createFakeProbeTransport,
  walletRecord,
} from "./helpers/policy-probe-fakes.js";

const USER_ID = "user-u2";
const WALLET_ID = "wallet-u2";
const PROVIDER_WALLET_ID = "privy-wallet-u2";
const PROVIDER_SIGNER_ID = "privy-signer-u2";
const POLICY_ID = "pol_applied_u2";
const binding = async () => ({
  providerWalletId: PROVIDER_WALLET_ID,
  providerSignerId: PROVIDER_SIGNER_ID,
});
const now = () => new Date("2026-10-05T12:00:00.000Z");

function deps(options: Parameters<typeof createFakeProbeTransport>[0]) {
  const { transport, calls } = createFakeProbeTransport(options);
  const { evidence, recorded } = createFakeProbeEvidence();
  return { transport, calls, evidence, recorded };
}

describe("assertPolicyTargetCapability (U2)", () => {
  it("proves the attachment from the owner-verified listing and records the evidence", async () => {
    const { transport, calls, evidence, recorded } = deps({
      signerAvailable: false,
      ownerWallets: [
        walletRecord({
          id: PROVIDER_WALLET_ID,
          policyIds: [POLICY_ID],
          signers: [
            { signerId: PROVIDER_SIGNER_ID, policyIds: [POLICY_ID] },
            { signerId: "sibling-signer", policyIds: ["pol_sibling"] },
          ],
        }),
      ],
    });

    const result = await assertPolicyTargetCapability({
      userId: USER_ID,
      walletId: WALLET_ID,
      policyId: POLICY_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result.proven).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.patchIssued).toBe(false);
    expect(result.evidence).toEqual({
      providerWalletId: PROVIDER_WALLET_ID,
      providerSignerId: PROVIDER_SIGNER_ID,
      policyId: POLICY_ID,
      observedOwnerWalletIds: [PROVIDER_WALLET_ID],
      observedSignerIds: [PROVIDER_SIGNER_ID, "sibling-signer"],
      observedPolicyIds: [POLICY_ID],
      readPath: "owner_verified_listing",
      occurrences: 1,
      at: "2026-10-05T12:00:00.000Z",
      detail: null,
    });
    expect(recorded.statusDetail).toEqual([
      { walletId: WALLET_ID, patch: { attachment_evidence: result.evidence } },
    ]);
    // The owner-verified path was used, and the unfiltered read was NOT.
    expect(calls.listOwnerWallets).toEqual([
      { userId: USER_ID, chain: "solana" },
    ]);
    expect(calls.getWallet).toEqual([]);
    // No policy write of any kind: the assertion never mutates.
    expect(calls.createPolicy).toEqual([]);
    expect(calls.patchPolicy).toEqual([]);
  });

  it("stops with signer_attachment_unproven when the wallet is absent from the owner listing", async () => {
    const { transport, calls, evidence, recorded } = deps({
      signerAvailable: true,
      ownerWallets: [],
    });

    const result = await assertPolicyTargetCapability({
      userId: USER_ID,
      walletId: WALLET_ID,
      policyId: POLICY_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result).toMatchObject({
      proven: false,
      failureClass: "blocked_configuration",
      reason: "signer_attachment_unproven",
      patchIssued: false,
    });
    expect(result.evidence.detail).toBe("wallet_absent_from_owner_listing");
    expect(recorded.statusDetail).toHaveLength(1);
    expect(calls.patchPolicy).toEqual([]);
    expect(calls.createPolicy).toEqual([]);
  });

  it("stops when the canonical signer is missing from the owner-verified wallet", async () => {
    const { transport, evidence } = deps({
      ownerWallets: [
        walletRecord({
          id: PROVIDER_WALLET_ID,
          signers: [{ signerId: "someone-else", policyIds: [POLICY_ID] }],
        }),
      ],
    });

    const result = await assertPolicyTargetCapability({
      userId: USER_ID,
      walletId: WALLET_ID,
      policyId: POLICY_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result.proven).toBe(false);
    expect(result.reason).toBe("signer_attachment_unproven");
    expect(result.evidence.detail).toBe("signer_absent");
    expect(result.evidence.occurrences).toBe(0);
  });

  it("stops when the canonical signer appears more than once", async () => {
    const { transport, evidence } = deps({
      ownerWallets: [
        walletRecord({
          id: PROVIDER_WALLET_ID,
          signers: [
            { signerId: PROVIDER_SIGNER_ID, policyIds: [POLICY_ID] },
            { signerId: PROVIDER_SIGNER_ID, policyIds: [] },
          ],
        }),
      ],
    });

    const result = await assertPolicyTargetCapability({
      userId: USER_ID,
      walletId: WALLET_ID,
      policyId: POLICY_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result.proven).toBe(false);
    expect(result.evidence.detail).toBe("signer_duplicated");
    expect(result.evidence.occurrences).toBe(2);
  });

  it("stops when the canonical signer does not carry our policy id", async () => {
    const { transport, evidence } = deps({
      ownerWallets: [
        walletRecord({
          id: PROVIDER_WALLET_ID,
          signers: [
            { signerId: PROVIDER_SIGNER_ID, policyIds: ["pol_other"] },
          ],
        }),
      ],
    });

    const result = await assertPolicyTargetCapability({
      userId: USER_ID,
      walletId: WALLET_ID,
      policyId: POLICY_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result.proven).toBe(false);
    expect(result.evidence.detail).toBe("policy_not_attached_to_signer");
    expect(result.evidence.observedPolicyIds).toEqual(["pol_other"]);
  });

  it("fails closed when the owner-verified listing itself cannot be read", async () => {
    const { transport, evidence } = deps({ ownerWallets: [] });
    const failing = {
      ...transport,
      listOwnerWallets: async () => {
        throw new Error("provider 503");
      },
    };

    const result = await assertPolicyTargetCapability({
      userId: USER_ID,
      walletId: WALLET_ID,
      policyId: POLICY_ID,
      transport: failing,
      evidence,
      binding,
      now,
    });

    // "We did not look" is not "we looked and it was fine".
    expect(result.proven).toBe(false);
    expect(result.evidence.detail).toBe("owner_listing_failed");
  });
});
