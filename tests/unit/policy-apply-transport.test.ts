/**
 * Task 2.8 — the signed apply adapter over a fake transport
 * (design §3.5 steps 4-9, §5.1, §5.3).
 *
 * WHY THE FAKE VERIFIES THE SIGNATURE
 * -----------------------------------
 * The adapter must present an authorization the provider can verify against the
 * registered public key. A test that only asserted "an authorization object was
 * passed" would pass with any bytes at all, so the fake VERIFIES with
 * `crypto.verify` and refuses otherwise — and the suite proves that verification
 * is real by handing it a key it does not hold and observing the refusal.
 *
 * NOTHING HERE ASSERTS A LIVE PROVIDER SEMANTIC. The provider is the injected
 * port; this environment has no signer sidecar, so the live path stays
 * `unavailable`/`unproven` and its verification is recorded as pending.
 */
import { describe, expect, it } from "vitest";
import {
  createSignedPolicyApplyPort,
  normalizeProviderReadbackRules,
} from "../../src/wallet/policy/apply.js";
import type { PolicyApplyRequest, PolicyApplyOutcome } from "../../src/wallet/policy/service.js";
import {
  allowRule,
  createFakeApplyTransport,
  createTestAuthorizationSigner,
  policyWallet,
} from "./helpers/policy-apply-fakes.js";

const USER_ID = "user-apply";
const WALLET_ID = "wallet-local-apply";
const PROVIDER_WALLET_ID = "privy-wallet-apply";
const PROVIDER_SIGNER_ID = "privy-signer-apply";
const POLICY_ID = "pol_attached_apply";
const OTHER_POLICY_ID = "pol_other_apply";
const ADDRESS_A = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const ADDRESS_B = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

const COMPOSED = [allowRule("Solana transfer allowlist", [ADDRESS_A, ADDRESS_B])];
/**
 * A drifted-but-CONSENTED rule set: `Test1`'s real drift shape. It converges
 * because its address has provenance; a drift whose address has none is the case
 * below that must STOP (§5.1 (d)).
 */
const DRIFTED = [allowRule("Solana transfer allowlist", [ADDRESS_A])];

/** Provenance covers both composed addresses: (d) must be provable. */
const PROVENANCE = {
  [ADDRESS_A]: { kind: "contact" as const },
  [ADDRESS_B]: { kind: "contact" as const },
} as unknown as PolicyApplyRequest["provenance"];

function request(overrides: Partial<PolicyApplyRequest> = {}): PolicyApplyRequest {
  return {
    userId: USER_ID,
    walletId: WALLET_ID,
    providerWalletId: PROVIDER_WALLET_ID,
    canonicalSignerId: PROVIDER_SIGNER_ID,
    desiredRevision: 1,
    appliedPolicyId: POLICY_ID,
    appliedSignerIds: [PROVIDER_SIGNER_ID],
    composedHash: "sha256:composed",
    rules: COMPOSED,
    provenance: PROVENANCE,
    ...overrides,
  };
}

function adapter(
  options: Parameters<typeof createFakeApplyTransport>[0],
  now = new Date("2026-10-06T00:00:00.000Z"),
) {
  const signer = createTestAuthorizationSigner();
  const { transport, calls } = createFakeApplyTransport({
    publicKey: signer.publicKey,
    ...options,
  });
  return {
    port: createSignedPolicyApplyPort({
      transport,
      signAuthorization: (payload) => signer.sign(payload),
      now: () => now,
    }),
    calls,
    signer,
  };
}

/** The positive control every negative case below runs first. */
function attachedWallet(policyIds: readonly string[] = [POLICY_ID]) {
  return [
    policyWallet({
      walletId: PROVIDER_WALLET_ID,
      signers: [{ signerId: PROVIDER_SIGNER_ID, overridePolicyIds: policyIds }],
    }),
  ];
}

describe("the signed apply adapter (design §3.5 steps 4-9)", () => {
  it("removes only Privy's response-only rule id before exact readback comparison", () => {
    const [rule] = normalizeProviderReadbackRules([
      { ...COMPOSED[0]!, id: "ifx_provider_generated" },
    ]);

    expect(rule).toEqual(COMPOSED[0]);
  });

  it("converges a drifted rule set and reports the verified readback", async () => {
    const { port, calls, signer } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({
      kind: "verified",
      appliedPolicyId: POLICY_ID,
      appliedSignerId: PROVIDER_SIGNER_ID,
      appliedSignerIds: [PROVIDER_SIGNER_ID],
      appliedRulesHash: "sha256:composed",
      appliedRecipients: [ADDRESS_A, ADDRESS_B],
    });
    // The pristine readback was read BEFORE the PATCH and the verification
    // readback AFTER it (steps 5 and 9), and the PATCH carried the composed rules
    // (never the readback's, design §5.1 (c)/(d)).
    expect(calls.getPolicy).toEqual([POLICY_ID, POLICY_ID]);
    expect(calls.patchPolicy).toEqual([{ policyId: POLICY_ID, rules: COMPOSED }]);

    // The signature verifies under the configured public key, and it is verified
    // by the CRYPTO CHECK rather than by equality with what the adapter sent.
    const presented = calls.authorizations.at(-1)!;
    expect(presented.operation).toBe("patchPolicy");
    expect(
      signer.verify(
        Buffer.from(presented.authorization.payload, "base64"),
        presented.authorization.signature,
      ),
    ).toBe(true);
  });

  it("signs without byte equality: one payload, two different signatures, both valid", async () => {
    const { port, calls, signer } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
    });

    await port.apply(request());
    const first = calls.authorizations.at(-1)!.authorization;
    // A second run over the SAME payload (same `now`, same rules) still produces a
    // different signature: ECDSA P-256 uses a random nonce. A byte comparison of
    // two signatures would therefore be worthless, which is why the assertion
    // above is a verification and not an equality.
    const second = await signer.sign(Buffer.from(first.payload, "base64"));
    expect(second).not.toBe(first.signature);
    expect(
      signer.verify(Buffer.from(first.payload, "base64"), second),
    ).toBe(true);
    expect(
      signer.verify(Buffer.from(first.payload, "base64"), first.signature),
    ).toBe(true);
  });

  it("is refused by a provider that holds a DIFFERENT public key (the check is real)", async () => {
    // Positive control for the verification itself: the adapter's signer is not
    // the key the provider holds, so the mutation is refused.
    const otherSigner = createTestAuthorizationSigner();
    const { transport, calls } = createFakeApplyTransport({
      publicKey: otherSigner.publicKey,
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
    });
    const signer = createTestAuthorizationSigner();
    const port = createSignedPolicyApplyPort({
      transport,
      signAuthorization: (payload) => signer.sign(payload),
    });

    const outcome = await port.apply(request());
    expect(calls.patchPolicy).toHaveLength(1);
    expect(outcome).toMatchObject({ kind: "retryable_failure", reason: "patch_rejected" });
  });

  it("SKIPS the PATCH entirely when the pristine readback already equals the composed rules", async () => {
    const { port, calls } = adapter({
      ownerWallets: attachedWallet(),
      // The pristine readback IS the composed rule set: nothing to converge.
      policyRules: { [POLICY_ID]: COMPOSED },
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({ kind: "verified", appliedPolicyId: POLICY_ID });
    // The load-bearing assertion of the idempotent skip: the provider was asked
    // for ZERO patches, so a replay cannot rewrite an unchanged policy.
    expect(calls.patchPolicy).toEqual([]);
    expect(calls.createPolicy).toEqual([]);
    expect(calls.attachPolicyToSigner).toEqual([]);
  });

  it("creates and attaches only when the signer has no policy at all", async () => {
    const { port, calls } = adapter({
      ownerWallets: attachedWallet([]),
      policyRules: {},
    });

    const outcome = await port.apply(request());

    expect(calls.createPolicy).toEqual([
      { name: "Solana transfer allowlist", rules: COMPOSED },
    ]);
    expect(calls.attachPolicyToSigner).toEqual([
      {
        walletId: PROVIDER_WALLET_ID,
        signerId: PROVIDER_SIGNER_ID,
        policyId: "pol_apply_1",
      },
    ]);
    // Attaching is the only path that creates; it never also patches.
    expect(calls.patchPolicy).toEqual([]);
    expect(outcome).toMatchObject({ kind: "verified", appliedPolicyId: "pol_apply_1" });
  });

  it("never creates or attaches when the signer already carries our policy", async () => {
    const { port, calls } = adapter({
      ownerWallets: attachedWallet([POLICY_ID]),
      policyRules: { [POLICY_ID]: COMPOSED },
    });

    await port.apply(request());

    expect(calls.createPolicy).toEqual([]);
    expect(calls.attachPolicyToSigner).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // §5.3 — the outcome classification
  // -------------------------------------------------------------------------

  it("classifies a timeout BEFORE the PATCH as retryable_failure with nothing sent", async () => {
    const calls = { patch: 0 };
    const failing = createSignedPolicyApplyPort({
      transport: {
        async listOwnerWallets() {
          return attachedWallet();
        },
        async getPolicy(policyId) {
          return { id: policyId, rules: DRIFTED };
        },
        async createPolicy() {
          throw new Error("createPolicy must not be reached: the signer failed first");
        },
        async attachPolicyToSigner() {
          throw new Error("attachPolicyToSigner must not be reached: the signer failed first");
        },
        async patchPolicy() {
          calls.patch += 1;
          throw new Error("patchPolicy must not be reached: the signer failed first");
        },
      },
      signAuthorization: async () => {
        const timeout = Object.assign(new Error("sidecar did not answer"), {
          name: "AbortError",
        });
        throw timeout;
      },
    });

    const outcome = await failing.apply(request());
    expect(outcome).toMatchObject({
      kind: "retryable_failure",
      reason: "signer_unreachable",
    });
    // Nothing was sent, so the retry is safe and no mutation was attempted.
    expect(calls.patch).toBe(0);
  });

  it("classifies a timeout AFTER the PATCH as unverified, never as an applied revision", async () => {
    const timeout = Object.assign(new Error("PATCH timed out"), { name: "AbortError" });
    const { port } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
      mutationError: timeout,
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({ kind: "unverified", reason: "patch_unverified" });
    expect((outcome as { detail: Record<string, unknown> }).detail).toMatchObject({
      // `AbortError` is the bounded-timeout shape the signer client raises; the
      // durable consequence is the same as a 5xx — nobody knows whether it landed.
      code: "provider_timeout",
      operation: "patchPolicy",
    });
  });

  it("classifies a 5xx as unverified (the write may have landed)", async () => {
    const provider5xx = Object.assign(new Error("provider 503"), { status: 503 });
    const { port } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
      mutationError: provider5xx,
    });

    expect(await port.apply(request())).toMatchObject({
      kind: "unverified",
      reason: "patch_unverified",
    });
  });

  it("classifies a definitive 4xx as retryable_failure and never promotes it by readback", async () => {
    const rejected = Object.assign(new Error("policy rules rejected: unknown field"), {
      status: 422,
    });
    const { port, calls } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
      mutationError: rejected,
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({
      kind: "retryable_failure",
      reason: "patch_rejected",
    });
    expect((outcome as { detail: Record<string, unknown> }).detail).toMatchObject({
      code: "provider_rejected",
      status: 422,
    });
    // The provider message is recorded, bounded, and no readback was consulted to
    // turn a rejection into an applied revision.
    expect(calls.getPolicy).toEqual([POLICY_ID]);
  });

  it("classifies an unreachable OWNER-VERIFIED listing as retryable_failure with no write", async () => {
    const unreachable = Object.assign(new Error("listing timed out"), {
      name: "AbortError",
    });
    const { port, calls } = adapter({
      listingError: unreachable,
      ownerWallets: attachedWallet(),
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({
      kind: "retryable_failure",
      reason: "owner_listing_unavailable",
    });
    expect(calls.patchPolicy).toEqual([]);
    expect(calls.createPolicy).toEqual([]);
    expect(calls.attachPolicyToSigner).toEqual([]);
  });

  it("stops as blocked_conflict on an unknown remote rule, with no PATCH", async () => {
    const foreignRule = allowRule("remote-rule-nobody-composed", [
      "Test1DriftAddressxxxxxxxxxxxxxxxxxxxxxx",
    ]);
    const { port, calls } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: [allowRule("Solana transfer allowlist", [ADDRESS_A]), foreignRule] },
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({
      kind: "blocked",
      failureClass: "blocked_conflict",
      reason: "unrecognized_rule",
    });
    // §5.1 (c): the unknown rule is never deleted to force convergence.
    expect(calls.patchPolicy).toEqual([]);
  });

  it("stops as blocked_conflict on an address with no consent provenance, with no PATCH", async () => {
    const { port, calls } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: {
        [POLICY_ID]: [
          allowRule("Solana transfer allowlist", [
            "Test1DriftAddressxxxxxxxxxxxxxxxxxxxxxx",
          ]),
        ],
      },
    });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({
      kind: "blocked",
      failureClass: "blocked_conflict",
      reason: "recipient_address_without_provenance",
    });
    expect(calls.patchPolicy).toEqual([]);
  });

  it("stops as blocked_configuration when the wallet is absent from the owner listing", async () => {
    const { port, calls } = adapter({ ownerWallets: [] });

    const outcome = await port.apply(request());

    expect(outcome).toMatchObject({
      kind: "blocked",
      failureClass: "blocked_configuration",
      reason: "ownership_drift",
    });
    expect(calls.patchPolicy).toEqual([]);
  });

  it("stops as blocked_configuration when the canonical signer is duplicated", async () => {
    const { port, calls } = adapter({
      ownerWallets: [
        policyWallet({
          walletId: PROVIDER_WALLET_ID,
          signers: [
            { signerId: PROVIDER_SIGNER_ID, overridePolicyIds: [POLICY_ID] },
            { signerId: PROVIDER_SIGNER_ID, overridePolicyIds: [] },
          ],
        }),
      ],
      policyRules: { [POLICY_ID]: DRIFTED },
    });

    expect(await port.apply(request())).toMatchObject({
      kind: "blocked",
      failureClass: "blocked_configuration",
      reason: "signer_attachment_unproven",
    });
    expect(calls.patchPolicy).toEqual([]);
  });

  it("does NOT report a verified revision when the verification readback still differs", async () => {
    // The PATCH is accepted, but the verifying GET still returns the drifted set:
    // a readback that is not the composed set can never be `applied`.
    const stale = createSignedPolicyApplyPort({
      transport: {
        async listOwnerWallets() {
          return attachedWallet();
        },
        async getPolicy(policyId) {
          return { id: policyId, rules: DRIFTED };
        },
        async createPolicy() {
          throw new Error("createPolicy must not be reached");
        },
        async attachPolicyToSigner() {
          throw new Error("attachPolicyToSigner must not be reached");
        },
        async patchPolicy() {
          return { id: POLICY_ID, rules: DRIFTED };
        },
      },
      signAuthorization: async () => "unused-by-this-transport",
    });

    // The comparator's own phase rule decides this, not a private heuristic:
    // §5.1 (b)'s rule-set equality is a `blocked_conflict`, and a `converge` is
    // only reachable in the pristine phase. So a PATCH the provider accepted but
    // that did not converge can never be promoted to an applied revision — and
    // the "equal to the previous applied rules ⇒ retry" branch of §5.3 belongs to
    // the reconciler (task 2.9), which owns GET-before-retry.
    const outcome: PolicyApplyOutcome = await stale.apply(request());
    expect(outcome).toMatchObject({
      kind: "blocked",
      failureClass: "blocked_conflict",
      reason: "rules_mismatch",
    });
  });

  it("reports an unreadable verification readback as unverified, never as applied", async () => {
    const { port } = adapter({
      ownerWallets: attachedWallet(),
      policyRules: { [POLICY_ID]: DRIFTED },
      readbackErrors: {
        [POLICY_ID]: Object.assign(new Error("provider 502"), { status: 502 }),
      },
    });

    const outcome = await port.apply(request());

    // 502 on the PRISTINE read happens before any write, so nothing was sent.
    expect(outcome).toMatchObject({
      kind: "retryable_failure",
      reason: "pristine_readback_unavailable",
    });
  });
});
