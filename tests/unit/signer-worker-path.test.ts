import { afterEach, describe, expect, it } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify } from "node:crypto";
import {
  formatRequestForAuthorizationSignature,
  generateP256KeyPair,
} from "@privy-io/node";
import type { DatabaseClient } from "../../src/db/client.js";
import { createConfiguredWalletForUser } from "../../src/runtime/dependencies.js";
import type { PrivyServerClient } from "../../src/wallet/privy-server-client.js";
import type { PayloadSigner } from "../../src/wallet/signer/port.js";
import {
  SOLANA_DEVNET_CAIP2,
  SolanaDevnetConfigError,
  type SolanaSignAndSendClient,
} from "../../src/wallet/solana-devnet-provider.js";
import { createWorkerPayloadSigner } from "../../src/wallet/signer/client.js";
import { startSigningSidecar, type SigningSidecar } from "../../src/wallet/signer/server.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";

/**
 * S2a: the worker's wallet path must build `authorization_context.sign_fns` from
 * the local signing sidecar instead of an in-process private key, and the worker
 * entry (`src/runtime/dependencies.ts`) must not read
 * `PRIVY_AUTHORIZATION_PRIVATE_KEY` at all.
 *
 * S5: the worker path serves Solana devnet only, so these cases drive the
 * per-user Solana resolver and its dispatch client. They previously read the
 * authorization context off the deleted Arc/EVM provider; the Solana provider
 * keeps that client private and the worker composition has no RPC/SDK injection
 * seam, so the same property is observed where it actually lands: the SDK
 * request the dispatch client signs.
 */
const TOKEN = "worker-path-token-0123456789abcdef";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WALLET_ADDRESS = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
const WALLET_ID = "hb000bxgo0kkdkg5fp6se9g9";
const DISPATCH_SIGNATURE = Buffer.alloc(64, 7).toString("base64");

function repoFile(relativePath: string): string {
  return readFileSync(
    fileURLToPath(new URL(`../../${relativePath}`, import.meta.url)),
    "utf8",
  );
}

function databaseFixture(): DatabaseClient {
  return {
    async withUserTransaction(
      _userId: string,
      operation: (client: unknown) => Promise<unknown>,
    ) {
      return operation({
        query: async () => ({
          rows: [
            {
              privy_did: "did:privy:user-a",
              id: "local-uuid",
              provider_wallet_id: WALLET_ID,
              state: "ready",
              address: WALLET_ADDRESS,
            },
          ],
        }),
      });
    },
  } as unknown as DatabaseClient;
}

function privyFixture(): PrivyServerClient {
  return {
    async listWalletsForChain() {
      return [
        {
          id: WALLET_ID,
          address: WALLET_ADDRESS,
          chain_type: "solana",
          policy_ids: [],
          owner_id: null,
          additional_signers: [],
          archived_at: null,
        },
      ];
    },
  } as unknown as PrivyServerClient;
}

/**
 * The worker-built dispatch client. The Solana provider keeps it private and
 * `createConfiguredWalletForUser` exposes no RPC/SDK injection, so the same
 * member the provider uses for a real broadcast is the only handle on it.
 */
function dispatchOf(provider: { id: string }): SolanaSignAndSendClient {
  return (provider as unknown as { signAndSend: SolanaSignAndSendClient })
    .signAndSend;
}

function unsignedTransaction(): string {
  return Buffer.from("unsigned-solana-transaction").toString("base64");
}

type RecordedPrivyRequest = {
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
        path: request.url ?? "",
        host: request.headers.host ?? "",
        headers: Object.fromEntries(
          Object.entries(request.headers).map(([name, value]) => [
            name,
            Array.isArray(value) ? value.join(",") : String(value ?? ""),
          ]),
        ),
        body: JSON.parse(
          Buffer.concat(chunks).toString("utf8") || "null",
        ) as Record<string, unknown>,
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

describe("worker wallet path authorization context", () => {
  let sidecar: SigningSidecar | undefined;
  let api: Awaited<ReturnType<typeof startFakePrivyApi>> | undefined;

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
    await api?.close();
    api = undefined;
  });

  it("builds sign_fns from the injected signer and never from the environment", async () => {
    api = await startFakePrivyApi();
    const payloads: Uint8Array[] = [];
    const signer: PayloadSigner = async (payload) => {
      payloads.push(payload);
      return DISPATCH_SIGNATURE;
    };
    const walletForUser = createConfiguredWalletForUser(
      databaseFixture(),
      {
        PRIVY_APP_ID: "app-test",
        PRIVY_APP_SECRET: "secret-test",
        PRIVY_API_BASE_URL: `${api.url}/v1`,
        // A decoy: nothing in this process may consume it.
        PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-this-process-must-not-use",
      },
      privyFixture(),
      signer,
    );
    expect(walletForUser).toBeDefined();

    const provider = await walletForUser!(USER_ID, "solana");
    await dispatchOf(provider).signAndSend(
      WALLET_ID,
      SOLANA_DEVNET_CAIP2,
      unsignedTransaction(),
      "preview-1",
    );

    expect(api.requests).toHaveLength(1);
    // The SDK formatted the request and handed its bytes to the injected
    // sidecar signer, whose answer IS the dispatched authorization signature.
    expect(payloads).toHaveLength(1);
    expect(payloads[0]).toBeInstanceOf(Uint8Array);
    expect(api.requests[0]!.headers["privy-authorization-signature"]).toBe(
      DISPATCH_SIGNATURE,
    );
  });

  it("stays fail-closed (no authorization context) when no signer is configured", async () => {
    api = await startFakePrivyApi();
    const walletForUser = createConfiguredWalletForUser(
      databaseFixture(),
      {
        PRIVY_APP_ID: "app-test",
        PRIVY_APP_SECRET: "secret-test",
        PRIVY_API_BASE_URL: `${api.url}/v1`,
        // Setting the key changes nothing: the sidecar is the only signing path.
        PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-this-process-must-not-use",
      },
      privyFixture(),
    );

    const provider = await walletForUser!(USER_ID, "solana");
    const error = await dispatchOf(provider)
      .signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedTransaction(),
        "preview-1",
      )
      .catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(SolanaDevnetConfigError);
    expect((error as Error).message).toContain("PRIVY_SIGNER_URL");
    expect(api.requests).toHaveLength(0);
  });

  it("keeps the worker entry free of the authorization key read", () => {
    const dependencies = repoFile("src/runtime/dependencies.ts");
    expect(dependencies).not.toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");

    // The key read is owned exclusively by the sidecar entrypoint.
    const sidecarEntrypoint = repoFile("src/wallet/signer/server.ts");
    expect(sidecarEntrypoint).toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");

    // Re-pointed from the deleted Arc/EVM provider module: `user-wallet.ts`
    // owns per-user wallet resolution now, so that module must hold no key.
    const provider = repoFile("src/wallet/user-wallet.ts");
    expect(provider).not.toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");
  });

  it("keeps the HTTP API and the server boundary free of the authorization key read", () => {
    // S2c: the HTTP API process no longer holds the authorization private key
    // either. It builds the sidecar signer from PRIVY_SIGNER_URL/TOKEN and the
    // Privy server boundary signs through that port instead of a key string.
    for (const relativePath of [
      "src/server.ts",
      "src/wallet/privy-server-client.ts",
      "src/runtime/dependencies.ts",
      "src/wallet/grants/privy-policy-runtime.ts",
    ]) {
      expect(repoFile(relativePath), relativePath).not.toContain(
        "PRIVY_AUTHORIZATION_PRIVATE_KEY",
      );
    }

    // The HTTP API entry wires the sidecar signer into the Privy client.
    const server = repoFile("src/server.ts");
    expect(server).toContain("createWorkerPayloadSigner(process.env)");
    expect(server).toContain("authorizationSigner");

    // The key read stays owned exclusively by the sidecar entrypoint + loader.
    expect(repoFile("src/wallet/signer/server.ts")).toContain(
      "PRIVY_AUTHORIZATION_PRIVATE_KEY",
    );
    expect(repoFile("src/wallet/signer/key-signer.ts")).toContain(
      "PRIVY_AUTHORIZATION_PRIVATE_KEY",
    );
  });

  it("signs one real SDK authorization through the sidecar with the key unset", async () => {
    const savedKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    delete process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    try {
      const keyPair = await generateP256KeyPair();
      sidecar = await startSigningSidecar({
        signer: createKeyPayloadSigner(keyPair.privateKey),
        token: TOKEN,
        port: 0,
      });
      api = await startFakePrivyApi();
      // The worker process learns only the sidecar url + shared token.
      const signer = createWorkerPayloadSigner({
        PRIVY_SIGNER_URL: sidecar.url,
        PRIVY_SIGNER_TOKEN: TOKEN,
      });
      const walletForUser = createConfiguredWalletForUser(
        databaseFixture(),
        {
          PRIVY_APP_ID: "app-test",
          PRIVY_APP_SECRET: "secret-test",
          PRIVY_API_BASE_URL: `${api.url}/v1`,
        },
        privyFixture(),
        signer,
      );
      const provider = await walletForUser!(USER_ID, "solana");
      const outcome = await dispatchOf(provider).signAndSend(
        WALLET_ID,
        SOLANA_DEVNET_CAIP2,
        unsignedTransaction(),
        "preview-1",
      );

      expect(outcome.hash).toBe(DISPATCH_SIGNATURE);
      expect(api.requests).toHaveLength(1);
      const request = api.requests[0]!;
      expect(request.path).toBe(`/v1/wallets/${WALLET_ID}/rpc`);

      const publicKey = createPublicKey({
        key: Buffer.from(keyPair.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      // A rejected or malformed signature would not verify at all; this asserts
      // the worker path produced a valid P-256 DER signature over the SDK's own
      // formatting of the request it dispatched, with the key absent from this
      // process.
      const payload = formatRequestForAuthorizationSignature({
        version: 1,
        method: "POST",
        url: `http://${request.host}${request.path}`,
        body: request.body,
        headers: {
          "privy-app-id": "app-test",
          "privy-idempotency-key": "preview-1",
          "privy-request-expiry": request.headers["privy-request-expiry"]!,
        },
      });
      expect(
        verify(
          "sha256",
          payload,
          { key: publicKey, dsaEncoding: "der" },
          Buffer.from(request.headers["privy-authorization-signature"]!, "base64"),
        ),
      ).toBe(true);
      expect(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY).toBeUndefined();
    } finally {
      if (savedKey !== undefined) {
        process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = savedKey;
      }
    }
  });
});
