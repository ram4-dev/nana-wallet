import { afterEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { generateP256KeyPair } from "@privy-io/node";
import { probePayloadSigner } from "../../src/wallet/signer/probe.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";
import { PayloadSignerError, type PayloadSigner } from "../../src/wallet/signer/port.js";
import { startSigningSidecar, type SigningSidecar } from "../../src/wallet/signer/server.js";

/**
 * D-D: the sidecar capability probe lives in the signer module and answers
 * ONLY with `{ capable, code }`. The positive control comes first in every
 * case so a `capable: false` assertion cannot pass because the probe or the
 * key was missing, and the negative cases exercise a REAL transport (an
 * unreachable loopback port and a refusing HTTP server), not an injected
 * failure alone.
 */

const TOKEN = "probe-signer-token-0123456789abcdef";
const SECRET_SHAPED = /token|key|signature|payload|private|secret/i;

const servers: Server[] = [];
const sidecars: SigningSidecar[] = [];

afterEach(async () => {
  for (const sidecar of sidecars.splice(0)) await sidecar.close();
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

/** A loopback HTTP server that always answers `status` with a JSON body. */
async function refusingServer(status: number): Promise<{ url: string }> {
  const server = createServer((_request, response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "refused", token: TOKEN }));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the refusing server did not bind a port");
  }
  return { url: `http://127.0.0.1:${address.port}/sign` };
}

/** A reserved-then-closed loopback port: nothing listens on it anymore. */
async function closedPortUrl(): Promise<string> {
  const server = createServer();
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the reserve server did not bind a port");
  }
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${address.port}/sign`;
}

describe("probePayloadSigner", () => {
  it("reports verified through a real in-process key signer", async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();

    const capability = await probePayloadSigner({
      signer: createKeyPayloadSigner(privateKey),
      authorizationPublicKey: publicKey,
    });

    expect(capability).toEqual({ capable: true, code: "verified" });
  });

  it("reports verified over real HTTP when the environment points at the live sidecar", async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();
    const sidecar = await startSigningSidecar({
      signer: createKeyPayloadSigner(privateKey),
      token: TOKEN,
      port: 0,
    });
    sidecars.push(sidecar);

    const capability = await probePayloadSigner({
      environment: {
        PRIVY_SIGNER_URL: sidecar.url,
        PRIVY_SIGNER_TOKEN: TOKEN,
        PRIVY_AUTHORIZATION_PUBLIC_KEY: publicKey,
      },
    });

    expect(capability).toEqual({ capable: true, code: "verified" });
  });

  it("reports signer_unavailable for an unreachable sidecar without throwing", async () => {
    const { publicKey } = await generateP256KeyPair();

    const capability = await probePayloadSigner({
      environment: {
        PRIVY_SIGNER_URL: await closedPortUrl(),
        PRIVY_SIGNER_TOKEN: TOKEN,
        PRIVY_AUTHORIZATION_PUBLIC_KEY: publicKey,
      },
    });

    expect(capability).toEqual({ capable: false, code: "signer_unavailable" });
  });

  it("reports signer_rejected for a definitive 4xx refusal from the sidecar", async () => {
    const { publicKey } = await generateP256KeyPair();
    const { url } = await refusingServer(401);

    const capability = await probePayloadSigner({
      environment: {
        PRIVY_SIGNER_URL: url,
        PRIVY_SIGNER_TOKEN: TOKEN,
        PRIVY_AUTHORIZATION_PUBLIC_KEY: publicKey,
      },
    });

    expect(capability).toEqual({ capable: false, code: "signer_rejected" });
  });

  it("reports signer_unavailable for a 5xx refusal from the sidecar", async () => {
    const { publicKey } = await generateP256KeyPair();
    const { url } = await refusingServer(503);

    const capability = await probePayloadSigner({
      environment: {
        PRIVY_SIGNER_URL: url,
        PRIVY_SIGNER_TOKEN: TOKEN,
        PRIVY_AUTHORIZATION_PUBLIC_KEY: publicKey,
      },
    });

    expect(capability).toEqual({ capable: false, code: "signer_unavailable" });
  });

  it("reports signer_unavailable when no sidecar is configured at all", async () => {
    const capability = await probePayloadSigner({ environment: {} });

    expect(capability).toEqual({ capable: false, code: "signer_unavailable" });
  });

  it("reports signature_mismatch for a well-formed signature from a different key", async () => {
    const { privateKey } = await generateP256KeyPair();
    const other = await generateP256KeyPair();

    const capability = await probePayloadSigner({
      signer: createKeyPayloadSigner(privateKey),
      authorizationPublicKey: other.publicKey,
    });

    expect(capability).toEqual({ capable: false, code: "signature_mismatch" });
  });

  it("never throws: a signer failure of any kind maps to an honest code", async () => {
    const { publicKey } = await generateP256KeyPair();
    const signers: PayloadSigner[] = [
      async () => {
        throw new PayloadSignerError("signer_timeout", "bounded timeout");
      },
      async () => {
        throw new PayloadSignerError("signer_protocol_error", "malformed answer");
      },
      async () => {
        throw new Error("not a typed signer failure");
      },
      async () => "",
    ];

    for (const signer of signers) {
      const capability = await probePayloadSigner({
        signer,
        authorizationPublicKey: publicKey,
      });
      expect(capability.capable).toBe(false);
      expect([
        "signer_unavailable",
        "signer_timeout",
        "signer_rejected",
        "signature_mismatch",
      ]).toContain(capability.code);
    }
  });

  it("leaves only { capable, code }: no token, key, payload or signature leaks", async () => {
    const { privateKey, publicKey } = await generateP256KeyPair();

    const ok = await probePayloadSigner({
      signer: createKeyPayloadSigner(privateKey),
      authorizationPublicKey: publicKey,
    });
    const failed = await probePayloadSigner({
      signer: async () => {
        throw new PayloadSignerError("signer_rejected", "refused");
      },
      authorizationPublicKey: publicKey,
    });

    for (const capability of [ok, failed]) {
      expect(Object.keys(capability).sort()).toEqual(["capable", "code"]);
      expect(JSON.stringify(capability)).not.toMatch(SECRET_SHAPED);
    }
    expect(JSON.stringify([ok, failed])).not.toContain(publicKey.slice(0, 24));
  });
});
