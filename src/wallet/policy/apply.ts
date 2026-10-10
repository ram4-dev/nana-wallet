/**
 * Task 2.8 — the signed apply capability (design §3.5 steps 4-10, §5.3, §5.4).
 *
 * WHY THIS IS A SEPARATE MODULE FROM THE SERVICE
 * ----------------------------------------------
 * Steps 4-9 are provider I/O and step 10 is one database transaction. The
 * ordering between them is the guarantee: "no transaction is open at steps 4-9"
 * (design §3.5). A module that owns only the provider half cannot open a
 * transaction at all, so the property is structural instead of a promise a later
 * edit can break — and the service's step 10 is asserted against a counting
 * database client.
 *
 * WHAT IT DECIDES, AND WHAT IT REFUSES TO DECIDE
 * ----------------------------------------------
 * The pristine comparison (§5.1) decides whether any PATCH is needed; the
 * verification comparison decides whether a revision may be marked applied. Both
 * come from the shared comparator in `readback.ts` — this module never
 * re-implements a rule check, so "unknown remote rules block instead of being
 * deleted" holds on the apply path too.
 *
 * A PATCH failure is classified exactly as §5.3 requires, and the classes are
 * NOT interchangeable:
 *
 *   * the signer could not sign, or the owner-verified listing was unreachable
 *     -> `retryable_failure` (nothing was sent, so nothing can have changed);
 *   * a timeout, a 5xx or a network failure on a mutation -> `unverified`
 *     (the write may or may not have landed; only a GET decides);
 *   * a definitive 4xx -> `retryable_failure` with the provider message bounded
 *     into the detail (a validation problem, never promoted by a readback).
 *
 * Nothing here opens a transaction, and nothing here writes a revision: the
 * applied revision is committed by the service's compare-and-set (§1.5).
 */
import { isDeepStrictEqual } from "node:util";
import type { DatabaseClient } from "../../db/client.js";
import {
  PrivyServerError,
  type PrivyPolicyRecord,
  type PrivyPolicyRule,
  type PrivyChainType,
  type PrivyServerClient,
} from "../privy-server-client.js";
import {
  comparePolicyReadback,
  type OwnerVerifiedSignerListing,
  type OwnerVerifiedWalletListing,
  type PolicyReadback,
} from "./readback.js";
import type { ComposedProvenance } from "./composer.js";
import type { GrantPolicyRule } from "../grants/solana-policy-provisioner.js";
import type {
  PolicyApplyOutcome,
  PolicyApplyRequest,
  PolicyApplySignedPort,
} from "./service.js";

/** The chain family this apply path writes; the composer is Solana-only. */
export const POLICY_APPLY_CHAIN = "solana";

/**
 * The authorization the provider requires on a signed mutation. `payload` is the
 * exact bytes that were signed and `signature` is the DER signature, base64 — the
 * provider verifies it against the registered public key, and a test can do the
 * same with `crypto.verify` (never by byte equality: ECDSA P-256 uses a random
 * nonce, so two signatures over one payload differ and both verify).
 */
export type SignedPolicyAuthorization = { payload: string; signature: string };

/** One signer, as the OWNER-VERIFIED listing reports it. */
export type PolicyApplySignerRecord = {
  signerId: string;
  overridePolicyIds: readonly string[];
};

/** One wallet, as the OWNER-VERIFIED listing reports it. */
export type PolicyApplyWalletRecord = {
  walletId: string;
  signers: readonly PolicyApplySignerRecord[];
};

export type PolicyApplyPolicyRecord = {
  id: string;
  rules: readonly GrantPolicyRule[];
};

/**
 * The provider surface this path needs. Injected, so every branch (timeout, 5xx,
 * 4xx, an unreachable signer, a stale readback) is provable over a fake
 * transport exactly as the repo's `startFakePrivyApi` idiom does.
 */
export type PolicyApplyTransport = {
  /** `privyDid(userId)` -> `listWalletsForChain(did, 'solana')` (design §0 C5). */
  listOwnerWallets(
    userId: string,
    chain: string,
  ): Promise<readonly PolicyApplyWalletRecord[]>;
  getPolicy(policyId: string): Promise<PolicyApplyPolicyRecord>;
  createPolicy(input: {
    name: string;
    rules: readonly GrantPolicyRule[];
    chainType: string;
    authorization: SignedPolicyAuthorization;
  }): Promise<{ id: string }>;
  attachPolicyToSigner(input: {
    walletId: string;
    signerId: string;
    policyId: string;
    authorization: SignedPolicyAuthorization;
  }): Promise<void>;
  patchPolicy(input: {
    policyId: string;
    rules: readonly GrantPolicyRule[];
    authorization: SignedPolicyAuthorization;
  }): Promise<PolicyApplyPolicyRecord>;
};

/**
 * The §5.3 failure vocabulary. `timeout`, `server_error` and `network` are
 * UNVERIFIED; `rejected` is a DEFINITIVE rejection; `signer` means no request was
 * ever sent; `protocol` means the provider answered with something that is not a
 * policy record.
 */
export type PolicyApplyFailureKind =
  | "timeout"
  | "server_error"
  | "network"
  | "rejected"
  | "signer"
  | "protocol";

export class PolicyApplyTransportError extends Error {
  public constructor(
    readonly failureKind: PolicyApplyFailureKind,
    readonly operation: string,
    readonly status: number | null,
    message: string,
  ) {
    super(message);
    this.name = "PolicyApplyTransportError";
  }

  /** §5.3: the write may or may not have landed. */
  public get unverified(): boolean {
    return (
      this.failureKind === "timeout" ||
      this.failureKind === "server_error" ||
      this.failureKind === "network" ||
      this.failureKind === "protocol"
    );
  }
}

export function isPolicyApplyTransportError(
  error: unknown,
): error is PolicyApplyTransportError {
  return error instanceof PolicyApplyTransportError;
}

/** Bounded `status_detail` evidence: ids, counts and codes. Never a signature. */
export type PolicyApplyDetail = Record<string, string | number | boolean | null>;

export type PolicyApplyAdapterDependencies = {
  transport: PolicyApplyTransport;
  /**
   * Signs the exact bytes of a mutation. Wired to the sidecar in production and
   * to a test key in the suite; a failure here is `retryable_failure` because no
   * request was sent.
   */
  signAuthorization: (payload: Uint8Array) => Promise<string>;
  /** The policy name a first attach uses (the enrollment builder's name). */
  policyName?: string;
  chain?: string;
  now?: () => Date;
};

const DEFAULT_POLICY_NAME = "Solana transfer allowlist";

/**
 * The canonical mutation payload. Deterministic in the request and free of
 * secrets: a policy id, the operation name, the rules and an issuance timestamp.
 */
export function policyAuthorizationPayload(input: {
  operation: string;
  policyId: string | null;
  rules: readonly GrantPolicyRule[];
  issuedAt: Date;
}): Uint8Array {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      op: input.operation,
      policyId: input.policyId,
      rules: input.rules,
      issuedAt: input.issuedAt.toISOString(),
    }),
    "utf8",
  );
}

/** Every address a rule set allows, deduplicated, in composition order. */
export function allowedAddressUnion(rules: readonly GrantPolicyRule[]): string[] {
  const addresses: string[] = [];
  for (const rule of rules) {
    const conditions = (rule as { conditions?: unknown }).conditions;
    if (!Array.isArray(conditions)) continue;
    for (const condition of conditions) {
      if (
        typeof condition !== "object" ||
        condition === null ||
        (condition as { field?: unknown }).field !== "Transfer.to"
      ) {
        continue;
      }
      const value = (condition as { value?: unknown }).value;
      if (!Array.isArray(value)) continue;
      for (const address of value) {
        if (typeof address === "string" && !addresses.includes(address)) {
          addresses.push(address);
        }
      }
    }
  }
  return addresses;
}

/**
 * The signed apply capability: design §3.5 steps 4-9 and the §5.3
 * classification, returning the evidence step 10 needs. It performs no write of
 * its own beyond the provider calls the design names, and it never opens a
 * transaction.
 */
export function createSignedPolicyApplyPort(
  deps: PolicyApplyAdapterDependencies,
): PolicyApplySignedPort {
  const now = deps.now ?? (() => new Date());
  const chain = deps.chain ?? POLICY_APPLY_CHAIN;

  const sign = async (
    operation: string,
    policyId: string | null,
    rules: readonly GrantPolicyRule[],
  ): Promise<SignedPolicyAuthorization | { error: PolicyApplyDetail }> => {
    const payload = policyAuthorizationPayload({
      operation,
      policyId,
      rules,
      issuedAt: now(),
    });
    try {
      return {
        payload: Buffer.from(payload).toString("base64"),
        signature: await deps.signAuthorization(payload),
      };
    } catch (error) {
      // No request was sent, so no binding can have changed: this is the one
      // failure class that is safe to retry blindly (§5.3).
      return {
        error: {
          code: "signer_unreachable",
          operation,
          message: boundedMessage(error),
        },
      };
    }
  };

  const verified = (
    request: PolicyApplyRequest,
    policyId: string,
    readback: PolicyReadback,
    signerIds: readonly string[],
  ): PolicyApplyOutcome => ({
    kind: "verified",
    appliedPolicyId: policyId,
    appliedSignerId: request.canonicalSignerId,
    appliedSignerIds: [...signerIds],
    appliedRulesHash: request.composedHash,
    appliedRecipients: allowedAddressUnion(readback.rules as GrantPolicyRule[]),
    detail: { code: "verified", policyId },
  });

  return {
    kind: "signed",
    async apply(request: PolicyApplyRequest): Promise<PolicyApplyOutcome> {
      // ---------------------------------------------------------------- step 4
      let ownerWallets: readonly PolicyApplyWalletRecord[];
      try {
        ownerWallets = await deps.transport.listOwnerWallets(request.userId, chain);
      } catch (error) {
        const failure = classify(error, "listOwnerWallets");
        return failure.unverified
          ? {
              kind: "retryable_failure",
              reason: "owner_listing_unavailable",
              detail: failureDetail(failure),
            }
          : {
              kind: "blocked",
              failureClass: "blocked_configuration",
              reason: "signer_attachment_unproven",
              detail: failureDetail(failure),
            };
      }
      const ownerSigners = ownerWallets.find(
        (wallet) => wallet.walletId === request.providerWalletId,
      );
      // (g) ownership: resolved ONLY through the owner-verified listing, and
      // compared with the recorded provider wallet id. U3's stop, applied here.
      if (!ownerSigners) {
        return {
          kind: "blocked",
          failureClass: "blocked_configuration",
          reason: "ownership_drift",
          detail: {
            code: "owner_listing_missing_wallet",
            providerWalletId: request.providerWalletId,
            observedWalletCount: ownerWallets.length,
          },
        };
      }
      const ownerVerifiedWallets: OwnerVerifiedWalletListing = {
        kind: "acquired",
        walletIds: ownerWallets.map((wallet) => wallet.walletId),
      };
      const ownerVerifiedSigners: OwnerVerifiedSignerListing = {
        kind: "acquired",
        signers: ownerSigners.signers.map((signer) => ({
          signerId: signer.signerId,
          overridePolicyIds: [...signer.overridePolicyIds],
        })),
      };
      const observedSignerIds = ownerSigners.signers.map((signer) => signer.signerId);
      const canonical = ownerSigners.signers.filter(
        (signer) => signer.signerId === request.canonicalSignerId,
      );
      if (canonical.length !== 1) {
        return {
          kind: "blocked",
          failureClass: "blocked_configuration",
          reason: "signer_attachment_unproven",
          detail: {
            code: "canonical_signer_not_exactly_once",
            canonicalSignerId: request.canonicalSignerId,
            observedOccurrences: canonical.length,
          },
        };
      }
      const attachedPolicyIds = [...canonical[0]!.overridePolicyIds];

      /**
       * The live listings are parameters, not captures: checks (e)-(g) are only
       * meaningful against the state AT the readback they judge. Reusing the
       * step-4 capture for the step-9 verification would compare the post-PATCH
       * rules against the pre-PATCH attachment, which is exactly how an
       * unverified attachment would look verified.
       */
      const compare = (
        phase: "pristine" | "verification",
        policyId: string,
        readback: PolicyReadback,
        listing: {
          signers: OwnerVerifiedSignerListing;
          wallets: OwnerVerifiedWalletListing;
        } = { signers: ownerVerifiedSigners, wallets: ownerVerifiedWallets },
      ) =>
        comparePolicyReadback({
          phase,
          expectedPolicyId: policyId,
          composedRules: request.rules,
          provenance: request.provenance,
          readback,
          signer: {
            canonicalSignerId: request.canonicalSignerId,
            ownerVerifiedSigners: listing.signers,
          },
          appliedSignerIds: request.appliedSignerIds,
          ownership: {
            providerWalletId: request.providerWalletId,
            ownerVerifiedWallets: listing.wallets,
          },
        });

      /**
       * Re-read the owner-verified listing for the verification step. Failing to
       * read it after a mutation is UNVERIFIED, never a pass: the attachment this
       * revision claims is exactly what the read was supposed to prove.
       */
      const reverifyListing = async (): Promise<
        | {
            signers: OwnerVerifiedSignerListing;
            wallets: OwnerVerifiedWalletListing;
            signerIds: string[];
          }
        | { error: PolicyApplyDetail }
      > => {
        let wallets: readonly PolicyApplyWalletRecord[];
        try {
          wallets = await deps.transport.listOwnerWallets(request.userId, chain);
        } catch (error) {
          return { error: failureDetail(classify(error, "listOwnerWallets")) };
        }
        const wallet = wallets.find(
          (candidate) => candidate.walletId === request.providerWalletId,
        );
        if (!wallet) {
          return {
            error: {
              code: "ownership_drift",
              providerWalletId: request.providerWalletId,
            },
          };
        }
        return {
          signers: {
            kind: "acquired",
            signers: wallet.signers.map((signer) => ({
              signerId: signer.signerId,
              overridePolicyIds: [...signer.overridePolicyIds],
            })),
          },
          wallets: {
            kind: "acquired",
            walletIds: wallets.map((candidate) => candidate.walletId),
          },
          signerIds: wallet.signers.map((signer) => signer.signerId),
        };
      };

      // A signer with NO policy has nothing to compare: step 5's pristine
      // readback does not exist, so steps 7-9 run instead. This is the only
      // branch that creates or attaches anything.
      if (attachedPolicyIds.length === 0) {
        const authorization = await sign("createPolicy", null, request.rules);
        if ("error" in authorization) {
          return {
            kind: "retryable_failure",
            reason: "signer_unreachable",
            detail: authorization.error,
          };
        }
        let created: { id: string };
        try {
          created = await deps.transport.createPolicy({
            name: deps.policyName ?? DEFAULT_POLICY_NAME,
            rules: request.rules,
            chainType: chain,
            authorization,
          });
        } catch (error) {
          const failure = classify(error, "createPolicy");
          return failure.unverified
            ? {
                kind: "unverified",
                reason: "policy_create_unverified",
                detail: failureDetail(failure),
              }
            : {
                kind: "retryable_failure",
                reason: "policy_create_rejected",
                detail: failureDetail(failure),
              };
        }
        const attachAuthorization = await sign("attachPolicyToSigner", created.id, []);
        if ("error" in attachAuthorization) {
          return {
            kind: "retryable_failure",
            reason: "signer_unreachable",
            detail: { ...attachAuthorization.error, policyId: created.id },
          };
        }
        try {
          await deps.transport.attachPolicyToSigner({
            walletId: request.providerWalletId,
            signerId: request.canonicalSignerId,
            policyId: created.id,
            authorization: attachAuthorization,
          });
        } catch (error) {
          const failure = classify(error, "attachPolicyToSigner");
          return failure.unverified
            ? {
                kind: "unverified",
                reason: "policy_attach_unverified",
                detail: { ...failureDetail(failure), policyId: created.id },
              }
            : {
                kind: "retryable_failure",
                reason: "policy_attach_rejected",
                detail: { ...failureDetail(failure), policyId: created.id },
              };
        }
        const verification = await readPolicy(deps.transport, created.id);
        if ("error" in verification) {
          return {
            kind: "unverified",
            reason: "verification_readback_unavailable",
            detail: { ...verification.error, policyId: created.id },
          };
        }
        const listing = await reverifyListing();
        if ("error" in listing) {
          return {
            kind: "unverified",
            reason: "verification_listing_unavailable",
            detail: { ...listing.error, policyId: created.id },
          };
        }
        const decision = compare("verification", created.id, verification.readback, listing);
        return applyVerificationDecision(
          decision,
          created.id,
          verification.readback,
          listing.signerIds,
        );
      }

      // ------------------------------------------------------------- steps 5-6
      const expectedPolicyId = request.appliedPolicyId ?? attachedPolicyIds[0]!;
      const pristine = await readPolicy(deps.transport, expectedPolicyId);
      if ("error" in pristine) {
        return {
          kind: "retryable_failure",
          reason: "pristine_readback_unavailable",
          detail: { ...pristine.error, policyId: expectedPolicyId },
        };
      }
      const pristineDecision = compare("pristine", expectedPolicyId, pristine.readback);
      if (pristineDecision.outcome === "blocked_conflict") {
        return {
          kind: "blocked",
          failureClass: "blocked_conflict",
          reason: pristineDecision.reason,
          detail: pristineDecision.detail as PolicyApplyDetail,
        };
      }
      if (pristineDecision.outcome === "blocked_configuration") {
        return {
          kind: "blocked",
          failureClass: "blocked_configuration",
          reason: pristineDecision.reason,
          detail: pristineDecision.detail as PolicyApplyDetail,
        };
      }
      // The idempotent skip: the pristine readback already IS the composed rule
      // set, so no PATCH is issued at all. Trusting a byte comparison of the
      // request instead of the readback would PATCH on every replay.
      if (pristineDecision.outcome === "verified") {
        return verified(request, expectedPolicyId, pristine.readback, observedSignerIds);
      }

      // --------------------------------------------------------------- step 8
      const authorization = await sign("patchPolicy", expectedPolicyId, request.rules);
      if ("error" in authorization) {
        return {
          kind: "retryable_failure",
          reason: "signer_unreachable",
          detail: { ...authorization.error, policyId: expectedPolicyId },
        };
      }
      try {
        await deps.transport.patchPolicy({
          policyId: expectedPolicyId,
          rules: request.rules,
          authorization,
        });
      } catch (error) {
        const failure = classify(error, "patchPolicy");
        return failure.unverified
          ? {
              // UNVERIFIED: the PATCH may have landed. No second blind PATCH; the
              // reconciler runs GET-before-retry (§5.3).
              kind: "unverified",
              reason: "patch_unverified",
              detail: failureDetail(failure),
            }
          : {
              kind: "retryable_failure",
              reason: "patch_rejected",
              detail: failureDetail(failure),
            };
      }

      // --------------------------------------------------------------- step 9
      const verification = await readPolicy(deps.transport, expectedPolicyId);
      if ("error" in verification) {
        return {
          kind: "unverified",
          reason: "verification_readback_unavailable",
          detail: { ...verification.error, policyId: expectedPolicyId },
        };
      }
      const listing = await reverifyListing();
      if ("error" in listing) {
        return {
          kind: "unverified",
          reason: "verification_listing_unavailable",
          detail: { ...listing.error, policyId: expectedPolicyId },
        };
      }
      return applyVerificationDecision(
        compare("verification", expectedPolicyId, verification.readback, listing),
        expectedPolicyId,
        verification.readback,
        listing.signerIds,
      );

      function applyVerificationDecision(
        decision: ReturnType<typeof comparePolicyReadback>,
        policyId: string,
        readback: PolicyReadback,
        signerIds: readonly string[],
      ): PolicyApplyOutcome {
        if (decision.outcome === "verified") {
          return verified(request, policyId, readback, signerIds);
        }
        if (decision.outcome === "patch_required") {
          // The provider accepted the write and the readback still differs: the
          // revision may not be marked applied, and this is not a proven
          // divergence, so no binding is invalidated either.
          return {
            kind: "unverified",
            reason: "readback_not_converged",
            detail: { code: "readback_not_converged", policyId },
          };
        }
        return {
          kind: "blocked",
          failureClass: decision.outcome,
          reason: decision.reason,
          detail: decision.detail as PolicyApplyDetail,
        };
      }
    },
  };
}

/**
 * The verification GET, with its failure classified instead of thrown: a readback
 * that cannot be read is never a verified apply, and a failure BEFORE the policy
 * exists (no attached policy, an unreadable pristine readback) is retryable
 * because nothing was written.
 */
async function readPolicy(
  transport: PolicyApplyTransport,
  policyId: string,
): Promise<{ readback: PolicyReadback } | { error: PolicyApplyDetail }> {
  try {
    const record = await transport.getPolicy(policyId);
    if (record.id !== policyId || !Array.isArray(record.rules)) {
      return {
        error: {
          code: "readback_protocol_error",
          operation: "getPolicy",
          policyId,
        },
      };
    }
    return { readback: { id: record.id, rules: [...record.rules] } };
  } catch (error) {
    return { error: failureDetail(classify(error, "getPolicy")) };
  }
}

/** §5.3: classify a provider failure by kind, never by message text. */
export function classify(
  error: unknown,
  operation: string,
): PolicyApplyTransportError {
  if (isPolicyApplyTransportError(error)) return error;
  const status =
    typeof (error as { status?: unknown })?.status === "number"
      ? ((error as { status: number }).status)
      : null;
  const message = boundedMessage(error);
  if (status !== null) {
    if (status >= 500) {
      return new PolicyApplyTransportError("server_error", operation, status, message);
    }
    if (status >= 400) {
      return new PolicyApplyTransportError("rejected", operation, status, message);
    }
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new PolicyApplyTransportError("timeout", operation, status, message);
  }
  return new PolicyApplyTransportError("network", operation, status, message);
}

function failureDetail(failure: PolicyApplyTransportError): PolicyApplyDetail {
  return {
    code: `provider_${failure.failureKind}`,
    operation: failure.operation,
    status: failure.status,
    message: failure.message,
  };
}

/** Bounded, secret-free rendering: a provider message never grows unbounded. */
function boundedMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 120 ? `${message.slice(0, 120)}…` : message;
}

// ---------------------------------------------------------------------------
// The production transport (design §3.5 steps 4-9 over the real client)
// ---------------------------------------------------------------------------

export type PrivyPolicyApplyTransportDependencies = {
  database: DatabaseClient;
  server: {
    listWalletsForChain(
      privyDid: string,
      chain: string,
    ): Promise<
      readonly {
        id: string;
        additional_signers?: readonly {
          signer_id?: string;
          override_policy_ids?: string[];
        }[];
      }[]
    >;
    getPolicy(policyId: string): Promise<{ id: string; rules: readonly unknown[] }>;
    createPolicy(
      name: string,
      rules: readonly GrantPolicyRule[],
      options: { chainType?: "solana" | "ethereum" },
    ): Promise<{ id: string }>;
    patchPolicy(
      policyId: string,
      rules: readonly GrantPolicyRule[],
    ): Promise<{ id: string; rules: readonly unknown[] }>;
    addPolicyToSigner(
      walletId: string,
      signerId: string,
      policyId: string,
    ): Promise<void>;
  };
};

/**
 * Privy adds an opaque `id` to each rule returned by GET/PATCH. It identifies
 * the provider's stored rule, not an authorization constraint, so it cannot be
 * part of the composer hash or the exact-shape guard. Every other key remains
 * intact for the comparator to validate fail-closed.
 */
export function normalizeProviderReadbackRules(
  rules: readonly unknown[],
): readonly GrantPolicyRule[] {
  return rules.map((rule) => {
    if (typeof rule !== "object" || rule === null || Array.isArray(rule)) {
      return rule as GrantPolicyRule;
    }
    const { id: _providerRuleId, ...withoutProviderId } = rule as Record<string, unknown>;
    return withoutProviderId as GrantPolicyRule;
  });
}

/**
 * The real provider implementation of the injected port. The owner-verified read
 * is `privyDid(userId)` -> `listWalletsForChain(did, 'solana')`; the unfiltered
 * `getWallet` read is deliberately NOT used here (design §0 C5), because it
 * cannot distinguish "my wallet" from "a wallet whose id I guessed".
 *
 * The `authorization` a caller obtains from `signAuthorization` is carried on
 * every mutation as evidence of what was signed; the SDK's own signing seam
 * (`PrivyServerClient`) stays the authority for the request it actually sends,
 * so this transport does not re-implement Privy's envelope.
 */
export function createPrivyPolicyApplyTransport(
  deps: PrivyPolicyApplyTransportDependencies,
): PolicyApplyTransport {
  return {
    async listOwnerWallets(userId, chain) {
      const identity = await deps.database.query<{ privy_did: string | null }>(
        "SELECT privy_did FROM users WHERE id = $1",
        [userId],
      );
      const privyDid = identity.rows[0]?.privy_did;
      if (!privyDid) {
        throw new PolicyApplyTransportError(
          "rejected",
          "listOwnerWallets",
          404,
          "No provider identity is recorded for this user; refusing an unowned wallet read.",
        );
      }
      const wallets = await deps.server.listWalletsForChain(privyDid, chain);
      return wallets.map((wallet) => ({
        walletId: wallet.id,
        signers: (wallet.additional_signers ?? []).flatMap((signer) =>
          typeof signer.signer_id === "string"
            ? [
                {
                  signerId: signer.signer_id,
                  overridePolicyIds: Array.isArray(signer.override_policy_ids)
                    ? signer.override_policy_ids
                    : [],
                },
              ]
            : [],
        ),
      }));
    },
    async getPolicy(policyId) {
      const policy = await deps.server.getPolicy(policyId);
      return { id: policy.id, rules: normalizeProviderReadbackRules(policy.rules) };
    },
    async createPolicy(input) {
      if (input.chainType !== POLICY_APPLY_CHAIN) {
        throw new PolicyApplyTransportError(
          "rejected",
          "createPolicy",
          400,
          "Recipient policy apply only supports the Solana chain.",
        );
      }
      return deps.server.createPolicy(input.name, input.rules, { chainType: "solana" });
    },
    async attachPolicyToSigner(input) {
      await deps.server.addPolicyToSigner(
        input.walletId,
        input.signerId,
        input.policyId,
      );
    },
    async patchPolicy(input) {
      const policy = await deps.server.patchPolicy(input.policyId, input.rules);
      return { id: policy.id, rules: normalizeProviderReadbackRules(policy.rules) };
    },
  };
}

/**
 * The production transport over the real `PrivyServerClient`, with the one
 * narrowing the SDK boundary needs: `PrivyPolicyRecord` carries an index
 * signature, so its `rules` are `unknown` until they are proven to be an array.
 * A readback without a rules array is refused (fail closed) instead of being
 * compared against an empty composition.
 */
export function createPrivyServerApplyTransport(dependencies: {
  database: DatabaseClient;
  server: PrivyServerClient;
}): PolicyApplyTransport {
  const readback = (record: PrivyPolicyRecord) => {
    if (!Array.isArray(record.rules)) {
      throw new PrivyServerError(
        500,
        null,
        "Policy readback returned no rules array.",
      );
    }
    return { id: record.id, rules: record.rules as readonly unknown[] };
  };
  return createPrivyPolicyApplyTransport({
    database: dependencies.database,
    server: {
      // The adapter only ever asks for `POLICY_APPLY_CHAIN`; the client's chain
      // union is narrower than the transport's open `string`, so the narrowing is
      // explicit here instead of at every call site.
      listWalletsForChain: (privyDid, chain) =>
        dependencies.server.listWalletsForChain(
          privyDid,
          chain as PrivyChainType,
        ),
      getPolicy: (policyId) =>
        dependencies.server.getPolicy(policyId).then(readback),
      createPolicy: (name, rules, options) =>
        dependencies.server.createPolicy(
          name,
          [...rules] as PrivyPolicyRule[],
          options as { chainType?: PrivyChainType },
        ),
      patchPolicy: (policyId, rules) =>
        dependencies.server
          .patchPolicy(policyId, [...rules] as PrivyPolicyRule[])
          .then(readback),
      addPolicyToSigner: (walletId, signerId, policyId) =>
        dependencies.server.addPolicyToSigner(walletId, signerId, policyId),
    },
  });
}

/** True when two rule sets are structurally equal (the §5.1 comparator's basis). */
export function rulesEqual(
  left: readonly GrantPolicyRule[],
  right: readonly GrantPolicyRule[],
): boolean {
  return isDeepStrictEqual(left, right);
}

/** The recorded provenance type this module consumes, re-exported for callers. */
export type { ComposedProvenance };
