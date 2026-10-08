import { describe, expect, it, vi } from "vitest";
import {
  createSolanaGrantPolicyProvisioner,
  composeGrantRules,
  type GrantPolicyInput,
  type PrivyPolicyAdminClient,
} from "../../src/wallet/grants/solana-policy-provisioner.js";
import { PrivyPolicySyncService } from "../../src/wallet/grants/privy-policy-sync.js";
import type { GrantPolicyProvisioner } from "../../src/wallet/grants/privy-policy-sync.js";
import {
  SOLANA_DEVNET_NETWORK,
  type SolanaRpc,
  type SolanaSignAndSendClient,
} from "../../src/wallet/solana-devnet-provider.js";

const WALLET_ID = "wallet-1";
const USER_ID = "user-1";
const CHAIN = "solana";
const SENDER = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
const CONTEXT = { wallet: WALLET_ID, network: SOLANA_DEVNET_NETWORK };

function rpcDouble(overrides: Partial<SolanaRpc> = {}): SolanaRpc {
  return {
    getBalance: vi.fn().mockResolvedValue(2_000_000_000n),
    getSignatureStatuses: vi
      .fn()
      .mockResolvedValue([{ confirmationStatus: "finalized", err: null }]),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    getRecentBlockhash: vi
      .fn()
      .mockResolvedValue("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq"),
    getFeeForTransferMessage: vi.fn().mockResolvedValue(5_000n),
    ...overrides,
  };
}

function signerDouble(
  overrides: Partial<SolanaSignAndSendClient> = {},
): SolanaSignAndSendClient {
  return {
    signAndSend: vi
      .fn()
      .mockResolvedValue({ hash: "signed-hash", id: "privy-tx-1" }),
    ...overrides,
  } as SolanaSignAndSendClient;
}

const GRANT_A: GrantPolicyInput = {
  grantId: "grant-A",
  walletId: "wallet-1",
  recipients: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
  maxPerTransfer: "1_000_000_000",
  expiresAt: 1_792_000_000,
};

const GRANT_B: GrantPolicyInput = {
  grantId: "grant-B",
  walletId: "wallet-1",
  recipients: ["4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq"],
  maxPerTransfer: "500_000_000",
  expiresAt: 1_793_000_000,
};

function adminDouble(): PrivyPolicyAdminClient {
  // Mirror of the provider surface: getPolicy reflects the last PATCH so the
  // exact readback comparison observes a converged provider.
  let currentRules: unknown[] = [];
  return {
    getSignerPolicyIds: vi.fn().mockResolvedValue(["policy-1"]),
    createPolicy: vi.fn().mockResolvedValue({ id: "policy-1" }),
    getPolicy: vi.fn().mockImplementation(async (_id: string) => ({
      id: "policy-1",
      rules: currentRules,
    })),
    patchPolicy: vi
      .fn()
      .mockImplementation(async (_id: string, patch: { rules?: unknown[] }) => {
        currentRules = patch.rules ?? [];
        return { id: "policy-1" };
      }),
    listActiveGrants: vi.fn().mockResolvedValue([GRANT_A, GRANT_B]),
    attachPolicyToSigner: vi.fn().mockResolvedValue(undefined),
  };
}

describe("composed Solana grant policy provisioner (ADR-2)", () => {
  it("composes conditioned ALLOW rules per grant; no fabricated cumulative rule", () => {
    const rules = composeGrantRules([GRANT_A]);
    expect(rules).toHaveLength(1);
    const rule = rules[0] as Record<string, unknown>;
    expect(rule.action).toBe("ALLOW");
    expect(JSON.stringify(rule)).toContain(
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    expect(JSON.stringify(rule)).toContain(GRANT_A.maxPerTransfer);
    expect(JSON.stringify(rule)).toContain(String(GRANT_A.expiresAt));
    // No cumulative-window rule may exist: ledger is the sole cumulative authority.
    expect(JSON.stringify(rules)).not.toMatch(/cumulative/i);
  });

  it("recomputes the union over active grants and PATCHes with readback before ready", async () => {
    const admin = adminDouble();
    const provisioner = createSolanaGrantPolicyProvisioner(admin);
    const result = await provisioner.provisionPolicy({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
      recipients: GRANT_A.recipients,
      maxPerTransfer: GRANT_A.maxPerTransfer,
      expiresAt: GRANT_A.expiresAt,
    });
    expect(result.policyId).toBe("policy-1");
    // Readback must have verified the exact composed rules.
    expect(admin.getPolicy).toHaveBeenCalledWith("policy-1");
    const patched = (admin.patchPolicy as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(patched.rules).toHaveLength(2); // grant A + grant B (union over active)
  });

  it("fails closed on uncertain PATCH: binding unchanged, audited, siblings degraded", async () => {
    const admin = adminDouble();
    (admin.patchPolicy as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("timeout after leaving our process"),
    );
    const provisioner = createSolanaGrantPolicyProvisioner(admin);
    const result = await provisioner.provisionPolicy({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
      recipients: GRANT_A.recipients,
      maxPerTransfer: GRANT_A.maxPerTransfer,
      expiresAt: GRANT_A.expiresAt,
    });
    expect(result.policyId).toBeNull();
    expect(result.error).toBeDefined();
    expect(result.affectedGrants).toEqual([GRANT_A.grantId, GRANT_B.grantId]);
  });

  it("revoke keeps sibling rules and the policy id; never deletes while siblings active", async () => {
    const admin = adminDouble();
    const provisioner = createSolanaGrantPolicyProvisioner(admin);
    const result = await provisioner.revokePolicyRules({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
    });
    expect(result.revoked).toBe(true);
    expect(result.policyId).toBe("policy-1");
    const patched = (admin.patchPolicy as ReturnType<typeof vi.fn>).mock
      .calls[0][1];
    expect(patched.rules).toHaveLength(1); // grant B survives
  });

  it("attach performs a post-attach signer readback and preserves unrelated additional_signers entries", async () => {
    const admin = adminDouble();
    // Signer starts with no policy; after attach, the readback must show it.
    (admin.getSignerPolicyIds as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([])
      .mockResolvedValue(["policy-1"]);
    const provisioner = createSolanaGrantPolicyProvisioner(admin);
    await provisioner.provisionPolicy({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
      recipients: GRANT_A.recipients,
      maxPerTransfer: GRANT_A.maxPerTransfer,
      expiresAt: GRANT_A.expiresAt,
    });
    expect(admin.attachPolicyToSigner).toHaveBeenCalled();
    const arg = (admin.attachPolicyToSigner as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(arg).toMatchObject({
      policyId: "policy-1",
      preserveExistingSigners: true,
    });
    // Post-attach readback: the signer must report the new policy before
    // the provision can succeed.
    expect(admin.getSignerPolicyIds).toHaveBeenCalledTimes(2);
  });

  it("fails closed when the post-attach signer readback omits the new policy", async () => {
    const admin = adminDouble();
    // The attach never registers the policy on the signer: every readback
    // of the signer's policy ids stays empty.
    (admin.getSignerPolicyIds as ReturnType<typeof vi.fn>).mockResolvedValue(
      [],
    );
    const provisioner = createSolanaGrantPolicyProvisioner(admin);
    const result = await provisioner.provisionPolicy({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
      recipients: GRANT_A.recipients,
      maxPerTransfer: GRANT_A.maxPerTransfer,
      expiresAt: GRANT_A.expiresAt,
    });
    expect(result.policyId).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("fails closed when the readback rules do not match the composed rules", async () => {
    const admin = adminDouble();
    // Readback returns a policy whose rules diverge from what was PATCHed.
    (admin.getPolicy as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "policy-1",
      rules: [{ action: "ALLOW", conditions: [] }],
    });
    const provisioner = createSolanaGrantPolicyProvisioner(admin);
    const result = await provisioner.provisionPolicy({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
      recipients: GRANT_A.recipients,
      maxPerTransfer: GRANT_A.maxPerTransfer,
      expiresAt: GRANT_A.expiresAt,
    });
    expect(result.policyId).toBeNull();
    expect(result.error).toBeDefined();
  });

  it("maps the grant's exact epoch-second expiry into the rule condition", () => {
    const rules = composeGrantRules([{ ...GRANT_A, expiresAt: 1_800_000_000 }]);
    const rule = rules[0] as unknown as {
      conditions: Array<{ field: string; value?: unknown }>;
    };
    const expiry = rule.conditions.find(
      (c) => c.field === "current_unix_timestamp",
    );
    expect(expiry?.value).toBe(1_800_000_000);
  });
});

describe("composed-policy serialization and denial paths (ADR-2, RED)", () => {
  it("serializes a concurrent provision-vs-revoke recompute per wallet", async () => {
    const admin = adminDouble();
    let patchCalls = 0;
    let currentRules: unknown[] = [];
    // Deterministic mutual exclusion: gate PATCH #1 behind a deferred promise;
    // PATCH #2 must NOT begin until #1 completes.
    let releaseFirstPatch: () => void = () => {};
    const firstPatchGate = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve;
    });
    (admin.getPolicy as ReturnType<typeof vi.fn>).mockImplementation(
      async (policyId: string) => ({ id: policyId, rules: currentRules }),
    );
    (admin.patchPolicy as ReturnType<typeof vi.fn>).mockImplementation(
      async (policyId: string, patch: { rules?: unknown[] }) => {
        patchCalls += 1;
        if (patchCalls === 1) await firstPatchGate;
        currentRules = patch.rules ?? [];
        return { id: policyId };
      },
    );
    const provisioner = createSolanaGrantPolicyProvisioner(admin, {
      serializePerWallet: true,
    });
    const provisionPromise = provisioner.provisionPolicy({
      grantId: "grant-C",
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
      recipients: ["2jXXABZCdeFGhIJKlMNopQRSTUVwXYZabcdefghijk1234"],
      maxPerTransfer: "250_000_000",
      expiresAt: 1_794_000_000,
    });
    const revokePromise = provisioner.revokePolicyRules({
      grantId: GRANT_A.grantId,
      walletId: GRANT_A.walletId,
      userId: USER_ID,
      chain: CHAIN,
    });
    // Yield microtasks so both operations reach their lock acquisition point.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    // PATCH #1 is blocked on the gate; the second recompute must still be
    // waiting on the per-wallet lock (mutual exclusion proven here).
    expect(patchCalls).toBe(1);
    releaseFirstPatch();
    const [provision, revoke] = await Promise.all([
      provisionPromise,
      revokePromise,
    ]);
    expect(provision.policyId).toBe("policy-1");
    expect(revoke.revoked).toBe(true);
    // Both recomputes serialized on the same wallet: two ordered PATCHes,
    // final rules reflect the last full recompute (B + C, A removed).
    expect(patchCalls).toBe(2);
    const finalRules = (admin.patchPolicy as ReturnType<typeof vi.fn>).mock
      .calls[1][1];
    expect(JSON.stringify(finalRules)).not.toContain(GRANT_A.recipients[0]);
    expect(JSON.stringify(finalRules)).toContain(GRANT_B.recipients[0]);
    expect(JSON.stringify(finalRules)).toContain(
      "2jXXABZCdeFGhIJKlMNopQRSTUVwXYZabcdefghijk1234",
    );
  });

  it("maps a Privy policy denial to a not_dispatched outcome (provider seam)", async () => {
    const { SolanaDevnetProvider } = await import(
      "../../src/wallet/solana-devnet-provider.js"
    );
    const p = new SolanaDevnetProvider(
      { walletId: WALLET_ID, senderAddress: SENDER },
      { rpc: rpcDouble(), signAndSend: signerDouble() },
    );
    const denial = Object.assign(
      new Error("Policy evaluation returned DENY for signAndSendTransaction"),
      { definitive: true },
    );
    // Force the denial through the signer seam directly:
    const denyingProvider = new (
      await import("../../src/wallet/solana-devnet-provider.js")
    ).SolanaDevnetProvider(
      { walletId: WALLET_ID, senderAddress: SENDER },
      {
        rpc: rpcDouble(),
        signAndSend: { signAndSend: vi.fn().mockRejectedValue(denial) },
        sleep: vi.fn().mockResolvedValue(undefined),
        now: () => 0,
      },
    );
    const result = await denyingProvider.broadcastTransfer({
      ...CONTEXT,
      token: "SOL",
      to: RECIPIENT,
      amount: "0.5",
      previewId: "preview-denial",
    });
    expect(result.kind).toBe("not_dispatched");
    if (result.kind === "not_dispatched")
      expect(result.reason).toMatch(/DENY|policy/i);
  });
});

describe("privy policy sync expiry passthrough (ADR-2, RED)", () => {
  it("passes the stored grant expiry (epoch seconds) to the provisioner, not a windowSeconds rollforward", async () => {
    // Minimal in-memory DatabaseClient double: PrivyPolicySyncService only
    // needs withUserTransaction + query against the delegated_grants row.
    const EXPIRES_AT = new Date("2030-01-01T00:00:00.000Z");
    const grantRow = {
      id: "grant-X",
      state: "active" as const,
      wallet_id: "wallet-1",
      max_per_transfer: "1_000_000",
      max_cumulative: "5_000_000",
      window_seconds: 3_600,
      recipients: [RECIPIENT],
      provider_policy_id: null,
      expires_at: EXPIRES_AT,
    };
    const queries: Array<{ text: string; values: readonly unknown[] }> = [];
    const clientDouble = {
      query: vi.fn(async (text: string, values?: readonly unknown[]) => {
        queries.push({ text, values: values ?? [] });
        if (text.includes("FROM delegated_grants")) {
          return { rows: [grantRow] };
        }
        return { rows: [] };
      }),
    };
    const databaseDouble = {
      withUserTransaction: async <T>(
        _userId: string,
        operation: (client: typeof clientDouble) => Promise<T>,
      ): Promise<T> => operation(clientDouble),
      query: clientDouble.query,
    };
    const calls: Array<Record<string, unknown>> = [];
    const provisioner = {
      async provisionPolicy(input: Record<string, unknown>) {
        calls.push(input);
        return { policyId: "policy-x" };
      },
      async revokePolicy() {},
    };
    const sync = new PrivyPolicySyncService(
      databaseDouble as unknown as ConstructorParameters<
        typeof PrivyPolicySyncService
      >[0],
      provisioner as unknown as GrantPolicyProvisioner,
    );
    const outcome = await sync.syncGrant("grant-X", "user-1", "wallet-1");
    expect(outcome.policyId).toBe("policy-x");
    const call = calls[0]!;
    // The provisioner call must carry the grant's stored expiry as epoch
    // seconds (exact value), and must NOT ask the provisioner to derive a
    // rolling expiry from windowSeconds.
    expect(call.expiresAt).toBe(Math.floor(EXPIRES_AT.getTime() / 1000));
    expect(call).not.toHaveProperty("windowSeconds");
  });
});

describe("Solana policy DSL exact shape (task 1.11, RED)", () => {
  /**
   * Exact Privy Solana policy shape, matching the EVM builder in
   * src/wallet/enrollment-policy.ts and verified live against the Privy API:
   * a rule is FLAT — `{ name, method, action, conditions[] }`. The former
   * `{ action, resource: { method, chain }, conditions }` wrapper is rejected
   * with 400 invalid_policy_format:
   *   Required at "rules[0].name"; Required at "rules[0].method";
   *   Unrecognized key(s) in object: 'resource'
   */
  it("uses the exact flat Solana shape: named ALLOW rule, hoisted method, Transfer.to in, Transfer.lamports lte", () => {
    const rules = composeGrantRules([GRANT_A]);
    expect(rules).toHaveLength(1);
    const rule = rules[0] as unknown as {
      name?: unknown;
      method?: unknown;
      action?: unknown;
      conditions: Array<Record<string, unknown>>;
    };
    // Privy requires a named rule and a top-level method; the `resource`
    // wrapper is rejected outright.
    expect(typeof rule.name).toBe("string");
    expect(rule.name).not.toBe("");
    // Rule names are capped at 50 characters by Privy.
    expect((rule.name as string).length).toBeLessThanOrEqual(50);
    expect(rule.method).toBe("signAndSendTransaction");
    expect(rule.action).toBe("ALLOW");
    expect(rule).not.toHaveProperty("resource");
    // Exact accepted key set: an extra `metadata` key is ALSO rejected by
    // Privy with "Unrecognized key(s) in object: 'metadata'".
    expect(Object.keys(rule).sort()).toEqual([
      "action",
      "conditions",
      "method",
      "name",
    ]);
    const conditions = rule.conditions;
    expect(conditions).toHaveLength(3);

    const recipient = conditions[0] as Record<string, unknown>;
    expect(recipient.field_source).toBe(
      "solana_system_program_instruction",
    );
    expect(recipient.field).toBe("Transfer.to");
    expect(recipient.operator).toBe("in");
    expect(recipient.value).toEqual(GRANT_A.recipients);

    const lamports = conditions[1] as Record<string, unknown>;
    expect(lamports.field_source).toBe(
      "solana_system_program_instruction",
    );
    expect(lamports.field).toBe("Transfer.lamports");
    expect(lamports.operator).toBe("lte");
    expect(lamports.value).toBe(GRANT_A.maxPerTransfer);
  });

  it("uses field_source system with current_unix_timestamp and exact lt expiry (not lte, not synthetic)", () => {
    const EXACT_EXPIRY = 1_792_000_000;
    const rules = composeGrantRules([{ ...GRANT_A, expiresAt: EXACT_EXPIRY }]);
    const rule = rules[0] as unknown as {
      conditions: Array<Record<string, unknown>>;
    };
    const expiry = rule.conditions[2] as Record<string, unknown>;
    // Expiry rides the system clock source with the exact strict operator.
    expect(expiry.field_source).toBe("system");
    expect(expiry.field).toBe("current_unix_timestamp");
    expect(expiry.operator).toBe("lt");
    expect(expiry.value).toBe(EXACT_EXPIRY);
  });

  it("defaults deny: every instruction must match an ALLOW rule (deny by absence, no catch-all ALLOW)", () => {
    const rules = composeGrantRules([GRANT_A]);
    // The composed policy must not contain any catch-all ALLOW rule: an
    // instruction that matches no conditioned ALLOW rule is denied by
    // absence of a matching rule, never by an explicit wildcard.
    for (const rule of rules as Array<Record<string, unknown>>) {
      const conditions = rule.conditions as Array<Record<string, unknown>>;
      expect(conditions.length).toBeGreaterThan(0);
      expect(rule.action).toBe("ALLOW");
    }
  });
});
