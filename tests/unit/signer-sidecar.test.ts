import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPublicKey, verify } from "node:crypto";
import { generateP256KeyPair } from "@privy-io/node";
import {
  isLoopbackHost,
  startSigningSidecar,
  type SigningSidecar,
} from "../../src/wallet/signer/server.js";
import {
  createKeyPayloadSigner,
  loadAuthorizationPrivateKey,
} from "../../src/wallet/signer/key-signer.js";

/**
 * S2a signing sidecar.
 *
 * ECDSA P-256 uses a per-signature random nonce, so two signatures over the
 * same payload are NEVER byte-identical. Every assertion here is therefore a
 * VERIFICATION assertion (`verify(sha256(payload))`) or a negative one (a
 * signature over different bytes must not verify) — never byte equality.
 */
const TOKEN = "test-signer-token-0123456789abcdef";

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

async function signRequest(
  url: string,
  payload: Uint8Array,
  token: string | null = TOKEN,
): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: {
      "content-type": "application/octet-stream",
      ...(token === null ? {} : { authorization: `Bearer ${token}` }),
    },
    body: payload,
  });
}

describe("Privy authorization signing sidecar", () => {
  let sidecar: SigningSidecar | undefined;
  let privateKey: string;
  let publicKey: string;
  const payload = new TextEncoder().encode('{"canonical":"request"}');

  beforeEach(async () => {
    const keyPair = await generateP256KeyPair();
    privateKey = keyPair.privateKey;
    publicKey = keyPair.publicKey;
  });

  afterEach(async () => {
    await sidecar?.close();
    sidecar = undefined;
    vi.restoreAllMocks();
  });

  it("signs the exact payload bytes with a DER-encoded P-256 signature", async () => {
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
    });

    const response = await signRequest(sidecar.url, payload);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { signature: string };
    expect(typeof body.signature).toBe("string");
    expect(verifySignature(body.signature, payload, publicKey)).toBe(true);
  });

  it("never re-formats the payload and never returns byte-identical signatures", async () => {
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
    });

    const first = (await (await signRequest(sidecar.url, payload)).json()) as {
      signature: string;
    };
    const second = (await (await signRequest(sidecar.url, payload)).json()) as {
      signature: string;
    };

    // Both verify over the payload as sent (the sidecar must not re-format it)…
    expect(verifySignature(first.signature, payload, publicKey)).toBe(true);
    expect(verifySignature(second.signature, payload, publicKey)).toBe(true);
    // …and a signature over different bytes must not verify.
    const other = new TextEncoder().encode('{"canonical":"other"}');
    expect(verifySignature(first.signature, other, publicKey)).toBe(false);
  });

  it("rejects a request without a token and with a wrong token", async () => {
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
    });

    const missing = await signRequest(sidecar.url, payload, null);
    expect(missing.status).toBe(401);
    const wrong = await signRequest(sidecar.url, payload, "wrong-token");
    expect(wrong.status).toBe(401);
    const sameLengthWrong = await signRequest(
      sidecar.url,
      payload,
      "x".repeat(TOKEN.length),
    );
    expect(sameLengthWrong.status).toBe(401);

    for (const response of [missing, wrong, sameLengthWrong]) {
      const text = await response.text();
      expect(text).not.toContain(privateKey);
      expect(text).not.toContain(TOKEN);
    }
  });

  it("rejects an oversized payload with and without a content-length", async () => {
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
      maxPayloadBytes: 64,
    });

    const oversized = new Uint8Array(65).fill(7);
    const declared = await signRequest(sidecar.url, oversized);
    expect(declared.status).toBe(413);

    // Chunked upload: node's fetch streams the body, so no content-length is
    // sent and the cap must be enforced while reading.
    const chunked = await fetch(sidecar.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${TOKEN}`,
        "content-type": "application/octet-stream",
      },
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(48).fill(1));
          controller.enqueue(new Uint8Array(48).fill(1));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(chunked.status).toBe(413);

    // The payload cap is not a soft limit: a payload at the cap still signs.
    const atCap = await signRequest(sidecar.url, new Uint8Array(64).fill(7));
    expect(atCap.status).toBe(200);
  });

  it("serves no route other than the sign operation and never returns the key", async () => {
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
    });
    const base = new URL(sidecar.url);

    const probes: Array<{ method: string; path: string }> = [
      { method: "GET", path: "/" },
      { method: "POST", path: "/" },
      { method: "GET", path: "/sign" },
      { method: "GET", path: "/key" },
      { method: "GET", path: "/private-key" },
      { method: "GET", path: "/public-key" },
      { method: "POST", path: "/export" },
      { method: "POST", path: "/sign/" },
    ];

    for (const probe of probes) {
      const response = await fetch(new URL(probe.path, base), {
        method: probe.method,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(
        response.status,
        `${probe.method} ${probe.path} must not be served`,
      ).toBeGreaterThanOrEqual(404);
      const text = await response.text();
      expect(text).not.toContain(privateKey);
      expect(text).not.toContain(TOKEN);
    }
  });

  it("refuses to bind anything other than loopback", async () => {
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("0.0.0.0")).toBe(false);
    expect(isLoopbackHost("192.168.0.91")).toBe(false);

    await expect(
      startSigningSidecar({
        signer: createKeyPayloadSigner(privateKey),
        token: TOKEN,
        host: "0.0.0.0",
        port: 0,
      }),
    ).rejects.toThrow(/loopback/iu);
  });

  it("refuses to start with a weak or missing bearer token", async () => {
    await expect(
      startSigningSidecar({
        signer: createKeyPayloadSigner(privateKey),
        token: "",
        port: 0,
      }),
    ).rejects.toThrow(/token/iu);
    await expect(
      startSigningSidecar({
        signer: createKeyPayloadSigner(privateKey),
        token: "short",
        port: 0,
      }),
    ).rejects.toThrow(/token/iu);
  });

  it("never logs the payload, the signature or the key", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (method) => vi.spyOn(console, method),
    );
    sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
    });

    await signRequest(sidecar.url, payload);
    await signRequest(sidecar.url, payload, "wrong-token");

    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe("sidecar key loading", () => {
  it("reads the key from the environment variable or a key file", async () => {
    const keyPair = await generateP256KeyPair();
    expect(
      loadAuthorizationPrivateKey({
        PRIVY_AUTHORIZATION_PRIVATE_KEY: keyPair.privateKey,
      }),
    ).toBe(keyPair.privateKey);

    const { mkdtemp, rm, writeFile } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const directory = await mkdtemp(join(tmpdir(), "s2a-key-"));
    try {
      const file = join(directory, "key");
      await writeFile(file, keyPair.privateKey, { mode: 0o600 });
      expect(loadAuthorizationPrivateKey({ PRIVY_SIGNER_KEY_FILE: file })).toBe(
        keyPair.privateKey,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("fails closed without a key and never echoes the key material", async () => {
    expect(() => loadAuthorizationPrivateKey({})).toThrow(/key/iu);
    expect(() =>
      loadAuthorizationPrivateKey({
        PRIVY_AUTHORIZATION_PRIVATE_KEY: "not-a-base64-pkcs8-key",
      }),
    ).toThrowError(/P-256/iu);
    try {
      createKeyPayloadSigner("not-a-base64-pkcs8-key");
      expect.unreachable("a malformed key must not construct a signer");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).not.toContain("not-a-base64-pkcs8-key");
    }
  });
});
