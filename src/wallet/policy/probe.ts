/**
 * The four unproven-provider-semantics probes (design §11 U1–U4).
 *
 * WHY THIS MODULE EXISTS
 * ----------------------
 * Slice 1 ships fail-closed defaults for four provider behaviours nobody has
 * observed on this deployment: several ALLOW rules coexisting in one policy
 * (U1), the canonical signer really being attached (U2), the wallet really being
 * owned by this identity (U3), and an empty rule set really denying (U4). Each of
 * them is a *blocking stop*: until a probe records the observation, the composer
 * refuses and the previously attached policy stays exactly as it is.
 *
 * THE ONE RULE THIS MODULE OBEYS
 * ------------------------------
 * **Never assume, and never infer.** A probe that cannot reach the provider — no
 * signed-authorization capability, no transport, an unreachable endpoint —
 * records `unproven` and leaves the refusal in force. It never upgrades an
 * unobserved behaviour to a resolved one, and provider documentation is recorded
 * as *partial* evidence only (design §11).
 *
 * WHY THE PROVIDER IS AN INJECTED PORT
 * ------------------------------------
 * Everything that touches the provider is an injected `PolicyProbeTransport`
 * (the same seam shape as `PrivyPolicyAdminClient`), so each probe's behaviour is
 * provable in unit tests over a fake transport — the pattern the repository
 * already uses (`startFakePrivyApi`, `tests/unit/solana-user-wallet.test.ts`) —
 * and so the live run is a wiring change, not a code change. The recorded
 * evidence goes through an injected `PolicyProbeEvidenceWriter`, whose production
 * implementation merges into `recipient_policy_state.status_detail` (design §11).
 *
 * THE CARRIED NOTE THIS MODULE DISCHARGES
 * ---------------------------------------
 * `RecipientPolicyRepository.setPolicyStatus` used to REPLACE `status_detail`, so
 * a probe result was destroyed by the next mutation's status write (found in task
 * 1.7 and handed forward). That is **fixed**, not worked around: `setPolicyStatus`
 * now merges, and `mergePolicyStatusDetail` exists for evidence recorded outside a
 * status transition.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { DatabaseClient } from "../../db/client.js";
/**
 * The capability probe signs through the SAME authorization-context seam every
 * real mutation uses, and verifies with the real P-256 public key.
 */
import { signerAuthorizationContext } from "../signer/authorization-context.js";
import { createWorkerPayloadSigner } from "../signer/client.js";
import { PayloadSignerError, type PayloadSigner } from "../signer/port.js";
/**
 * The consented ceiling, imported rather than restated: even a synthetic probe
 * policy must not re-author the 0.01 SOL ceiling (design §3.2 guarantee 1).
 */
import { SOLANA_MAX_PER_TRANSFER_LAMPORTS } from "../embedded.js";
import type { GrantPolicyRule } from "../grants/solana-policy-provisioner.js";
import type {
  PolicyEmptyComposition,
  RecipientPolicyRepository,
} from "./repository.js";

// ---------------------------------------------------------------------------
// The injected provider seam
// ---------------------------------------------------------------------------

/** One signer entry of a remote wallet, reduced to what the probes prove. */
export type PolicyProbeSigner = {
  signerId: string;
  /** The signer's `override_policy_ids`, flattened. */
  policyIds: readonly string[];
};

/** A remote wallet, reduced to what the probes prove. */
export type PolicyProbeWallet = {
  id: string;
  ownerId: string | null;
  /** Policies enforced on every authorization for this wallet. */
  policyIds: readonly string[];
  signers: readonly PolicyProbeSigner[];
};

/** A remote policy with its rules, as read back. */
export type PolicyProbePolicy = {
  id: string;
  rules: readonly GrantPolicyRule[];
};

/** One signed transfer the probe asks the provider to evaluate. */
export type PolicyProbeTransferRequest = {
  /** The policy under test (probes never target the wallet's attached policy). */
  policyId: string;
  to: string;
  lamports: string;
};

export type PolicyProbeTransferOutcome = { permitted: boolean };

/**
 * Everything the four probes need from the provider. Deliberately has NO detach
 * or delete member: a probe can create and patch its own probe policy, and it
 * structurally cannot detach, delete, or empty a wallet's policy (design §11 U4:
 * "the policy is never detached, deleted, or left with an absent recipient
 * rule").
 */
export type PolicyProbeTransport = {
  /** Truthful capability read: `false` means every probe must record `unproven`. */
  canSignAuthorizations(): boolean;
  /**
   * The OWNER-VERIFIED listing (`privyDid(userId)` + `listWalletsForChain(did,
   * 'solana')`), never the unfiltered `server.getWallet` (design §0 C5, §11 U2).
   */
  listOwnerWallets(
    userId: string,
    chain: "solana",
  ): Promise<readonly PolicyProbeWallet[]>;
  /** The UNFILTERED read. U3 needs it to observe the mismatch signature. */
  getWallet(walletId: string): Promise<PolicyProbeWallet>;
  createPolicy(
    name: string,
    rules: readonly GrantPolicyRule[],
  ): Promise<PolicyProbePolicy>;
  patchPolicy(
    policyId: string,
    rules: readonly GrantPolicyRule[],
  ): Promise<PolicyProbePolicy>;
  getPolicy(policyId: string): Promise<PolicyProbePolicy>;
  /**
   * A signed `signAndSendTransaction` under exactly one policy. Optional: with
   * no signer and no user-authorized wallet action this step cannot run, and the
   * probe must record `unproven` rather than infer the outcome (design §11 U1,
   * U4 step iii).
   */
  signAndSendTransfer?(
    input: PolicyProbeTransferRequest,
  ): Promise<PolicyProbeTransferOutcome>;
};

/** The recorded canonical binding the probes assert against. */
export type PolicyProbeBinding = {
  providerWalletId: string;
  providerSignerId: string;
};

/** Resolves `user_wallets.provider_wallet_id`/`provider_signer_id` (never infers). */
export type PolicyProbeBindingResolver = (
  walletId: string,
) => Promise<PolicyProbeBinding>;

/**
 * Where each probe records its observation (design §11):
 * `status_detail.rules_union` / `.attachment_evidence` / `.ownership_evidence`,
 * and the `empty_composition` column for U4.
 */
export type PolicyProbeEvidenceWriter = {
  /** Merge keys into `recipient_policy_state.status_detail`. */
  recordStatusDetail(input: {
    walletId: string;
    patch: Record<string, unknown>;
  }): Promise<void>;
  /** Record the U4 outcome in `recipient_policy_state.empty_composition`. */
  recordEmptyComposition(input: {
    walletId: string;
    value: PolicyEmptyComposition;
  }): Promise<void>;
};

export type PolicyProbeDeps = {
  transport: PolicyProbeTransport;
  binding: PolicyProbeBindingResolver;
  evidence: PolicyProbeEvidenceWriter;
  /** Injected clock so recorded evidence is deterministic under test. */
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// U1 — coexistence of several ALLOW rules in one policy
// ---------------------------------------------------------------------------

export type RuleCompositionUnprovenReason =
  | "signer_unavailable"
  | "provider_unreachable"
  | "signed_transfer_unavailable"
  | "transfer_not_permitted";

/** Design §11 U1: both rule sets and the observed outcome, bounded and secret-free. */
export type RuleCompositionEvidence = {
  /** The two ALLOW rules sent (the observed "before" set). */
  before: readonly GrantPolicyRule[] | null;
  /** What `getPolicy` returned (the observed "after" set). */
  after: readonly GrantPolicyRule[] | null;
  /** `true` only when a signed transfer covered by one rule was permitted. */
  permitted: boolean | null;
  /** The probe policy id; never a wallet policy. */
  probePolicyId: string | null;
  at: string;
  reason: RuleCompositionUnprovenReason | null;
};

export type RuleCompositionProbeResult =
  | { outcome: "union"; reason: null; evidence: RuleCompositionEvidence }
  | {
      outcome: "unproven";
      reason: RuleCompositionUnprovenReason;
      evidence: RuleCompositionEvidence;
    };

/**
 * One synthetic ALLOW rule over a single-address `Transfer.to` allowlist. This is
 * a PROBE rule for a policy that is never attached to a wallet — wallet
 * composition remains the composer's exclusive job (design §3.3) — and it reuses
 * the single consented ceiling instead of re-authoring it.
 */
function probeAllowRule(name: string, address: string): GrantPolicyRule {
  return {
    name,
    method: "signAndSendTransaction",
    action: "ALLOW",
    conditions: [
      {
        field_source: "solana_system_program_instruction",
        field: "Transfer.to",
        operator: "in",
        value: [address],
      },
      {
        field_source: "solana_system_program_instruction",
        field: "Transfer.lamports",
        operator: "lte",
        value: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
      },
    ],
  };
}

/**
 * Design §11 U1. Writes ONE policy with two ALLOW rules over disjoint
 * `Transfer.to` allowlists, then attempts ONE signed transfer to an address
 * covered by only one rule.
 *
 * `union` is recorded ONLY when that transfer is observed as permitted. Prior
 * readback equality is explicitly not proof, and a missing signer, a missing
 * signed-send capability or an unreachable provider records `unproven` with the
 * refusal left in force (no PATCH is ever issued against a wallet's policy).
 */
export async function probeRuleComposition(deps: {
  transport: PolicyProbeTransport;
  evidence: PolicyProbeEvidenceWriter;
  walletId: string;
  /** An address covered by the FIRST rule only. */
  ordinaryAddress: string;
  /** An address covered by the SECOND rule only, disjoint from the first. */
  grantAddress: string;
  now?: () => Date;
}): Promise<RuleCompositionProbeResult> {
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const unproven = (
    reason: RuleCompositionUnprovenReason,
    partial: Partial<RuleCompositionEvidence> = {},
  ): RuleCompositionProbeResult => {
    const evidence: RuleCompositionEvidence = {
      before: null,
      after: null,
      permitted: null,
      probePolicyId: null,
      at,
      reason,
      ...partial,
    };
    return { outcome: "unproven", reason, evidence };
  };

  if (!deps.transport.canSignAuthorizations()) {
    // No signed-authorization capability: the write CANNOT be attempted, so the
    // observation does not exist. `unproven` is the only honest record.
    const result = unproven("signer_unavailable");
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: {
        rules_union: "unproven",
        rules_union_evidence: result.evidence,
      },
    });
    return result;
  }

  const before = [
    probeAllowRule("Solana policy probe rule A", deps.ordinaryAddress),
    probeAllowRule("Solana policy probe rule B", deps.grantAddress),
  ];

  let created: PolicyProbePolicy;
  let after: PolicyProbePolicy;
  try {
    created = await deps.transport.createPolicy(
      "Solana policy composition probe",
      before,
    );
    after = await deps.transport.getPolicy(created.id);
  } catch {
    const result = unproven("provider_unreachable", { before });
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: {
        rules_union: "unproven",
        rules_union_evidence: result.evidence,
      },
    });
    return result;
  }

  const partial: Partial<RuleCompositionEvidence> = {
    before,
    after: after.rules,
    probePolicyId: created.id,
  };

  if (!deps.transport.signAndSendTransfer) {
    // Step (ii) alone proves nothing: the design resolves U1 with an OBSERVED
    // permit under one rule. Documentation is partial evidence, not proof.
    const result = unproven("signed_transfer_unavailable", partial);
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: {
        rules_union: "unproven",
        rules_union_evidence: result.evidence,
      },
    });
    return result;
  }

  let permitted: boolean;
  try {
    const send = await deps.transport.signAndSendTransfer({
      policyId: created.id,
      // Covered by rule A only: a union perm its, an intersection (or a
      // rejection of extra rules) refuses.
      to: deps.ordinaryAddress,
      lamports: "1",
    });
    permitted = send.permitted;
  } catch {
    const result = unproven("provider_unreachable", partial);
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: {
        rules_union: "unproven",
        rules_union_evidence: result.evidence,
      },
    });
    return result;
  }

  if (!permitted) {
    const result = unproven("transfer_not_permitted", partial);
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: {
        rules_union: "unproven",
        rules_union_evidence: result.evidence,
      },
    });
    return result;
  }

  const evidence: RuleCompositionEvidence = {
    ...(partial as Omit<RuleCompositionEvidence, "permitted" | "at" | "reason">),
    permitted: true,
    at,
    reason: null,
  };
  await deps.evidence.recordStatusDetail({
    walletId: deps.walletId,
    patch: { rules_union: "union", rules_union_evidence: evidence },
  });
  return { outcome: "union", reason: null, evidence };
}

// ---------------------------------------------------------------------------
// U2 — signer attachment asserted by an owner-verified readback
// ---------------------------------------------------------------------------

export type SignerAttachmentUnprovenDetail =
  | "owner_listing_failed"
  | "wallet_absent_from_owner_listing"
  | "signer_absent"
  | "signer_duplicated"
  | "policy_not_attached_to_signer"
  | "binding_unresolved";

/** Design §11 U2: the observed ids and timestamp, never a secret. */
export type AttachmentEvidence = {
  providerWalletId: string | null;
  providerSignerId: string | null;
  policyId: string;
  observedOwnerWalletIds: readonly string[];
  observedSignerIds: readonly string[];
  observedPolicyIds: readonly string[];
  /** The read path used: the owner-verified listing, never the unfiltered read. */
  readPath: "owner_verified_listing";
  occurrences: number;
  at: string;
  detail: SignerAttachmentUnprovenDetail | null;
};

export type SignerAttachmentProbeResult =
  | { proven: true; reason: null; patchIssued: false; evidence: AttachmentEvidence }
  | {
      proven: false;
      reason: "signer_attachment_unproven";
      failureClass: "blocked_configuration";
      patchIssued: false;
      evidence: AttachmentEvidence;
    };

/**
 * Design §11 U2. The owner-verified readback that replaces the unfiltered
 * `server.getWallet` read: the canonical signer must be present EXACTLY ONCE in
 * the owner-verified listing and its `override_policy_ids` must contain our
 * policy id.
 *
 * A failure is a blocking stop (`blocked_configuration` /
 * `signer_attachment_unproven`): no policy write is attempted and the previous
 * policy stays attached.
 */
export async function assertPolicyTargetCapability(deps: {
  userId: string;
  walletId: string;
  /** Our policy id, from `recipient_policy_state.applied_policy_id`. */
  policyId: string;
  transport: PolicyProbeTransport;
  binding: PolicyProbeBindingResolver;
  evidence: PolicyProbeEvidenceWriter;
  now?: () => Date;
}): Promise<SignerAttachmentProbeResult> {
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const fail = async (
    detail: SignerAttachmentUnprovenDetail,
    observed: Partial<AttachmentEvidence> = {},
    resolved: Partial<PolicyProbeBinding> = {},
  ): Promise<SignerAttachmentProbeResult> => {
    const evidence: AttachmentEvidence = {
      providerWalletId: resolved.providerWalletId ?? null,
      providerSignerId: resolved.providerSignerId ?? null,
      policyId: deps.policyId,
      observedOwnerWalletIds: [],
      observedSignerIds: [],
      observedPolicyIds: [],
      readPath: "owner_verified_listing",
      occurrences: 0,
      at,
      detail,
      ...observed,
    };
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: { attachment_evidence: evidence },
    });
    return {
      proven: false,
      reason: "signer_attachment_unproven",
      failureClass: "blocked_configuration",
      patchIssued: false,
      evidence,
    };
  };

  let target: PolicyProbeBinding;
  try {
    target = await deps.binding(deps.walletId);
  } catch {
    return fail("binding_unresolved");
  }

  let listing: readonly PolicyProbeWallet[];
  try {
    listing = await deps.transport.listOwnerWallets(deps.userId, "solana");
  } catch {
    return fail("owner_listing_failed", {}, target);
  }

  const observedOwnerWalletIds = listing.map((wallet) => wallet.id);
  const wallet = listing.find(
    (candidate) => candidate.id === target.providerWalletId,
  );
  if (!wallet) {
    return fail(
      "wallet_absent_from_owner_listing",
      { observedOwnerWalletIds },
      target,
    );
  }

  const observedSignerIds = wallet.signers.map((signer) => signer.signerId);
  const matches = wallet.signers.filter(
    (signer) => signer.signerId === target.providerSignerId,
  );
  if (matches.length === 0) {
    return fail("signer_absent", { observedOwnerWalletIds, observedSignerIds }, target);
  }
  if (matches.length > 1) {
    return fail(
      "signer_duplicated",
      { observedOwnerWalletIds, observedSignerIds, occurrences: matches.length },
      target,
    );
  }

  const observedPolicyIds = [...matches[0]!.policyIds];
  if (!observedPolicyIds.includes(deps.policyId)) {
    return fail(
      "policy_not_attached_to_signer",
      { observedOwnerWalletIds, observedSignerIds, observedPolicyIds, occurrences: 1 },
      target,
    );
  }

  const evidence: AttachmentEvidence = {
    providerWalletId: target.providerWalletId,
    providerSignerId: target.providerSignerId,
    policyId: deps.policyId,
    observedOwnerWalletIds,
    observedSignerIds,
    observedPolicyIds,
    readPath: "owner_verified_listing",
    occurrences: 1,
    at,
    detail: null,
  };
  await deps.evidence.recordStatusDetail({
    walletId: deps.walletId,
    patch: { attachment_evidence: evidence },
  });
  return { proven: true, reason: null, patchIssued: false, evidence };
}

// ---------------------------------------------------------------------------
// U3 — policy-ownership conflict
// ---------------------------------------------------------------------------

export type OwnershipSignature =
  | "owner_listing_present"
  | "owner_listing_empty_unfiltered_present"
  | "absent_everywhere";

export type OwnershipEvidence = {
  providerWalletId: string | null;
  observedOwnerWalletIds: readonly string[];
  unfilteredObservedId: string | null;
  signature: OwnershipSignature;
  at: string;
  detail: string | null;
};

export type OwnershipProbeResult =
  | { proven: true; reason: null; bindingRewritten: false; evidence: OwnershipEvidence }
  | {
      proven: false;
      reason: "ownership_drift" | "ownership_unproven";
      failureClass: "blocked_configuration";
      patchIssued: false;
      bindingRewritten: false;
      evidence: OwnershipEvidence;
    };

/**
 * Design §11 U3. Resolves the wallet ONLY through the owner-verified listing and
 * compares it with the recorded `user_wallets.provider_wallet_id`.
 *
 * The mismatch signature — the owner-verified listing returns nothing while the
 * unfiltered read returns a record — stops with `ownership_drift`. The remote
 * owner is neither adopted nor overwritten and `provider_signer_id` is never
 * rewritten from here: this function has no write path to `user_wallets` at all.
 */
export async function assertPolicyOwnership(deps: {
  userId: string;
  walletId: string;
  transport: PolicyProbeTransport;
  binding: PolicyProbeBindingResolver;
  evidence: PolicyProbeEvidenceWriter;
  now?: () => Date;
}): Promise<OwnershipProbeResult> {
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const record = async (
    evidence: OwnershipEvidence,
  ): Promise<void> => {
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: { ownership_evidence: evidence },
    });
  };

  let target: PolicyProbeBinding;
  try {
    target = await deps.binding(deps.walletId);
  } catch {
    const evidence: OwnershipEvidence = {
      providerWalletId: null,
      observedOwnerWalletIds: [],
      unfilteredObservedId: null,
      signature: "absent_everywhere",
      at,
      detail: "binding_unresolved",
    };
    await record(evidence);
    return {
      proven: false,
      reason: "ownership_unproven",
      failureClass: "blocked_configuration",
      patchIssued: false,
      bindingRewritten: false,
      evidence,
    };
  }

  let listing: readonly PolicyProbeWallet[];
  try {
    listing = await deps.transport.listOwnerWallets(deps.userId, "solana");
  } catch {
    const evidence: OwnershipEvidence = {
      providerWalletId: target.providerWalletId,
      observedOwnerWalletIds: [],
      unfilteredObservedId: null,
      signature: "absent_everywhere",
      at,
      detail: "owner_listing_failed",
    };
    await record(evidence);
    return {
      proven: false,
      reason: "ownership_unproven",
      failureClass: "blocked_configuration",
      patchIssued: false,
      bindingRewritten: false,
      evidence,
    };
  }

  const observedOwnerWalletIds = listing.map((wallet) => wallet.id);
  if (listing.some((wallet) => wallet.id === target.providerWalletId)) {
    const evidence: OwnershipEvidence = {
      providerWalletId: target.providerWalletId,
      observedOwnerWalletIds,
      unfilteredObservedId: null,
      signature: "owner_listing_present",
      at,
      detail: null,
    };
    await record(evidence);
    return { proven: true, reason: null, bindingRewritten: false, evidence };
  }

  // The owner-verified listing does not know this wallet. The unfiltered read is
  // consulted ONLY to characterise the mismatch; it is never ownership evidence
  // and its result is never adopted (design §0 C5).
  let unfilteredObservedId: string | null = null;
  let detail: string = "unfiltered_absent";
  try {
    unfilteredObservedId = (await deps.transport.getWallet(target.providerWalletId)).id;
    detail = "owner_listing_empty_unfiltered_present";
  } catch {
    unfilteredObservedId = null;
  }

  const drift = unfilteredObservedId !== null;
  const evidence: OwnershipEvidence = {
    providerWalletId: target.providerWalletId,
    observedOwnerWalletIds,
    unfilteredObservedId,
    signature: drift
      ? "owner_listing_empty_unfiltered_present"
      : "absent_everywhere",
    at,
    detail,
  };
  await record(evidence);
  return {
    proven: false,
    reason: drift ? "ownership_drift" : "ownership_unproven",
    failureClass: "blocked_configuration",
    patchIssued: false,
    bindingRewritten: false,
    evidence,
  };
}

// ---------------------------------------------------------------------------
// U4 — empty composed policy / deny behaviour
// ---------------------------------------------------------------------------

export type EmptyCompositionUnprovenReason =
  | "signer_unavailable"
  | "provider_unreachable"
  | "signed_denial_unobserved"
  | "signed_transfer_permitted";

/** Design §11 U4: the observed policy facts, never an inferred deny. */
export type EmptyCompositionEvidence = {
  /** What `createPolicy(name, [])` returned, if it ran. */
  createdPolicyId: string | null;
  /** `rules.length` as read back after create; null when the step did not run. */
  rulesAfterCreate: number | null;
  /** `rules.length` as read back after `patchPolicy(id, [])`. */
  rulesAfterPatch: number | null;
  /** `true` only when a signed transfer against the empty policy was REFUSED. */
  signedDenialObserved: boolean | null;
  at: string;
  reason: EmptyCompositionUnprovenReason | null;
};

export type EmptyCompositionProbeResult = {
  /** `proven_deny` ONLY from an observed signed refusal, never from a PATCH. */
  emptyComposition: "proven_deny" | "unproven";
  reason: EmptyCompositionUnprovenReason | null;
  /** Always `false`: the probe has no detach/delete capability at all. */
  policyDetached: false;
  evidence: EmptyCompositionEvidence;
};

/**
 * Design §11 U4. Runs `createPolicy(name, [])` + `getPolicy` and
 * `patchPolicy(id, [])` + `getPolicy`, and — when a signed transfer port exists —
 * step (iii), the signed transfer attempt against the empty-rules policy.
 *
 * `proven_deny` is recorded ONLY when step (iii) observed a provider refusal.
 * Nothing is inferred from a successful zero-rule PATCH: with step (iii) omitted
 * the outcome stays `unproven` and the composer keeps refusing.
 */
export async function probeEmptyComposition(deps: {
  transport: PolicyProbeTransport;
  evidence: PolicyProbeEvidenceWriter;
  walletId: string;
  /** An address no probe rule covers, for the step (iii) attempt. */
  uncoveredAddress: string;
  now?: () => Date;
}): Promise<EmptyCompositionProbeResult> {
  const at = (deps.now ?? (() => new Date()))().toISOString();

  const settle = async (
    emptyComposition: "proven_deny" | "unproven",
    reason: EmptyCompositionUnprovenReason | null,
    evidence: EmptyCompositionEvidence,
  ): Promise<EmptyCompositionProbeResult> => {
    await deps.evidence.recordEmptyComposition({
      walletId: deps.walletId,
      value: emptyComposition,
    });
    await deps.evidence.recordStatusDetail({
      walletId: deps.walletId,
      patch: { empty_composition_evidence: evidence },
    });
    return {
      emptyComposition,
      reason,
      policyDetached: false,
      evidence,
    };
  };

  const blank = (
    reason: EmptyCompositionUnprovenReason | null,
  ): EmptyCompositionEvidence => ({
    createdPolicyId: null,
    rulesAfterCreate: null,
    rulesAfterPatch: null,
    signedDenialObserved: null,
    at,
    reason,
  });

  if (!deps.transport.canSignAuthorizations()) {
    return settle("unproven", "signer_unavailable", blank("signer_unavailable"));
  }

  let createdPolicyId: string;
  let rulesAfterCreate: number;
  let rulesAfterPatch: number;
  try {
    const created = await deps.transport.createPolicy(
      "Solana empty policy probe",
      [],
    );
    createdPolicyId = created.id;
    rulesAfterCreate = (await deps.transport.getPolicy(created.id)).rules.length;
    await deps.transport.patchPolicy(created.id, []);
    rulesAfterPatch = (await deps.transport.getPolicy(created.id)).rules.length;
  } catch {
    return settle("unproven", "provider_unreachable", blank("provider_unreachable"));
  }

  const observed: EmptyCompositionEvidence = {
    createdPolicyId,
    rulesAfterCreate,
    rulesAfterPatch,
    signedDenialObserved: null,
    at,
    reason: null,
  };

  if (!deps.transport.signAndSendTransfer) {
    // The zero-rule PATCH succeeded and that is EXACTLY what must not be read as
    // deny: an empty rules array may be accepted as input without any request
    // ever being denied by it.
    const reason: EmptyCompositionUnprovenReason = "signed_denial_unobserved";
    return settle("unproven", reason, { ...observed, reason });
  }

  let permitted: boolean;
  try {
    permitted = (
      await deps.transport.signAndSendTransfer({
        policyId: createdPolicyId,
        to: deps.uncoveredAddress,
        lamports: "1",
      })
    ).permitted;
  } catch {
    return settle("unproven", "provider_unreachable", {
      ...observed,
      reason: "provider_unreachable",
    });
  }

  if (permitted) {
    // An empty policy that ALLOWS is not a deny container. Fail closed and
    // record it as an anomaly rather than as a deny.
    const reason: EmptyCompositionUnprovenReason = "signed_transfer_permitted";
    return settle("unproven", reason, {
      ...observed,
      signedDenialObserved: false,
      reason,
    });
  }

  return settle("proven_deny", null, { ...observed, signedDenialObserved: true });
}

// ---------------------------------------------------------------------------
// Production wiring
// ---------------------------------------------------------------------------

/**
 * The production evidence writer: probes record into
 * `recipient_policy_state.status_detail` (merged, so the next status transition
 * cannot erase them) and into the `empty_composition` column.
 */
export function createRepositoryProbeEvidenceWriter(deps: {
  userId: string;
  repository: RecipientPolicyRepository;
}): PolicyProbeEvidenceWriter {
  return {
    async recordStatusDetail(input) {
      await deps.repository.mergePolicyStatusDetail(
        deps.userId,
        input.walletId,
        input.patch,
      );
    },
    async recordEmptyComposition(input) {
      await deps.repository.setEmptyComposition(
        deps.userId,
        input.walletId,
        input.value,
      );
    },
  };
}

/**
 * The production binding resolver: the recorded canonical binding, resolved by
 * `resolvePolicyTarget` so a wallet with no verified signer binding fails closed
 * instead of inferring one.
 */
export function createPolicyProbeBindingResolver(
  database: DatabaseClient,
): PolicyProbeBindingResolver {
  return async (walletId) => {
    const { resolvePolicyTarget } = await import(
      "../grants/privy-policy-admin.js"
    );
    const target = await resolvePolicyTarget(database, walletId);
    return {
      providerWalletId: target.providerWalletId,
      providerSignerId: target.providerSignerId,
    };
  };
}

// ---------------------------------------------------------------------------
// The signed-authorization capability probe (design §6.4 layer 2, task 2.7)
// ---------------------------------------------------------------------------

/** The readiness codes the capability probe can report. Exactly these. */
export type PolicySignerCapabilityCode =
  | "verified"
  | "signer_unavailable"
  | "signer_rejected"
  | "signer_timeout"
  | "signature_mismatch";

/**
 * The readiness result. `capable` and `code` only: no payload, no signature, no
 * token and no key ever leaves `verifyPolicySignerCapability`, and nothing is
 * logged (design §6.3's last bullet).
 */
export type PolicySignerCapability = {
  capable: boolean;
  code: PolicySignerCapabilityCode;
};

/**
 * The probe payload: fixed, non-secret, and byte-stable. `JSON.stringify` over a
 * literal with a fixed key order is deterministic, so every run signs exactly
 * these bytes; nothing in the object carries a token, a key, an address or a
 * user id.
 */
const PROBE_PAYLOAD_OBJECT = {
  probe: "policy-signer-capability",
  version: 1,
  issuedAt: "1970-01-01T00:00:00.000Z",
} as const;

export function policySignerProbePayload(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(PROBE_PAYLOAD_OBJECT));
}

/**
 * Proves the signed-authorization capability, not merely that an endpoint
 * answers (design §6.4 layer 2).
 *
 * The payload is signed THROUGH `signerAuthorizationContext` — the exact seam
 * every real mutation uses — and the result is asserted with
 * `crypto.verify("sha256", payload, publicKeyObject, signature)` against the
 * configured `PRIVY_AUTHORIZATION_PUBLIC_KEY` (already validated as P-256 SPKI
 * DER by `readPrivyServerConfig`). It is **never** byte equality: ECDSA P-256
 * uses a random per-signature nonce, so two signatures over the same payload are
 * never equal, and a byte-equality check would prove nothing.
 *
 * Because only the holder of the private key matching the registered quorum
 * public key can produce a verifying signature, a `verified` result proves
 * authority; every other result is a truthful `capable: false`.
 *
 * Mapping, exhaustively:
 *  - no signer configured, no public key to verify against, a signer
 *    configuration error, an unreachable sidecar, a 5xx, a malformed answer, or
 *    an unusable public key -> `signer_unavailable`;
 *  - a definitive 4xx from the sidecar -> `signer_rejected`;
 *  - the sidecar did not answer inside its bounded timeout -> `signer_timeout`;
 *  - a signature came back but does not verify under the configured key (or is
 *    not a well-formed base64 DER signature) -> `signature_mismatch`.
 */
export async function verifyPolicySignerCapability(
  deps: {
    /** Defaults to the current process environment. */
    environment?: NodeJS.ProcessEnv;
    /** Defaults to the environment-configured sidecar client, if any. */
    signer?: PayloadSigner;
    /** Defaults to `PRIVY_AUTHORIZATION_PUBLIC_KEY`. */
    authorizationPublicKey?: string;
  } = {},
): Promise<PolicySignerCapability> {
  const environment = deps.environment ?? process.env;

  let signer = deps.signer;
  if (!signer) {
    try {
      signer = createWorkerPayloadSigner(environment);
    } catch (error) {
      // A partial signer configuration is not a reachable capability.
      return {
        capable: false,
        code: payloadSignerFailureCode(error),
      };
    }
  }
  if (!signer) {
    return { capable: false, code: "signer_unavailable" };
  }

  const publicKeyB64 =
    deps.authorizationPublicKey ??
    environment.PRIVY_AUTHORIZATION_PUBLIC_KEY?.trim();
  if (!publicKeyB64) {
    // Without the registered public key the signature is unverifiable, so the
    // capability cannot be asserted. Fails closed rather than assuming.
    return { capable: false, code: "signer_unavailable" };
  }

  let publicKeyObject: KeyObject;
  try {
    publicKeyObject = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    // Never echo the key material, not even a prefix.
    return { capable: false, code: "signer_unavailable" };
  }

  const payload = policySignerProbePayload();
  // The production seam: the SDK-shaped authorization context, whose sign
  // function receives the payload bytes verbatim.
  const signFns = signerAuthorizationContext(signer).sign_fns ?? [];
  const [sign] = signFns;
  if (!sign) {
    // The context builder always carries one sign function; treat its absence
    // as an unavailable capability rather than signing with nothing.
    return { capable: false, code: "signer_unavailable" };
  }

  let signature: string;
  try {
    signature = await sign(payload);
  } catch (error) {
    return { capable: false, code: payloadSignerFailureCode(error) };
  }

  try {
    const verified = verify(
      "sha256",
      payload,
      publicKeyObject,
      Buffer.from(signature, "base64"),
    );
    return verified
      ? { capable: true, code: "verified" }
      : { capable: false, code: "signature_mismatch" };
  } catch {
    // A signature that is not well-formed DER is a mismatch, not a crash.
    return { capable: false, code: "signature_mismatch" };
  }
}

/** Maps a worker-side signer failure onto the readiness vocabulary. */
function payloadSignerFailureCode(error: unknown): PolicySignerCapabilityCode {
  if (error instanceof PayloadSignerError) {
    switch (error.code) {
      case "signer_timeout":
        return "signer_timeout";
      case "signer_rejected":
        return "signer_rejected";
      default:
        // signer_unavailable, signer_protocol_error and signer_not_configured
        // are all "we could not obtain a usable signature".
        return "signer_unavailable";
    }
  }
  return "signer_unavailable";
}
