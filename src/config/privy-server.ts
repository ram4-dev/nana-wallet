import { createPublicKey } from "node:crypto";

/**
 * PEW-014: server-side Privy configuration for the owner-verified sync and
 * user-authenticated signer enrollment paths.
 *
 * This config is ONLY about the server-side Privy API client (app id/secret,
 * authorization key quorum, optional authorization public key). It is distinct
 * from the identity verification inputs (PRIVY_VERIFICATION_KEY) which gate the
 * access-token verifier.
 *
 * Security rules enforced here:
 *  - The server client is configured ONLY when BOTH PRIVY_APP_ID and
 *    PRIVY_APP_SECRET are present. Identity-only Privy deployments (verification
 *    key present, no server secret) deliberately stay fixture-backed for wallet
 *    sync/enrollment.
 *  - PRIVY_AUTHORIZATION_PUBLIC_KEY, when present, is validated as base64
 *    DER/SPKI that decodes to a P-256 public key. The key material is never
 *    printed, and no validation failure includes the key value.
 *  - No secret is ever logged or embedded in a thrown error (PEW-011).
 *  - PMU-024: a funded singleton wallet provider is rejected outright; only the
 *    per-user-bound sources (`fixture` and `solana-devnet`) are allowed.
 */

export type PrivyServerConfig = {
 appId: string;
 appSecret: string;
 /** Authorization key quorum id; required only for enrollment prepare. */
 keyQuorumId?: string;
 /** Optional P-256 public key, base64-encoded DER/SPKI. Never exposed. */
 authorizationPublicKey?: string;
 baseUrl: string;
};

export const DEFAULT_PRIVY_API_BASE_URL = "https://api.privy.io/v1";

/**
 * Validates that `value` is a base64-encoded DER/SPKI EC public key on P-256.
 * Throws a message that never includes the key value.
 */
function assertP256Spki(value: string, name: string): void {
 let decoded: Buffer;
 try {
  decoded = Buffer.from(value, "base64");
  if (decoded.length === 0) throw new Error("empty");
 } catch {
  throw new Error(`${name} must be a valid base64-encoded public key.`);
 }
 try {
  const key = createPublicKey({
   key: decoded,
   format: "der",
   type: "spki",
  });
  if (
   key.asymmetricKeyType !== "ec" ||
   key.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
   throw new Error("not P-256");
  }
 } catch {
  // Never include the key material (or a prefix of it) in the error.
  throw new Error(`${name} must be a valid P-256 public key.`);
 }
}

/**
 * Reads the server-side Privy config. Returns `undefined` when the server client
 * is not configured (no app secret); throws on a partial/misconfigured pair or a
 * missing/extra auth public key rather than silently guessing.
 */
export function readPrivyServerConfig(
 environment: NodeJS.ProcessEnv = process.env,
): PrivyServerConfig | undefined {
 const appId = environment.PRIVY_APP_ID?.trim();
 const appSecret = environment.PRIVY_APP_SECRET?.trim();
 if (!appId || !appSecret) return undefined;

 // PMU-024: the identity foundation must not start with a funded singleton
 // wallet provider. Production identity is always the Privy verifier, so the
 // allowlist is unconditional: any source outside the per-user-bound set is
 // rejected — including a stale `WDK_TOOLS_SOURCE=live`.
 const source = environment.WDK_TOOLS_SOURCE?.trim() || "fixture";
 // PMU-024: Solana devnet is the only live provider allowed because its signing
 // path requires a per-user wallet binding; the singleton Solana provider has
 // no sender identity and fails closed.
 const perUserBoundSolana = source === "solana-devnet";
 if (source !== "fixture" && !perUserBoundSolana) {
  throw new Error(
   `WDK_TOOLS_SOURCE=${source} is not allowed: use 'fixture' or the per-user-bound 'solana-devnet' provider.`,
  );
 }

 const keyQuorumId =
  environment.PRIVY_AUTHORIZATION_KEY_QUORUM_ID?.trim() || undefined;
 const authorizationPublicKey =
  environment.PRIVY_AUTHORIZATION_PUBLIC_KEY?.trim() || undefined;
 if (authorizationPublicKey) {
  assertP256Spki(authorizationPublicKey, "PRIVY_AUTHORIZATION_PUBLIC_KEY");
 }

 return {
  appId,
  appSecret,
  keyQuorumId,
  authorizationPublicKey,
  baseUrl: environment.PRIVY_API_BASE_URL?.trim() || DEFAULT_PRIVY_API_BASE_URL,
 };
}
