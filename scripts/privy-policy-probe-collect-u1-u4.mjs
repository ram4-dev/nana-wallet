/**
 * Live collection of the U1 and U4 unproven-provider-semantics probes (design §11).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `scripts/privy-policy-probe-collect.mjs` collected U2 (`assertPolicyTargetCapability`)
 * and U3 (`assertPolicyOwnership`) — both READS — and deliberately left U1 and U4
 * uncollected, because their steps (i)/(ii) write a policy. The user has now
 * explicitly authorized those policy writes, so this harness closes that half:
 * it runs the SAME shipped probe functions (`probeRuleComposition`,
 * `probeEmptyComposition`) against the deployed stack, with the SAME production
 * client, binding resolver and evidence writer the U2/U3 run used. No probe
 * logic is reimplemented here.
 *
 * SCOPE — READ BEFORE RUNNING
 * ---------------------------
 * This run creates and PATCHes **two standalone probe policies** in the real
 * Privy account:
 *
 *   - `"Solana policy composition probe"` (U1) — two ALLOW rules, one per address;
 *   - `"Solana empty policy probe"` (U4) — zero rules, PATCHed to zero.
 *
 * Neither is ever ATTACHED to the wallet, and the wallet's own policy is never
 * read-modify-written, detached, deleted or emptied: `PolicyProbeTransport` has
 * no detach/delete member at all, so that is structural rather than promised.
 *
 * KNOWN RESIDUE — STEP (III) IS NOT RUN, AND THAT IS DELIBERATE
 * -------------------------------------------------------------
 * U1 and U4's step (iii) is a signed `signAndSendTransaction` evaluated under the
 * PROBE policy. That step is NOT implemented here, so both probes record
 * `unproven` with the complete (i)/(ii) evidence attached:
 *
 *   - U1 -> `rules_union: "unproven"`, `reason: "signed_transfer_unavailable"`;
 *   - U4 -> `empty_composition: "unproven"`, `reason: "signed_denial_unobserved"`.
 *
 * The reason is a verified capability gap, not caution. The installed provider
 * SDK (`@privy-io/node` 0.34.0) offers NO way to select which policy a wallet RPC
 * is evaluated against: `AuthorizationContext` carries signing material only
 * (`authorization_private_keys`, `user_jwts`, `signatures`, `sign_fns`) and
 * `SolanaSignAndSendTransactionRpcInput` accepts `caip2`, `params`, `address`,
 * `optimistic_broadcast`, `reference_id`, `sponsor`, `sponsor_options` and
 * `wallet_id` — no policy field anywhere on the send path. Privy enforces at most
 * ONE policy per wallet (`policy_ids`) and at most one override per additional
 * signer (`override_policy_ids`). So a signed send from this process could be
 * evaluated under exactly two policies: the wallet's ATTACHED policy — the
 * explicit prohibition, and a wrong U1/U4 observation — or a probe policy
 * attached to the wallet, which would displace the user's real policy on a stack
 * a user is actively testing against. Neither is acceptable, so the honest
 * `unproven` is recorded instead of an approximation. Close it by implementing
 * the step against a policy-selection seam the provider actually offers.
 *
 * RECORDED EVIDENCE
 * -----------------
 * `status_detail.rules_union` / `.rules_union_evidence` (U1),
 * `status_detail.empty_composition_evidence` and the `empty_composition` column
 * (U4), merged in place by `createRepositoryProbeEvidenceWriter` — so U2's
 * `attachment_evidence` and U3's `ownership_evidence` are preserved, and this
 * run reads all four back to prove it.
 *
 * SECRET SAFETY
 * -------------
 * Bounded ids, booleans, codes and public devnet addresses only. No environment
 * value, token, key, payload or signature is ever printed, and `.env` is never
 * read: the script runs inside the backend container, which already holds its
 * own credentials and reaches the signing sidecar on its own loopback.
 *
 * USAGE (inside the backend container, which mounts no `scripts/` volume, hence
 * the stdin form):
 *
 *   docker exec -i \
 *     -e PROBE_USER_ID=<uuid> -e PROBE_WALLET_ID=<uuid> \
 *     nana-privy-impl-backend-1 node --input-type=module - \
 *     < scripts/privy-policy-probe-collect-u1-u4.mjs
 */
const userId = process.env.PROBE_USER_ID?.trim();
const walletId = process.env.PROBE_WALLET_ID?.trim();
if (!userId || !walletId) {
  console.error("BLOCKED: PROBE_USER_ID and PROBE_WALLET_ID are required.");
  process.exit(2);
}

/**
 * Public devnet addresses, never secrets. `ordinaryAddress` is covered by U1's
 * FIRST rule, `grantAddress` by its SECOND (disjoint), and `uncoveredAddress` by
 * nothing at all, which is what U4's empty policy must refuse.
 */
const ordinaryAddress =
  process.env.PROBE_ORDINARY_ADDRESS?.trim() ||
  "DFYT4RDcvr6vL46c7iVDmfBbEYQxAZhUxkgvwzuVHMEk";
const grantAddress =
  process.env.PROBE_GRANT_ADDRESS?.trim() ||
  "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";
const uncoveredAddress =
  process.env.PROBE_UNCOVERED_ADDRESS?.trim() ||
  "3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2";

const { createConfiguredDatabaseClient } = await import("/app/dist/db/client.js");
const { RecipientPolicyRepository } = await import("/app/dist/wallet/policy/repository.js");
const { readPrivyServerConfig } = await import("/app/dist/config/privy-server.js");
const { PrivyServerClient } = await import("/app/dist/wallet/privy-server-client.js");
const { createWorkerPayloadSigner } = await import("/app/dist/wallet/signer/client.js");
const {
  createPolicyProbeBindingResolver,
  createRepositoryProbeEvidenceWriter,
  probeEmptyComposition,
  probeRuleComposition,
} = await import("/app/dist/wallet/policy/probe.js");

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

/** The app identity -> Privy DID resolution the owner-verified listing requires. */
async function privyDidOf(id) {
  const result = await database.query("SELECT privy_did FROM users WHERE id = $1", [id]);
  const row = result.rows[0];
  if (!row?.privy_did) throw new Error("no privy_did for this user");
  return row.privy_did;
}

/** Maps a production wallet record onto the reduced probe shape. No new provider logic. */
function toProbeWallet(record) {
  const signers = Array.isArray(record.additional_signers) ? record.additional_signers : [];
  return {
    id: record.id,
    ownerId: typeof record.owner_id === "string" ? record.owner_id : null,
    policyIds: Array.isArray(record.policy_ids) ? record.policy_ids : [],
    signers: signers.map((signer) => ({
      signerId: signer.signer_id,
      policyIds: Array.isArray(signer.override_policy_ids) ? signer.override_policy_ids : [],
    })),
  };
}

/**
 * The probe transport. It carries the three policy members U1/U4 steps (i)/(ii)
 * need and NOTHING that could move funds, select a policy for a wallet RPC, or
 * detach a policy: the absent member below is what makes `proven_deny`,
 * `union` and an inferred permit unreachable from this script.
 */
const transport = {
  canSignAuthorizations: () => privy.canSignAuthorizations(),
  listOwnerWallets: async (id, chain) => {
    const did = await privyDidOf(id);
    const records = await privy.listWalletsForChain(did, chain);
    return records.map(toProbeWallet);
  },
  getWallet: async (id) => toProbeWallet(await privy.getWallet(id)),
  createPolicy: async (name, rules) => {
    const created = await privy.createPolicy(name, rules, { chainType: "solana" });
    return { id: created.id, rules };
  },
  patchPolicy: async (policyId, rules) => {
    await privy.patchPolicy(policyId, rules);
    return { id: policyId, rules };
  },
  getPolicy: async (policyId) => {
    const record = await privy.getPolicy(policyId);
    return { id: record.id, rules: record.rules ?? [] };
  },
  // Step (iii) is deliberately not wired: the provider exposes no policy
  // selection on the send path (see the header), so the probes record
  // `unproven` with the (i)/(ii) evidence instead of an inferred outcome.
};

const binding = createPolicyProbeBindingResolver(database);
const evidence = createRepositoryProbeEvidenceWriter({ userId, repository });

const out = {
  walletId,
  userId,
  privyApiBaseUrlConfigured: typeof process.env.PRIVY_API_BASE_URL === "string",
  resolvedProviderBaseUrl: privyConfig.baseUrl,
  signerConfigured: privy.canSignAuthorizations(),
  addresses: {
    ordinaryAddress,
    grantAddress,
    uncoveredAddress,
    grantAndUncoveredAreSameAddress: grantAddress === uncoveredAddress,
  },
  stepIIIAttempted: false,
};

try {
  const before = await repository.readPolicyState(userId, walletId);

  // ---- U1 — two ALLOW rules coexisting in ONE policy ----
  out.u1 = await probeRuleComposition({
    transport,
    evidence,
    walletId,
    ordinaryAddress,
    grantAddress,
  });

  // ---- U4 — an empty composed policy must DENY ----
  out.u4 = await probeEmptyComposition({
    transport,
    evidence,
    walletId,
    uncoveredAddress,
  });

  // Read the recorded bytes back, so the evidence is the database's, not ours.
  // The four keys must COEXIST: this run must not have erased U2's or U3's.
  const state = await repository.readPolicyState(userId, walletId);
  const detail = state?.statusDetail ?? {};
  out.recordedStatusDetail = {
    rules_union: detail.rules_union ?? null,
    rules_union_evidence: detail.rules_union_evidence ?? null,
    empty_composition_evidence: detail.empty_composition_evidence ?? null,
    attachment_evidence: detail.attachment_evidence ?? null,
    ownership_evidence: detail.ownership_evidence ?? null,
    empty_composition: state?.emptyComposition ?? null,
    status: state?.status ?? null,
  };
  out.evidenceCoexistence = {
    u1Recorded: Boolean(detail.rules_union_evidence),
    u2Preserved: Boolean(detail.attachment_evidence),
    u3Preserved: Boolean(detail.ownership_evidence),
    u4Recorded: Boolean(detail.empty_composition_evidence),
  };
  out.probePolicyIds = {
    u1: out.u1?.evidence?.probePolicyId ?? null,
    u4: out.u4?.evidence?.createdPolicyId ?? null,
  };
  out.stateRowExisted = Boolean(before);

  console.log("PROBE_COLLECTION_U1U4=" + JSON.stringify(out, null, 2));
} catch (error) {
  console.log(
    "PROBE_COLLECTION_U1U4_FAILED=" +
      JSON.stringify({ ...out, error: error instanceof Error ? error.message : String(error) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
