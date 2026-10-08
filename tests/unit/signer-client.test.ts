import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { createPublicKey, verify } from "node:crypto";
import { generateP256KeyPair } from "@privy-io/node";
import {
  DEFAULT_SIGNER_TIMEOUT_MS,
  createHttpPayloadSigner,
  createWorkerPayloadSigner,
  readPayloadSignerConfig,
} from "../../src/wallet/signer/client.js";
import { PayloadSignerError } from "../../src/wallet/signer/port.js";
import { startSigningSidecar, type SigningSidecar } from "../../src/wallet/signer/server.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";

const TOKEN = "worker-signer-token-0123456789abcdef";

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

describe("worker-side signer client", () => {
  let sidecar: SigningSidecar | undefined;
  const extraServers: Server[] = [];

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
    for (const server of extraServers.splice(0)) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
    vi.restoreAllMocks();
  });

  it("reads PRIVY_SIGNER_URL/PRIVY_SIGNER_TOKEN and ignores the key variable", () => {
    expect(readPayloadSignerConfig({})).toBeUndefined();
    expect(
      readPayloadSignerConfig({
        PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-that-must-be-ignored",
      }),
    ).toBeUndefined();

    const config = readPayloadSignerConfig({
      PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign",
      PRIVY_SIGNER_TOKEN: TOKEN,
      PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-that-must-be-ignored",
    });
    expect(config).toMatchObject({
      url: "http://127.0.0.1:8788/sign",
      token: TOKEN,
      timeoutMs: DEFAULT_SIGNER_TIMEOUT_MS,
    });
  });

  it("fails closed on a partial configuration instead of guessing", () => {
    expect(() =>
      readPayloadSignerConfig({ PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign" }),
    ).toThrowError(/PRIVY_SIGNER_TOKEN/u);
    expect(() =>
      readPayloadSignerConfig({ PRIVY_SIGNER_TOKEN: TOKEN }),
    ).toThrowError(/PRIVY_SIGNER_URL/u);
    expect(() =>
      createWorkerPayloadSigner({
        PRIVY_SIGNER_URL: "http://127.0.0.1:8788/sign",
      }),
    ).toThrowError(/PRIVY_SIGNER_TOKEN/u);
  });

  it("signs through the sidecar with only the configured url and token", async () => {
    const keyPair = await generateP256KeyPair();
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(keyPair.privateKey),
      token: TOKEN,
      port: 0,
    });

    const signer = createWorkerPayloadSigner({
      PRIVY_SIGNER_URL: sidecar.url,
      PRIVY_SIGNER_TOKEN: TOKEN,
      PRIVY_AUTHORIZATION_PRIVATE_KEY: "a-key-the-worker-must-never-use",
    });
    expect(signer).toBeTypeOf("function");

    const payload = new TextEncoder().encode('{"canonical":"worker-request"}');
    const signature = await signer!(payload);
    expect(verifySignature(signature, payload, keyPair.publicKey)).toBe(true);
    expect(verifySignature(signature, new Uint8Array([1, 2, 3]), keyPair.publicKey)).toBe(
      false,
    );
  });

  it("sends the exact payload bytes to the configured url with the bearer token", async () => {
    const received: Array<{ body: Buffer; authorization?: string }> = [];
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        received.push({
          body: Buffer.concat(chunks),
          authorization: request.headers.authorization,
        });
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ signature: "c2lnbmF0dXJl" }));
      });
    });
    extraServers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw new Error("test server did not bind a port");
    }

    const signer = createHttpPayloadSigner({
      url: `http://127.0.0.1:${address.port}/sign`,
      token: TOKEN,
    });
    const payload = new Uint8Array([0, 1, 2, 250, 255]);
    await expect(signer(payload)).resolves.toBe("c2lnbmF0dXJl");

    expect(received).toHaveLength(1);
    expect([...received[0]!.body]).toEqual([...payload]);
    expect(received[0]!.authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("maps a rejected token to a typed error that never leaks the token", async () => {
    const keyPair = await generateP256KeyPair();
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(keyPair.privateKey),
      token: TOKEN,
      port: 0,
    });

    const signer = createHttpPayloadSigner({
      url: sidecar.url,
      token: "a-totally-wrong-token-value",
    });
    const error = await signer(new Uint8Array([1])).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PayloadSignerError);
    expect((error as PayloadSignerError).code).toBe("signer_rejected");
    expect((error as Error).message).not.toContain("a-totally-wrong-token-value");
  });

  it("maps a transport failure, a timeout and a bad response to typed errors", async () => {
    // Connection refused: nothing listens on this ephemeral port.
    const unreachable = createHttpPayloadSigner({
      url: "http://127.0.0.1:1/sign",
      token: TOKEN,
      timeoutMs: 250,
    });
    const refused = await unreachable(new Uint8Array([1])).catch(
      (e: unknown) => e,
    );
    expect((refused as PayloadSignerError).code).toBe("signer_unavailable");

    // A sidecar that never answers must time out, not hang.
    const hanging = createServer(() => {
      // Intentionally never responds.
    });
    extraServers.push(hanging);
    await new Promise<void>((resolve) => hanging.listen(0, "127.0.0.1", resolve));
    const hangingAddress = hanging.address();
    if (hangingAddress === null || typeof hangingAddress === "string") {
      throw new Error("test server did not bind a port");
    }
    const slow = createHttpPayloadSigner({
      url: `http://127.0.0.1:${hangingAddress.port}/sign`,
      token: TOKEN,
      timeoutMs: 60,
    });
    const timedOut = await slow(new Uint8Array([1])).catch((e: unknown) => e);
    expect((timedOut as PayloadSignerError).code).toBe("signer_timeout");

    // 5xx and a malformed body are protocol/availability failures.
    const broken = createServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ signature: "ignored" }));
    });
    extraServers.push(broken);
    await new Promise<void>((resolve) => broken.listen(0, "127.0.0.1", resolve));
    const brokenAddress = broken.address();
    if (brokenAddress === null || typeof brokenAddress === "string") {
      throw new Error("test server did not bind a port");
    }
    const serverError = await createHttpPayloadSigner({
      url: `http://127.0.0.1:${brokenAddress.port}/sign`,
      token: TOKEN,
    })(new Uint8Array([1])).catch((e: unknown) => e);
    expect((serverError as PayloadSignerError).code).toBe("signer_unavailable");

    const malformed = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ nope: true }));
    });
    extraServers.push(malformed);
    await new Promise<void>((resolve) => malformed.listen(0, "127.0.0.1", resolve));
    const malformedAddress = malformed.address();
    if (malformedAddress === null || typeof malformedAddress === "string") {
      throw new Error("test server did not bind a port");
    }
    const protocolError = await createHttpPayloadSigner({
      url: `http://127.0.0.1:${malformedAddress.port}/sign`,
      token: TOKEN,
    })(new Uint8Array([1])).catch((e: unknown) => e);
    expect((protocolError as PayloadSignerError).code).toBe("signer_protocol_error");
  });
});
