import { PayloadSignerError, type PayloadSigner } from "./port.js";

/**
 * S2a: the worker-side client of the local signing sidecar.
 *
 * The worker knows only the sidecar url and the shared bearer token. It sends
 * the SDK-formatted payload bytes verbatim and returns the base64 DER signature.
 * Every failure mode is mapped to a typed `PayloadSignerError`, and no failure
 * carries the token, the payload, the signature or the key.
 */

export const SIGNER_URL_ENV = "PRIVY_SIGNER_URL";
export const SIGNER_TOKEN_ENV = "PRIVY_SIGNER_TOKEN";
export const SIGNER_TIMEOUT_MS_ENV = "PRIVY_SIGNER_TIMEOUT_MS";

/** Bounded attempt: a hung sidecar must fail the request, never block it. */
export const DEFAULT_SIGNER_TIMEOUT_MS = 5_000;

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/u;

export type PayloadSignerConfig = {
  /** Absolute url of the sidecar sign endpoint (loopback in deployments). */
  url: string;
  token: string;
  timeoutMs?: number;
};

/**
 * Reads the worker-side signing configuration. Returns `undefined` when no
 * signer is configured (the worker then has no signing path at all, exactly as
 * today), and fails closed on a partial or malformed configuration instead of
 * guessing. `PRIVY_AUTHORIZATION_PRIVATE_KEY` is deliberately NOT read here:
 * the key belongs to the sidecar process only.
 */
export function readPayloadSignerConfig(
  environment: NodeJS.ProcessEnv = process.env,
): PayloadSignerConfig | undefined {
  const url = environment[SIGNER_URL_ENV]?.trim();
  const token = environment[SIGNER_TOKEN_ENV]?.trim();
  if (!url && !token) return undefined;
  if (!url) {
    throw new PayloadSignerError(
      "signer_not_configured",
      `The local signing sidecar requires ${SIGNER_URL_ENV} when ${SIGNER_TOKEN_ENV} is configured.`,
    );
  }
  if (!token) {
    throw new PayloadSignerError(
      "signer_not_configured",
      `The local signing sidecar requires ${SIGNER_TOKEN_ENV} when ${SIGNER_URL_ENV} is configured.`,
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new PayloadSignerError(
      "signer_not_configured",
      `${SIGNER_URL_ENV} must be an absolute http(s) url.`,
    );
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PayloadSignerError(
      "signer_not_configured",
      `${SIGNER_URL_ENV} must be an absolute http(s) url.`,
    );
  }

  const timeoutRaw = environment[SIGNER_TIMEOUT_MS_ENV]?.trim();
  const timeoutMs = timeoutRaw ? Number(timeoutRaw) : DEFAULT_SIGNER_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new PayloadSignerError(
      "signer_not_configured",
      `${SIGNER_TIMEOUT_MS_ENV} must be a positive number of milliseconds.`,
    );
  }
  return { url, token, timeoutMs };
}

export function createHttpPayloadSigner(
  config: PayloadSignerConfig,
): PayloadSigner {
  const timeoutMs = config.timeoutMs ?? DEFAULT_SIGNER_TIMEOUT_MS;

  return async (payload: Uint8Array): Promise<string> => {
    let response: Response;
    try {
      response = await fetch(config.url, {
        method: "POST",
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
        headers: {
          authorization: `Bearer ${config.token}`,
          "content-type": "application/octet-stream",
        },
        body: payload,
      });
    } catch (error) {
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new PayloadSignerError(
          "signer_timeout",
          `The local signing sidecar did not answer within ${timeoutMs}ms.`,
        );
      }
      throw new PayloadSignerError(
        "signer_unavailable",
        "The local signing sidecar is unreachable.",
      );
    }

    if (!response.ok) {
      // Drain the body so the connection can be reused; the body is never
      // surfaced (it may echo request headers or other sensitive context).
      await response.text().catch(() => "");
      const definitive = response.status >= 400 && response.status < 500;
      throw new PayloadSignerError(
        definitive ? "signer_rejected" : "signer_unavailable",
        definitive
          ? `The local signing sidecar rejected the request (${response.status}).`
          : `The local signing sidecar is unavailable (${response.status}).`,
      );
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      throw new PayloadSignerError(
        "signer_protocol_error",
        "The local signing sidecar returned a malformed response.",
      );
    }
    const signature = (body as { signature?: unknown } | null)?.signature;
    if (typeof signature !== "string" || !BASE64.test(signature)) {
      throw new PayloadSignerError(
        "signer_protocol_error",
        "The local signing sidecar returned no signature.",
      );
    }
    return signature;
  };
}

/**
 * Worker-side entry point: builds the signer from the environment, or returns
 * `undefined` when the sidecar is not configured.
 */
export function createWorkerPayloadSigner(
  environment: NodeJS.ProcessEnv = process.env,
): PayloadSigner | undefined {
  const config = readPayloadSignerConfig(environment);
  return config ? createHttpPayloadSigner(config) : undefined;
}
