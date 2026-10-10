/**
 * Shared fakes for the four provider-semantics probes (design §11).
 *
 * The probes take their provider as an injected port, so their behaviour is
 * provable without a live provider — the pattern the repository already uses
 * (`startFakePrivyApi`, `tests/unit/solana-user-wallet.test.ts`). Nothing here
 * simulates a Privy semantic: the fake only RECORDS what the probe asked for and
 * RETURNS what the test configured, so a test can never accidentally assert a
 * provider behaviour as if the provider had been observed.
 */
import type {
  PolicyProbeEvidenceWriter,
  PolicyProbePolicy,
  PolicyProbeSigner,
  PolicyProbeTransport,
  PolicyProbeTransferOutcome,
  PolicyProbeTransferRequest,
  PolicyProbeWallet,
} from "../../../src/wallet/policy/probe.js";
import type { GrantPolicyRule } from "../../../src/wallet/grants/solana-policy-provisioner.js";
import type { PolicyEmptyComposition } from "../../../src/wallet/policy/repository.js";

export type FakeProbeCalls = {
  listOwnerWallets: Array<{ userId: string; chain: string }>;
  getWallet: string[];
  createPolicy: Array<{ name: string; rules: readonly GrantPolicyRule[] }>;
  patchPolicy: Array<{ policyId: string; rules: readonly GrantPolicyRule[] }>;
  getPolicy: string[];
  transfers: PolicyProbeTransferRequest[];
};

export type FakeProbeOptions = {
  /** `false` models this environment: no signed-authorization capability. */
  signerAvailable?: boolean;
  /** The owner-verified listing (`privyDid` + `listWalletsForChain`). */
  ownerWallets?: readonly PolicyProbeWallet[];
  /** The unfiltered `getWallet` result, keyed by wallet id; absent ⇒ 404. */
  unfilteredWallets?: Record<string, PolicyProbeWallet>;
  /** When set, `createPolicy` rejects with this error. */
  createPolicyError?: Error;
  /** The readback returned by `getPolicy`, keyed by policy id. */
  policyRules?: Record<string, readonly GrantPolicyRule[]>;
  /** Omit to model "no signed send capability" (the design's step (iii) gap). */
  signedSend?: (input: PolicyProbeTransferRequest) => PolicyProbeTransferOutcome;
};

export function createFakeProbeTransport(options: FakeProbeOptions = {}): {
  transport: PolicyProbeTransport;
  calls: FakeProbeCalls;
} {
  const calls: FakeProbeCalls = {
    listOwnerWallets: [],
    getWallet: [],
    createPolicy: [],
    patchPolicy: [],
    getPolicy: [],
    transfers: [],
  };
  const policyRules: Record<string, readonly GrantPolicyRule[]> = {
    ...options.policyRules,
  };

  const base: PolicyProbeTransport = {
    canSignAuthorizations: () => options.signerAvailable ?? false,
    async listOwnerWallets(userId, chain) {
      calls.listOwnerWallets.push({ userId, chain });
      return options.ownerWallets ?? [];
    },
    async getWallet(walletId) {
      calls.getWallet.push(walletId);
      const found = options.unfilteredWallets?.[walletId];
      if (!found) {
        throw new Error(`Unfiltered read found no wallet ${walletId}`);
      }
      return found;
    },
    async createPolicy(name, rules): Promise<PolicyProbePolicy> {
      calls.createPolicy.push({ name, rules });
      if (options.createPolicyError) throw options.createPolicyError;
      const id = `pol_probe_${calls.createPolicy.length}`;
      // The provider echoes what it stored; a test that wants a DIFFERENT
      // readback seeds `policyRules` for that id explicitly.
      policyRules[id] = rules;
      return { id, rules };
    },
    async patchPolicy(policyId, rules): Promise<PolicyProbePolicy> {
      calls.patchPolicy.push({ policyId, rules });
      policyRules[policyId] = rules;
      return { id: policyId, rules };
    },
    async getPolicy(policyId): Promise<PolicyProbePolicy> {
      calls.getPolicy.push(policyId);
      return { id: policyId, rules: policyRules[policyId] ?? [] };
    },
  };
  const transport: PolicyProbeTransport = options.signedSend
    ? {
        ...base,
        async signAndSendTransfer(input) {
          calls.transfers.push(input);
          return options.signedSend!(input);
        },
      }
    : base;
  return { transport, calls };
}

export type FakeProbeEvidence = {
  statusDetail: Array<{ walletId: string; patch: Record<string, unknown> }>;
  emptyComposition: Array<{ walletId: string; value: PolicyEmptyComposition }>;
};

export function createFakeProbeEvidence(): {
  evidence: PolicyProbeEvidenceWriter;
  recorded: FakeProbeEvidence;
} {
  const recorded: FakeProbeEvidence = { statusDetail: [], emptyComposition: [] };
  return {
    recorded,
    evidence: {
      async recordStatusDetail(input) {
        recorded.statusDetail.push(input);
      },
      async recordEmptyComposition(input) {
        recorded.emptyComposition.push(input);
      },
    },
  };
}

/** The flattened `rules_union` value across every recorded patch, if any. */
export function recordedRuleUnion(
  recorded: FakeProbeEvidence,
): unknown[] {
  return recorded.statusDetail
    .map((entry) => entry.patch["rules_union"])
    .filter((value) => value !== undefined);
}

/** Two disjoint probe addresses, and the ALLOW rule set a probe should send. */
export const ADDRESS_A = "4Nd1mYQ8hQfaRv9wrfbWL1qQrRxLoUFCPvFu3G5GNoP1";
export const ADDRESS_B = "9xQeWvG816bUx9EPa2r6Pz1Yb8NyJo5BY7Scm2YcQQuZ";

export function walletRecord(input: {
  id: string;
  signers: readonly PolicyProbeSigner[];
  policyIds?: readonly string[];
}): PolicyProbeWallet {
  return {
    id: input.id,
    ownerId: "did:privy:owner",
    policyIds: input.policyIds ?? [],
    signers: input.signers,
  };
}
