/**
 * Task 1.8 — the legacy full-rule writer is gone and its port delegates.
 *
 * This suite replaces `tests/unit/grants-policy-provisioner.test.ts`, which
 * asserted the DELETED direct-call behaviour of
 * `createSolanaGrantPolicyProvisioner(...).provisionPolicy` /
 * `.revokePolicyRules`. Those assertions are not dropped: their intent moved to
 * the composer (design §3.3/§3.4), and this file proves the property the old
 * suite cannot even express — that the writer no longer exists and that the
 * caller it used to serve now FAILS VISIBLY instead of attaching no policy.
 */
import { describe, expect, it, vi } from "vitest";
import {
  composeGrantRules,
  type GrantPolicyInput,
} from "../../src/wallet/grants/solana-policy-provisioner.js";
import { createRuntimeGrantPolicyProvisioner } from "../../src/wallet/grants/privy-policy-runtime.js";
import { PolicyCompositionRefusalError } from "../../src/wallet/policy/errors.js";
import type { DatabaseClient } from "../../src/db/client.js";
import type { PrivyPolicyAdmin } from "../../src/wallet/grants/privy-policy-admin.js";
import type { PrivyServerClient } from "../../src/wallet/privy-server-client.js";

const USER_ID = "7f0a1c8e-3a1f-4d3f-9d5c-9c2b6f1a4e11";
const WALLET_ID = "b1e6d0d2-6c2f-4a77-8a1e-4c9d2b7f5a33";
const CHAIN = "solana";
const CONTACT_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

const GRANT_A: GrantPolicyInput = {
  grantId: "grant-A",
  walletId: WALLET_ID,
  recipients: [CONTACT_ADDRESS],
  maxPerTransfer: "1000000000",
  expiresAt: 1_792_000_000,
};

/**
 * A database double that answers the composer's reads with one active contact
 * and no recorded policy state, so the composition itself SUCCEEDS (one ordinary
 * family, single family ⇒ no U1 probe needed) and the only thing left to observe
 * is what the grant-sync port does with it. Every statement is recorded, so
 * "the composer ran" is asserted positively rather than inferred.
 */
function databaseDouble(): { database: DatabaseClient; statements: string[] } {
  const statements: string[] = [];
  const query = async (sql: string) => {
    statements.push(sql.replace(/\s+/g, " ").trim());
    if (sql.includes("FROM user_wallets")) {
      return { rows: [{ user_id: USER_ID }] };
    }
    if (sql.includes("FROM recipients")) {
      return { rows: [{ id: "contact-1", version: 1, address: CONTACT_ADDRESS }] };
    }
    return { rows: [] };
  };
  const client = { query, release: () => undefined };
  return {
    statements,
    database: {
      query,
      withUserTransaction: async (
        _userId: string,
        run: (c: unknown) => unknown,
      ) => run(client),
    } as unknown as DatabaseClient,
  };
}

/**
 * Whole provider + signer surface, instrumented. The negative assertions below
 * are only meaningful because these ARE reachable: the writer this unit deleted
 * would have called them, so a regression that re-installs a direct provider
 * call is recorded and caught by name.
 */
function runtimeDouble(database: DatabaseClient) {
  const server = {
    createPolicy: vi.fn().mockResolvedValue({ id: "policy-1", rules: [] }),
    getPolicy: vi.fn().mockResolvedValue({ id: "policy-1", rules: [] }),
    patchPolicy: vi.fn().mockResolvedValue({ id: "policy-1" }),
    getWallet: vi.fn().mockResolvedValue({ id: "provider-wallet-1", additional_signers: [] }),
  } as unknown as Pick<
    PrivyServerClient,
    "createPolicy" | "getPolicy" | "patchPolicy" | "getWallet"
  >;
  const admin = {
    attachPolicyToSigner: vi.fn().mockResolvedValue(undefined),
    resolveTarget: vi.fn().mockResolvedValue({
      providerWalletId: "provider-wallet-1",
      providerSignerId: "signer-1",
    }),
  } as unknown as Pick<PrivyPolicyAdmin, "attachPolicyToSigner" | "resolveTarget">;
  return {
    deps: { database, server, admin },
    server,
    admin,
    adminClient: { server, admin },
  };
}

describe("the grant policy provisioner delegates to the composer (task 1.8)", () => {
  it("keeps the GrantPolicyProvisioner port: both methods exist and are callable", () => {
    const { database } = databaseDouble();
    const provisioner = createRuntimeGrantPolicyProvisioner(
      runtimeDouble(database).deps,
    );
    expect(typeof provisioner.provisionPolicy).toBe("function");
    expect(typeof provisioner.revokePolicy).toBe("function");
  });

  it("routes provisionPolicy through the composer and never issues an independent full-rule write", async () => {
    const { database, statements } = databaseDouble();
    const surface = runtimeDouble(database);
    const provisioner = createRuntimeGrantPolicyProvisioner(surface.deps);

    const outcome = await provisioner
      .provisionPolicy({
        grantId: GRANT_A.grantId,
        walletId: WALLET_ID,
        userId: USER_ID,
        chain: CHAIN,
        recipients: GRANT_A.recipients,
        maxPerTransfer: GRANT_A.maxPerTransfer,
        maxCumulative: GRANT_A.maxPerTransfer,
        expiresAt: GRANT_A.expiresAt,
      })
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );

    // POSITIVE CONTROL: the composer's own reads ran (the ledger scope and the
    // contact projection), so the refusal below is the composer's successor and
    // not an early bail that never reached it.
    expect(
      statements.some((sql) => sql.includes("FROM delegates_nonexistent")),
    ).toBe(false);
    expect(statements.some((sql) => sql.includes("FROM user_wallets"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM recipients"))).toBe(true);
    expect(statements.some((sql) => sql.includes("FROM recipient_policy_state"))).toBe(
      true,
    );

    // FAIL VISIBLE: a policy id is NEVER fabricated. This is the assertion that
    // fails the moment the path silently succeeds while no policy is attached.
    expect(outcome.kind).toBe("rejected");
    const error = (outcome as { error: unknown }).error;
    expect(error).toBeInstanceOf(PolicyCompositionRefusalError);
    const refusal = error as PolicyCompositionRefusalError;
    expect(refusal.failureClass).toBe("blocked_configuration");
    // Task 2.8 DELETED `apply_capability_unwired` (the class and its reason code
    // are gone from `errors.ts`) because the signed implementation now exists:
    // what stays true for THIS path is that the grant-sync runtime carries no
    // payload signer, so it still refuses — with the reason that names that
    // deployment fact instead of an implementation stage.
    expect(refusal.reason).toBe("provider_unavailable");

    // NO SECOND FULL-RULE WRITER: no provider or signer mutation was issued.
    expect(surface.server.createPolicy).not.toHaveBeenCalled();
    expect(surface.server.patchPolicy).not.toHaveBeenCalled();
    expect(surface.admin.attachPolicyToSigner).not.toHaveBeenCalled();
  });

  it("routes revokePolicy through the composer too, with the same visible refusal", async () => {
    const { database, statements } = databaseDouble();
    const surface = runtimeDouble(database);
    const provisioner = createRuntimeGrantPolicyProvisioner(surface.deps);

    const outcome = await provisioner
      .revokePolicy({
        grantId: GRANT_A.grantId,
        walletId: WALLET_ID,
        userId: USER_ID,
        chain: CHAIN,
        policyId: "policy-1",
      })
      .then(
        (value) => ({ kind: "resolved" as const, value }),
        (error: unknown) => ({ kind: "rejected" as const, error }),
      );

    expect(statements.some((sql) => sql.includes("FROM recipients"))).toBe(true);
    expect(outcome.kind).toBe("rejected");
    expect((outcome as { error: PolicyCompositionRefusalError }).error.reason).toBe(
      "provider_unavailable",
    );
    expect(surface.server.patchPolicy).not.toHaveBeenCalled();
  });

  it("refuses a non-ledger chain family before doing any work", async () => {
    const { database, statements } = databaseDouble();
    const surface = runtimeDouble(database);
    const provisioner = createRuntimeGrantPolicyProvisioner(surface.deps);

    await expect(
      provisioner.provisionPolicy({
        grantId: GRANT_A.grantId,
        walletId: WALLET_ID,
        userId: USER_ID,
        chain: "ethereum",
        recipients: GRANT_A.recipients,
        maxPerTransfer: GRANT_A.maxPerTransfer,
        maxCumulative: GRANT_A.maxPerTransfer,
        expiresAt: GRANT_A.expiresAt,
      }),
    ).rejects.toThrow(/ledger chain family solana/);
    expect(statements).toHaveLength(0);
  });

  it("still builds one flat ALLOW rule per grant (the rule builder survives the writer)", () => {
    const rules = composeGrantRules([GRANT_A]);
    expect(rules).toHaveLength(1);
    const rule = rules[0] as Record<string, unknown>;
    expect(rule.name).toBe("solana-grant-grant-A");
    expect(rule.method).toBe("signAndSendTransaction");
    expect(rule.action).toBe("ALLOW");
    expect(rule).not.toHaveProperty("chain");
    expect(JSON.stringify(rules)).not.toMatch(/cumulative/i);
  });
});
