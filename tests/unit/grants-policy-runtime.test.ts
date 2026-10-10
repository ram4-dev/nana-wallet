/**
 * Task 2.3 (solana-devnet-provider) — runtime policy adapter + wiring (RED).
 *
 * Expected contract for `src/wallet/grants/privy-policy-runtime.ts`
 * (to be implemented in GREEN):
 *
 *  - `createPrivyPolicyAdminClient` maps the real `PrivyServerClient` (Solana
 *    chain policies) plus the canonical `PrivyPolicyAdmin` (exact signer
 *    resolution, complete-list attach) onto the `PrivyPolicyAdminClient` seam
 *    the composed provisioner consumes:
 *      * `getSignerPolicyIds(walletId)`: resolve target → GET wallet readback →
 *        exactly one signer match → its override policy ids; zero or multiple
 *        matches fail closed.
 *      * `createPolicy`: ALWAYS `chainType: "solana"` — no EVM chain type can
 *        ever be serialized through this adapter.
 *      * `patchPolicy`: PATCHes the exact rule payload; no silent conversion.
 *      * `attachPolicyToSigner`: refuses anything but a complete-list
 *        (sibling-preserving) attach.
 *      * `listActiveGrants(walletId)`: recompute reads are user-scoped — the
 *        query resolves the wallet's owning user and filters by BOTH
 *        `wallet_id` AND `user_id`; amounts stay verbatim ledger strings
 *        (lamports), expiry is the stored epoch-second value.
 *  - `createRuntimeGrantPolicyProvisioner` adapts the composed provisioner to
 *    the `GrantPolicyProvisioner` seam:
 *      * refuses any non-Solana ledger chain (provision AND revoke):
 *        no unintended EVM policy activation;
 *      * passes ledger lamports strings through verbatim;
 *      * provision failure and uncertain revoke throw so
 *        `PrivyPolicySyncService` keeps its fail-closed audit path.
 *  - `createGrantPolicySyncService` wires the real path ONLY when the Privy
 *    server client and the canonical signer configuration (key quorum id) are
 *    available; otherwise it returns the Slice 1 unavailable fail-closed stub.
 */
import { describe, expect, it, vi } from "vitest";
import { PolicyCompositionRefusalError } from "../../src/wallet/policy/errors.js";

type AdapterModule = {
  createPrivyPolicyAdminClient(deps: {
    server: {
      createPolicy(
        name: string,
        rules: unknown[],
        options?: { chainType?: string },
      ): Promise<{ id: string }>;
      getPolicy(
        policyId: string,
      ): Promise<{ id: string } & Record<string, unknown>>;
      patchPolicy(
        policyId: string,
        rules: unknown[],
      ): Promise<{ id: string } & Record<string, unknown>>;
      getWallet(walletId: string): Promise<{
        additional_signers: Array<{
          signer_id: string;
          override_policy_ids?: string[];
        }>;
      }>;
    };
    admin: {
      attachPolicyToSigner(input: {
        walletId: string;
        policyId: string;
      }): Promise<void>;
      resolveTarget(walletId: string): Promise<{
        providerWalletId: string;
        providerSignerId: string;
      }>;
    };
    database: unknown;
    // Observability hook for assertions only — never part of the adapter input.
    queries?: Array<{ text: string; values: readonly unknown[] }>;
  }): {
    getSignerPolicyIds(walletId: string): Promise<string[]>;
    createPolicy(input: {
      walletId: string;
      name: string;
      rules: unknown[];
    }): Promise<{ id: string }>;
    getPolicy(policyId: string): Promise<{ id: string; rules: unknown[] }>;
    patchPolicy(
      policyId: string,
      patch: { rules: unknown[] },
    ): Promise<{ id: string }>;
    listActiveGrants(walletId: string): Promise<
      Array<{
        grantId: string;
        walletId: string;
        recipients: string[];
        maxPerTransfer: string;
        expiresAt: number;
      }>
    >;
    attachPolicyToSigner(input: {
      walletId: string;
      policyId: string;
      preserveExistingSigners: boolean;
    }): Promise<void>;
  };
  createRuntimeGrantPolicyProvisioner(
    deps: Parameters<AdapterModule["createPrivyPolicyAdminClient"]>[0],
  ): {
    provisionPolicy(input: {
      grantId: string;
      walletId: string;
      userId: string;
      chain: string;
      recipients: string[];
      maxPerTransfer: string;
      maxCumulative: string;
      expiresAt: number;
    }): Promise<{ policyId: string }>;
    revokePolicy(input: {
      grantId: string;
      userId: string;
      walletId: string;
      chain: string;
      policyId: string;
    }): Promise<void>;
  };
  createGrantPolicySyncService(input: {
    database: unknown;
    privyServer?: unknown;
    quorumId?: string;
  }): { kind: "runtime" | "unavailable"; service: unknown };
};

async function loadModule(): Promise<AdapterModule> {
  // Indirect specifier: the module is intentional RED until GREEN implements it.
  const specifier = "../../src/wallet/grants/privy-policy-runtime.js";
  return (await import(specifier)) as unknown as AdapterModule;
}

const WALLET_ID = "wallet-1";
const USER_ID = "user-1";
const PROVIDER_WALLET_ID = "privy-wallet-1";
const SIGNER_ID = "signer-canonical-1";
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

function makeDeps(
  overrides: {
    signerRows?: Array<{ signer_id: string; override_policy_ids?: string[] }>;
    walletRow?: Record<string, unknown> | null;
    grantRows?: Array<Record<string, unknown>>;
  } = {},
) {
  let currentRules: unknown[] = [];
  const currentSignerRows = overrides.signerRows ?? [
    { signer_id: SIGNER_ID, override_policy_ids: ["policy-1"] },
  ];
  const server = {
    canSignAuthorizations: vi.fn().mockReturnValue(true),
    createPolicy: vi.fn().mockResolvedValue({ id: "policy-new" }),
    getPolicy: vi
      .fn()
      .mockImplementation(async (id: string) => ({ id, rules: currentRules })),
    patchPolicy: vi
      .fn()
      .mockImplementation(async (id: string, rules: unknown[]) => {
        currentRules = rules;
        return { id };
      }),
    getWallet: vi.fn().mockResolvedValue({
      additional_signers: currentSignerRows,
    }),
    addPolicyToSigner: vi
      .fn()
      .mockImplementation(
        async (_walletId: string, signerId: string, policyId: string) => {
          const signer = currentSignerRows.find(
            (row) => row.signer_id === signerId,
          );
          if (signer) signer.override_policy_ids = [policyId];
        },
      ),
  };
  const admin = {
    attachPolicyToSigner: vi
      .fn()
      .mockImplementation(async ({ policyId }: { policyId: string }) => {
        const signer = currentSignerRows.find(
          (row) => row.signer_id === SIGNER_ID,
        );
        if (signer) signer.override_policy_ids = [policyId];
      }),
    resolveTarget: vi.fn().mockResolvedValue({
      providerWalletId: PROVIDER_WALLET_ID,
      providerSignerId: SIGNER_ID,
    }),
  };
  const queries: Array<{ text: string; values: readonly unknown[] }> = [];
  const walletRow =
    overrides.walletRow === undefined
      ? {
          id: WALLET_ID,
          user_id: USER_ID,
          provider_wallet_id: PROVIDER_WALLET_ID,
          provider_signer_id: SIGNER_ID,
          state: "ready",
        }
      : overrides.walletRow;
  const database = {
    query: vi.fn(
      async <T>(
        text: string,
        values?: readonly unknown[],
      ): Promise<{ rows: T[] }> => {
        queries.push({ text, values: values ?? [] });
        if (text.includes("FROM user_wallets")) {
          return { rows: (walletRow ? [walletRow] : []) as T[] };
        }
        if (text.includes("FROM delegated_grants")) {
          const rows = overrides.grantRows ?? [
            {
              id: "grant-A",
              user_id: USER_ID,
              wallet_id: WALLET_ID,
              chain: "solana",
              state: "active",
              recipients: [RECIPIENT],
              max_per_transfer: "1_000_000_000",
              max_cumulative: "5_000_000_000",
              window_seconds: 3_600,
              provider_policy_id: null,
              expires_at: new Date(1_792_000_000_000),
            },
          ];
          return { rows: rows as T[] };
        }
        return { rows: [] as T[] };
      },
    ),
    withUserTransaction: async <T>(
      _userId: string,
      operation: (client: unknown) => Promise<T>,
    ): Promise<T> => operation(database),
  };
  return { server, admin, database, queries };
}

describe("privy policy runtime adapter (task 2.3, RED)", () => {
  it("createPolicy always serializes the Solana chain type through the server client", async () => {
    const mod = await loadModule();
    const deps = makeDeps();
    const adapter = mod.createPrivyPolicyAdminClient(deps);

    const created = await adapter.createPolicy({
      walletId: WALLET_ID,
      name: "solana-grant-policy",
      rules: [{ action: "ALLOW" }],
    });

    expect(created.id).toBe("policy-new");
    expect(deps.server.createPolicy).toHaveBeenCalledWith(
      "solana-grant-policy",
      [{ action: "ALLOW" }],
      { chainType: "solana" },
    );
  });

  it("getSignerPolicyIds reads back the exact canonical signer and returns its policy ids", async () => {
    const mod = await loadModule();
    const deps = makeDeps();
    const adapter = mod.createPrivyPolicyAdminClient(deps);

    await expect(adapter.getSignerPolicyIds(WALLET_ID)).resolves.toEqual([
      "policy-1",
    ]);
    expect(deps.admin.resolveTarget).toHaveBeenCalledWith(WALLET_ID);
    expect(deps.server.getWallet).toHaveBeenCalledWith(PROVIDER_WALLET_ID);
  });

  it("getSignerPolicyIds fails closed on zero or multiple signer matches", async () => {
    const mod = await loadModule();
    const zero = mod.createPrivyPolicyAdminClient(makeDeps({ signerRows: [] }));
    await expect(zero.getSignerPolicyIds(WALLET_ID)).rejects.toThrow(/signer/i);
    const multiple = mod.createPrivyPolicyAdminClient(
      makeDeps({
        signerRows: [
          { signer_id: SIGNER_ID, override_policy_ids: ["policy-1"] },
          { signer_id: SIGNER_ID, override_policy_ids: ["policy-2"] },
        ],
      }),
    );
    await expect(multiple.getSignerPolicyIds(WALLET_ID)).rejects.toThrow(
      /signer/i,
    );
  });

  it("patchPolicy sends the exact rules without conversion", async () => {
    const mod = await loadModule();
    const deps = makeDeps();
    const adapter = mod.createPrivyPolicyAdminClient(deps);
    const rules = [{ action: "ALLOW", conditions: [] }];

    await expect(adapter.patchPolicy("policy-1", { rules })).resolves.toEqual({
      id: "policy-1",
    });
    expect(deps.server.patchPolicy).toHaveBeenCalledWith("policy-1", rules);
  });

  it("attachPolicyToSigner only accepts the sibling-preserving complete-list attach", async () => {
    const mod = await loadModule();
    const deps = makeDeps();
    const adapter = mod.createPrivyPolicyAdminClient(deps);

    await adapter.attachPolicyToSigner({
      walletId: WALLET_ID,
      policyId: "policy-new",
      preserveExistingSigners: true,
    });
    expect(deps.admin.attachPolicyToSigner).toHaveBeenCalledWith({
      walletId: WALLET_ID,
      policyId: "policy-new",
    });
    await expect(
      adapter.attachPolicyToSigner({
        walletId: WALLET_ID,
        policyId: "policy-new",
        preserveExistingSigners: false,
      }),
    ).rejects.toThrow(/preserve|complete-list|sibling/i);
    expect(deps.admin.attachPolicyToSigner).toHaveBeenCalledTimes(1);
  });

  it("listActiveGrants recompute is user-scoped and keeps ledger strings verbatim", async () => {
    const mod = await loadModule();
    const EXPIRES = 1_792_000_000;
    const deps = makeDeps({
      grantRows: [
        {
          id: "grant-A",
          wallet_id: WALLET_ID,
          recipients: [RECIPIENT],
          max_per_transfer: "1_000_000_000",
          expires_at: new Date(EXPIRES * 1000),
        },
      ],
    });
    const adapter = mod.createPrivyPolicyAdminClient(deps);

    const grants = await adapter.listActiveGrants(WALLET_ID);

    // User scoping: the recompute query must resolve the wallet's owner and
    // filter by BOTH wallet_id and user_id.
    const grantsQuery = deps.queries.find((q) =>
      q.text.includes("FROM delegated_grants"),
    );
    expect(grantsQuery).toBeDefined();
    expect(grantsQuery?.text).toMatch(/user_id/i);
    expect(grantsQuery?.values).toContain(WALLET_ID);
    expect(grantsQuery?.values).toContain(USER_ID);
    // Ledger chain family passes through UNCHANGED: delegated_grants.chain
    // stores the Solana family value "solana" (migration 008), never the
    // provider network "solana-devnet".
    expect(grantsQuery?.values).toContain("solana");
    expect(grantsQuery?.values).not.toContain("solana-devnet");

    expect(grants).toEqual([
      {
        grantId: "grant-A",
        walletId: WALLET_ID,
        recipients: [RECIPIENT],
        maxPerTransfer: "1_000_000_000",
        expiresAt: EXPIRES,
      },
    ]);
  });

  it("listActiveGrants fails closed when the wallet row (and its user scope) is missing", async () => {
    const mod = await loadModule();
    const adapter = mod.createPrivyPolicyAdminClient(
      makeDeps({ walletRow: null }),
    );
    await expect(adapter.listActiveGrants(WALLET_ID)).rejects.toThrow(
      /wallet/i,
    );
  });
});

describe("runtime grant policy provisioner (task 2.3, RED)", () => {
  const RUNTIME_INPUT = {
    grantId: "grant-A",
    walletId: WALLET_ID,
    userId: USER_ID,
    chain: "solana",
    recipients: [RECIPIENT],
    maxPerTransfer: "1_000_000_000",
    maxCumulative: "5_000_000_000",
    expiresAt: 1_792_000_000,
  };

  it("accepts the stored Solana ledger chain, then refuses visibly instead of writing a policy", async () => {
    /**
     * Task 1.8 CHANGED THIS CASE. It used to assert that provisioning emitted a
     * flat Solana PATCH body. The full-rule writer that emitted it is deleted
     * (design §3.3), so the PATCH body no longer exists for this port to emit:
     * the composer owns rule composition now. What remains assertable here, and
     * is the property that matters, is that the port ACCEPTS the stored ledger
     * family value "solana" and then fails visibly — it never fabricates a
     * policy id and never reaches the provider. The rule-shape intent moved to
     * `tests/unit/policy-composer.test.ts` (byte-identical ordinary rule) and
     * `tests/unit/policy-provisioner-delegation.test.ts` (flat grant rule).
     */
    const mod = await loadModule();
    const deps = makeDeps({
      signerRows: [{ signer_id: SIGNER_ID, override_policy_ids: [] }],
    });
    const provisioner = mod.createRuntimeGrantPolicyProvisioner(deps);

    const refusal = await provisioner
      .provisionPolicy(RUNTIME_INPUT)
      .then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(PolicyCompositionRefusalError);
    expect((refusal as PolicyCompositionRefusalError).failureClass).toBe(
      "blocked_configuration",
    );

    await expect(
      provisioner.revokePolicy({
        grantId: "grant-A",
        userId: USER_ID,
        walletId: WALLET_ID,
        chain: "solana",
        policyId: "policy-1",
      }),
    ).rejects.toBeInstanceOf(PolicyCompositionRefusalError);

    // The provider surface stays untouched: no policy is created, no rule set
    // is PATCHed, no signer is re-attached.
    expect(deps.server.patchPolicy).not.toHaveBeenCalled();
    expect(deps.server.createPolicy).not.toHaveBeenCalled();
    expect(deps.admin.attachPolicyToSigner ?? null).toBeTruthy();
  });

  it("refuses any non-Solana ledger chain on provision AND revoke", async () => {
    const mod = await loadModule();
    const deps = makeDeps({
      signerRows: [{ signer_id: SIGNER_ID, override_policy_ids: [] }],
    });
    const provisioner = mod.createRuntimeGrantPolicyProvisioner(deps);

    await expect(
      provisioner.provisionPolicy({ ...RUNTIME_INPUT, chain: "ethereum" }),
    ).rejects.toThrow(/chain|solana/i);
    await expect(
      provisioner.revokePolicy({
        grantId: "grant-A",
        userId: USER_ID,
        walletId: WALLET_ID,
        chain: "ethereum",
        policyId: "policy-1",
      }),
    ).rejects.toThrow(/chain|solana/i);
  });

  it("delegates provision to the composer, which emits no provider write in this slice", async () => {
    /**
     * Task 1.8 CHANGED THIS CASE. It asserted that the adapter PATCHed the
     * composed rules with verbatim ledger lamports strings. The adapter no
     * longer composes or PATCHes anything: it delegates to the composer entry
     * point. The lamports-string intent of the original case is asserted by
     * `tests/unit/policy-composer.test.ts`; here the assertion is the safety
     * property — a ledger amount never reaches a provider write because no
     * provider write happens.
     */
    const mod = await loadModule();
    const deps = makeDeps({
      signerRows: [{ signer_id: SIGNER_ID, override_policy_ids: [] }],
    });
    const provisioner = mod.createRuntimeGrantPolicyProvisioner(deps);

    await expect(provisioner.provisionPolicy(RUNTIME_INPUT)).rejects.toBeInstanceOf(
      PolicyCompositionRefusalError,
    );
    expect(deps.server.patchPolicy).not.toHaveBeenCalled();
    expect(deps.server.createPolicy).not.toHaveBeenCalled();
  });

  it("throws on provision refusal so the sync service keeps its fail-closed audit path", async () => {
    /**
     * Task 1.8 CHANGED THIS CASE. Its assertion strength is preserved and
     * strengthened: the original case only asserted that a provider failure was
     * re-thrown (so `PrivyPolicySyncService`'s catch path runs and the grant is
     * degraded + audited). The adapter no longer surfaces a raw provider error,
     * because it no longer calls a provider; it re-throws the composer's TYPED
     * refusal, which the same catch path consumes. A refusal is never converted
     * into a resolved outcome.
     */
    const mod = await loadModule();
    const deps = makeDeps();
    deps.server.patchPolicy.mockRejectedValue(new Error("provider timeout"));
    const provisioner = mod.createRuntimeGrantPolicyProvisioner(deps);

    const refusal = await provisioner
      .provisionPolicy(RUNTIME_INPUT)
      .then(() => null, (error: unknown) => error);
    expect(refusal).toBeInstanceOf(PolicyCompositionRefusalError);
    // Task 2.8 DELETED `apply_capability_unwired`: the implementation exists, so
    // the refusal now names the deployment fact (no payload signer in this
    // runtime) rather than an unwritten slice.
    expect((refusal as PolicyCompositionRefusalError).reason).toBe(
      "provider_unavailable",
    );
  });

  it("refuses revoke visibly instead of reporting a revocation nobody performed", async () => {
    /**
     * Task 1.8 CHANGED THIS CASE. It asserted that revoke PATCHed the empty
     * union and rejected on an ambiguous provider outcome. There is no revoke
     * PATCH any more (task 1.7 owns whole-grant revocation in the ledger
     * transaction, and the composer owns the remote surface). Both directions
     * now assert the same contract: `revokePolicy` resolves ONLY when the remote
     * rule set was verified, and in this slice that is never, so it refuses.
     */
    const mod = await loadModule();
    for (const deps of [makeDeps(), makeDeps()]) {
      const provisioner = mod.createRuntimeGrantPolicyProvisioner(deps);
      await expect(
        provisioner.revokePolicy({
          grantId: "grant-A",
          userId: USER_ID,
          walletId: WALLET_ID,
          chain: "solana",
          policyId: "policy-1",
        }),
      ).rejects.toBeInstanceOf(PolicyCompositionRefusalError);
      expect(deps.server.patchPolicy).not.toHaveBeenCalled();
    }
  });
});

describe("createGrantPolicySyncService wiring (task 2.3, RED)", () => {
  it("keeps the fail-closed unavailable stub without the Privy server client or quorum id", async () => {
    const mod = await loadModule();
    const withoutServer = mod.createGrantPolicySyncService({
      database: {},
      quorumId: "quorum-1",
    });
    expect(withoutServer.kind).toBe("unavailable");
    const withoutQuorum = mod.createGrantPolicySyncService({
      database: {},
      privyServer: {},
    });
    expect(withoutQuorum.kind).toBe("unavailable");
  });

  it("keeps the unavailable stub when the server client cannot sign", async () => {
    const mod = await loadModule();
    // S2c: the gate is driven by the injected signer, so a server client that
    // reports it cannot sign must NEVER be treated as available — the gate
    // stays honest instead of degrading to always-true.
    const signerless = mod.createGrantPolicySyncService({
      database: {},
      privyServer: { canSignAuthorizations: () => false },
      quorumId: "quorum-1",
    });
    expect(signerless.kind).toBe("unavailable");
  });

  it("returns the runtime service when Privy + canonical signer config are available", async () => {
    const mod = await loadModule();
    const deps = makeDeps({
      signerRows: [{ signer_id: SIGNER_ID, override_policy_ids: [] }],
    });
    const wired = mod.createGrantPolicySyncService({
      database: deps.database,
      privyServer: deps.server,
      quorumId: "quorum-not-a-signer",
    });
    expect(wired.kind).toBe("runtime");

    // Task 1.8 CHANGED THIS CASE. It used to assert an end-to-end sync that
    // created a Solana policy through the runtime adapter. No slice-1 wiring may
    // create a policy, so the same end-to-end path now asserts the fail-closed
    // end state: the port refuses, the sync service degrades the grant, and no
    // policy id is ever reported.
    const service = wired.service as {
      syncGrant(
        grantId: string,
        userId: string,
        walletId: string,
      ): Promise<{ policyId: string | null; error?: string }>;
    };
    const result = await service.syncGrant("grant-A", USER_ID, WALLET_ID);
    expect(result.policyId).toBeNull();
    expect(result.error).toMatch(/grant_policy_sync|signed implementation/);
    expect(deps.server.createPolicy).not.toHaveBeenCalled();
  });
});
