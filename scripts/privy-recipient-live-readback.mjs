/**
 * Live signed readback of one wallet's Privy policy state (task 5.7, read half).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * Task 5.7 needs the wallet's remote policy state captured BEFORE and AFTER the
 * authorized `sophie.sns` screen operation, so "the address is included" and
 * "the ordinary cap / delegated limits / canonical signer attachment / unrelated
 * signers are preserved" are READ rather than asserted. The written evidence must
 * come from the deployed stack, not from a fixture.
 *
 * This script performs READS ONLY. It creates nothing, PATCHes nothing, attaches
 * nothing, deletes nothing and moves no funds. It is safe to run repeatedly.
 *
 * WHAT IT READS, AND THROUGH WHICH PRODUCTION SEAM
 * -----------------------------------------------
 *   - the OWNER-VERIFIED wallet listing (`privyDid(userId)` ->
 *     `listWalletsForChain(did, 'solana')`) through `PrivyServerClient`, i.e. the
 *     same read `assertPolicyTargetCapability` (U2) and the apply path use;
 *   - the canonical binding through `createPolicyProbeBindingResolver` (the
 *     recorded `user_wallets` binding, never inferred);
 *   - the attached policy and its rules through `privyServer.getPolicy()`.
 *     Read this honestly: this GET is authenticated with the app credentials; the
 *     *signed* capability is what `canSignAuthorizations()` reports, and its
 *     `true` value is what makes the corresponding WRITE provable. This script
 *     prints `signerConfigured` so that distinction is visible in the evidence
 *     rather than rounded to "signed GET";
 *   - the recorded database state through the production repository
 *     (`recipient_policy_state`, active contacts, active delegated grants);
 *   - the composed rule set the reconciler WOULD apply (`composeRevision`, which
 *     performs no write) and the pure `comparePolicyReadback` decision over the
 *     observed remote rules. This is a PREDICTION, labelled as such: it is the
 *     deployment's own composer and comparator judging the live remote readback,
 *     not an independent verifier.
 *
 * SECRET SAFETY
 * -------------
 * Bounded ids, booleans, codes and public devnet addresses only. No environment
 * value, token, key, payload or signature is ever printed, and `.env` is never
 * read: the script runs inside the container, which already holds its own
 * credentials. `docker inspect | jq ... split("=")[0]` is the only env access
 * used anywhere in this work unit.
 *
 * USAGE (inside a container that has the build, hence the stdin form):
 *
 *   docker exec -i -e READBACK_USER_ID=<uuid> -e READBACK_WALLET_ID=<uuid> \
 *     nana-privy-impl-backend-1 node --input-type=module - \
 *     < scripts/privy-recipient-live-readback.mjs
 */
const userId = process.env.READBACK_USER_ID?.trim();
const walletId = process.env.READBACK_WALLET_ID?.trim();
const label = process.env.READBACK_LABEL?.trim() || "unlabelled";
/** The candidate recipient the parent authorized (public devnet address, not a secret). */
const candidateAddress =
  process.env.READBACK_CANDIDATE_ADDRESS?.trim() ||
  "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
if (!userId || !walletId) {
  console.error("BLOCKED: READBACK_USER_ID and READBACK_WALLET_ID are required.");
  process.exit(2);
}

const { createConfiguredDatabaseClient } = await import("/app/dist/db/client.js");
const { RecipientPolicyRepository } = await import("/app/dist/wallet/policy/repository.js");
const { readPrivyServerConfig } = await import("/app/dist/config/privy-server.js");
const { PrivyServerClient } = await import("/app/dist/wallet/privy-server-client.js");
const { createWorkerPayloadSigner } = await import("/app/dist/wallet/signer/client.js");
const { createPolicyProbeBindingResolver } = await import("/app/dist/wallet/policy/probe.js");
const { createRecipientPolicyService, createUnavailablePolicyApplyPort } = await import(
  "/app/dist/wallet/policy/service.js"
);
const { comparePolicyReadback } = await import("/app/dist/wallet/policy/readback.js");
// The apply path's own normaliser. `createPrivyPolicyApplyTransport.getPolicy`
// and the reconciler's §5.3 GET both strip the provider-assigned per-rule `id`
// BEFORE the comparator sees a readback, so a harness that feeds RAW provider
// rules judges a different input than production does and mis-reports the
// decision. This import is what keeps the prediction honest.
const { normalizeProviderReadbackRules } = await import("/app/dist/wallet/policy/apply.js");
const { composePolicy } = await import("/app/dist/wallet/policy/composer.js");
const { SOLANA_MAX_PER_TRANSFER_LAMPORTS } = await import("/app/dist/wallet/embedded.js");
const { ContactsRepository } = await import("/app/dist/memory/contacts-repository.js");
const { createRecipientContactMutationPort } = await import(
  "/app/dist/memory/contact-policy-adapter.js"
);

const privyConfig = readPrivyServerConfig(process.env);
if (!privyConfig) {
  console.error("BLOCKED: the production Privy client is not configured in this process.");
  process.exit(2);
}
const authorizationSigner = createWorkerPayloadSigner(process.env);
const privy = new PrivyServerClient({
  appId: privyConfig.appId,
  appSecret: privyConfig.appSecret,
  baseUrl: privyConfig.baseUrl,
  ...(authorizationSigner ? { authorizationSigner } : {}),
});

const database = createConfiguredDatabaseClient();
const repository = new RecipientPolicyRepository(database);

async function privyDidOf(id) {
  const result = await database.query("SELECT privy_did FROM users WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row?.privy_did) throw new Error("no privy_did for this user");
  return row.privy_did;
}

/** Every `Transfer.to` allowlist entry a rule declares, in declared order. */
function transferToAddresses(rule) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const addresses = [];
  for (const condition of conditions) {
    if (condition?.field !== "Transfer.to") continue;
    if (Array.isArray(condition.value)) addresses.push(...condition.value);
  }
  return addresses;
}

/** The `Transfer.lamports` ceiling a rule declares, or null. */
function transferCeiling(rule) {
  const conditions = Array.isArray(rule?.conditions) ? rule.conditions : [];
  const found = conditions.find((condition) => condition?.field === "Transfer.lamports");
  return found ? { operator: found.operator ?? null, value: found.value ?? null } : null;
}

/**
 * The observed rule set reduced to the four facts task 5.7 must prove are
 * preserved. The full rules are ALSO emitted, because a reduction is a claim and
 * the raw bytes are the evidence.
 */
function summariseRules(rules) {
  return {
    ruleCount: rules.length,
    ruleNames: rules.map((rule) => rule?.name ?? null),
    allowlists: rules.map((rule) => transferToAddresses(rule).slice().sort()),
    ceilings: rules.map((rule) => transferCeiling(rule)),
    /**
     * The exact key sets. `hasExpectedRuleShape` (`src/wallet/policy/readback.ts`)
     * requires the observed and the composed rule to carry the SAME key set, so
     * this is the fact that decides whether a remote readback can ever be
     * classified as `converge` rather than `rule_shape_unrecognized`.
     */
    ruleKeys: rules.map((rule) =>
      rule && typeof rule === "object" ? Object.keys(rule).sort() : null,
    ),
    conditionKeys: rules.map((rule) =>
      Array.isArray(rule?.conditions)
        ? rule.conditions.map((condition) =>
            condition && typeof condition === "object"
              ? Object.keys(condition).sort()
              : null,
          )
        : null,
    ),
  };
}

const out = {
  label,
  walletId,
  userId,
  at: new Date().toISOString(),
  resolvedProviderBaseUrl: privyConfig.baseUrl,
  signerConfigured: privy.canSignAuthorizations(),
};

try {
  const did = await privyDidOf(userId);
  out.privyDidResolved = Boolean(did);

  // ---- the owner-verified listing: signer attachment + unrelated signers ----
  const wallets = await privy.listWalletsForChain(did, "solana");
  const target = await createPolicyProbeBindingResolver(database)(walletId);
  out.recordedBinding = target;

  const ownerWallet = wallets.find((candidate) => candidate.id === target.providerWalletId);
  const observed = ownerWallet ?? null;
  out.ownerVerifiedListing = {
    walletIds: wallets.map((candidate) => candidate.id),
    walletPresent: Boolean(ownerWallet),
    walletPolicyIds: observed && Array.isArray(observed.policy_ids) ? observed.policy_ids : [],
    signers: (observed?.additional_signers ?? []).map((signer) => ({
      signerId: signer.signer_id ?? null,
      overridePolicyIds: Array.isArray(signer.override_policy_ids)
        ? signer.override_policy_ids
        : [],
    })),
  };
  out.canonicalSignerOccurrences = out.ownerVerifiedListing.signers.filter(
    (signer) => signer.signerId === target.providerSignerId,
  ).length;
  // "Unrelated signers": every signer on the wallet that is NOT the canonical one.
  out.unrelatedSigners = out.ownerVerifiedListing.signers.filter(
    (signer) => signer.signerId !== target.providerSignerId,
  );

  // ---- the attached policy and its rules, through the production client ----
  const canonical = out.ownerVerifiedListing.signers.find(
    (signer) => signer.signerId === target.providerSignerId,
  );
  const attachedPolicyIds = canonical?.overridePolicyIds ?? [];
  out.attachedPolicyIds = attachedPolicyIds;

  const state = await repository.readPolicyState(userId, walletId);
  out.recordedAppliedPolicyId = state?.appliedPolicyId ?? null;
  out.expectedPolicyId = state?.appliedPolicyId ?? attachedPolicyIds[0] ?? null;

  if (out.expectedPolicyId) {
    const policy = await privy.getPolicy(out.expectedPolicyId);
    const rules = Array.isArray(policy.rules) ? policy.rules : [];
    const normalised = [...normalizeProviderReadbackRules(rules)];
    out.remotePolicy = {
      id: policy.id,
      rules,
      summary: summariseRules(rules),
      // The exact input the apply path and the reconciler compare. Kept beside
      // the raw rules so the difference is visible instead of implied.
      normalisedRules: normalised,
      normalisedSummary: summariseRules(normalised),
    };
  } else {
    out.remotePolicy = null;
  }

  // ---- recorded database state ----
  out.recordedState = state
    ? {
        desiredRevision: state.desiredRevision,
        appliedRevision: state.appliedRevision,
        appliedPolicyId: state.appliedPolicyId,
        appliedSignerId: state.appliedSignerId,
        appliedSignerIds: state.appliedSignerIds,
        appliedRecipients: state.appliedRecipients,
        consentBaseline: state.consentBaseline,
        emptyComposition: state.emptyComposition,
        status: state.status,
        statusReason: state.statusReason ?? null,
        statusDetailKeys: Object.keys(state.statusDetail ?? {}),
        verifiedAt: state.verifiedAt ?? null,
      }
    : null;

  const contacts = await repository.listComposerContacts(userId);
  out.composerContacts = contacts;
  const grantRows = await database.withUserTransaction(userId, (client) =>
    repository.listActiveLedgerGrants(userId, walletId, "solana", client),
  );
  out.activeDelegatedGrants = grantRows;

  // ---- the deployment's own composer + comparator, over the live readback ----
  const service = createRecipientPolicyService({
    database,
    repository,
    contacts: createRecipientContactMutationPort({
      contacts: new ContactsRepository(database),
      // Never used on a compose-only path; a wrong embedding must fail loudly
      // rather than silently return a placeholder vector.
      embedder: { embed: async () => { throw new Error("embedder must not be called on a readback"); } },
    }),
    listActiveGrants: (wId, uId, chain) =>
      database.withUserTransaction(uId, (client) =>
        repository.listActiveLedgerGrants(uId, wId, chain, client),
      ),
    aliases: null,
    provider: createUnavailablePolicyApplyPort(
      "readback harness: this process applies nothing; the deployment's reconciler owns the write.",
    ),
  });

  let composed = null;
  try {
    composed = await service.composeRevision(userId, walletId);
    out.composition = {
      outcome: "composed",
      hash: composed.hash ?? null,
      ordinaryRecipients: composed.ordinaryRecipients ?? null,
      grantRecipients: composed.grantRecipients ?? null,
      provenance: composed.provenance ?? null,
      rules: composed.rules,
      summary: summariseRules(composed.rules ?? []),
    };
  } catch (error) {
    out.composition = {
      outcome: "refused",
      errorName: error?.constructor?.name ?? null,
      // Bounded: a refusal type name, never a payload or a stack.
      errorMessage: typeof error?.message === "string" ? error.message.slice(0, 200) : null,
    };
  }

  if (out.remotePolicy && composed && out.composition?.outcome === "composed") {
    out.pristineDecision = comparePolicyReadback({
      phase: "pristine",
      expectedPolicyId: out.expectedPolicyId,
      composedRules: composed.rules,
      provenance: composed.provenance,
      readback: { id: out.remotePolicy.id, rules: out.remotePolicy.normalisedRules },
      signer: {
        canonicalSignerId: target.providerSignerId,
        ownerVerifiedSigners: {
          kind: "acquired",
          signers: out.ownerVerifiedListing.signers.map((signer) => ({
            signerId: signer.signerId,
            overridePolicyIds: signer.overridePolicyIds,
          })),
        },
      },
      appliedSignerIds: state?.appliedSignerIds ?? [],
      ownership: {
        providerWalletId: target.providerWalletId,
        ownerVerifiedWallets: {
          kind: "acquired",
          walletIds: wallets.map((candidate) => candidate.id),
        },
      },
    });
  } else {
    out.pristineDecision = null;
  }

  // -------------------------------------------------------------------------
  // PREDICTION: what the deployment's OWN composer and comparator would decide
  // -------------------------------------------------------------------------
  // Nothing is written here. `readActiveEnrollmentConsent` is a read; the
  // first-mutation baseline capture is SIMULATED by feeding that read's exact
  // result to the production composer, because `captureConsentBaselineOnce`
  // writes and this script does not. `comparePolicyReadback` is the same pure
  // function the apply path calls, over the live remote readback.
  const consent = await repository.readActiveEnrollmentConsent(userId, walletId);
  out.prediction = {
    candidateAddress,
    consentBaselineReadOnly: consent ? consent.baseline : null,
    consentProvenanceReadOnly: consent ? consent.provenance : null,
    baselineCaptureIsDue: Boolean(
      state &&
        state.status === "saved_not_configured" &&
        state.desiredRevision === 0 &&
        state.appliedRevision === 0 &&
        (state.consentBaseline ?? []).length === 0,
    ),
    baselineCaptureSimulated: true,
  };

  const baseline = {
    addresses: consent?.baseline ?? [],
    provenance: consent?.provenance ?? {},
  };
  const composeWith = (contacts) =>
    composePolicy({
      walletId,
      userId,
      baseline,
      contacts,
      grants: grantRows,
      ordinaryCapLamports: SOLANA_MAX_PER_TRANSFER_LAMPORTS,
      emptyComposition: state?.emptyComposition ?? "unproven",
      ruleComposition: "unproven",
    });

  const afterAddContacts = [
    ...contacts,
    { id: "00000000-0000-4000-8000-000000000001", version: 1, address: candidateAddress },
  ];

  const ownerSigners = {
    kind: "acquired",
    signers: out.ownerVerifiedListing.signers.map((signer) => ({
      signerId: signer.signerId,
      overridePolicyIds: signer.overridePolicyIds,
    })),
  };
  const ownership = {
    providerWalletId: target.providerWalletId,
    ownerVerifiedWallets: {
      kind: "acquired",
      walletIds: wallets.map((candidate) => candidate.id),
    },
  };

  const decide = (composedRules, provenance, remoteRules) =>
    comparePolicyReadback({
      phase: "pristine",
      expectedPolicyId: out.expectedPolicyId,
      composedRules,
      provenance,
      readback: { id: out.expectedPolicyId, rules: remoteRules },
      signer: { canonicalSignerId: target.providerSignerId, ownerVerifiedSigners: ownerSigners },
      appliedSignerIds: state?.appliedSignerIds ?? [],
      ownership,
    });

  try {
    const add = composeWith(afterAddContacts);
    out.prediction.afterAdd = {
      rules: add.rules,
      summary: summariseRules(add.rules),
      provenance: add.provenance,
      pristineDecision: decide(add.rules, add.provenance, out.remotePolicy?.normalisedRules ?? []),
    };

    // THE CONTROL. A composed set whose only difference from the live remote
    // readback is the provider-assigned per-rule `id`. If the comparator cannot
    // call even THIS converged, no pristine readback on this deployment can ever
    // reach `patch_required`, and the apply path cannot write anything.
    const noChange = composeWith(contacts);
    out.prediction.afterNoChange = {
      rules: noChange.rules,
      summary: summariseRules(noChange.rules),
      pristineDecision: decide(noChange.rules, noChange.provenance, out.remotePolicy?.normalisedRules ?? []),
      note: "Simulated baseline capture; the comparator input is the NORMALISED remote readback, exactly as the apply path builds it.",
    };

    // The REMOVAL is predicted against the state the ADD would leave behind:
    // the composed post-add rules ARE the remote rules once the add verified.
    const remove = composeWith(contacts);
    out.prediction.afterRemove = {
      rules: remove.rules,
      summary: summariseRules(remove.rules),
      provenance: remove.provenance,
      pristineDecision: decide(remove.rules, remove.provenance, add.rules),
    };
  } catch (error) {
    out.prediction.errorName = error?.constructor?.name ?? null;
    out.prediction.errorMessage =
      typeof error?.message === "string" ? error.message.slice(0, 200) : null;
  }

  console.log("RECIPIENT_READBACK=" + JSON.stringify(out, null, 2));
} catch (error) {
  console.log(
    "RECIPIENT_READBACK_FAILED=" +
      JSON.stringify(
        { ...out, error: error instanceof Error ? error.message : String(error) },
        null,
        2,
      ),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
