import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { DelegatedGrantService } from "../../src/wallet/grants/consumption.js";
import {
  PrivyPolicySyncService,
  type GrantPolicyProvisioner,
} from "../../src/wallet/grants/privy-policy-sync.js";

const RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

type ProvisionCall = {
  grantId: string;
  walletId: string;
  userId: string;
  chain: string;
  recipients: string[];
  maxPerTransfer: string;
  maxCumulative: string;
  /** Stored ledger expiry (epoch seconds); never synthesized from a window. */
  expiresAt: number;
};

function fakeProvisioner(
  overrides: {
    onProvision?: (call: ProvisionCall) => Promise<{ policyId: string }>;
    onRevoke?: (input: Parameters<GrantPolicyProvisioner["revokePolicy"]>[0]) => Promise<void>;
  } = {},
): GrantPolicyProvisioner & { calls: ProvisionCall[]; revoked: string[] } {
  const calls: ProvisionCall[] = [];
  const revoked: string[] = [];
  return {
    calls,
    revoked,
    async provisionPolicy(input: ProvisionCall) {
      calls.push(input);
      if (overrides.onProvision) return overrides.onProvision(input);
      return { policyId: `policy-${input.grantId.slice(0, 8)}` };
    },
    async revokePolicy(input) {
      revoked.push(input.policyId);
      if (overrides.onRevoke) return overrides.onRevoke(input);
    },
  };
}
const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("privy policy sync (DGC-4, hybrid enforcement)", () => {
  let database: DatabaseClient;
  let service: DelegatedGrantService;

  beforeAll(async () => {
    database = createDatabaseClient(databaseUrl!);
    service = new DelegatedGrantService(database);
  });

  afterAll(async () => {
    await database.close();
  });

  async function setup(): Promise<{
    userId: string;
    walletId: string;
    grantId: string;
    expiresAtSeconds: number;
  }> {
    const user = await database.query<{ id: string }>(
      `INSERT INTO users (privy_did, display_name)
       VALUES ($1, $2) RETURNING id`,
      [`did:privy:dgc-sync-${randomUUID()}`, "DGC Sync"],
    );
    const userId = user.rows[0]!.id;
    const wallet = await database.query<{ id: string }>(
      `INSERT INTO user_wallets (user_id, provider, provider_wallet_id, chain_family, address, state)
       VALUES ($1, 'fixture', $2, 'solana', $3, 'ready') RETURNING id`,
      [userId, `fixture-${randomUUID()}`, `${randomUUID()}.sol`],
    );
    const walletId = wallet.rows[0]!.id;
    // Single source for the expiry: the case must assert the EXACT stored
    // expiry, so recomputing `Date.now()` at assertion time made the check
    // flip by one second whenever the wall clock crossed a second boundary
    // between grant creation and the assertion (observed in CI).
    const expiresAt = new Date(Date.now() + 86_400_000);
    const grant = await service.createGrant({
      userId,
      walletId,
      action: "transfer",
      chain: "solana",
      maxPerTransfer: "1_000_000",
      maxCumulative: "5_000_000",
      windowSeconds: 3_600,
      recipients: [RECIPIENT],
      expiresAt,
    });
    return {
      userId,
      walletId,
      grantId: grant.id,
      expiresAtSeconds: Math.floor(expiresAt.getTime() / 1000),
    };
  }

  it("provisions the policy and records policy_synced with the policy id", async () => {
    const { userId, walletId, grantId, expiresAtSeconds } = await setup();
    const provisioner = fakeProvisioner();

    const sync = new PrivyPolicySyncService(database, provisioner);
    const outcome = await sync.syncGrant(grantId, userId, walletId);

    expect(outcome.policyId).toBe(`policy-${grantId.slice(0, 8)}`);
    expect(provisioner.calls).toHaveLength(1);
    expect(provisioner.calls[0]).toMatchObject({
      grantId,
      walletId,
      recipients: [RECIPIENT],
      maxPerTransfer: "1000000",
      maxCumulative: "5000000",
      // Exact stored expiry (epoch seconds), never a window rollforward.
      // Deterministic: the same instant the grant was created with.
      expiresAt: expiresAtSeconds,
    });

    const row = await database.withUserTransaction(userId, (client) =>
      client.query<{ provider_policy_id: string; state: string }>(
        `SELECT provider_policy_id, state FROM delegated_grants WHERE id = $1`,
        [grantId],
      ),
    );
    expect(row.rows[0]?.provider_policy_id).toBe(
      `policy-${grantId.slice(0, 8)}`,
    );
    expect(row.rows[0]?.state).toBe("active");

    const audit = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string; detail: { policyId?: string } | null }>(
        `SELECT event, detail FROM grant_audit_log WHERE grant_id = $1 ORDER BY created_at`,
        [grantId],
      ),
    );
    const events = audit.rows.map((r) => r.event);
    expect(events).toContain("policy_synced");
    // Two policy_synced rows may exist: the creation-time placeholder (no
    // detail) and the sync outcome carrying the policy id.
    const synced = audit.rows.find(
      (r) => r.event === "policy_synced" && r.detail?.policyId,
    );
    expect(synced?.detail?.policyId).toBe(`policy-${grantId.slice(0, 8)}`);
  });

  it("fails closed: a provisioning error leaves the grant non-executable and audited", async () => {
    const { userId, walletId, grantId } = await setup();
    const provisioner = fakeProvisioner({
      onProvision: async () => {
        throw new Error("privy unreachable");
      },
    });

    const sync = new PrivyPolicySyncService(database, provisioner);
    const outcome = await sync.syncGrant(grantId, userId, walletId);
    expect(outcome.policyId).toBeNull();
    expect(outcome.error).toMatch(/privy unreachable/);

    // Fail-closed: the grant must not be executable without its policy.
    const row = await database.withUserTransaction(userId, (client) =>
      client.query<{ provider_policy_id: string | null; state: string }>(
        `SELECT provider_policy_id, state FROM delegated_grants WHERE id = $1`,
        [grantId],
      ),
    );
    expect(row.rows[0]?.provider_policy_id).toBeNull();

    const audit = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string; reason: string | null }>(
        `SELECT event, reason FROM grant_audit_log WHERE grant_id = $1 ORDER BY created_at`,
        [grantId],
      ),
    );
    const events = audit.rows.map((r) => r.event);
    expect(events).toContain("policy_sync_failed");
    const failed = audit.rows.find((r) => r.event === "policy_sync_failed");
    expect(failed?.reason).toContain("privy unreachable");
  });

  it("revocation removes the policy enforcement surface and is audited", async () => {
    const { userId, walletId, grantId } = await setup();
    const provisioner = fakeProvisioner();
    const sync = new PrivyPolicySyncService(database, provisioner);

    await sync.syncGrant(grantId, userId, walletId);
    const policyId = `policy-${grantId.slice(0, 8)}`;

    await service.revokeGrant(grantId, userId);
    await sync.syncRevocation(grantId, userId);

    expect(provisioner.revoked).toEqual([policyId]);
    const audit = await database.withUserTransaction(userId, (client) =>
      client.query<{ event: string }>(
        `SELECT event FROM grant_audit_log WHERE grant_id = $1 ORDER BY created_at`,
        [grantId],
      ),
    );
    const events = audit.rows.map((r) => r.event);
    expect(events).toContain("policy_synced");
  });
});
