import { afterEach, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createPublicKey, verify } from "node:crypto";
import {
  PrivyClient,
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignatures,
  generateP256KeyPair,
  type WalletApiRequestSignatureInput,
} from "@privy-io/node";
import type { DatabaseClient } from "../../src/db/client.js";
import { createConfiguredWalletForUser } from "../../src/runtime/dependencies.js";
import type { PrivyServerClient } from "../../src/wallet/privy-server-client.js";
import type { PayloadSigner } from "../../src/wallet/signer/port.js";
import type { PrivyUserWalletProvider } from "../../src/wallet/privy-user-provider.js";
import { createWorkerPayloadSigner } from "../../src/wallet/signer/client.js";
import { startSigningSidecar, type SigningSidecar } from "../../src/wallet/signer/server.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";

/**
 * S2a: the worker's wallet path must build `authorization_context.sign_fns` from
 * the local signing sidecar instead of an in-process private key, and the worker
 * entry (`src/runtime/dependencies.ts`) must not read
 * `PRIVY_AUTHORIZATION_PRIVATE_KEY` at all.
 */
const TOKEN = "worker-path-token-0123456789abcdef";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const WALLET_ADDRESS = "0x5770353D56e4a7cBAa078CD46248e75431c7514f";
const WALLET_ID = "hb000bxgo0kkdkg5fp6se9g9";

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
              provider_wallet_id: WALLET_ID,
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
    async listWalletsForUser() {
      return [
        {
          id: WALLET_ID,
          address: WALLET_ADDRESS,
          chain_type: "ethereum",
          policy_ids: [],
          owner_id: null,
          additional_signers: [],
          archived_at: null,
        },
      ];
    },
  } as unknown as PrivyServerClient;
}

describe("worker wallet path authorization context", () => {
  let sidecar: SigningSidecar | undefined;

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
  });

  it("builds sign_fns from the injected signer and never from the environment", async () => {
    const signer: PayloadSigner = async () => "signature";
    const walletForUser = createConfiguredWalletForUser(
      databaseFixture(),
      {
        IDENTITY_PROVIDER: "privy",
        PRIVY_APP_ID: "app-test",
        PRIVY_APP_SECRET: "secret-test",
      },
      privyFixture(),
      signer,
    );
    expect(walletForUser).toBeDefined();

    const provider = (await walletForUser!(
      USER_ID,
      "ethereum",
    )) as PrivyUserWalletProvider;
    expect(provider.authorizationContext).toEqual({ sign_fns: [signer] });
  });

  it("stays fail-closed (no authorization context) when no signer is configured", async () => {
    const walletForUser = createConfiguredWalletForUser(
      databaseFixture(),
      {
        IDENTITY_PROVIDER: "privy",
        PRIVY_APP_ID: "app-test",
        PRIVY_APP_SECRET: "secret-test",
      },
      privyFixture(),
    );

    const provider = (await walletForUser!(
      USER_ID,
      "ethereum",
    )) as PrivyUserWalletProvider;
    expect(provider.authorizationContext).toBeUndefined();
  });

  it("keeps the worker entry free of the authorization key read", () => {
    const dependencies = repoFile("src/runtime/dependencies.ts");
    expect(dependencies).not.toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");

    // The key read is owned exclusively by the sidecar entrypoint.
    const sidecarEntrypoint = repoFile("src/wallet/signer/server.ts");
    expect(sidecarEntrypoint).toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");

    const provider = repoFile("src/wallet/privy-user-provider.ts");
    expect(provider).not.toContain("PRIVY_AUTHORIZATION_PRIVATE_KEY");
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
      // The worker process learns only the sidecar url + shared token.
      const signer = createWorkerPayloadSigner({
        PRIVY_SIGNER_URL: sidecar.url,
        PRIVY_SIGNER_TOKEN: TOKEN,
      });
      const walletForUser = createConfiguredWalletForUser(
        databaseFixture(),
        {
          IDENTITY_PROVIDER: "privy",
          PRIVY_APP_ID: "app-test",
          PRIVY_APP_SECRET: "secret-test",
        },
        privyFixture(),
        signer,
      );
      const provider = (await walletForUser!(
        USER_ID,
        "ethereum",
      )) as PrivyUserWalletProvider;
      const context = provider.authorizationContext;
      expect(context?.sign_fns).toHaveLength(1);

      const input: WalletApiRequestSignatureInput = {
        version: 1,
        method: "POST",
        url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
        body: {
          method: "eth_signTransaction",
          params: {
            transaction: {
              chain_id: 5042002,
              from: WALLET_ADDRESS,
              to: "0x1531F7AA08D5dF6E9e7d1e0dF8C88656BF9EBd5C",
              data: "0xa9059cbb",
              value: "0x0",
              nonce: "0x0",
              type: 2,
            },
          },
        },
        headers: { "privy-app-id": "app-test" },
      };
      const signatures = await generateAuthorizationSignatures(
        new PrivyClient({ appId: "app-test", appSecret: "secret-test" }),
        { authorizationContext: context!, input },
      );

      expect(signatures).toHaveLength(1);
      const key = createPublicKey({
        key: Buffer.from(keyPair.publicKey, "base64"),
        format: "der",
        type: "spki",
      });
      const signPayload = formatRequestForAuthorizationSignature(input);
      // A rejected or malformed signature would not verify at all; this asserts
      // the worker path produced a valid P-256 DER signature over the SDK's own
      // formatting, with the key absent from this process.
      expect(
        verify(
          "sha256",
          signPayload,
          { key, dsaEncoding: "der" },
          Buffer.from(signatures[0]!, "base64"),
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
