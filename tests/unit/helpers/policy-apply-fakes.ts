/**
 * Shared fake transport for the signed apply path (task 2.8).
 *
 * The adapter takes its provider as an injected port, so every §5.3 branch is
 * provable without a live provider — the repo's existing idiom
 * (`startFakePrivyApi`, `tests/unit/solana-user-wallet.test.ts`, and the probe
 * fakes). Nothing here simulates a Privy semantic: the fake records what it was
 * asked for and returns what the test configured.
 *
 * THE SIGNATURE CHECK IS REAL, NOT A STRING COMPARISON
 * ---------------------------------------------------
 * Each mutation the fake accepts must carry an authorization whose signature
 * VERIFIES under the configured public key (`crypto.verify`, ECDSA P-256). That
 * is what makes "the signature verifies against the configured public key" a
 * statement about cryptography instead of about two equal strings: the same
 * payload signed twice produces two different signatures and both verify
 * (a random nonce), while a signature from another key is refused.
 */
import { createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import type { GrantPolicyRule } from "../../../src/wallet/grants/solana-policy-provisioner.js";
import {
  PolicyApplyTransportError,
  type PolicyApplyPolicyRecord,
  type PolicyApplyTransport,
  type PolicyApplyWalletRecord,
  type SignedPolicyAuthorization,
} from "../../../src/wallet/policy/apply.js";

export type TestAuthorizationSigner = {
  /** The registered public key a transport verifies against. */
  publicKey: KeyObject;
  sign(payload: Uint8Array): Promise<string>;
  verify(payload: Uint8Array, signature: string): boolean;
};

/** An in-memory P-256 signer standing in for the loopback sidecar. */
export function createTestAuthorizationSigner(): TestAuthorizationSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ec", {
    namedCurve: "prime256v1",
  });
  return {
    publicKey,
    async sign(payload) {
      return sign("sha256", Buffer.from(payload), privateKey).toString("base64");
    },
    verify(payload, signature) {
      return verify(
        "sha256",
        Buffer.from(payload),
        publicKey,
        Buffer.from(signature, "base64"),
      );
    },
  };
}

export type FakeApplyCalls = {
  listOwnerWallets: Array<{ userId: string; chain: string }>;
  getPolicy: string[];
  createPolicy: Array<{ name: string; rules: readonly GrantPolicyRule[] }>;
  attachPolicyToSigner: Array<{
    walletId: string;
    signerId: string;
    policyId: string;
  }>;
  patchPolicy: Array<{ policyId: string; rules: readonly GrantPolicyRule[] }>;
  /** Every authorization that was presented, for the signature assertions. */
  authorizations: Array<{ operation: string; authorization: SignedPolicyAuthorization }>;
};

export type FakeApplyOptions = {
  /** The owner-verified listing (`privyDid` + `listWalletsForChain`). */
  ownerWallets?: readonly PolicyApplyWalletRecord[];
  /** The readback `getPolicy` returns, keyed by policy id. */
  policyRules?: Record<string, readonly GrantPolicyRule[]>;
  /**
   * The registered public key every mutation is verified against. Optional so a
   * caller that only exercises a read path can omit it; when it is absent no
   * mutation can be accepted, which is the fail-closed default.
   */
  publicKey?: KeyObject;
  /** When set, a mutation fails with this error instead of succeeding. */
  mutationError?: Error;
  /** When set, `listOwnerWallets` fails with this error. */
  listingError?: Error;
  /** When set, `getPolicy` fails for these policy ids. */
  readbackErrors?: Record<string, Error>;
  /** Called inside `patchPolicy`, before it returns (a concurrent writer). */
  onPatch?: () => Promise<void>;
};

export function createFakeApplyTransport(options: FakeApplyOptions): {
  transport: PolicyApplyTransport;
  calls: FakeApplyCalls;
} {
  const calls: FakeApplyCalls = {
    listOwnerWallets: [],
    getPolicy: [],
    createPolicy: [],
    attachPolicyToSigner: [],
    patchPolicy: [],
    authorizations: [],
  };
  const policyRules: Record<string, readonly GrantPolicyRule[]> = {
    ...options.policyRules,
  };
  /**
   * The owner-verified listing is MUTABLE state, because attaching a policy
   * changes what the next owner-verified readback reports. A fake that kept
   * returning the pre-attach state would make the post-attach verification check
   * unreachable, and a test could not tell "the attachment was verified" from
   * "the verification never looked".
   */
  let ownerWallets: readonly PolicyApplyWalletRecord[] = options.ownerWallets ?? [];

  const checkAuthorization = (
    operation: string,
    authorization: SignedPolicyAuthorization,
    payload: Uint8Array,
  ): void => {
    calls.authorizations.push({ operation, authorization });
    const signatureValid =
      options.publicKey !== undefined &&
      verify(
        "sha256",
        Buffer.from(payload),
        options.publicKey,
        Buffer.from(authorization.signature, "base64"),
      );
    if (!signatureValid) {
      throw new PolicyApplyTransportError(
        "rejected",
        operation,
        401,
        "authorization signature does not verify under the registered public key",
      );
    }
  };

  const transport: PolicyApplyTransport = {
    async listOwnerWallets(userId, chain) {
      calls.listOwnerWallets.push({ userId, chain });
      if (options.listingError) throw options.listingError;
      return ownerWallets;
    },
    async getPolicy(policyId): Promise<PolicyApplyPolicyRecord> {
      calls.getPolicy.push(policyId);
      const failure = options.readbackErrors?.[policyId];
      if (failure) throw failure;
      return { id: policyId, rules: policyRules[policyId] ?? [] };
    },
    async createPolicy(input) {
      calls.createPolicy.push({ name: input.name, rules: input.rules });
      checkAuthorization(
        "createPolicy",
        input.authorization,
        Buffer.from(input.authorization.payload, "base64"),
      );
      if (options.mutationError) throw options.mutationError;
      const id = `pol_apply_${calls.createPolicy.length}`;
      policyRules[id] = input.rules;
      return { id };
    },
    async attachPolicyToSigner(input) {
      calls.attachPolicyToSigner.push({
        walletId: input.walletId,
        signerId: input.signerId,
        policyId: input.policyId,
      });
      checkAuthorization(
        "attachPolicyToSigner",
        input.authorization,
        Buffer.from(input.authorization.payload, "base64"),
      );
      if (options.mutationError) throw options.mutationError;
      ownerWallets = ownerWallets.map((wallet) =>
        wallet.walletId !== input.walletId
          ? wallet
          : {
              walletId: wallet.walletId,
              signers: wallet.signers.map((signer) =>
                signer.signerId !== input.signerId
                  ? signer
                  : { ...signer, overridePolicyIds: [input.policyId] },
              ),
            },
      );
    },
    async patchPolicy(input) {
      calls.patchPolicy.push({ policyId: input.policyId, rules: input.rules });
      checkAuthorization(
        "patchPolicy",
        input.authorization,
        Buffer.from(input.authorization.payload, "base64"),
      );
      if (options.mutationError) throw options.mutationError;
      if (options.onPatch) await options.onPatch();
      policyRules[input.policyId] = input.rules;
      return { id: input.policyId, rules: input.rules };
    },
  };
  return { transport, calls };
}

export function policyWallet(input: {
  walletId: string;
  signers: readonly { signerId: string; overridePolicyIds?: readonly string[] }[];
}): PolicyApplyWalletRecord {
  return {
    walletId: input.walletId,
    signers: input.signers.map((signer) => ({
      signerId: signer.signerId,
      overridePolicyIds: [...(signer.overridePolicyIds ?? [])],
    })),
  };
}

/** The one ordinary ALLOW rule shape the composer composes. */
export function allowRule(name: string, addresses: readonly string[]): GrantPolicyRule {
  return {
    name,
    method: "signAndSendTransaction",
    action: "ALLOW",
    conditions: [{ field: "Transfer.to", operator: "in", value: [...addresses] }],
  } as unknown as GrantPolicyRule;
}

export function createPublicKeyFromSpki(base64: string): KeyObject {
  return createPublicKey({
    key: Buffer.from(base64, "base64"),
    format: "der",
    type: "spki",
  });
}
