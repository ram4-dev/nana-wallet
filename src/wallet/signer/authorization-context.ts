import type { AuthorizationContext } from "@privy-io/node";
import type { PayloadSigner } from "./port.js";

/**
 * S2a: builds the Privy authorization context from a signer port instead of an
 * in-process private key.
 *
 * `sign_fns` is the official SDK seam: the SDK formats the request payload,
 * canonicalizes it and passes the resulting bytes to every sign function. The
 * signer (the worker-side sidecar client) signs those bytes unchanged, so no
 * code path in this process ever sees `PRIVY_AUTHORIZATION_PRIVATE_KEY`.
 *
 * Usage at the SDK call site:
 * ```ts
 * await privy.wallets().ethereum().signTransaction(walletId, {
 *   params: { transaction },
 *   authorization_context: signerAuthorizationContext(payloadSigner),
 * });
 * ```
 */
export function signerAuthorizationContext(
  signer: PayloadSigner,
): AuthorizationContext {
  return { sign_fns: [signer] };
}
