import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { randomUUID, generateKeyPairSync, createHash } from "node:crypto";
import { PublicKey } from "@solana/web3.js";
import { InternalServerError } from "@privy-io/node";
import { buildServer } from "../../src/server.js";
import {
  createDatabaseClient,
  type DatabaseClient,
} from "../../src/db/client.js";
import { isValidSolanaAddress } from "../../src/memory/address.js";
import {
  EmbeddedWalletService,
  WalletConflictError,
  WalletUnavailableError,
} from "../../src/wallet/embedded.js";
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
  composedRulesHash,
  type GrantPolicyRule,
} from "../../src/wallet/policy/composer.js";

const databaseUrl = process.env.DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const APP_ID = "test-enroll-app";
const APP_SECRET = "test-enroll-secret";
const BASE = "https://mock.privy.test/v1";
const DID = "did:privy:enroll-user";
/** A real Solana recipient: enrollment now validates base58, never 0x. */
const SOL_RECIPIENT = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * A valid base58 Solana address derived from a seed. The embedded-wallet
 * service is Solana-only, so every wallet record handed to the Privy boundary
 * must be Solana-shaped (`chain_type: 'solana'` + base58 address) or the chain
 * filter drops it before any ownership proof is evaluated.
 */
function solanaAddress(seed: string): string {
  return new PublicKey(createHash("sha256").update(seed).digest()).toBase58();
}

async function provisionUser(
  database: DatabaseClient,
  did: string,
): Promise<string> {
  const result = await database.query<{ id: string }>(
    "SELECT users_ensure_for_privy_did($1, $2) AS id",
    [did, did],
  );
  return result.rows[0]!.id;
}

/**
 * Standard wallet read-back for the enroll user (owner + signer with policy).
 * Every wallet is chain_type 'solana' with a valid base58 address (a unique one
 * per provider id) because the service binds and lists the Solana family only.
 * Every wallet gets a UNIQUE provider id so test runs never collide on the
 * `provider_wallet_id` unique constraint across different users (which would trip
 * the user_wallets RLS USING check on an ON CONFLICT update).
 */
function enrollWallet(
  policyId: string,
  ownerId = "owner-key-quorum",
  id = `provider-wallet-${randomUUID()}`,
  address = solanaAddress(id),
): PrivyWalletRecord {
  return {
    id,
    address,
    chain_type: "solana",
    policy_ids: [],
    owner_id: ownerId,
    additional_signers: [
      { signer_id: "auth-signer-1", override_policy_ids: [policyId] },
    ],
    archived_at: null,
  };
}

function listPage(records: readonly PrivyWalletRecord[]): PrivyWalletPage {
  return {
    data: [...records],
    hasNextPage: () => false,
    getNextPage: async () => listPage([]),
  };
}

type ListCall = { user_id: string; chain_type: string };

/**
 * Builds a server client backed by an injected fake SDK client. The wallet
 * list (per chain) and the provider policy create are configurable so each
 * scenario can prove the contract without a live Privy call. `listCalls`
 * records the exact query the boundary handed the SDK.
 */
function mockServerClient(options: {
  policyId?: string;
  policyRules?: unknown[];
  list?: PrivyWalletRecord[];
  lists?: PrivyWalletRecord[][];
  listStatuses?: number[];
  solanaList?: PrivyWalletRecord[];
  solanaLists?: PrivyWalletRecord[][];
  solanaListStatuses?: number[];
  onSolanaList?: () => Promise<void>;
}): {
  client: PrivyServerClient;
  listCalls: ListCall[];
  createPolicy: ReturnType<typeof vi.fn>;
  getPolicy: ReturnType<typeof vi.fn>;
} {
  let listCall = 0;
  let solanaListCall = 0;
  const listCalls: ListCall[] = [];
  const list = async (params: { user_id: string; chain_type: string }) => {
    listCalls.push({ user_id: params.user_id, chain_type: params.chain_type });
    const isSolana = params.chain_type === "solana";
    const call = isSolana ? solanaListCall++ : listCall++;
    const status = isSolana
      ? (options.solanaListStatuses?.[call] ?? 200)
      : (options.listStatuses?.[call] ?? 200);
    const configured = isSolana
      ? (options.solanaLists?.[call] ?? options.solanaList ?? options.list ?? [])
      : (options.lists?.[call] ?? options.list ?? []);
    if (isSolana) await options.onSolanaList?.();
    if (status >= 400) {
      throw new InternalServerError(
        status,
        { error: "wallet_provider_unavailable" },
        undefined,
        new Headers(),
      );
    }
    return listPage(configured);
  };
  const unused = async () => {
    throw new Error("single-wallet SDK surface is unused in this scenario");
  };
  const createPolicy = vi.fn(async () => ({ id: options.policyId ?? "pol_1" }));
  // The applied-revision rule readback (design §3.4 step 3): the wallet's
  // applied policy must read back the rules `applied_rules_hash` was composed
  // from. Defaulting to an empty rule set keeps the negative cases negative.
  const getPolicy = vi.fn(async (id: string) => ({
    id,
    rules: options.policyRules ?? [],
  }));
  const wallets: PrivySdkWallets = { list, get: unused, update: unused };
  const client = new PrivyServerClient({
    appId: APP_ID,
    appSecret: APP_SECRET,
    client: {
      wallets: () => wallets,
      policies: () => ({ create: createPolicy, get: getPolicy, update: unused }),
    } as unknown as PrivySdkClient,
  });
  return { client, listCalls, createPolicy, getPolicy };
}

suite(
  "signer enrollment + owner-verified sync (PEW-014, privy mode, injected fetch)",
  () => {
    let database: DatabaseClient;
    let verifyPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    const previousEnv = { ...process.env };

    beforeAll(() => {
      database = createDatabaseClient(databaseUrl!);
      // Suite-wide test verification key (P-256, ES256) for the access-token
      // identity provider.
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      verifyPrivateKey = pair.privateKey;
      process.env.PRIVY_VERIFICATION_KEY = String(
        pair.publicKey.export({ type: "spki", format: "pem" }),
      );
      process.env.PRIVY_APP_ID = APP_ID;
      process.env.PRIVY_APP_SECRET = APP_SECRET;
      process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = "key-quorum-1";
      process.env.PRIVY_API_BASE_URL = BASE;
    });

    afterAll(async () => {
      await database.close();
      for (const key of [
        "PRIVY_APP_ID",
        "PRIVY_APP_SECRET",
        "PRIVY_VERIFICATION_KEY",
        "PRIVY_AUTHORIZATION_KEY_QUORUM_ID",
        "PRIVY_API_BASE_URL",
      ]) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key] as string;
      }
    });

    it("sync gives unprovisioned for zero owned wallets and never creates a server wallet", {
      timeout: 60_000,
    }, async () => {
      const userId = await provisionUser(
        database,
        `did:privy:zero-${randomUUID()}`,
      );
      const { client } = mockServerClient({ list: [] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const result = await service.syncWallet(userId);
      expect(result.state).toBe("unprovisioned");
      expect(result.address).toBe("");
      const rows = await database.query<{ count: string }>(
        "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1",
        [userId],
      );
      expect(rows.rows[0]?.count).toBe("0");
    });

    it("sync binds a single owned wallet to ready and is idempotent", {
      timeout: 60_000,
    }, async () => {
      const userId = await provisionUser(
        database,
        `did:privy:one-${randomUUID()}`,
      );
      const wallet = enrollWallet("pol_ignored", `did:privy:one-${randomUUID()}`);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const first = await service.syncWallet(userId);
      expect(first.state).toBe("ready");
      expect(first.created).toBe(true);
      // The bound address is the discovered Solana one, proven through the
      // repo's Solana validator instead of a retired EVM shape.
      expect(first.address).toBe(wallet.address);
      expect(isValidSolanaAddress(first.address)).toBe(true);
      const second = await service.syncWallet(userId);
      expect(second.created).toBe(false);
      expect(second.address).toBe(first.address);
    });

    it("demotes a stale ready binding when Privy no longer attributes a wallet to the user", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:removed-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = enrollWallet("pol_ignored");
      const { client } = mockServerClient({ solanaLists: [[wallet], []] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );

      expect((await service.syncWallet(userId)).state).toBe("ready");
      const removed = await service.syncWallet(userId);
      expect(removed).toMatchObject({ state: "unavailable", address: "" });
      await expect(service.getCurrentWallet(userId)).resolves.toMatchObject({
        state: "unavailable",
        address: "",
      });
    });

    it("fails the sync closed on a Privy outage and leaves the cached binding untouched", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sync-outage-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = enrollWallet("pol_ignored");
      const { client } = mockServerClient({
        solanaLists: [[wallet], [wallet]],
        solanaListStatuses: [200, 503],
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );

      expect((await service.syncWallet(userId)).state).toBe("ready");
      // Solana is the only chain, so a discovery outage IS the sync failing
      // closed: no binding change is attempted and the cached row keeps the
      // evidence it already had instead of being demoted on an unverified read.
      await expect(service.syncWallet(userId)).rejects.toBeInstanceOf(
        WalletUnavailableError,
      );
      await expect(service.getCurrentWallet(userId)).resolves.toMatchObject({
        state: "ready",
        address: wallet.address,
      });
    });

    it("serializes concurrent syncs so an older failure cannot overwrite a newer success", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sync-race-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = enrollWallet("pol_ignored");
      let callCount = 0;
      let activeLists = 0;
      let maxActiveLists = 0;
      let markFirstStarted!: () => void;
      let markSecondStarted!: () => void;
      let rejectFirst!: (reason: Error) => void;
      const firstStarted = new Promise<void>((resolve) => {
        markFirstStarted = resolve;
      });
      const secondStarted = new Promise<void>((resolve) => {
        markSecondStarted = resolve;
      });
      const list = async (): Promise<PrivyWalletPage> => {
        callCount += 1;
        activeLists += 1;
        maxActiveLists = Math.max(maxActiveLists, activeLists);
        if (callCount === 1) {
          markFirstStarted();
          try {
            return await new Promise<PrivyWalletPage>((_resolve, reject) => {
              rejectFirst = reject;
            });
          } finally {
            activeLists -= 1;
          }
        }

        markSecondStarted();
        activeLists -= 1;
        return listPage([wallet]);
      };
      const unused = async () => {
        throw new Error("single-wallet SDK surface is unused");
      };
      const client = new PrivyServerClient({
        appId: APP_ID,
        appSecret: APP_SECRET,
        requestTimeoutMs: 1_000,
        client: {
          wallets: () => ({ list, get: unused, update: unused }),
          policies: () => ({ create: unused, get: unused, update: unused }),
        } as unknown as PrivySdkClient,
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );

      const firstSync = service.syncWallet(userId);
      const firstResult = expect(firstSync).rejects.toBeInstanceOf(
        WalletUnavailableError,
      );
      await firstStarted;
      const secondSync = service.syncWallet(userId);
      const secondStartedBeforeRelease = await Promise.race([
        secondStarted.then(() => true),
        new Promise<false>((resolve) => setTimeout(() => resolve(false), 100)),
      ]);

      rejectFirst(new Error("older provider request failed"));
      await firstResult;
      await expect(secondSync).resolves.toMatchObject({
        state: "ready",
        address: wallet.address,
      });
      await expect(service.getCurrentWallet(userId)).resolves.toMatchObject({
        state: "ready",
        address: wallet.address,
      });
      expect(secondStartedBeforeRelease).toBe(false);
      expect(maxActiveLists).toBe(1);
    });

    it("atomically replaces a stale ready binding when Privy attributes a new wallet", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:replacement-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const firstWallet = enrollWallet(
        "pol_ignored",
        "owner-key-quorum",
        `provider-wallet-${randomUUID()}`,
      );
      const secondWallet = enrollWallet(
        "pol_ignored",
        "owner-key-quorum",
        `provider-wallet-${randomUUID()}`,
        solanaAddress(`replacement-${randomUUID()}`),
      );
      const { client } = mockServerClient({
        solanaLists: [[firstWallet], [secondWallet]],
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );

      await service.syncWallet(userId);
      const replaced = await service.syncWallet(userId);
      expect(replaced).toMatchObject({
        state: "ready",
        address: secondWallet.address,
      });
      const rows = await database.query<{
        provider_wallet_id: string;
        state: string;
      }>(
        "SELECT provider_wallet_id, state FROM user_wallets WHERE user_id = $1 ORDER BY provider_wallet_id",
        [userId],
      );
      expect(rows.rows).toEqual(
        expect.arrayContaining([
          { provider_wallet_id: firstWallet.id, state: "unavailable" },
          { provider_wallet_id: secondWallet.id, state: "ready" },
        ]),
      );
    });

    it("sync marks multiple owned wallets as conflict", {
      timeout: 60_000,
    }, async () => {
      const userId = await provisionUser(
        database,
        `did:privy:two-${randomUUID()}`,
      );
      const did = `did:privy:two-${randomUUID()}`;
      const { client } = mockServerClient({
        list: [enrollWallet("pol_a", did), enrollWallet("pol_b", did)],
      });

      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const result = await service.syncWallet(userId);
      expect(result.state).toBe("conflict");
    });

    it("prepare records no policy and fails visibly instead of reporting a permission nobody attached", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:prep-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const { client, createPolicy } = mockServerClient({
        list: [enrollWallet("pol_enroll_1")],
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await service.syncWallet(userId);

      // The composer is the only policy creator (task 1.8). A caller that used
      // to obtain a policy here and now cannot MUST fail visibly: never a
      // fabricated id, never a silent success, never a direct provider call.
      await expect(
        service.preparePermission(userId, [SOL_RECIPIENT]),
      ).rejects.toMatchObject({ failureClass: "blocked_configuration" });
      expect(createPolicy).not.toHaveBeenCalled();
      // Positive control: the enrollment DID persist its pending grant, so the
      // refusal happened after the durable enrollment record, not before it.
      const rows = await database.query<{
        state: string;
        provider_policy_id: string | null;
      }>(
        "SELECT state, provider_policy_id FROM signer_grants WHERE user_id = $1 LIMIT 1",
        [userId],
      );
      expect(rows.rows[0]).toEqual({
        state: "pending",
        provider_policy_id: null,
      });
    });

    it("does not activate when the attached signer policy differs from the stored grant", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:complete-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      // The provider wallet carries a signer with a DIFFERENT policy id:
      // ownership proves, but the stored grant's policy is not attached.
      const wallet = enrollWallet("pol_other");
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await service.syncWallet(userId);
      const localWallet = await service.getCurrentWallet(userId);
      await database.query(
        `INSERT INTO signer_grants
           (user_id, wallet_id, provider_policy_id, policy_hash, allowlisted_recipients,
            per_transfer_atomic6, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state)
           VALUES ($1, $2, 'pol_enroll_1', 'hash', '["0x1111111111111111111111111111111111111111"]'::jsonb,
                   '10000000', '50000000', 3600, '0.01', 'pending')`,
        [userId, localWallet.id],
      );

      const result = await service.completePermission(userId, localWallet.id);
      expect(result.verified).toBe(false);
      expect(result.observed?.policyAttached).toBe(false);
      const rows = await database.query<{ state: string }>(
        "SELECT state FROM signer_grants WHERE wallet_id = $1",
        [localWallet.id],
      );
      expect(rows.rows[0]?.state).toBe("pending");
    });

    it("never activates when the wallet disappears from the user's filtered list", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:ownership-loss-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = enrollWallet("pol_enroll_1");
      const { client } = mockServerClient({ solanaLists: [[wallet], []] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await service.syncWallet(userId);
      const localWallet = await service.getCurrentWallet(userId);
      await database.query(
        `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, policy_hash, allowlisted_recipients,
          per_transfer_atomic6, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state)
         VALUES ($1, $2, 'pol_enroll_1', 'hash', '["0x1111111111111111111111111111111111111111"]'::jsonb,
                 '10000000', '50000000', 3600, '0.01', 'pending')`,
        [userId, localWallet.id],
      );

      const result = await service.completePermission(userId, localWallet.id);
      expect(result.verified).toBe(false);
      const rows = await database.query<{ state: string }>(
        "SELECT state FROM signer_grants WHERE wallet_id = $1",
        [localWallet.id],
      );
      expect(rows.rows[0]?.state).toBe("pending");
    });

    it("never reports a real Privy grant revoked without provider removal and read-back", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:revoke-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = enrollWallet("pol_enroll_1");
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await service.syncWallet(userId);
      const localWallet = await service.getCurrentWallet(userId);
      await database.query(
        `INSERT INTO signer_grants
         (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
          allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
          rolling_window_seconds, gas_ceiling, state)
         VALUES ($1, $2, 'pol_enroll_1', 'auth-signer-1', 'hash',
                 '["0x1111111111111111111111111111111111111111"]'::jsonb,
                 '10000000', '50000000', 3600, '0.01', 'active')`,
        [userId, localWallet.id],
      );

      await expect(service.revokePermission(userId)).rejects.toBeInstanceOf(
        WalletUnavailableError,
      );
      const rows = await database.query<{ state: string }>(
        "SELECT state FROM signer_grants WHERE wallet_id = $1",
        [localWallet.id],
      );
      expect(rows.rows[0]?.state).toBe("revoking");
    });

    it("maps a provider failure during complete to unavailable and keeps the grant pending", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:complete-unavailable-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = enrollWallet("pol_enroll_1");
      const { client } = mockServerClient({
        solanaLists: [[wallet], [wallet]],
        solanaListStatuses: [200, 503],
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await service.syncWallet(userId);
      const localWallet = await service.getCurrentWallet(userId);
      await database.query(
        `INSERT INTO signer_grants
           (user_id, wallet_id, provider_policy_id, policy_hash, allowlisted_recipients,
            per_transfer_atomic6, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state)
           VALUES ($1, $2, 'pol_enroll_1', 'hash', '["0x1111111111111111111111111111111111111111"]'::jsonb,
                   '10000000', '50000000', 3600, '0.01', 'pending')`,
        [userId, localWallet.id],
      );

      await expect(
        service.completePermission(userId, localWallet.id),
      ).rejects.toBeInstanceOf(WalletUnavailableError);
      const rows = await database.query<{ state: string }>(
        "SELECT state FROM signer_grants WHERE wallet_id = $1",
        [localWallet.id],
      );
      expect(rows.rows[0]?.state).toBe("pending");
    });

    it("prepare is 503-readiness-blocked when the authorization quorum is not configured", {
      timeout: 60_000,
    }, async () => {
      const userId = await provisionUser(
        database,
        `did:privy:nq-${randomUUID()}`,
      );
      const { client } = mockServerClient({
        policyId: "pol_enroll_1",
        list: [enrollWallet("pol_enroll_1", `did:privy:nq-${randomUUID()}`)],
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        // no keyQuorumId configured
      );
      await service.syncWallet(userId);
      await expect(
        service.preparePermission(userId, [SOL_RECIPIENT]),
      ).rejects.toBeInstanceOf(WalletUnavailableError);
    });

    it("authenticated prepare endpoint fails visibly instead of reporting an enabled enrollment", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:route-${randomUUID()}`;
      const wallet = enrollWallet("pol_route", did);
      const { client } = mockServerClient({
        list: [wallet],
        policyId: "pol_route_1",
      });
      // Build the app with the injected mock server client.
      const app = buildServer({ privyServer: client });
      try {
        const token = await signToken(did, verifyPrivateKey);
        const sync = await app.inject({
          method: "POST",
          url: "/v1/wallets/sync",
          headers: { authorization: `Bearer ${token}` },
        });
        expect(sync.statusCode).toBe(200);
        expect(sync.json().data.state).toBe("ready");

        const prepare = await app.inject({
          method: "POST",
          url: "/v1/wallets/current/permission/prepare",
          headers: { authorization: `Bearer ${token}` },
          payload: {
            recipients: [SOL_RECIPIENT],
          },
        });
        // No policy can be composed in this slice, so the endpoint reports the
        // typed configuration conflict instead of a 200 with a permission the
        // caller would mistake for ready.
        expect(prepare.statusCode).toBe(409);
        expect(prepare.json().error.code).toBe("CONFLICTO_POLITICA");
        expect(JSON.stringify(prepare.json())).not.toContain(APP_SECRET);
      } finally {
        await app.close();
      }
    });

    it("rejects the legacy activation endpoint for an authenticated Privy user", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:legacy-activate-${randomUUID()}`;
      const { client } = mockServerClient({
        list: [enrollWallet("pol_legacy")],
      });
      const app = buildServer({ privyServer: client });
      try {
        const authorization = `Bearer ${await signToken(did, verifyPrivateKey)}`;
        const sync = await app.inject({
          method: "POST",
          url: "/v1/wallets/sync",
          headers: { authorization },
        });
        const userId = sync.json().data.userId as string;
        const activation = await app.inject({
          method: "POST",
          url: "/v1/wallets/current/permission",
          headers: { authorization },
          payload: {
            recipients: ["0x1111111111111111111111111111111111111111"],
          },
        });

        expect(activation.statusCode).toBe(503);
        expect(activation.json().error.code).toBe("WALLET_NO_DISPONIBLE");
        const rows = await database.query<{ count: string }>(
          "SELECT count(*)::text AS count FROM signer_grants WHERE user_id = $1",
          [userId],
        );
        expect(rows.rows[0]?.count).toBe("0");
      } finally {
        await app.close();
      }
    });

    it("reports a legacy active row honestly with the pending hourly limit", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:legacy-active-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const { client } = mockServerClient({
        list: [enrollWallet("pol_legacy")],
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await service.syncWallet(userId);
      const wallet = await service.getCurrentWallet(userId);
      await database.query(
        `INSERT INTO signer_grants
           (user_id, wallet_id, provider_policy_id, provider_signer_id, policy_hash,
            allowlisted_recipients, per_transfer_atomic6, rolling_total_atomic6,
            rolling_window_seconds, gas_ceiling, state)
           VALUES ($1, $2, 'pol_legacy', 'signer-legacy', 'legacy-hash',
                   '["0x1111111111111111111111111111111111111111"]'::jsonb,
                   '10000000', '50000000', 3600, '0.01', 'active')`,
        [userId, wallet.id],
      );

      // USER DECISION (2026-09-09): the real state is reported honestly; the
      // unenforced hourly limit stays visible, never 'unavailable'.
      await expect(service.getPermission(userId)).resolves.toMatchObject({
        state: "active",
        grantId: expect.any(String),
        aggregationReady: false,
        aggregateOvershootCaveat: true,
      });
    });

    it("authenticated sync maps Privy discovery failures to 503", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sync-unavailable-${randomUUID()}`;
      const { client } = mockServerClient({ solanaListStatuses: [503] });
      const app = buildServer({ privyServer: client });
      try {
        const response = await app.inject({
          method: "POST",
          url: "/v1/wallets/sync",
          headers: {
            authorization: `Bearer ${await signToken(did, verifyPrivateKey)}`,
          },
        });
        expect(response.statusCode).toBe(503);
        expect(response.json().error.code).toBe("WALLET_NO_DISPONIBLE");
        expect(response.json().error.message).not.toContain(
          "wallet_provider_unavailable",
        );
      } finally {
        await app.close();
      }
    });
  },
);

/** Signs a Privy-style ES256 access token for the given DID (suite verification key). */
async function signToken(
  did: string,
  verifyPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"],
): Promise<string> {
  const { SignJWT } = await import("jose");
  return new SignJWT({})
    .setProtectedHeader({ alg: "ES256" })
    .setSubject(did)
    .setIssuedAt(Math.floor(Date.now() / 1000) - 5)
    .setIssuer("privy.io")
    .setAudience(APP_ID)
    .setExpirationTime(Math.floor(Date.now() / 1000) + 300)
    .sign(verifyPrivateKey);
}

/**
 * Task 1.10 (solana-devnet-provider) — Solana signer enrollment contract RED
 * tests. These scenarios encode the spec delta's enrollment requirements:
 * durable signer snapshot in prepare (retry/restart-safe), exact-one new
 * signer vs snapshot, canonical stored-id reuse, signed attach + readback
 * BEFORE persistence, and fail-closed zero/multiple/conflict/readback paths.
 *
 * The current implementation has no signer snapshot, no snapshot diff, and
 * persists provider_signer_id on ANY policy-bearing signer match. These tests
 * are expected to fail RED until tasks 2.7/2.8 implement the Solana flow.
 */
suite(
  "Solana signer enrollment: snapshot, exact-one diff, signed attach/readback (task 1.10, RED)",
  () => {
    let database: DatabaseClient;
    let verifyPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
    const previousEnv = { ...process.env };

    beforeAll(() => {
      database = createDatabaseClient(databaseUrl!);
      const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
      verifyPrivateKey = pair.privateKey;
      process.env.PRIVY_VERIFICATION_KEY = String(
        pair.publicKey.export({ type: "spki", format: "pem" }),
      );
      process.env.PRIVY_APP_ID = APP_ID;
      process.env.PRIVY_APP_SECRET = APP_SECRET;
      process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = "key-quorum-1";
      process.env.PRIVY_API_BASE_URL = BASE;
    });

    afterAll(async () => {
      await database.close();
      for (const key of [
        "PRIVY_APP_ID",
        "PRIVY_APP_SECRET",
        "PRIVY_VERIFICATION_KEY",
        "PRIVY_AUTHORIZATION_KEY_QUORUM_ID",
        "PRIVY_API_BASE_URL",
      ]) {
        if (previousEnv[key] === undefined) delete process.env[key];
        else process.env[key] = previousEnv[key] as string;
      }
    });

    /** A Solana-chain Privy wallet record with configurable additional signers. */
    function solanaWallet(
      signers: PrivyWalletSigner[],
      id = `sol-wallet-${randomUUID()}`,
    ): PrivyWalletRecord {
      return {
        id,
        address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        chain_type: "solana",
        policy_ids: [],
        owner_id: "owner-key-quorum",
        additional_signers: signers,
        archived_at: null,
      };
    }

    async function insertPendingGrant(
      userId: string,
      walletId: string,
      policyId: string,
    ): Promise<void> {
      await database.query(
        `INSERT INTO signer_grants
           (user_id, wallet_id, provider_policy_id, policy_hash, allowlisted_recipients,
            per_transfer_atomic6, per_transfer_lamports, rolling_total_atomic6, rolling_window_seconds, gas_ceiling, state)
           VALUES ($1, $2, $3, 'hash', '["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"]'::jsonb,
                       '10000000', '10000000', '50000000', 3600, '0.01', 'pending')`,
        [userId, walletId, policyId],
      );
    }

    /**
     * The applied revision completion is verified against (design §3.4 step 3):
     * `applied_policy_id` plus the hash of the exact rules the policy reads
     * back, at `applied_revision = desired_revision`.
     */
    async function insertAppliedPolicyState(
      userId: string,
      walletId: string,
      policyId: string,
      rules: GrantPolicyRule[],
    ): Promise<void> {
      await database.query(
        `INSERT INTO recipient_policy_state
           (wallet_id, user_id, desired_revision, applied_revision, applied_policy_id,
            applied_rules_hash, applied_signer_id, status, verified_at)
         VALUES ($1, $2, 1, 1, $3, $4, 'signer-verified', 'applied', now())`,
        [walletId, userId, policyId, composedRulesHash(rules)],
      );
    }

    /** The rule set the applied policy reads back (one ordinary allowance rule). */
    const APPLIED_RULES: GrantPolicyRule[] = [
      {
        name: "Solana transfer allowlist",
        method: "signAndSendTransaction",
        action: "ALLOW",
        conditions: [],
      },
    ];

    /**
     * Inserts the ready Solana wallet row DIRECTLY (bypassing syncWallet,
     * which does not yet provision Solana rows — that is task 2.6's GREEN
     * step) and returns the local wallet UUID. The mock Privy client must
     * be configured with the SAME providerWalletId.
     */
    async function insertReadySolanaWallet(
      userId: string,
      providerWalletId: string,
      address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    ): Promise<string> {
      const result = await database.query<{ id: string }>(
        `INSERT INTO user_wallets
               (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
               VALUES ($1, 'privy', $2, 'solana', $3, 'ready', now())
               ON CONFLICT (provider_wallet_id) DO UPDATE
                 SET user_id = EXCLUDED.user_id,
                     address = EXCLUDED.address,
                     state = 'ready',
                     verified_at = now()
               RETURNING id`,
        [userId, providerWalletId, address],
      );
      return result.rows[0]!.id;
    }

    it("migration provides the durable enrollment snapshot column", async () => {
      const result = await database.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = current_schema()
             AND table_name = 'signer_grants'
             AND column_name = 'signer_enrollment_snapshot'
         ) AS exists`,
      );
      expect(result.rows[0]?.exists).toBe(true);
    });

    it("prepare persists a durable signer snapshot on the pending grant", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-prep-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      // Pre-consent signer list: the snapshot must capture this state.
      const wallet = solanaWallet([
        { signer_id: "pre-existing-signer-1", override_policy_ids: [] },
      ]);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await insertReadySolanaWallet(userId, wallet.id);

      // Prepare records the durable snapshot and then refuses visibly (the
      // composer owns the policy write, which this slice cannot perform).
      await expect(
        service.preparePermission(userId, [
          "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        ]),
      ).rejects.toMatchObject({ failureClass: "blocked_configuration" });
      // The pending grant must carry a persisted snapshot of the CURRENT
      // remote signer ids (pre-consent), so complete can diff against it.
      const rows = await database.query<{
        signer_enrollment_snapshot: unknown;
        per_transfer_lamports: string | null;
        provider_policy_id: string | null;
      }>(
        `SELECT signer_enrollment_snapshot, per_transfer_lamports, provider_policy_id FROM signer_grants WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      expect(rows.rows[0]?.signer_enrollment_snapshot).toEqual(
        expect.objectContaining({
          signerIds: expect.arrayContaining(["pre-existing-signer-1"]),
        }),
      );
      expect(rows.rows[0]?.per_transfer_lamports).toBe("10000000");
      // No policy id: the composer is the only policy creator.
      expect(rows.rows[0]?.provider_policy_id).toBeNull();
    });

    it("prepare retry preserves the original snapshot and pending grant (restart-safe)", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-prep-retry-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([
        { signer_id: "pre-existing-signer-1", override_policy_ids: [] },
      ]);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      await insertReadySolanaWallet(userId, wallet.id);
      await expect(
        service.preparePermission(userId, [
          "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        ]),
      ).rejects.toMatchObject({ failureClass: "blocked_configuration" });

      // Consent happens between prepare calls: the remote signer list now
      // contains a NEW signer. A retried prepare must NOT overwrite the
      // persisted pre-consent snapshot with the post-consent list.
      const postConsentWallet = solanaWallet(
        [
          { signer_id: "pre-existing-signer-1", override_policy_ids: [] },
          { signer_id: "new-signer-after-consent", override_policy_ids: [] },
        ],
        wallet.id,
      );
      const { client: retryClient } = mockServerClient({
        list: [postConsentWallet],
      });
      const retryService = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        retryClient,
        { keyQuorumId: "key-quorum-1" },
      );
      await expect(
        retryService.preparePermission(userId, [
          "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
        ]),
      ).rejects.toMatchObject({ failureClass: "blocked_configuration" });

      const rows = await database.query<{
        signer_enrollment_snapshot: unknown;
      }>(
        `SELECT signer_enrollment_snapshot FROM signer_grants WHERE user_id = $1 LIMIT 1`,
        [userId],
      );
      const snapshot = rows.rows[0]?.signer_enrollment_snapshot as {
        signerIds: string[];
      } | null;
      expect(snapshot?.signerIds).not.toContain("new-signer-after-consent");
      expect(snapshot?.signerIds).toContain("pre-existing-signer-1");
    });

    it("complete binds exactly-one new signer vs snapshot and stores the canonical id", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-exact-one-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([
        { signer_id: "pre-existing-signer-1", override_policy_ids: [] },
      ]);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const localWalletId = await insertReadySolanaWallet(userId, wallet.id);
      await insertPendingGrant(userId, localWalletId, "pol_solana_1");
      await insertAppliedPolicyState(
        userId,
        localWalletId,
        "pol_solana_1",
        APPLIED_RULES,
      );

      // After consent: the pre-existing signer plus EXACTLY ONE new signer
      // carrying the pending policy.
      const postConsentWallet = solanaWallet(
        [
          { signer_id: "pre-existing-signer-1", override_policy_ids: [] },
          {
            signer_id: "new-sol-signer",
            override_policy_ids: ["pol_solana_1"],
          },
        ],
        wallet.id,
      );
      const { client: completeClient } = mockServerClient({
        list: [postConsentWallet],
        policyRules: APPLIED_RULES,
      });
      const completeService = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        completeClient,
        { keyQuorumId: "key-quorum-1" },
      );

      const result = await completeService.completePermission(
        userId,
        localWalletId,
      );
      expect(result.verified).toBe(true);
      expect(result.permission).toMatchObject({
        perTransferUsdc: "",
        perTransferSol: "0.01",
      });
      // The canonical binding must be the exact new signer id, never the
      // quorum id, a list position, or another grant's signer.
      const rows = await database.query<{ provider_signer_id: string | null }>(
        "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
        [localWalletId],
      );
      expect(rows.rows[0]?.provider_signer_id).toBe("new-sol-signer");
    });

    it("complete reuses the canonical stored signer id when present after remote readback", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-reuse-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([
        {
          signer_id: "canonical-signer",
          override_policy_ids: ["pol_solana_1"],
        },
      ]);
      const { client } = mockServerClient({
        list: [wallet],
        policyRules: APPLIED_RULES,
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const localWalletId = await insertReadySolanaWallet(userId, wallet.id);
      // Canonical binding already stored by a prior verified enrollment.
      await database.query(
        "UPDATE user_wallets SET provider_signer_id = 'canonical-signer' WHERE id = $1",
        [localWalletId],
      );
      await insertPendingGrant(userId, localWalletId, "pol_solana_1");
      await insertAppliedPolicyState(
        userId,
        localWalletId,
        "pol_solana_1",
        APPLIED_RULES,
      );

      const result = await service.completePermission(userId, localWalletId);
      expect(result.verified).toBe(true);
      // A client retry after the first request committed must return the same
      // verified result rather than treating the now-active grant as missing.
      const retry = await service.completePermission(userId, localWalletId);
      expect(retry.verified).toBe(true);
      // Reuse, never re-selection: the stored id must remain exactly the same.
      const rows = await database.query<{ provider_signer_id: string | null }>(
        "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
        [localWalletId],
      );
      expect(rows.rows[0]?.provider_signer_id).toBe("canonical-signer");
    });

    it("does not activate a grant when a concurrent enrollment wins the canonical signer binding", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-binding-race-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([]);
      const localWalletId = await insertReadySolanaWallet(userId, wallet.id);
      await insertPendingGrant(userId, localWalletId, "pol_solana_1");

      // Model another complete request persisting a different verified id
      // after this request read NULL, but before its guarded UPDATE.
      const { client } = mockServerClient({
        solanaList: [
          solanaWallet(
            [{ signer_id: "candidate-signer", override_policy_ids: ["pol_solana_1"] }],
            wallet.id,
          ),
        ],
        onSolanaList: async () => {
          await database.query(
            "UPDATE user_wallets SET provider_signer_id = 'concurrent-signer' WHERE id = $1",
            [localWalletId],
          );
        },
      });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );

      const result = await service.completePermission(userId, localWalletId);
      expect(result.verified).toBe(false);
      const binding = await database.query<{ provider_signer_id: string | null }>(
        "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
        [localWalletId],
      );
      expect(binding.rows[0]?.provider_signer_id).toBe("concurrent-signer");
      const grant = await database.query<{ state: string; provider_signer_id: string | null }>(
        "SELECT state, provider_signer_id FROM signer_grants WHERE wallet_id = $1",
        [localWalletId],
      );
      expect(grant.rows[0]).toEqual({
        state: "pending",
        provider_signer_id: null,
      });
    });

    it("complete writes NO binding when multiple new signers appear vs the snapshot", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-multi-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([]);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const localWalletId = await insertReadySolanaWallet(userId, wallet.id);
      await insertPendingGrant(userId, localWalletId, "pol_solana_1");

      // Two NEW signers vs the empty snapshot: ambiguity, fail closed.
      const ambiguousWallet = solanaWallet(
        [
          { signer_id: "new-signer-a", override_policy_ids: ["pol_solana_1"] },
          { signer_id: "new-signer-b", override_policy_ids: ["pol_solana_1"] },
        ],
        wallet.id,
      );
      const { client: completeClient } = mockServerClient({
        list: [ambiguousWallet],
      });
      const completeService = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        completeClient,
        { keyQuorumId: "key-quorum-1" },
      );

      const result = await completeService.completePermission(
        userId,
        localWalletId,
      );
      expect(result.verified).toBe(false);
      const rows = await database.query<{ provider_signer_id: string | null }>(
        "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
        [localWalletId],
      );
      expect(rows.rows[0]?.provider_signer_id).toBeNull();
      const grants = await database.query<{ state: string }>(
        "SELECT state FROM signer_grants WHERE wallet_id = $1",
        [localWalletId],
      );
      expect(grants.rows[0]?.state).toBe("pending");
    });

    it("complete stays pending with NO binding when zero new signers appear", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-zero-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([
        { signer_id: "pre-existing-signer-1", override_policy_ids: [] },
      ]);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const localWalletId = await insertReadySolanaWallet(userId, wallet.id);
      await insertPendingGrant(userId, localWalletId, "pol_solana_1");

      // Consent did not produce any new signer: complete must keep the
      // enrollment pending and write no canonical id.
      const result = await service.completePermission(userId, localWalletId);
      expect(result.verified).toBe(false);
      const rows = await database.query<{ provider_signer_id: string | null }>(
        "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
        [localWalletId],
      );
      expect(rows.rows[0]?.provider_signer_id).toBeNull();
    });

    it("complete writes NO binding when policy readback is missing on the discovered signer", {
      timeout: 60_000,
    }, async () => {
      const did = `did:privy:sol-readback-${randomUUID()}`;
      const userId = await provisionUser(database, did);
      const wallet = solanaWallet([]);
      const { client } = mockServerClient({ list: [wallet] });
      const service = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        client,
        { keyQuorumId: "key-quorum-1" },
      );
      const localWalletId = await insertReadySolanaWallet(userId, wallet.id);
      await insertPendingGrant(userId, localWalletId, "pol_solana_1");

      // One new signer appeared but carries NO policy: attach/readback never
      // succeeded, so nothing may be persisted.
      const noPolicyWallet = solanaWallet(
        [{ signer_id: "new-sol-signer", override_policy_ids: [] }],
        wallet.id,
      );
      const { client: completeClient } = mockServerClient({
        list: [noPolicyWallet],
      });
      const completeService = new EmbeddedWalletService(
        database,
        createPrivyWalletApiClient(process.env, {}),
        completeClient,
        { keyQuorumId: "key-quorum-1" },
      );

      const result = await completeService.completePermission(
        userId,
        localWalletId,
      );
      expect(result.verified).toBe(false);
      const rows = await database.query<{ provider_signer_id: string | null }>(
        "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
        [localWalletId],
      );
      expect(rows.rows[0]?.provider_signer_id).toBeNull();
      const grants = await database.query<{ state: string }>(
        "SELECT state FROM signer_grants WHERE wallet_id = $1",
        [localWalletId],
      );
      expect(grants.rows[0]?.state).toBe("pending");
    });
  },
);

/**
 * Task 2.6 (solana-devnet-provider) — chain-aware authenticated Solana sync.
 * Exactly one `chain_type: 'solana'` Privy wallet with a
 * valid base58 address upserts a ready `user_wallets` row
 * (chain_family 'solana', same provider_wallet_id/address) and NEVER writes
 * provider_signer_id; zero/multiple/listing-failure fail closed without
 * promoting, deleting, or fabricating bindings; Ethereum behavior unchanged.
 */
suite("chain-aware authenticated Solana wallet sync (task 2.6)", () => {
  let database: DatabaseClient;
  let verifyPrivateKey: ReturnType<typeof generateKeyPairSync>["privateKey"];
  const previousEnv = { ...process.env };

  beforeAll(() => {
    database = createDatabaseClient(databaseUrl!);
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    verifyPrivateKey = pair.privateKey;
    process.env.PRIVY_VERIFICATION_KEY = String(
      pair.publicKey.export({ type: "spki", format: "pem" }),
    );
    process.env.PRIVY_APP_ID = APP_ID;
    process.env.PRIVY_APP_SECRET = APP_SECRET;
    process.env.PRIVY_AUTHORIZATION_KEY_QUORUM_ID = "key-quorum-1";
    process.env.PRIVY_API_BASE_URL = BASE;
  });

  afterAll(async () => {
    await database.close();
    for (const key of [
      "PRIVY_APP_ID",
      "PRIVY_APP_SECRET",
      "PRIVY_VERIFICATION_KEY",
      "PRIVY_AUTHORIZATION_KEY_QUORUM_ID",
      "PRIVY_API_BASE_URL",
    ]) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key] as string;
    }
  });

  /** A Privy wallet record with an explicit chain_type for sync scenarios. */
  function privyWallet(
    chainType: string,
    address: string,
    id = `sync-wallet-${randomUUID()}`,
  ): PrivyWalletRecord {
    return {
      id,
      address,
      chain_type: chainType,
      policy_ids: [],
      owner_id: "owner-key-quorum",
      additional_signers: [],
      archived_at: null,
    };
  }

  async function solanaReadyRowCount(userId: string): Promise<string> {
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1 AND chain_family = 'solana' AND state = 'ready'",
      [userId],
    );
    return rows.rows[0]?.count ?? "0";
  }

  /**
   * Asserts the client listed wallets through Privy's authenticated
   * user_id filter restricted to chain_type=solana, by inspecting the exact
   * parameters the boundary handed to the SDK.
   */
  function expectSolanaListingCall(
    listCalls: readonly ListCall[],
    did: string,
  ): void {
    const solanaListings = listCalls.filter(
      (call) => call.user_id === did && call.chain_type === "solana",
    );
    expect(solanaListings.length).toBeGreaterThan(0);
  }

  it("sync provisions exactly one valid Solana wallet as a ready row without writing provider_signer_id", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-one-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const wallet = privyWallet(
      "solana",
      "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
    );
    const { client, listCalls } = mockServerClient({ list: [wallet] });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    const result = await service.syncWallet(userId);
    expect(result.created).toBe(true);
    // Discovery must list ONLY the authenticated user's wallets restricted
    // to the solana chain (user_id + chain_type query contract).
    expectSolanaListingCall(listCalls, did);
    const rows = await database.query<{
      id: string;
      provider_wallet_id: string;
      address: string;
      state: string;
      provider_signer_id: string | null;
    }>(
      "SELECT id, provider_wallet_id, address, state, provider_signer_id FROM user_wallets WHERE user_id = $1 AND chain_family = 'solana'",
      [userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({
      provider_wallet_id: wallet.id,
      address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
      state: "ready",
    });
    // Discovery NEVER writes the canonical signer binding; only verified
    // enrollment readback may set it.
    expect(rows.rows[0]?.provider_signer_id).toBeNull();

    // A later discovery refresh may update provider metadata but must preserve
    // a canonical signer id previously written by verified enrollment.
    await database.query(
      "UPDATE user_wallets SET provider_signer_id = $2 WHERE id = $1",
      [rows.rows[0]!.id, "verified-solana-signer"],
    );
    const refreshed = await service.syncWallet(userId);
    expect(refreshed.state).toBe("ready");
    expect(refreshed.created).toBe(false);
    const refreshedRows = await database.query<{
      provider_signer_id: string | null;
    }>(
      "SELECT provider_signer_id FROM user_wallets WHERE id = $1",
      [rows.rows[0]!.id],
    );
    expect(refreshedRows.rows[0]?.provider_signer_id).toBe(
      "verified-solana-signer",
    );
  });

  it("sync reports conflict without a ready row when multiple Solana wallets exist", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-multi-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const { client, listCalls } = mockServerClient({
      list: [
        privyWallet("solana", "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"),
        privyWallet("solana", "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq"),
      ],
    });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    const result = await service.syncWallet(userId);
    expect(result.state).toBe("conflict");
    // The conflicting discovery still goes through the authenticated
    // solana-restricted listing.
    expectSolanaListingCall(listCalls, did);
    expect(await solanaReadyRowCount(userId)).toBe("0");
  });

  it("does not let a Solana wallet id overwrite an Arc binding", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-cross-chain-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const providerWalletId = `shared-provider-wallet-${randomUUID()}`;
    const arcAddress = "0x1111111111111111111111111111111111111111";
    const solanaAddress = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    await database.query(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, 'privy', $2, 'arc', $3, 'ready', now())`,
      [userId, providerWalletId, arcAddress],
    );
    const { client } = mockServerClient({
      list: [
        privyWallet("ethereum", arcAddress, providerWalletId),
        privyWallet("solana", solanaAddress, providerWalletId),
      ],
    });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    await expect(service.syncWallet(userId)).rejects.toBeInstanceOf(
      WalletConflictError,
    );
    const rows = await database.query<{
      chain_family: string;
      address: string;
      state: string;
    }>(
      "SELECT chain_family, address, state FROM user_wallets WHERE provider_wallet_id = $1",
      [providerWalletId],
    );
    expect(rows.rows).toEqual([
      { chain_family: "arc", address: arcAddress, state: "ready" },
    ]);
    expect(await solanaReadyRowCount(userId)).toBe("0");
  });

  it("sync creates no Solana row when the authenticated list has zero Solana wallets", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-zero-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const { client, listCalls } = mockServerClient({
      list: [
        privyWallet("ethereum", "0x1111111111111111111111111111111111111111"),
      ],
    });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    // Zero Solana wallets is an exercised sync path, not an inert one: the
    // non-Solana record is dropped by the chain filter, so NO binding of any
    // chain family may be fabricated from it.
    const result = await service.syncWallet(userId);
    expect(result.state).toBe("unprovisioned");
    expect(result.address).toBe("");
    // The authenticated listing must still target the solana chain so the
    // empty result is authoritative, not an accidental ethereum-only read.
    expectSolanaListingCall(listCalls, did);
    expect(result.created).toBe(false);
    const rows = await database.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM user_wallets WHERE user_id = $1",
      [userId],
    );
    expect(rows.rows[0]?.count).toBe("0");
    expect(await solanaReadyRowCount(userId)).toBe("0");
  });

  it("demotes a cached Solana binding to unavailable, but never deletes the row, when the authenticated list has no Solana wallet", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-empty-existing-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const providerWalletId = `existing-sol-wallet-${randomUUID()}`;
    const address = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
    await database.query(
      `INSERT INTO user_wallets
         (user_id, provider, provider_wallet_id, chain_family, address, state, verified_at)
       VALUES ($1, 'privy', $2, 'solana', $3, 'ready', now())`,
      [userId, providerWalletId, address],
    );
    const { client, listCalls } = mockServerClient({
      list: [
        privyWallet(
          "ethereum",
          "0x1111111111111111111111111111111111111111",
        ),
      ],
    });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    const result = await service.syncWallet(userId);
    expectSolanaListingCall(listCalls, did);
    // An empty trusted Solana result revokes the evidence behind the cached
    // ready binding: readiness fails closed while the row stays for audit.
    expect(result.state).toBe("unavailable");
    expect(result.address).toBe("");
    const rows = await database.query<{
      provider_wallet_id: string;
      address: string;
      state: string;
    }>(
      "SELECT provider_wallet_id, address, state FROM user_wallets WHERE user_id = $1 AND chain_family = 'solana'",
      [userId],
    );
    expect(rows.rows).toEqual([
      { provider_wallet_id: providerWalletId, address, state: "unavailable" },
    ]);
  });

  it("sync fails closed as wallet_unavailable without a Solana row when Privy listing fails", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-outage-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const { client, listCalls } = mockServerClient({
      solanaListStatuses: [503],
    });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    await expect(service.syncWallet(userId)).rejects.toBeInstanceOf(
      WalletUnavailableError,
    );
    // The outage path must still have attempted the authenticated,
    // solana-restricted listing before failing closed.
    expectSolanaListingCall(listCalls, did);
    expect(await solanaReadyRowCount(userId)).toBe("0");
  });

  it("sync does not provision a Solana wallet whose address is not valid base58", {
    timeout: 60_000,
  }, async () => {
    const did = `did:privy:sol-sync-invalid-${randomUUID()}`;
    const userId = await provisionUser(database, did);
    const { client, listCalls } = mockServerClient({
      list: [privyWallet("solana", "0xdeadbeefnotbase58!!!")],
    });
    const service = new EmbeddedWalletService(
      database,
      createPrivyWalletApiClient(process.env, {}),
      client,
      { keyQuorumId: "key-quorum-1" },
    );

    await service.syncWallet(userId);
    // The invalid-address wallet was still discovered through the
    // authenticated solana listing before being rejected.
    expectSolanaListingCall(listCalls, did);
    expect(await solanaReadyRowCount(userId)).toBe("0");
  });
});
