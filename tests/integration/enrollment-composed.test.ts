/**
 * Task 1.8 (deliverables 2 and 3) — enrollment routes through the single
 * composer, and completion is verified against the APPLIED revision.
 *
 * WHY THIS SUITE EXISTS
 * ---------------------
 * The legacy `preparePermission` created a Solana policy directly
 * (`privyServer.createPolicy`) and attached it, then `completePermission`
 * activated the grant on the strength of the pending row's stored policy id.
 * Removing that direct writer is the dangerous half of this unit: if enrollment
 * can no longer obtain a policy AND still reports success, the result is a
 * permission with NOTHING attached — unrestricted authority, which the spec
 * forbids ever detaching to.
 *
 * The three properties below are the structural guard against that:
 *
 *   1. **No independent policy creator.** Enrollment records the durable
 *      `origin='enrollment'` intent through the composer and issues no provider
 *      policy write of its own.
 *   2. **A pending row cannot activate against a foreign applied revision.** The
 *      stored id is no longer the authority; `recipient_policy_state` is.
 *   3. **Fail visible.** A caller that used to obtain a policy and now cannot
 *      REJECTS with a typed `blocked_configuration` result — it can never report
 *      a permission as ready while no policy is attached.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { EmbeddedWalletService } from "../../src/wallet/embedded.js";
import { createPrivyWalletApiClient } from "../../src/wallet/privy-client.js";
import {
  PrivyServerClient,
  type PrivySdkClient,
  type PrivySdkWallets,
  type PrivyWalletPage,
  type PrivyWalletRecord,
  type PrivyWalletSigner,
} from "../../src/wallet/privy-server-client.js";
import {
  PolicyCompositionRefusalError,
  RecipientPolicyService,
  createUnavailablePolicyApplyPort,
  type RecipientContactMutationPort,
} from "../../src/wallet/policy/service.js";
import { RecipientPolicyRepository } from "../../src/wallet/policy/repository.js";
import {
  composedRulesHash,
  type GrantPolicyRule,
} from "../../src/wallet/policy/composer.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APP_ID = "test-enroll-app";
const APP_SECRET = "test-enroll-secret";
const SOL_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/** The one ordinary allowance rule, mirroring the enrollment rule builder. */
const APPLIED_RULES: GrantPolicyRule[] = [
  {
    name: "Solana transfer allowlist",
    method: "signAndSendTransaction",
    action: "ALLOW",
    conditions: [],
  },
];

/**
 * No contact mutation can route through the enrollment composer: composition
 * reads contacts through the repository. A refusal keeps the seam honest if a
 * future caller wires it here by mistake.
 */
const refusingContacts: RecipientContactMutationPort = {
  create: () => {
    throw new Error("enrollment composition must not mutate contacts");
  },
  update: () => {
    throw new Error("enrollment composition must not mutate contacts");
  },
  archive: () => {
    throw new Error("enrollment composition must not mutate contacts");
  },
  readActive: () => {
    throw new Error("enrollment composition must not mutate contacts");
  },
};

function listPage(records: readonly PrivyWalletRecord[]): PrivyWalletPage {
  return {
    data: [...records],
    hasNextPage: () => false,
    getNextPage: async () => listPage([]),
  };
}

function solanaWallet(
  id: string,
  signers: PrivyWalletSigner[],
): PrivyWalletRecord {
  return {
    id,
    address: SOL_RECIPIENT,
    chain_type: "solana",
    policy_ids: [],
    owner_id: "owner-key-quorum",
    additional_signers: signers,
    archived_at: null,
  };
}

/**
 * A Privy server client backed by an injected fake SDK client. The provider
 * policy surface is instrumented so "no independent policy write" is asserted
 * on calls that WOULD have been recorded — not on an unreachable stub.
 */
function mockServerClient(records: PrivyWalletRecord[], policyRules: unknown[]) {
  const list = async () => listPage(records);
  const unused = async () => {
    throw new Error("unused SDK surface");
  };
  const createPolicy = vi.fn(async () => ({ id: "pol_independent" }));
  const getPolicy = vi.fn(async (id: string) => ({ id, rules: policyRules }));
  const patchPolicy = vi.fn(async () => ({ id: "pol_independent" }));
  const addPolicyToSigner = vi.fn(async () => undefined);
  const wallets: PrivySdkWallets = { list, get: unused, update: unused };
  const client = new PrivyServerClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    client: {
      wallets: () => wallets,
      policies: () => ({
        create: createPolicy,
        get: getPolicy,
        update: patchPolicy,
      }),
    } as unknown as PrivySdkClient,
  });
  return { client, createPolicy, getPolicy, patchPolicy, addPolicyToSigner };
}

suite("enrollment composes through the single service (task 1.8)", () => {
  let database: DatabaseClient;
  const previousEnv = { ...process.env };

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    process.env.PRIVY_APP_ID = APP_ID;
    process.env.PRIVY_APP_SECRET = APP_SECRET;
    process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = "key-quorum-1";
  });

  afterAll(async () => {
    await database.close();
    for (const key of ["PRIVY_APP_ID", "PRIVY_APP_SECRET", "PRIVY_AUTHORIZATION_KEY_QUORUM_ID"]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  async function provisionUser(did: string): Promise<string> {
    const result = await database.query<{ id: string }>(
      "SELECT users_ensure_for_privy_did($1, $2) AS id",
      [did, did],
    );
    return result.rows[0]!.id;
  }

  async function insertReadySolanaWallet(
    userId: string,
    providerWalletId: string,
  ): Promise<string> {
    const result = await database.query<{ id: string }>(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, 'privy', $2, 'solana', $3, 'ready', now())
       RETURNING id`,
      [userId, providerWalletId, SOL_RECIPIENT],
    );
    return result.rows[0]!.id;
  }

  /**
   * The recorded enrollment consent the composer composes the ordinary rule
   * from. Inserted directly so the composition SUCCEEDS and the only observable
   * left is what enrollment does with the composed revision.
   */
  async function insertConsentState(userId: string, walletId: string): Promise<void> {
    await database.query(
      `INSERT INTO recipient_policy_state (wallet_id, user_id, consent_baseline)
       VALUES ($1, $2, $3::jsonb)`,
      [walletId, userId, JSON.stringify([SOL_RECIPIENT])],
    );
  }

  /** The real composer service, wired with the slice-1 unavailable apply port. */
  function composerService(): RecipientPolicyService {
    return new RecipientPolicyService({
      database,
      repository: new RecipientPolicyRepository(database),
      contacts: refusingContacts,
      listActiveGrants: async () => [],
      provider: createUnavailablePolicyApplyPort(
        "provider_unavailable: no signed apply capability in this deployment.",
      ),
    });
  }

  function service(
    client: PrivyServerClient,
    composer?: RecipientPolicyService,
  ): EmbeddedWalletService {
    return new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
      composer,
    );
  }

  it("records the enrollment intent through the service and creates no independent policy", async () => {
    const did = `did:privy:enroll-composed-${randomUUID()}`;
    const userId = await provisionUser(did);
    const providerWalletId = `provider-wallet-${randomUUID()}`;
    const localWalletId = await insertReadySolanaWallet(userId, providerWalletId);
    await insertConsentState(userId, localWalletId);

    const surface = mockServerClient(
      [solanaWallet(providerWalletId, [{ signer_id: "pre-auth-signer", override_policy_ids: [] }])],
      [],
    );

    const outcome = await service(surface.client, composerService())
      .preparePermission(userId, [SOL_RECIPIENT])
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );

    // POSITIVE CONTROL: the composer ran and recorded the enrollment intent, so
    // the refusal below is the composer's successor and not an early bail.
    const intent = await database.query<{
      origin: string;
      composed_hash: string;
      composed_rules: unknown;
    }>(
      "SELECT origin, composed_hash, composed_rules FROM recipient_policy_sync_intent WHERE user_id = $1",
      [userId],
    );
    expect(intent.rows).toHaveLength(1);
    expect(intent.rows[0]?.origin).toBe("enrollment");
    // The intent carries the EXACT composed rules, i.e. the composition really
    // happened instead of the code stopping before it.
    expect(Array.isArray(intent.rows[0]?.composed_rules)).toBe(true);
    expect(JSON.stringify(intent.rows[0]?.composed_rules)).toContain(
      SOL_RECIPIENT,
    );
    expect(intent.rows[0]?.composed_hash).toMatch(/^sha256:/u);

    // FAIL VISIBLE: the typed configuration stop, never a resolved enrollment.
    expect(outcome.kind).toBe("rejected");
    const refusal = (outcome as { error: PolicyCompositionRefusalError }).error;
    expect(refusal).toBeInstanceOf(PolicyCompositionRefusalError);
    expect(refusal.failureClass).toBe("blocked_configuration");
    // Task 2.8 DELETED `apply_capability_unwired`; the enrollment path now RUNS
    // the apply orchestration and stops on what the deployment recorded, which
    // here is the unavailable capability's own reason.
    expect(refusal.reason).toBe("provider_unavailable");

    // NO INDEPENDENT POLICY CREATOR: the provider policy surface was reachable
    // and was not used.
    expect(surface.createPolicy).not.toHaveBeenCalled();
    expect(surface.patchPolicy).not.toHaveBeenCalled();
    const pending = await database.query<{ state: string; provider_policy_id: string | null }>(
      "SELECT state, provider_policy_id FROM signer_grants WHERE user_id = $1",
      [userId],
    );
    expect(pending.rows[0]).toEqual({ state: "pending", provider_policy_id: null });
  });

  it("cannot activate a permission from a pending row whose id is not the applied revision", async () => {
    const did = `did:privy:enroll-stale-${randomUUID()}`;
    const userId = await provisionUser(did);
    const providerWalletId = `provider-wallet-${randomUUID()}`;
    const localWalletId = await insertReadySolanaWallet(userId, providerWalletId);

    // The pending row stores the OLD id; the applied revision is a DIFFERENT one.
    await database.query(
      `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, policy_hash, allowlisted_recipients,
          per_transfer_atomic6, per_transfer_lamports, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state)
       VALUES ($1, $2, 'pol_stale', 'hash', $3::jsonb, '10000000', '10000000', '50000000', 3600, '0.01', 'pending')`,
      [userId, localWalletId, JSON.stringify([SOL_RECIPIENT])],
    );
    await database.query(
      `INSERT INTO recipient_policy_state
         (wallet_id, user_id, desired_revision, applied_revision, applied_policy_id,
          applied_rules_hash, applied_signer_id, status, verified_at)
       VALUES ($1, $2, 1, 1, 'pol_applied', $3, 'signer-verified', 'applied', now())`,
      [localWalletId, userId, composedRulesHash(APPLIED_RULES)],
    );

    // The signer carries the STALE id the pending row stored, not the applied one.
    const surface = mockServerClient(
      [
        solanaWallet(providerWalletId, [
          { signer_id: "canonical-signer", override_policy_ids: ["pol_stale"] },
        ]),
      ],
      APPLIED_RULES,
    );
    await database.query(
      "UPDATE user_wallets SET provider_signer_id = 'canonical-signer' WHERE id = $1",
      [localWalletId],
    );

    const result = await service(surface.client).completePermission(
      userId,
      localWalletId,
    );

    // Negative: the stale id cannot activate, and nothing is bound.
    expect(result.verified).toBe(false);
    const binding = await database.query<{ provider_signer_id: string | null }>(
      "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
      [localWalletId],
    );
    expect(binding.rows[0]?.provider_signer_id).toBe("canonical-signer");
    const grant = await database.query<{ state: string }>(
      "SELECT state FROM signer_grants WHERE wallet_id = $1",
      [localWalletId],
    );
    expect(grant.rows[0]?.state).toBe("pending");
  });

  it("fails visibly instead of reporting an enrollment with no policy attached", async () => {
    const did = `did:privy:enroll-fail-visible-${randomUUID()}`;
    const userId = await provisionUser(did);
    const providerWalletId = `provider-wallet-${randomUUID()}`;
    const localWalletId = await insertReadySolanaWallet(userId, providerWalletId);
    await insertConsentState(userId, localWalletId);

    const surface = mockServerClient(
      [solanaWallet(providerWalletId, [{ signer_id: "pre-auth-signer", override_policy_ids: [] }])],
      [],
    );

    // The structural guard: a future edit that lets enrollment REPORT SUCCESS
    // while no policy is attached turns this red, because the call can no longer
    // resolve.
    await expect(
      service(surface.client, composerService()).preparePermission(userId, [
        SOL_RECIPIENT,
      ]),
    ).rejects.toBeInstanceOf(PolicyCompositionRefusalError);

    // And no policy is attached anywhere for this wallet.
    expect(surface.createPolicy).not.toHaveBeenCalled();
    expect(surface.addPolicyToSigner).not.toHaveBeenCalled();
    const pending = await database.query<{ provider_policy_id: string | null }>(
      "SELECT provider_policy_id FROM signer_grants WHERE user_id = $1",
      [userId],
    );
    expect(pending.rows[0]?.provider_policy_id).toBeNull();
  });
});
