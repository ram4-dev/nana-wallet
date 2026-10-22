import { createPublicKey, verify, type KeyObject } from "node:crypto";
import { createWorkerPayloadSigner } from "./client.js";
import {
  PayloadSignerError,
  type PayloadSigner,
} from "./port.js";

/**
 * D-D: the signing sidecar capability probe, hosted by the signer module —
 * the module that owns the port the sidecar is reached through.
 *
 * A capability answer must come from actually SIGNING, not from configuration
 * presence: the 2026-10-12 orphaned-sidecar incident showed that a configured
 * url/token pair says nothing about whether a sidecar is still reachable in
 * this network namespace. The probe signs one tiny fixed, non-secret payload
 * through the `PayloadSigner` port and asserts the answer against the
 * registered authorization public key.
 *
 * The contract mirrors the health readiness vocabulary (`{ capable, code }`
 * only): the probe NEVER throws — every failure class maps to an honest code —
 * and it never returns or logs the token, the payload, the signature or the
 * key. A `verified` answer means a signature over the fixed payload verified
 * under the configured P-256 public key; without a public key to verify
 * against, the capability cannot be asserted and the probe fails closed.
 */
export type SignerCapabilityCode =
  | "verified"
  | "signer_unavailable"
  | "signer_rejected"
  | "signer_timeout"
  | "signature_mismatch";

export type SignerCapability = {
  capable: boolean;
  code: SignerCapabilityCode;
};

/**
 * The probe payload: fixed, non-secret and byte-stable across runs. Nothing in
 * it carries a token, a key, an address or a user id.
 */
const PROBE_PAYLOAD_OBJECT = {
  probe: "signer-capability",
  version: 1,
  issuedAt: "1970-01-01T00:00:00.000Z",
} as const;

export function signerProbePayload(): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(PROBE_PAYLOAD_OBJECT));
}

/**
 * Signs the fixed probe payload through the configured sidecar and verifies
 * the signature against the registered authorization public key.
 *
 * Failure mapping is exhaustive and secret-free:
 *  - no signer configured, a partial configuration, a transport failure, a
 *    5xx, a malformed answer or an unusable public key -> `signer_unavailable`;
 *  - a definitive 4xx from the sidecar -> `signer_rejected`;
 *  - the sidecar did not answer inside its bounded timeout -> `signer_timeout`;
 *  - the signature does not verify under the configured key (or is not a
 *    well-formed signature) -> `signature_mismatch`.
 */
export async function probePayloadSigner(
  deps: {
    /** Defaults to the current process environment. */
    environment?: NodeJS.ProcessEnv;
    /** Defaults to the environment-configured sidecar client, if any. */
    signer?: PayloadSigner;
    /** Defaults to `PRIVY_AUTHORIZATION_PUBLIC_KEY`. */
    authorizationPublicKey?: string;
  } = {},
): Promise<SignerCapability> {
  const environment = deps.environment ?? process.env;

  let signer = deps.signer;
  if (!signer) {
    try {
      signer = createWorkerPayloadSigner(environment);
    } catch {
      // A partial or malformed configuration is not a reachable capability.
      return { capable: false, code: "signer_unavailable" };
    }
  }
  if (!signer) {
    return { capable: false, code: "signer_unavailable" };
  }

  const publicKeyB64 =
    deps.authorizationPublicKey ??
    environment.PRIVY_AUTHORIZATION_PUBLIC_KEY?.trim();
  if (!publicKeyB64) {
    // Without the registered public key the signature is unverifiable, so the
    // capability cannot be asserted. Fails closed rather than assuming.
    return { capable: false, code: "signer_unavailable" };
  }

  let publicKeyObject: KeyObject;
  try {
    publicKeyObject = createPublicKey({
      key: Buffer.from(publicKeyB64, "base64"),
      format: "der",
      type: "spki",
    });
  } catch {
    // Never echo the key material, not even a prefix.
    return { capable: false, code: "signer_unavailable" };
  }

  const payload = signerProbePayload();
  let signature: string;
  try {
    signature = await signer(payload);
  } catch (error) {
    return { capable: false, code: failureCode(error) };
  }

  try {
    const verified = verify(
      "sha256",
      payload,
      publicKeyObject,
      Buffer.from(signature, "base64"),
    );
    return verified
      ? { capable: true, code: "verified" }
      : { capable: false, code: "signature_mismatch" };
  } catch {
    // A signature that is not well-formed DER is a mismatch, not a crash.
    return { capable: false, code: "signature_mismatch" };
  }
}

/** Maps a worker-side signer failure onto the readiness vocabulary. */
function failureCode(error: unknown): SignerCapabilityCode {
  if (error instanceof PayloadSignerError) {
    switch (error.code) {
      case "signer_timeout":
        return "signer_timeout";
      case "signer_rejected":
        return "signer_rejected";
      default:
        // signer_unavailable, signer_protocol_error and signer_not_configured
        // are all "we could not obtain a usable signature".
        return "signer_unavailable";
    }
  }
  return "signer_unavailable";
}
