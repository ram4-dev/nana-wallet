/**
 * U3 — policy-ownership conflict (design §11 U3).
 *
 * The wallet is resolved ONLY through the owner-verified listing and compared
 * with the recorded `user_wallets.provider_wallet_id`. The mismatch signature —
 * the owner-verified listing empty while the unfiltered read is non-empty —
 * stops with `ownership_drift`: the remote owner is neither adopted nor
 * overwritten and `provider_signer_id` is never rewritten.
 */
import { describe, expect, it } from "vitest";
import { assertPolicyOwnership } from "../../src/wallet/policy/probe.js";
import {
  createFakeProbeEvidence,
  createFakeProbeTransport,
  walletRecord,
} from "./helpers/policy-probe-fakes.js";

const USER_ID = "user-u3";
const WALLET_ID = "wallet-u3";
const PROVIDER_WALLET_ID = "privy-wallet-u3";
const binding = async () => ({
  providerWalletId: PROVIDER_WALLET_ID,
  providerSignerId: "privy-signer-u3",
});
const now = () => new Date("2026-10-05T12:00:00.000Z");

function deps(options: Parameters<typeof createFakeProbeTransport>[0]) {
  const { transport, calls } = createFakeProbeTransport(options);
  const { evidence, recorded } = createFakeProbeEvidence();
  return { transport, calls, evidence, recorded };
}

describe("assertPolicyOwnership (U3)", () => {
  it("proves ownership when the owner-verified listing carries the recorded wallet", async () => {
    const { transport, calls, evidence, recorded } = deps({
      ownerWallets: [
        walletRecord({ id: PROVIDER_WALLET_ID, signers: [] }),
        walletRecord({ id: "privy-wallet-other", signers: [] }),
      ],
    });

    const result = await assertPolicyOwnership({
      userId: USER_ID,
      walletId: WALLET_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result.proven).toBe(true);
    expect(result.reason).toBeNull();
    expect(result.bindingRewritten).toBe(false);
    expect(result.evidence.signature).toBe("owner_listing_present");
    // Positive control for the unfiltered-read assertion below: the same port
    // answers the owner-verified listing, so the mismatch case is not passing
    // because the listing port is dead.
    expect(calls.listOwnerWallets).toEqual([
      { userId: USER_ID, chain: "solana" },
    ]);
    // The unfiltered read is not consulted when ownership is already proven.
    expect(calls.getWallet).toEqual([]);
    expect(recorded.statusDetail).toEqual([
      { walletId: WALLET_ID, patch: { ownership_evidence: result.evidence } },
    ]);
  });

  it("stops with ownership_drift on the mismatch signature (owner listing empty, unfiltered present)", async () => {
    const { transport, calls, evidence, recorded } = deps({
      ownerWallets: [],
      unfilteredWallets: {
        [PROVIDER_WALLET_ID]: walletRecord({
          id: PROVIDER_WALLET_ID,
          signers: [],
        }),
      },
    });

    const result = await assertPolicyOwnership({
      userId: USER_ID,
      walletId: WALLET_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result).toMatchObject({
      proven: false,
      failureClass: "blocked_configuration",
      reason: "ownership_drift",
      patchIssued: false,
      bindingRewritten: false,
    });
    expect(result.evidence).toEqual({
      providerWalletId: PROVIDER_WALLET_ID,
      observedOwnerWalletIds: [],
      unfilteredObservedId: PROVIDER_WALLET_ID,
      signature: "owner_listing_empty_unfiltered_present",
      at: "2026-10-05T12:00:00.000Z",
      detail: "owner_listing_empty_unfiltered_present",
    });
    // The unfiltered read characterises the mismatch and is never adopted: the
    // probe recorded a stop and issued no write.
    expect(calls.getWallet).toEqual([PROVIDER_WALLET_ID]);
    expect(calls.createPolicy).toEqual([]);
    expect(calls.patchPolicy).toEqual([]);
    expect(recorded.statusDetail).toHaveLength(1);
  });

  it("stops as ownership_unproven when the wallet is absent from both reads", async () => {
    const { transport, evidence } = deps({ ownerWallets: [] });

    const result = await assertPolicyOwnership({
      userId: USER_ID,
      walletId: WALLET_ID,
      transport,
      evidence,
      binding,
      now,
    });

    expect(result.proven).toBe(false);
    expect(result.reason).toBe("ownership_unproven");
    expect(result.evidence.signature).toBe("absent_everywhere");
    expect(result.evidence.unfilteredObservedId).toBeNull();
    expect(result.bindingRewritten).toBe(false);
  });
});
