import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createPublicKey, verify } from "node:crypto";
import {
  InternalServerError,
  formatRequestForAuthorizationSignature,
  generateP256KeyPair,
} from "@privy-io/node";
import type { DatabaseClient } from "../../src/db/client.js";
import {
  SOLANA_DEVNET_CAIP2,
  SOLANA_DEVNET_NETWORK,
  type SolanaRpc,
} from "../../src/wallet/solana-devnet-provider.js";
import {
  PrivyServerClient,
  type PrivySdkClient,
  type PrivyWalletPage,
  type PrivyWalletRecord,
} from "../../src/wallet/privy-server-client.js";
import { PrivyWalletRuntimeError } from "../../src/wallet/user-wallet.js";
import { createSolanaWalletForUser } from "../../src/wallet/solana-user-wallet.js";
import { createWorkerPayloadSigner } from "../../src/wallet/signer/client.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";
import {
  startSigningSidecar,
  type SigningSidecar,
} from "../../src/wallet/signer/server.js";

const USER = "11111111-1111-4111-8111-111111111111";
const PRIVY_DID = "did:privy:user-solana";
const PRIVY_WALLET_ID = "privy-solana-wallet-1";
const LOCAL_UUID = "33333333-3333-4333-8333-333333333333";
const BOUND_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const OTHER_ADDRESS = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";

/**
 * Construction environment for the injectable Privy dispatch seam. The
 * authorization key here is a deliberate DECOY: since S4 the worker signs
 * through the local sidecar, so this variable must never be consumed.
 */
const TEST_ENVIRONMENT = {
  PRIVY_APP_ID: "app-test",
  PRIVY_APP_SECRET: "secret-test",
  PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-the-worker-must-never-use",
};

type QueryLog = { readonly sql: string; readonly params: readonly unknown[] };

/** Row shape of `user_wallets` (migration 006_embedded_wallets). */
type WalletRow = {
  id: string;
  user_id: string;
  chain_family: string;
  provider_wallet_id: string;
  address: string | null;
  state: string;
  created_at: string;
};

function walletRow(overrides: Partial<WalletRow> = {}): WalletRow {
  return {
    id: LOCAL_UUID,
    user_id: USER,
    chain_family: "solana",
    provider_wallet_id: PRIVY_WALLET_ID,
    address: BOUND_ADDRESS,
    state: "ready",
    created_at: "2026-10-01T00:00:00.000Z",
    ...overrides,
  };
}

function solanaWalletRecord(id: string, address: string): PrivyWalletRecord {
  return {
    id,
    address,
    chain_type: "solana",
    policy_ids: [],
    owner_id: null,
    additional_signers: [],
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

/**
 * Emulates only the filters the ADR-3 readiness gate requires: the
 * authenticated user id, the chain family, and `state = 'ready'`. An
 * unfiltered read returns every fixture row, so a gate that omits the ready
 * filter observes stale rows exactly as production would.
 */
function applyReadinessFilters(
  sql: string,
  params: readonly unknown[],
  rows: readonly WalletRow[],
): WalletRow[] {
  let filtered = [...rows];
  const userIdParam = /user_id\s*=\s*\$(\d+)/u.exec(sql);
  if (userIdParam) {
    const bound = params[Number(userIdParam[1]) - 1];
    filtered = filtered.filter((row) => row.user_id === bound);
  }
  const chainFamily = /chain_family\s*=\s*'([^']+)'/u.exec(sql)?.[1];
  if (chainFamily) {
    filtered = filtered.filter((row) => row.chain_family === chainFamily);
  }
  if (/state\s*(?:=\s*'ready'|IN\s*\(\s*'ready'\s*\))/iu.test(sql)) {
    filtered = filtered.filter((row) => row.state === "ready");
  }
  return filtered;
}

function makeResolverFixture(fixture: {
  wallets: readonly WalletRow[];
  privyWallets?: readonly PrivyWalletRecord[];
  privyStatus?: number;
  environment?: NodeJS.ProcessEnv;
  authorizationSigner?: ReturnType<typeof createWorkerPayloadSigner>;
  rpc?: SolanaRpc;
}) {
  const queries: QueryLog[] = [];
  const database = {
    async withUserTransaction(
      userId: string,
      operation: (client: unknown) => Promise<unknown>,
    ) {
      return operation({
        query: async (sql: string, params: readonly unknown[] = []) => {
          queries.push({ sql, params });
          if (/from\s+users/iu.test(sql)) {
            return {
              rows: [
                {
                  privy_did: PRIVY_DID,
                  provider_wallet_id: null,
                  address: null,
                },
              ],
            };
          }
          if (/from\s+user_wallets/iu.test(sql)) {
            return {
              rows: applyReadinessFilters(sql, params, fixture.wallets),
            };
          }
          return { rows: [] };
        },
      });
    },
  } as unknown as DatabaseClient;

  const listMock = vi.fn(
    async ({ chain_type }: { user_id: string; chain_type: string }) => {
      if (fixture.privyStatus && fixture.privyStatus >= 400) {
        throw new InternalServerError(
          fixture.privyStatus,
          { error: "internal_error" },
          undefined,
          new Headers(),
        );
      }
      return listPage(
        (fixture.privyWallets ?? []).filter(
          (wallet) => wallet.chain_type === chain_type,
        ),
      );
    },
  );

  const resolve = createSolanaWalletForUser({
    database,
    privy: new PrivyServerClient({
      appId: "app-test",
      appSecret: "secret-test",
      client: {
        wallets: () => ({ list: listMock, get: vi.fn(), update: vi.fn() }),
        policies: () => ({
          create: vi.fn(),
          get: vi.fn(),
          update: vi.fn(),
        }),
      } as unknown as PrivySdkClient,
    }),
    environment: fixture.environment ?? TEST_ENVIRONMENT,
    ...(fixture.authorizationSigner
      ? { authorizationSigner: fixture.authorizationSigner }
      : {}),
    ...(fixture.rpc ? { rpc: fixture.rpc } : {}),
  });

  return { resolve, queries, listMock };
}

function readinessQuery(queries: readonly QueryLog[]): QueryLog {
  const found = queries.find(
    (entry) =>
      /user_wallets/iu.test(entry.sql) && /\bstate\b/iu.test(entry.sql),
  );
  expect(
    found,
    "the resolver must read the user_wallets readiness contract",
  ).toBeDefined();
  return found as QueryLog;
}

/** The exact `list` parameters the boundary asked the SDK for. */
function privyListCall(
  listMock: { mock: { calls: unknown[][] } },
  index = 0,
): { user_id: string; chain_type: string; limit: number } {
  const call = listMock.mock.calls[index];
  expect(call, `Privy wallet list call #${index} must happen`).toBeDefined();
  return call?.[0] as { user_id: string; chain_type: string; limit: number };
}

async function senderAddressOf(
  provider: Awaited<
    ReturnType<ReturnType<typeof makeResolverFixture>["resolve"]>
  >,
): Promise<string> {
  return (
    await provider.getAddress({ network: SOLANA_DEVNET_NETWORK, wallet: USER })
  ).address;
}

describe("per-user Solana wallet resolver (ADR-3)", () => {
  it("reads only ready Solana bindings for the authenticated user and ignores stale rows", async () => {
    const { resolve, queries, listMock } = makeResolverFixture({
      wallets: [
        // Newest row is stale: a DESC read must not let it displace the ready row.
        walletRow({
          state: "provisioning",
          created_at: "2026-10-02T00:00:00.000Z",
        }),
        walletRow(),
      ],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
    });

    const provider = await resolve(USER);

    const readiness = readinessQuery(queries);
    expect(readiness.sql).toMatch(
      /state\s*(?:=\s*'ready'|IN\s*\(\s*'ready'\s*\))/iu,
    );
    expect(readiness.sql).toMatch(/chain_family\s*=\s*'solana'/u);
    expect(readiness.params).toContain(USER);

    expect(await senderAddressOf(provider)).toBe(BOUND_ADDRESS);
    expect(privyListCall(listMock).chain_type).toBe(
      "solana",
    );
  });

  it("fails with wallet_not_ready when the user has no Solana binding at all", async () => {
    const { resolve, listMock } = makeResolverFixture({
      wallets: [],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
    });

    await expect(resolve(USER)).rejects.toMatchObject({
      name: "PrivyWalletRuntimeError",
      code: "wallet_not_ready",
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("fails with wallet_not_ready when every Solana binding is stale (non-ready)", async () => {
    const { resolve, listMock } = makeResolverFixture({
      wallets: [
        walletRow({ state: "recovery_required" }),
        walletRow({
          id: "44444444-4444-4444-8444-444444444444",
          state: "conflict",
          created_at: "2026-10-03T00:00:00.000Z",
        }),
      ],
    });

    await expect(resolve(USER)).rejects.toMatchObject({
      name: "PrivyWalletRuntimeError",
      code: "wallet_not_ready",
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("fails with wallet_config_error when more than one ready binding exists", async () => {
    const { resolve, listMock } = makeResolverFixture({
      wallets: [
        walletRow(),
        walletRow({
          id: "55555555-5555-4555-8555-555555555555",
          provider_wallet_id: "privy-solana-wallet-2",
          address: OTHER_ADDRESS,
        }),
        walletRow({
          id: "66666666-6666-4666-8666-666666666666",
          state: "unavailable",
        }),
      ],
    });

    await expect(resolve(USER)).rejects.toMatchObject({
      name: "PrivyWalletRuntimeError",
      code: "wallet_config_error",
    });
    expect(listMock).not.toHaveBeenCalled();
  });

  it("binds by user_wallets.provider_wallet_id, never the local UUID primary key", async () => {
    const { resolve } = makeResolverFixture({
      wallets: [walletRow({ id: LOCAL_UUID })],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
    });

    const provider = await resolve(USER);

    expect(provider).toMatchObject({ id: "solana-devnet", mode: "live" });
    expect(await senderAddressOf(provider)).toBe(BOUND_ADDRESS);
  });

  it("fails with wallet_config_error when the Privy wallet id is not the bound provider_wallet_id", async () => {
    const { resolve } = makeResolverFixture({
      wallets: [
        walletRow({
          id: PRIVY_WALLET_ID,
          provider_wallet_id: "privy-solana-wallet-unbound",
        }),
      ],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
    });

    await expect(resolve(USER)).rejects.toMatchObject({
      name: "PrivyWalletRuntimeError",
      code: "wallet_config_error",
    });
  });

  it("fails with wallet_config_error when the Privy wallet address does not match the bound address", async () => {
    const { resolve } = makeResolverFixture({
      wallets: [walletRow({ id: PRIVY_WALLET_ID })],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, OTHER_ADDRESS)],
    });

    await expect(resolve(USER)).rejects.toMatchObject({
      name: "PrivyWalletRuntimeError",
      code: "wallet_config_error",
    });
  });

  it("maps a Privy wallet listing failure to wallet_unavailable", async () => {
    const { resolve, listMock } = makeResolverFixture({
      wallets: [walletRow()],
      privyStatus: 500,
    });

    await expect(resolve(USER)).rejects.toMatchObject({
      name: "PrivyWalletRuntimeError",
      code: "wallet_unavailable",
    });

    const listCall = privyListCall(listMock);
    expect(listCall.user_id).toBe(PRIVY_DID);
    expect(listCall.chain_type).toBe("solana");
  });

  it("never substitutes a fallback sender address when the binding has no address", async () => {
    for (const address of [null, ""] as const) {
      const { resolve } = makeResolverFixture({
        wallets: [walletRow({ id: PRIVY_WALLET_ID, address })],
        privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
      });

      const error = await resolve(USER).catch((thrown: unknown) => thrown);
      expect(error).toBeInstanceOf(PrivyWalletRuntimeError);
      // A missing binding address is a local configuration anomaly, never a
      // provider outage, and never an empty sender address.
      expect(["wallet_config_error", "wallet_not_ready"]).toContain(
        (error as PrivyWalletRuntimeError).code,
      );
    }
  });
});

// ---------------------------------------------------------------------------
// S4: the worker's per-user Solana dispatch runs through the official SDK and
// is authorized by the LOCAL SIGNING SIDECAR. The authorization key in the
// environment is a decoy: it is not, and must never become, a signing path.
// ---------------------------------------------------------------------------

const SIDECAR_TOKEN = "user-wallet-path-token-0123456789abcdef";
const DISPATCH_SIGNATURE =
  "5ZzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWMAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
const RECIPIENT = OTHER_ADDRESS;

const TRANSFER = {
  network: SOLANA_DEVNET_NETWORK,
  wallet: USER,
  token: "SOL",
  to: RECIPIENT,
  amount: "0.5",
  previewId: "preview-solana-1",
} as const;

/** Read-only RPC double: the dispatch path never submits to RPC itself. */
function solanaRpcDouble(): SolanaRpc {
  return {
    getBalance: vi.fn().mockResolvedValue(2_000_000_000n),
    getSignatureStatuses: vi.fn().mockResolvedValue(null),
    getSignaturesForAddress: vi.fn().mockResolvedValue([]),
    getRecentBlockhash: vi
      .fn()
      .mockResolvedValue("4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq"),
    getFeeForTransferMessage: vi.fn().mockResolvedValue(5_000n),
  };
}

type RecordedPrivyRequest = {
  method: string;
  path: string;
  host: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
};

/** Minimal stand-in for the Privy API: records the request, answers the RPC. */
async function startFakePrivyApi(): Promise<{
  url: string;
  requests: RecordedPrivyRequest[];
  close(): Promise<void>;
}> {
  const requests: RecordedPrivyRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      requests.push({
        method: request.method ?? "",
        path: request.url ?? "",
        host: request.headers.host ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(",") : String(value ?? ""),
          ]),
        ),
        body: JSON.parse(Buffer.concat(chunks).toString("utf8") || "null") as Record<
          string,
          unknown
        >,
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          method: "signAndSendTransaction",
          data: {
            caip2: SOLANA_DEVNET_CAIP2,
            hash: DISPATCH_SIGNATURE,
            transaction_id: "privy-tx-solana-1",
          },
        }),
      );
    });
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

describe("per-user Solana dispatch through the SDK and the signing sidecar (S4)", () => {
  let sidecar: SigningSidecar | undefined;
  let api: Awaited<ReturnType<typeof startFakePrivyApi>> | undefined;

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
    await api?.close();
    api = undefined;
  });

  it("authorizes the SDK dispatch with the sidecar key, never the environment key", async () => {
    const keyPair = await generateP256KeyPair();
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(keyPair.privateKey),
      token: SIDECAR_TOKEN,
      port: 0,
    });
    api = await startFakePrivyApi();
    const signer = createWorkerPayloadSigner({
      PRIVY_SIGNER_URL: sidecar.url,
      PRIVY_SIGNER_TOKEN: SIDECAR_TOKEN,
    });

    const { resolve } = makeResolverFixture({
      wallets: [walletRow()],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
      environment: {
        ...TEST_ENVIRONMENT,
        PRIVY_API_BASE_URL: `${api.url}/v1`,
      },
      authorizationSigner: signer,
      rpc: solanaRpcDouble(),
    });
    const provider = await resolve(USER);

    const outcome = await provider.broadcastTransfer({ ...TRANSFER });

    expect(outcome.kind).toBe("submitted");
    if (outcome.kind === "submitted") {
      expect(outcome.transaction.transactionHash).toBe(DISPATCH_SIGNATURE);
    }
    expect(api.requests).toHaveLength(1);
    const request = api.requests[0]!;
    expect(request.path).toBe(`/v1/wallets/${PRIVY_WALLET_ID}/rpc`);
    expect(request.body).toMatchObject({
      method: "signAndSendTransaction",
      chain_type: "solana",
      caip2: SOLANA_DEVNET_CAIP2,
      reference_id: "preview-solana-1",
    });
    expect(request.headers["privy-idempotency-key"]).toBe("preview-solana-1");
    // The dispatched transaction is the provider-built legacy transfer, base64:
    // the worker never submits to Solana RPC directly.
    const params = request.body.params as {
      transaction: string;
      encoding: string;
    };
    expect(params.encoding).toBe("base64");
    expect(Buffer.from(params.transaction, "base64").length).toBeGreaterThan(0);

    // The sidecar's key authorized that request: the signature verifies
    // against the SDK's own formatting, and the decoy env key was never used.
    const payload = formatRequestForAuthorizationSignature({
      version: 1,
      method: "POST",
      url: `http://${request.host}${request.path}`,
      body: request.body,
      headers: {
        "privy-app-id": "app-test",
        "privy-idempotency-key": "preview-solana-1",
        "privy-request-expiry": request.headers["privy-request-expiry"]!,
      },
    });
    const publicKey = createPublicKey({
      key: Buffer.from(keyPair.publicKey, "base64"),
      format: "der",
      type: "spki",
    });
    expect(
      verify(
        "sha256",
        payload,
        { key: publicKey, dsaEncoding: "der" },
        Buffer.from(
          request.headers["privy-authorization-signature"]!,
          "base64",
        ),
      ),
    ).toBe(true);
  });

  it("fails closed without a sidecar: the environment key is not a signing path", async () => {
    api = await startFakePrivyApi();
    const { resolve } = makeResolverFixture({
      wallets: [walletRow()],
      privyWallets: [solanaWalletRecord(PRIVY_WALLET_ID, BOUND_ADDRESS)],
      environment: {
        ...TEST_ENVIRONMENT,
        PRIVY_API_BASE_URL: `${api.url}/v1`,
      },
      rpc: solanaRpcDouble(),
    });
    const provider = await resolve(USER);

    const outcome = await provider.broadcastTransfer({ ...TRANSFER });

    // No sidecar, no dispatch: the outcome stays ambiguous (reconcilable,
    // never blindly retried) and the decoy key never reached Privy.
    expect(outcome.kind).toBe("uncertain");
    expect(api.requests).toHaveLength(0);
  });
});
