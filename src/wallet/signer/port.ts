/**
 * S2a: the Privy authorization signing port.
 *
 * The authorization signing key is the last secret that could mint a Privy
 * authorization signature for arbitrary payloads. It is therefore held by a
 * separate local process (the signing sidecar) instead of the worker, and the
 * worker reaches it through this narrow port only.
 *
 * The payload is the ALREADY-FORMATTED authorization payload produced by the
 * official SDK (`formatRequestForAuthorizationSignature`, RFC 8785 canonical
 * JSON over the exact request). A signer must sign those bytes verbatim and
 * must never re-format, re-serialize or trim them.
 */
export type PayloadSigner = (payload: Uint8Array) => Promise<string>;

export type PayloadSignerErrorCode =
  /** The worker-side configuration is missing or partial. */
  | "signer_not_configured"
  /** Transport failure, 5xx, or any other non-definitive failure. */
  | "signer_unavailable"
  /** The sidecar did not answer inside the bounded timeout. */
  | "signer_timeout"
  /** A definitive 4xx rejection (bad token, oversized or malformed request). */
  | "signer_rejected"
  /** The answer was not a well-formed signature. */
  | "signer_protocol_error";

/**
 * Worker-side typed failure. Messages never carry the shared token, the
 * payload bytes, the signature or the key: only the failure class and, at most,
 * the HTTP status of the sidecar.
 */
export class PayloadSignerError extends Error {
  public constructor(
    public readonly code: PayloadSignerErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PayloadSignerError";
  }
}
