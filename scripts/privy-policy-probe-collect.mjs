/**
 * Live collection of the U2 and U3 unproven-provider-semantics probes (design §11).
 *
 * WHY THIS FILE EXISTS
 * --------------------
 * `src/wallet/policy/probe.ts` implements all four probes behind an injected
 * `PolicyProbeTransport`, and slice 2 shipped the production binding resolver and
 * evidence writer with it — but nothing ever supplied the transport to a live
 * deployment, so U1–U4 stayed `unproven` with no way to collect them. This is the
 * missing wiring, and nothing more: every provider call is delegated to the
 * existing production client (`PrivyServerClient`), every recorded byte goes
 * through the production repository, and the probe logic itself is unchanged.
 *
 * SCOPE — READ BEFORE RUNNING
 * ---------------------------
 * This run collects **U2** (`assertPolicyTargetCapability`) and **U3**
 * (`assertPolicyOwnership`) only. Both are READS. Neither writes a policy, moves
 * funds, detaches anything, or rewrites `user_wallets`.
 *
 * `createPolicy`/`patchPolicy`/`getPolicy` are wired so the transport satisfies its
 * declared port, but this script never calls them: U1 and U4 steps (i)/(ii) write
 * a policy and are out of scope here. `signAndSendTransfer` is deliberately
 * **absent**, so U1 and U4 step (iii) — the signed transfer — are structurally
 * impossible from this script. Those need a separately authorized wallet action.
 *
 * RECORDED EVIDENCE
 * -----------------
 * `status_detail.attachment_evidence` (U2) and `status_detail.ownership_evidence`
 * (U3) through `RecipientPolicyRepository.mergePolicyStatusDetail`, merged in place:
 * nothing else in `status_detail` is erased. The state row is created if the wallet
 * has none yet, exactly as `lockPolicyState` does for a first real mutation, and
 * the script says whether it had to.
 *
 * SECRET SAFETY
 * -------------
 * The script prints bounded ids, booleans and codes only. It never prints an
 * environment value, a token, a key, a payload or a signature, and it never reads
 * `.env` itself — it runs inside the backend container, which already holds the
 * provider credentials and reaches the signing sidecar on its own loopback.
 *
 * USAGE (inside the backend container, which mounts no `scripts/` volume, hence
 * the stdin form):
 *
 *   docker exec -i -e PROBE_USER_ID=<uuid> -e PROBE_WALLET_ID=<uuid> \
 *     nana-privy-impl-backend-1 node --input-type=module - \
 *     < scripts/privy-policy-probe-collect.mjs
 */
const userId = process.env.PROBE_USER_ID?.trim();
const walletId = process.env.PROBE_WALLET_ID?.trim();
if (!userId || !walletId) {
  console.error("BLOCKED: PROBE_USER_ID and PROBE_WALLET_ID are required.");
  process.exit(2);
}

const { createConfiguredDatabaseClient } = await import("/app/dist/db/client.js");
const { RecipientPolicyRepository } = await import("/app/dist/wallet/policy/repository.js");
const { readPrivyServerConfig } = await import("/app/dist/config/privy-server.js");
const { PrivyServerClient } = await import("/app/dist/wallet/privy-server-client.js");
const { createWorkerPayloadSigner } = await import("/app/dist/wallet/signer/client.js");
const {
  assertPolicyOwnership,
  assertPolicyTargetCapability,
  createPolicyProbeBindingResolver,
  createRepositoryProbeEvidenceWriter,
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

const transport = {
  canSignAuthorizations: () => privy.canSignAuthorizations(),
  // The OWNER-VERIFIED listing (design §0 C5, §11 U2): the app user id is resolved
  // to the Privy DID here and the listing is the SDK's user-filtered one. The
  // unfiltered `getWallet` is exposed for U3 only, which is where it is
  // characterising evidence rather than ownership evidence.
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
  // Deliberately absent: U1 and U4 step (iii) need a signed transfer, which needs
  // separate explicit user authorization. The probes record `unproven` without it.
};

const binding = createPolicyProbeBindingResolver(database);
const evidence = createRepositoryProbeEvidenceWriter({ userId, repository });

/** The policy id our own records say is attached to this wallet's canonical signer. */
async function recordedPolicyId() {
  const state = await repository.readPolicyState(userId, walletId);
  if (state?.appliedPolicyId) return { policyId: state.appliedPolicyId, source: "recipient_policy_state.applied_policy_id" };
  const result = await database.query(
    `SELECT provider_policy_id FROM signer_grants
      WHERE wallet_id = $1 AND state = 'active' AND provider_policy_id IS NOT NULL
      ORDER BY updated_at DESC LIMIT 1`,
    [walletId],
  );
  const row = result.rows[0];
  if (row?.provider_policy_id) {
    return { policyId: row.provider_policy_id, source: "signer_grants.provider_policy_id (newest active)" };
  }
  return { policyId: null, source: null };
}

const out = {
  walletId,
  userId,
  privyApiBaseUrlConfigured: typeof process.env.PRIVY_API_BASE_URL === "string",
  // Not a secret: the endpoint the production client actually resolved. Recording
  // it is what makes "live provider" checkable instead of asserted.
  resolvedProviderBaseUrl: privyConfig.baseUrl,
  signerConfigured: privy.canSignAuthorizations(),
};

try {
  // The evidence writer merges into an existing row (design §2.1: one row per
  // wallet). A wallet that has never had a recipient mutation has none yet, so
  // create it the way the first real mutation would — `lockPolicyState` — and say so.
  const before = await repository.readPolicyState(userId, walletId);
  if (!before) {
    await database.withUserTransaction(userId, (client) =>
      repository.lockPolicyState(userId, walletId, client),
    );
  }
  out.stateRowExisted = Boolean(before);
  out.stateRowCreatedByThisRun = !before;

  const recorded = await recordedPolicyId();
  out.policyIdSource = recorded.source;

  // ---- U2 — signer attachment asserted by the owner-verified readback ----
  out.u2 = await assertPolicyTargetCapability({
    userId,
    walletId,
    policyId: recorded.policyId ?? "00000000-0000-4000-8000-000000000000",
    transport,
    binding,
    evidence,
  });
  out.u2PolicyIdPassed = recorded.policyId;

  // ---- U3 — the ownership read ----
  out.u3 = await assertPolicyOwnership({ userId, walletId, transport, binding, evidence });

  // Read the recorded bytes back, so the evidence is the database's, not ours.
  const state = await repository.readPolicyState(userId, walletId);
  out.recordedStatusDetail = {
    attachment_evidence: state?.statusDetail?.attachment_evidence ?? null,
    ownership_evidence: state?.statusDetail?.ownership_evidence ?? null,
    status: state?.status ?? null,
  };

  console.log("PROBE_COLLECTION=" + JSON.stringify(out, null, 2));
} catch (error) {
  console.log(
    "PROBE_COLLECTION_FAILED=" +
      JSON.stringify({ ...out, error: error instanceof Error ? error.message : String(error) }, null, 2),
  );
  process.exitCode = 1;
} finally {
  await database.close();
}
