import { describe, expect, it, vi } from "vitest";
import { ConflictError, InternalServerError, NotFoundError } from "@privy-io/node";
import {
  PrivyServerClient,
  PrivyServerError,
  type PrivySdkClient,
  type PrivySdkPolicies,
  type PrivySdkWallets,
  type PrivyWalletPage,
  type PrivyWalletRecord,
} from "../../src/wallet/privy-server-client.js";

/**
 * Contract tests for the server-side Privy boundary. The SDK owns transport,
 * signing and pagination, so these tests inject a fake SDK client implementing
 * the narrow surface the boundary uses and assert BEHAVIOUR: the exact query
 * the SDK is asked for, ownership by exact membership, the fail-closed
 * pagination cap, the signer-scoped attach with readback, and typed error
 * surfacing that never leaks the app secret or the authorization key.
 */

const APP_ID = "client-id";
const APP_SECRET = "app-secret-value";

function walletRecord(
  id: string,
  overrides: Partial<PrivyWalletRecord> = {},
): PrivyWalletRecord {
  return {
    id,
    address: "0x0000000000000000000000000000000000000001",
    chain_type: "ethereum",
    policy_ids: [],
    owner_id: "key-quorum-owner",
    additional_signers: [],
    archived_at: null,
    ...overrides,
  };
}

/** Builds one SDK cursor page; `getNext` drives `hasNextPage`. */
function page(
  items: PrivyWalletRecord[],
  getNext?: () => Promise<PrivyWalletPage>,
): PrivyWalletPage {
  return {
    data: items,
    hasNextPage: () => Boolean(getNext),
    getNextPage: () => {
      if (!getNext) throw new Error("no next page");
      return getNext();
    },
  };
}

/** Builds a fake SDK client over only the surface the boundary uses. */
function sdkClient(
  overrides: {
    wallets?: Partial<PrivySdkWallets>;
    policies?: Partial<PrivySdkPolicies>;
  } = {},
): PrivySdkClient {
  const wallets: PrivySdkWallets = {
    list: vi.fn(async () => page([])),
    get: vi.fn(async () => walletRecord("wallet-none")),
    update: vi.fn(async () => walletRecord("wallet-none")),
    ...overrides.wallets,
  };
  const policies: PrivySdkPolicies = {
    create: vi.fn(async () => ({ id: "policy-none" })),
    get: vi.fn(async () => ({ id: "policy-none" })),
    update: vi.fn(async () => ({ id: "policy-none" })),
    ...overrides.policies,
  };
  return { wallets: () => wallets, policies: () => policies };
}

describe("PrivyServerClient (official SDK boundary)", () => {
  it("lists all active Ethereum wallets through the SDK's trusted user_id filter", async () => {
    const secondPage = page([
      walletRecord("wallet-2"),
      walletRecord("archived", { archived_at: 123 }),
    ]);
    const firstPage = page([walletRecord("wallet-1")], async () => secondPage);
    const list = vi.fn(async () => firstPage);
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { list } }),
    });

    const wallets = await client.listWalletsForUser("did:privy:user-1");

    expect(wallets.map((wallet) => wallet.id)).toEqual([
      "wallet-1",
      "wallet-2",
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list).toHaveBeenCalledWith({
      user_id: "did:privy:user-1",
      chain_type: "ethereum",
      limit: 100,
    });
  });

  it("lists active wallets for one authenticated chain", async () => {
    const list = vi.fn(async () =>
      page([
        walletRecord("sol-wallet", {
          address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
          chain_type: "solana",
        }),
        walletRecord("ethereum-wallet"),
        walletRecord("archived-sol-wallet", {
          chain_type: "solana",
          archived_at: 123,
        }),
      ]),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { list } }),
    });

    await expect(
      client.listWalletsForChain("did:privy:user-1", "solana"),
    ).resolves.toMatchObject([{ id: "sol-wallet", chain_type: "solana" }]);
    expect(list).toHaveBeenCalledWith({
      user_id: "did:privy:user-1",
      chain_type: "solana",
      limit: 100,
    });
  });

  it("fails closed when a chain wallet list exceeds the pagination cap", async () => {
    let pageFetches = 0;
    const infinitePage = (): PrivyWalletPage => {
      pageFetches += 1;
      return {
        data: [
          walletRecord("sol-wallet", {
            address: "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM",
            chain_type: "solana",
          }),
        ],
        hasNextPage: () => true,
        getNextPage: async () => infinitePage(),
      };
    };
    const list = vi.fn(async () => infinitePage());
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { list } }),
    });

    await expect(
      client.listWalletsForChain("did:privy:user-1", "solana"),
    ).rejects.toMatchObject({ status: 502, name: "PrivyServerError" });
    // Cap is 100 pages at limit 100: the 100th page is fetched, the 101st is
    // refused instead of looping forever.
    expect(pageFetches).toBe(100);
  });

  it("verifies ownership by exact membership in the user-filtered list", async () => {
    const list = vi.fn(async () => page([walletRecord("wallet-9")]));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { list } }),
    });

    await expect(
      client.getVerifiedWalletForUser("did:privy:user-1", "wallet-9"),
    ).resolves.toMatchObject({ id: "wallet-9", owner_id: "key-quorum-owner" });
    await expect(
      client.getVerifiedWalletForUser("did:privy:user-1", "wallet-forged"),
    ).rejects.toMatchObject({ status: 404 });
  });

  it("rejects legacy owner/signers response shapes instead of treating them as ownership evidence", async () => {
    const legacy = {
      id: "wallet-legacy",
      address: "0x0000000000000000000000000000000000000001",
      chain_type: "ethereum",
      owner: "did:privy:user-1",
      signers: [],
    } as unknown as PrivyWalletRecord;
    const list = vi.fn(async () => page([legacy]));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { list } }),
    });

    await expect(
      client.listWalletsForUser("did:privy:user-1"),
    ).rejects.toMatchObject({
      status: 502,
    });
  });

  it("getWallet reads back the record through the SDK", async () => {
    const get = vi.fn(async () =>
      walletRecord("wallet-9", {
        address: "0x0000000000000000000000000000000000000009",
        additional_signers: [
          { signer_id: "signer-1", override_policy_ids: ["pol_abc"] },
        ],
      }),
    );
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { get } }),
    });

    const wallet = await client.getWallet("wallet-9");
    expect(wallet.id).toBe("wallet-9");
    expect(wallet.owner_id).toBe("key-quorum-owner");
    expect(get).toHaveBeenCalledWith("wallet-9");
  });

  it("createPolicy serializes version/chain_type/rules through the SDK and returns {id}", async () => {
    const rules = [
      {
        field_source: "ethereum_transaction" as const,
        field: "chain_id",
        operator: "eq",
        value: 5042002,
      },
    ];
    const create = vi.fn(async () => ({ id: "pol_new" }));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ policies: { create } }),
    });

    const { id } = await client.createPolicy("my-policy", rules);
    expect(id).toBe("pol_new");
    expect(create).toHaveBeenCalledWith({
      version: "1.0",
      name: "my-policy",
      chain_type: "ethereum",
      rules,
    });
  });

  it("createPolicy serializes chain_type solana when requested", async () => {
    const solanaRules = [
      {
        method: "signAndSendTransaction" as const,
        field_source: "solana_system_program_instruction" as const,
        field: "Transfer.to",
        operator: "in" as const,
        value: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
      },
    ];
    const create = vi.fn(async () => ({ id: "pol_sol" }));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ policies: { create } }),
    });

    const { id } = await client.createPolicy("sol-policy", solanaRules, {
      chainType: "solana",
    });
    expect(id).toBe("pol_sol");
    expect(create).toHaveBeenCalledWith({
      version: "1.0",
      name: "sol-policy",
      chain_type: "solana",
      rules: solanaRules,
    });
  });

  it("getPolicy returns the SDK policy record", async () => {
    const get = vi.fn(async () => ({ id: "pol_abc", version: "1.0", rules: [] }));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ policies: { get } }),
    });

    const policy = await client.getPolicy("pol_abc");
    expect(policy.id).toBe("pol_abc");
    expect(policy.rules).toEqual([]);
    expect(get).toHaveBeenCalledWith("pol_abc");
  });

  it("patchPolicy sends the exact rules through the SDK (unsigned without a key)", async () => {
    const rules = [
      {
        method: "signAndSendTransaction" as const,
        field_source: "solana_system_program_instruction" as const,
        field: "Transfer.to",
        operator: "in" as const,
        value: ["9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM"],
      },
    ];
    const update = vi.fn(async () => ({ id: "pol_abc", rules }));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ policies: { update } }),
    });

    await expect(
      client.patchPolicy("pol_abc", rules),
    ).resolves.toMatchObject({ id: "pol_abc" });
    expect(update).toHaveBeenCalledWith("pol_abc", { rules });
  });

  it("patchPolicy delegates authorization signing to the SDK when a key is configured", async () => {
    const update = vi.fn(async () => ({ id: "pol_abc" }));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey: "test-p256-private-key",
      client: sdkClient({ policies: { update } }),
    });

    await client.patchPolicy("pol_abc", []);
    const [, params] = update.mock.calls[0] as unknown as [
      string,
      { authorization_context?: unknown },
    ];
    expect(params.authorization_context).toEqual({
      authorization_private_keys: ["test-p256-private-key"],
    });
  });

  it("surfaces a typed PrivyServerError with status + provider code but NEVER the secret", async () => {
    const create = vi.fn(async () => {
      throw new ConflictError(
        409,
        { error: "policy_conflict", message: "already exists" },
        undefined,
        new Headers(),
      );
    });
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ policies: { create } }),
    });

    const error = await client.createPolicy("p", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrivyServerError);
    const typed = error as PrivyServerError;
    expect(typed.status).toBe(409);
    expect(typed.providerCode).toBe("policy_conflict");
    expect(typed.message).not.toContain(APP_SECRET);
    expect(typed.message).not.toContain(APP_ID);
  });

  it("maps an SDK 404 into a PrivyServerError without leaking the secret", async () => {
    const get = vi.fn(async () => {
      throw new NotFoundError(
        404,
        { error: "wallet_not_found" },
        undefined,
        new Headers(),
      );
    });
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: "short-secret",
      client: sdkClient({ wallets: { get } }),
    });

    const error = await client.getWallet("wallet-1").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrivyServerError);
    expect((error as PrivyServerError).status).toBe(404);
    expect((error as PrivyServerError).providerCode).toBe("wallet_not_found");
    expect((error as PrivyServerError).message).not.toContain("short-secret");
  });

  it("never leaks the authorization private key when a signed mutation fails", async () => {
    const authorizationPrivateKey = "test-p256-private-key";
    const get = vi.fn(async () =>
      walletRecord("wallet-9", {
        additional_signers: [{ signer_id: "signer-1" }],
      }),
    );
    const update = vi.fn(async () => {
      throw new InternalServerError(
        500,
        { error: "provider_fault" },
        undefined,
        new Headers(),
      );
    });
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey,
      client: sdkClient({ wallets: { get, update } }),
    });

    const error = await client
      .addPolicyToSigner("wallet-9", "signer-1", "pol_solana")
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrivyServerError);
    expect((error as PrivyServerError).status).toBe(500);
    expect((error as PrivyServerError).providerCode).toBe("provider_fault");
    expect((error as PrivyServerError).message).not.toContain(
      authorizationPrivateKey,
    );
  });

  it("bounds the real SDK request with the configured timeout", async () => {
    const fetchMock = vi.fn(
      async (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      const client = new PrivyServerClient({
        appId: APP_ID,
        appSecret: APP_SECRET,
        requestTimeoutMs: 20,
      });

      const error = await client
        .listWalletsForUser("did:privy:user-1")
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PrivyServerError);
      expect((error as PrivyServerError).status).toBe(502);
      // The deadline is enforced on the underlying request: never dropped.
      expect(
        fetchMock.mock.calls[0]?.[1]?.signal?.aborted,
      ).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("PrivyServerClient canonical signer policy attachment", () => {
  it("attaches to the exact signer, preserves siblings, and verifies readback", async () => {
    const before = walletRecord("wallet-9", {
      chain_type: "solana",
      additional_signers: [
        { signer_id: "signer-1", override_policy_ids: [], label: "target" },
        { signer_id: "sibling-1", override_policy_ids: ["sibling-policy"] },
      ],
    });
    const after = walletRecord("wallet-9", {
      chain_type: "solana",
      additional_signers: [
        {
          signer_id: "signer-1",
          override_policy_ids: ["pol_solana"],
          label: "target",
        },
        { signer_id: "sibling-1", override_policy_ids: ["sibling-policy"] },
      ],
    });
    const get = vi
      .fn()
      .mockResolvedValueOnce(before)
      .mockResolvedValueOnce(after);
    const update = vi.fn(async () => after);
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey: "test-p256-private-key",
      client: sdkClient({ wallets: { get, update } }),
    });

    await client.addPolicyToSigner("wallet-9", "signer-1", "pol_solana");

    expect(get).toHaveBeenCalledTimes(2);
    expect(get).toHaveBeenNthCalledWith(1, "wallet-9");
    expect(update).toHaveBeenCalledTimes(1);
    const [walletId, params] = update.mock.calls[0] as unknown as [
      string,
      {
        additional_signers?: unknown;
        authorization_context?: { authorization_private_keys?: string[] };
      },
    ];
    expect(walletId).toBe("wallet-9");
    expect(params.additional_signers).toEqual(after.additional_signers);
    expect(params.authorization_context).toEqual({
      authorization_private_keys: ["test-p256-private-key"],
    });
  });

  it("refuses to overwrite another policy already attached to the canonical signer", async () => {
    const get = vi.fn(async () =>
      walletRecord("wallet-9", {
        additional_signers: [
          { signer_id: "signer-1", override_policy_ids: ["other-policy"] },
        ],
      }),
    );
    const update = vi.fn(async () => walletRecord("wallet-9"));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey: "test-p256-private-key",
      client: sdkClient({ wallets: { get, update } }),
    });

    await expect(
      client.addPolicyToSigner("wallet-9", "signer-1", "pol_solana"),
    ).rejects.toThrow(/existing policy/i);
    expect(get).toHaveBeenCalledTimes(1);
    expect(update).not.toHaveBeenCalled();
  });

  it("requires an authorization private key before any signed mutation", async () => {
    const get = vi.fn(async () => walletRecord("wallet-9"));
    const update = vi.fn(async () => walletRecord("wallet-9"));
    const client = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient({ wallets: { get, update } }),
    });

    await expect(
      client.addPolicyToSigner("wallet-9", "signer-1", "pol_solana"),
    ).rejects.toMatchObject({ status: 503 });
    expect(get).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("reports whether the client can authorize signed mutations", () => {
    const withoutKey = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      client: sdkClient(),
    });
    const withKey = new PrivyServerClient({
      appId: APP_ID,
      appSecret: APP_SECRET,
      authorizationPrivateKey: "test-p256-private-key",
      client: sdkClient(),
    });
    expect(withoutKey.hasAuthorizationPrivateKey()).toBe(false);
    expect(withKey.hasAuthorizationPrivateKey()).toBe(true);
  });

  it("exposes the signer policy ids and signer id accessors", () => {
    expect(
      PrivyServerClient.signerPolicyIds({
        signer_id: "signer-1",
        override_policy_ids: ["pol_a"],
      }),
    ).toEqual(["pol_a"]);
    expect(
      PrivyServerClient.signerPolicyIds({ signer_id: "signer-1" }),
    ).toEqual([]);
    expect(PrivyServerClient.signerId({ signer_id: "signer-1" })).toBe(
      "signer-1",
    );
  });
});
