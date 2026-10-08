import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PayloadSigner } from "./port.js";

/**
 * S2a: the key-holding half of the signing sidecar.
 *
 * This module is imported ONLY by the sidecar entrypoint
 * (`src/wallet/signer/server.ts`). No worker process imports it, so the
 * authorization private key is loaded in exactly one process.
 *
 * Format contract (matches `@privy-io/node`'s `generateAuthorizationSignature`):
 * a base64-encoded PKCS#8 DER P-256 private key with no PEM headers. The
 * signature is the DER-encoded ECDSA P-256 over SHA-256 of the payload. The
 * SDK's own signer hashes the payload once with SHA-256; verified against
 * OpenSSL (`crypto.verify("sha256", payload, publicKey, signature)`).
 */

export const AUTHORIZATION_PRIVATE_KEY_ENV = "PRIVY_AUTHORIZATION_PRIVATE_KEY";
/** Preferred in deployments: a 0600 file holding the same base64 key. */
export const SIGNER_KEY_FILE_ENV = "PRIVY_SIGNER_KEY_FILE";

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

function parseAuthorizationPrivateKey(value: string): KeyObject {
  const message =
    "The authorization private key must be a valid base64-encoded P-256 PKCS#8 private key.";
  const trimmed = value.trim();
  if (!trimmed || !BASE64.test(trimmed)) throw new Error(message);
  let decoded: Buffer;
  try {
    decoded = Buffer.from(trimmed, "base64");
    if (decoded.length === 0) throw new Error("empty");
  } catch {
    // Never include the key material (or a prefix of it) in the error.
    throw new Error(message);
  }
  try {
    const key = createPrivateKey({ key: decoded, format: "der", type: "pkcs8" });
    if (
      key.asymmetricKeyType !== "ec" ||
      key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
    ) {
      throw new Error("not P-256");
    }
    return key;
  } catch {
    throw new Error(message);
  }
}

/**
 * Loads the authorization private key from the environment (base64 PKCS#8 DER)
 * or, preferably, from `PRIVY_SIGNER_KEY_FILE` (a file with mode 0600 that the
 * operator or secret injector wrote). Never returns or logs the key.
 */
export function loadAuthorizationPrivateKey(
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const inline = environment[AUTHORIZATION_PRIVATE_KEY_ENV]?.trim();
  const file = environment[SIGNER_KEY_FILE_ENV]?.trim();
  if (inline && file) {
    throw new Error(
      `Configure either ${AUTHORIZATION_PRIVATE_KEY_ENV} or ${SIGNER_KEY_FILE_ENV}, not both.`,
    );
  }
  if (inline) {
    // Fail at load time: an unusable key must stop the sidecar at boot, not at
    // the first signing request.
    parseAuthorizationPrivateKey(inline);
    return inline;
  }
  if (!file) {
    throw new Error(
      `The signing sidecar requires the authorization private key: set ${SIGNER_KEY_FILE_ENV} (preferred) or ${AUTHORIZATION_PRIVATE_KEY_ENV}.`,
    );
  }
  let contents: string;
  try {
    contents = readFileSync(file, "utf8").trim();
  } catch {
    throw new Error(`${SIGNER_KEY_FILE_ENV} could not be read.`);
  }
  if (!contents) throw new Error(`${SIGNER_KEY_FILE_ENV} is empty.`);
  parseAuthorizationPrivateKey(contents);
  return contents;
}

/**
 * Builds the payload signer that holds the key in memory. Every call signs the
 * payload it is given; the payload is never logged, stored or echoed.
 */
export function createKeyPayloadSigner(
  base64Pkcs8PrivateKey: string,
): PayloadSigner {
  const key = parseAuthorizationPrivateKey(base64Pkcs8PrivateKey);
  return async (payload: Uint8Array): Promise<string> => {
    const signer = createSign("sha256");
    signer.update(payload);
    // DER-encoded ECDSA signature over SHA-256(payload), base64 encoded — the
    // exact encoding content of @privy-io/node's authorization signature.
    return signer.sign({ key, dsaEncoding: "der" }).toString("base64");
  };
}
