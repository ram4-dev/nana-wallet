import { afterEach, describe, expect, it } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import {
  PrivyClient,
  formatRequestForAuthorizationSignature,
  generateAuthorizationSignature,
  generateAuthorizationSignatures,
  generateP256KeyPair,
  type WalletApiRequestSignatureInput,
} from "@privy-io/node";
import { signerAuthorizationContext } from "../../src/wallet/signer/authorization-context.js";
import { createWorkerPayloadSigner } from "../../src/wallet/signer/client.js";
import { startSigningSidecar, type SigningSidecar } from "../../src/wallet/signer/server.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";

/**
 * S2a: the worker must obtain Privy authorization signatures through the SDK's
 * `sign_fns` seam while the authorization private key lives ONLY in the sidecar.
 *
 * These tests drive the REAL SDK authorization pipeline
 * (`generateAuthorizationSignatures`), which formats the request payload
 * itself and hands the already-formatted bytes to `sign_fns`.
 */
const TOKEN = "sdk-seam-token-0123456789abcdef";
const WALLET_ID = "wallet-under-test";

function verifySignature(
  signatureBase64: string,
  payload: Uint8Array,
  publicKeyBase64: string,
): boolean {
  const key = createPublicKey({
    key: Buffer.from(publicKeyBase64, "base64"),
    format: "der",
    type: "spki",
  });
  return verify(
    "sha256",
    payload,
    { key, dsaEncoding: "der" },
    Buffer.from(signatureBase64, "base64"),
  );
}

function request(
  to: string,
  amountAtomic: string,
): WalletApiRequestSignatureInput {
  return {
    version: 1,
    method: "POST",
    url: `https://api.privy.io/v1/wallets/${WALLET_ID}/rpc`,
    body: {
      method: "eth_signTransaction",
      params: {
        transaction: {
          chain_id: "0x4cef52",
          from: "0x5770353D56e4a7cBAa078CD46248e75431c7514f",
          to: "0x3600000000000000000000000000000000000000",
          data: `0xa9059cbb${to.slice(2).padStart(64, "0")}${BigInt(amountAtomic).toString(16).padStart(64, "0")}`,
          value: "0x0",
          nonce: "0x0",
          type: 2,
        },
      },
    },
    headers: { "privy-app-id": "app-test", "privy-request-expiry": "1799999999999" },
  };
}

describe("SDK sign_fns seam", () => {
  let sidecar: SigningSidecar | undefined;

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
  });

  it("builds exactly the SDK authorization context shape from a signer port", () => {
    const signer = async () => "sig";
    const context = signerAuthorizationContext(signer);
    expect(context).toEqual({ sign_fns: [signer] });
    expect(context.sign_fns?.[0]).toBe(signer);
  });

  it("signs an SDK-formatted request without the key in the calling process", async () => {
    // The worker process must not hold the key: prove it by removing the
    // variable that used to carry it.
    const savedKey = process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    delete process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY;
    try {
      const keyPair = await generateP256KeyPair();
      sidecar = await startSigningSidecar({
        signer: createKeyPayloadSigner(keyPair.privateKey),
        token: TOKEN,
        port: 0,
      });

      // Capture the payload the SDK hands to sign_fns to prove the sidecar is
      // given the SDK's own formatting and never re-formats it.
      const seen: Uint8Array[] = [];
      const clientSigner = createWorkerPayloadSigner({
        PRIVY_SIGNER_URL: sidecar.url,
        PRIVY_SIGNER_TOKEN: TOKEN,
      })!;
      const capturingSigner = async (payload: Uint8Array): Promise<string> => {
        seen.push(payload);
        return clientSigner(payload);
      };

      const allowed = request(
        "0x1531F7AA08D5dF6E9e7d1e0dF8C88656BF9EBd5C",
        "1000000",
      );
      const signatures = await generateAuthorizationSignatures(
        new PrivyClient({ appId: "app-test", appSecret: "secret-test" }),
        {
          authorizationContext: signerAuthorizationContext(capturingSigner),
          input: allowed,
        },
      );

      expect(signatures).toHaveLength(1);
      const expectedPayload = formatRequestForAuthorizationSignature(
        request("0x1531F7AA08D5dF6E9e7d1e0dF8C88656BF9EBd5C", "1000000"),
      );
      expect(seen).toHaveLength(1);
      expect(Buffer.from(seen[0]!)).toEqual(Buffer.from(expectedPayload));
      expect(verifySignature(signatures[0]!, expectedPayload, keyPair.publicKey)).toBe(
        true,
      );

      // The signature is over the payload as sent: different request bytes fail.
      const otherPayload = formatRequestForAuthorizationSignature(
        request("0x2222222222222222222222222222222222222222", "1000000"),
      );
      expect(
        verifySignature(signatures[0]!, otherPayload, keyPair.publicKey),
      ).toBe(false);

      // And the sidecar reproduces the SDK's own signing algorithm: a signature
      // computed in-process by the SDK over the same payload verifies too.
      const sdkSignature = generateAuthorizationSignature({
        authorizationPrivateKey: keyPair.privateKey,
        input: expectedPayload,
      });
      expect(
        verifySignature(sdkSignature, expectedPayload, keyPair.publicKey),
      ).toBe(true);
      expect(process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY).toBeUndefined();
    } finally {
      if (savedKey !== undefined) {
        process.env.PRIVY_AUTHORIZATION_PRIVATE_KEY = savedKey;
      }
    }
  });
});
