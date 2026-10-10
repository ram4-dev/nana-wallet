import { afterEach, describe, expect, it, vi } from "vitest";
import { generateP256KeyPair } from "@privy-io/node";
import Fastify from "fastify";
import { registerHealthRoutes } from "../../src/api/health.js";
import { createKeyPayloadSigner } from "../../src/wallet/signer/key-signer.js";
import { PayloadSignerError } from "../../src/wallet/signer/port.js";
import {
  policySignerProbePayload,
  verifyPolicySignerCapability,
} from "../../src/wallet/policy/probe.js";
import type { WalletProvider } from "../../src/wallet/provider.js";

/**
 * Design §6.4 layer 2/3, task 2.7 — the capability probe and the readiness
 * surface.
 *
 * The positive control comes first in every case: `verified` is asserted against
 * a REAL P-256 key pair before any negative code is asserted, so a
 * `capable: false` assertion cannot pass because the probe, the key or the whole
 * module was missing.
 *
 * The signature is asserted with `crypto.verify`, never byte equality: ECDSA
 * P-256 signs the same payload differently every time, and the "two runs, two
 * different signatures, both verified" case pins exactly that.
 */

const SECRET_SHAPED = /token|key|signature|payload|private|secret/i;

async function keyPair(): Promise<{ privateKey: string; publicKey: string }> {
  const pair = await generateP256KeyPair();
  return { privateKey: pair.privateKey, publicKey: pair.publicKey };
}

function failingSigner(code: ConstructorParameters<typeof PayloadSignerError>[0]) {
  return async (): Promise<string> => {
    throw new PayloadSignerError(code, `probe failure (${code})`);
  };
}

function fakeWallet(): WalletProvider {
  return {
    async listNetworks() {
      return ["solana-devnet"];
    },
    async getAddress() {
      return "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7ua4e6FjZg3Dq";
    },
    async getBalance() {
      return "0";
    },
    async getHistory() {
      return [];
    },
    async sendToken() {
      return "signature";
    },
    async close() {},
  } as unknown as WalletProvider;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("verifyPolicySignerCapability", () => {
  it("reports verified for a signature that verifies under the configured public key", async () => {
    const { privateKey, publicKey } = await keyPair();

    const capability = await verifyPolicySignerCapability({
      signer: createKeyPayloadSigner(privateKey),
      authorizationPublicKey: publicKey,
    });

    expect(capability).toEqual({ capable: true, code: "verified" });
  });

  it("verifies rather than comparing bytes: two signed runs differ and both verify", async () => {
    const { privateKey, publicKey } = await keyPair();
    const signer = createKeyPayloadSigner(privateKey);
    const payload = policySignerProbePayload();

    const first = await signer(payload);
    const second = await signer(payload);

    expect(first).not.toBe(second);
    for (const capability of await Promise.all([
      verifyPolicySignerCapability({
        signer,
        authorizationPublicKey: publicKey,
      }),
      verifyPolicySignerCapability({
        signer,
        authorizationPublicKey: publicKey,
      }),
    ])) {
      expect(capability).toEqual({ capable: true, code: "verified" });
    }
  });

  it("reports signer_unavailable when no signer is configured", async () => {
    const capability = await verifyPolicySignerCapability({
      environment: {},
      authorizationPublicKey: "irrelevant-because-no-signer",
    });

    expect(capability).toEqual({ capable: false, code: "signer_unavailable" });
  });

  it("reports signer_unavailable when there is no configured public key to verify against", async () => {
    const { privateKey } = await keyPair();

    const capability = await verifyPolicySignerCapability({
      environment: {},
      signer: createKeyPayloadSigner(privateKey),
    });

    expect(capability).toEqual({ capable: false, code: "signer_unavailable" });
  });

  it("reports signer_rejected for a definitive refusal from the sidecar", async () => {
    const { publicKey } = await keyPair();

    const capability = await verifyPolicySignerCapability({
      environment: {},
      signer: failingSigner("signer_rejected"),
      authorizationPublicKey: publicKey,
    });

    expect(capability).toEqual({ capable: false, code: "signer_rejected" });
  });

  it("reports signer_timeout when the sidecar does not answer inside its bound", async () => {
    const { publicKey } = await keyPair();

    const capability = await verifyPolicySignerCapability({
      environment: {},
      signer: failingSigner("signer_timeout"),
      authorizationPublicKey: publicKey,
    });

    expect(capability).toEqual({ capable: false, code: "signer_timeout" });
  });

  it("reports signer_unavailable for transport, protocol and configuration failures", async () => {
    const { publicKey } = await keyPair();

    for (const signer of [
      failingSigner("signer_unavailable"),
      failingSigner("signer_protocol_error"),
      failingSigner("signer_not_configured"),
      async (): Promise<string> => {
        throw new Error("not a PayloadSignerError");
      },
    ]) {
      const capability = await verifyPolicySignerCapability({
        environment: {},
        signer,
        authorizationPublicKey: publicKey,
      });
      expect(capability).toEqual({
        capable: false,
        code: "signer_unavailable",
      });
    }
  });

  it("reports signature_mismatch for a well-formed signature from a DIFFERENT key", async () => {
    const { publicKey } = await keyPair();
    const other = await keyPair();

    const capability = await verifyPolicySignerCapability({
      environment: {},
      signer: createKeyPayloadSigner(other.privateKey),
      authorizationPublicKey: publicKey,
    });

    expect(capability).toEqual({ capable: false, code: "signature_mismatch" });
  });

  it("reports signature_mismatch for a signature that is not well-formed DER", async () => {
    const { publicKey } = await keyPair();

    for (const signature of ["", "not-base64!!", Buffer.alloc(8, 3).toString("base64")]) {
      const capability = await verifyPolicySignerCapability({
        environment: {},
        signer: async () => signature,
        authorizationPublicKey: publicKey,
      });
      expect(capability).toEqual({
        capable: false,
        code: "signature_mismatch",
      });
    }
  });

  it("reports signer_unavailable for an unusable configured public key", async () => {
    const { privateKey } = await keyPair();

    const capability = await verifyPolicySignerCapability({
      environment: {},
      signer: createKeyPayloadSigner(privateKey),
      authorizationPublicKey: "not-a-p256-spki-key",
    });

    expect(capability).toEqual({ capable: false, code: "signer_unavailable" });
  });

  it("leaves only { capable, code }: no token, key, payload or signature in the result, and nothing logged", async () => {
    const { privateKey, publicKey } = await keyPair();
    const logged: unknown[][] = [];
    const spies = (["log", "error", "warn", "info"] as const).map((method) =>
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(args);
      }),
    );

    const capability = await verifyPolicySignerCapability({
      signer: createKeyPayloadSigner(privateKey),
      authorizationPublicKey: publicKey,
    });

    expect(capability).toEqual({ capable: true, code: "verified" });
    expect(Object.keys(capability).sort()).toEqual(["capable", "code"]);
    expect(JSON.stringify(capability)).not.toMatch(SECRET_SHAPED);
    expect(JSON.stringify(logged)).not.toMatch(SECRET_SHAPED);
    // The configured key never appears anywhere in the probe's output, not even
    // a prefix of it.
    expect(JSON.stringify([capability, logged])).not.toContain(publicKey.slice(0, 24));
    expect(spies).toHaveLength(4);
  });

  it("exercises the real environment without fabricating a capability", async () => {
    const capability = await verifyPolicySignerCapability();

    expect(Object.keys(capability).sort()).toEqual(["capable", "code"]);
    expect(JSON.stringify(capability)).not.toMatch(SECRET_SHAPED);
    if (!process.env.PRIVY_SIGNER_URL && !process.env.PRIVY_SIGNER_TOKEN) {
      // This deployment's actual state: no sidecar configured at all.
      expect(capability).toEqual({
        capable: false,
        code: "signer_unavailable",
      });
    }
  });
});

describe("GET /health policySigner readiness surface", () => {
  async function healthBody(
    policySigner?: () => Promise<{ capable: boolean; code: string }>,
  ): Promise<Record<string, unknown>> {
    const app = Fastify();
    await registerHealthRoutes(app, {
      wallet: fakeWallet(),
      ...(policySigner
        ? { policySigner: policySigner as never }
        : {}),
    });
    const response = await app.inject({ method: "GET", url: "/health" });
    expect(response.statusCode).toBe(200);
    return response.json() as Record<string, unknown>;
  }

  it("carries policySigner with exactly the capability and the code, and no secret", async () => {
    const body = await healthBody(async () => ({
      capable: true,
      code: "verified",
    }));

    expect(body.policySigner).toEqual({ capable: true, code: "verified" });
    expect(Object.keys(body.policySigner as object).sort()).toEqual([
      "capable",
      "code",
    ]);
    expect(JSON.stringify(body.policySigner)).not.toMatch(SECRET_SHAPED);
    // No other field was added by this unit.
    expect(Object.keys(body).sort()).toEqual(
      [
        "mcp",
        "mode",
        "network",
        "policySigner",
        "provider",
        "status",
        "wallet",
      ].sort(),
    );
  });

  it("defaults to the real probe and reports the deployment's honest code", async () => {
    const body = await healthBody();

    const policySigner = body.policySigner as {
      capable: boolean;
      code: string;
    };
    expect(Object.keys(policySigner).sort()).toEqual(["capable", "code"]);
    expect([
      "verified",
      "signer_unavailable",
      "signer_rejected",
      "signer_timeout",
      "signature_mismatch",
    ]).toContain(policySigner.code);
    expect(JSON.stringify(body)).not.toMatch(SECRET_SHAPED);
    if (!process.env.PRIVY_SIGNER_URL && !process.env.PRIVY_SIGNER_TOKEN) {
      expect(policySigner).toEqual({
        capable: false,
        code: "signer_unavailable",
      });
    }
  });
});
