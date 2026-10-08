import { createHash, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import {
  createKeyPayloadSigner,
  loadAuthorizationPrivateKey,
} from "./key-signer.js";
import type { PayloadSigner } from "./port.js";

/**
 * S2a: the Privy authorization signing sidecar.
 *
 * WHY A SIDECAR
 * -------------
 * The Privy authorization key can mint an authorization signature for ANY
 * payload. Keeping it inside the voice worker means every code path, dependency
 * and crash dump of that process is in reach of the key. The key therefore
 * lives in this one small process, and the worker only ever asks it to sign.
 *
 * THE SIGNATURE CONTRACT
 * ----------------------
 * The sidecar performs exactly one operation:
 * `sign(payload) -> base64(der(ECDSA-P256(SHA256(payload))))`
 * over the bytes it receives. The official SDK formats the request payload
 * (`formatRequestForAuthorizationSignature`) and passes the already-serialized
 * bytes to `sign_fns`; the sidecar must never re-format, re-serialize or trim
 * them, and it never sees the request itself.
 *
 * HONEST LIMITATION — THIS IS A SIGNING ORACLE
 * --------------------------------------------
 * A bare sign endpoint signs whatever it is given. Any process that can reach
 * this port AND presents the shared bearer token can have arbitrary payloads
 * signed (for example a policy-evading transaction, bounded only by the Privy
 * policy attached to the wallet). Per-request authorization — proving that a
 * specific user/authz flow requested this exact signature, and granting the
 * token per request instead of statically — is DELIBERATELY DEFERRED to a later
 * slice. The mitigations implemented here reduce the blast radius; they do not
 * remove the oracle:
 *   - loopback-only bind (a non-loopback host is refused, not warned about),
 *   - a required shared bearer token compared in constant time,
 *   - a hard payload size cap, enforced before and while reading,
 *   - exactly one route (`POST /sign`) and no key-export route of any kind,
 *   - the payload, the signature, the token and the key are never logged,
 *   - the key is never returned by any response.
 * The intended deployment is therefore: the sidecar runs beside the worker on
 * the same host, its port is never exposed beyond loopback, and the token is
 * injected as a secret that is rotated with the key.
 */

export const SIGNER_PATH = "/sign";
export const DEFAULT_SIGNER_HOST = "127.0.0.1";
export const DEFAULT_SIGNER_PORT = 8788;
export const DEFAULT_MAX_PAYLOAD_BYTES = 64 * 1024;
export const MIN_TOKEN_LENGTH = 16;

export const SIGNER_TOKEN_ENV = "PRIVY_SIGNER_TOKEN";
export const SIGNER_HOST_ENV = "PRIVY_SIGNER_HOST";
export const SIGNER_PORT_ENV = "PRIVY_SIGNER_PORT";
export const SIGNER_MAX_PAYLOAD_BYTES_ENV = "PRIVY_SIGNER_MAX_PAYLOAD_BYTES";

export type SigningSidecarOptions = {
  /** Holds the key; the sidecar never inspects what it signs. */
  signer: PayloadSigner;
  /** Shared bearer token required on every request. */
  token: string;
  host?: string;
  port?: number;
  maxPayloadBytes?: number;
};

export type SigningSidecar = {
  /** Full sign endpoint url, e.g. `http://127.0.0.1:8788/sign`. */
  url: string;
  host: string;
  port: number;
  close(): Promise<void>;
};

export type SigningSidecarConfig = {
  token: string;
  host: string;
  port: number;
  maxPayloadBytes: number;
};

/** Loopback only: `localhost`, `::1`, or any `127.0.0.0/8` address. */
export function isLoopbackHost(host: string): boolean {
  const normalized = host.trim().toLocaleLowerCase("en-US");
  if (normalized === "localhost" || normalized === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(normalized);
}

function readPositiveInteger(
  value: string | undefined,
  name: string,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer.`);
  }
  return parsed;
}

function sendJson(
  response: ServerResponse,
  status: number,
  body: Record<string, unknown>,
  extraHeaders: Record<string, string> = {},
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
    ...extraHeaders,
  });
  response.end(payload);
}

/** Constant-time bearer comparison over fixed-length digests. */
function hasValidToken(request: IncomingMessage, expected: Buffer): boolean {
  const header = request.headers.authorization;
  if (typeof header !== "string") return false;
  const match = /^Bearer (.+)$/u.exec(header.trim());
  if (!match) return false;
  const received = createHash("sha256").update(match[1]!, "utf8").digest();
  return timingSafeEqual(received, expected);
}

/** Bounded read: the cap is enforced on the declared length AND while reading. */
async function readPayload(
  request: IncomingMessage,
  maxPayloadBytes: number,
): Promise<Uint8Array | "too_large"> {
  const declared = Number(request.headers["content-length"]);
  if (Number.isFinite(declared) && declared > maxPayloadBytes) return "too_large";
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > maxPayloadBytes) return "too_large";
    chunks.push(buffer);
  }
  return new Uint8Array(Buffer.concat(chunks, total));
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  options: {
    signer: PayloadSigner;
    expectedTokenDigest: Buffer;
    maxPayloadBytes: number;
  },
): Promise<void> {
  const path = (request.url ?? "").split("?")[0];
  if (path !== SIGNER_PATH) {
    sendJson(response, 404, { error: "not_found" });
    request.resume();
    return;
  }
  if (request.method !== "POST") {
    sendJson(response, 405, { error: "method_not_allowed" }, { allow: "POST" });
    request.resume();
    return;
  }
  if (!hasValidToken(request, options.expectedTokenDigest)) {
    sendJson(response, 401, { error: "unauthorized" });
    request.resume();
    return;
  }

  const body = await readPayload(request, options.maxPayloadBytes).catch(
    () => "aborted" as const,
  );
  if (body === "aborted") {
    request.destroy();
    return;
  }
  if (body === "too_large") {
    sendJson(
      response,
      413,
      { error: "payload_too_large" },
      { connection: "close" },
    );
    response.once("finish", () => request.destroy());
    return;
  }
  if (body.length === 0) {
    sendJson(response, 400, { error: "empty_payload" });
    return;
  }

  try {
    const signature = await options.signer(body);
    sendJson(response, 200, { signature });
  } catch {
    // A signer failure is reported without the payload, signature or key.
    sendJson(response, 500, { error: "signing_failed" });
  }
}

export async function startSigningSidecar(
  options: SigningSidecarOptions,
): Promise<SigningSidecar> {
  const token = options.token?.trim() ?? "";
  if (token.length < MIN_TOKEN_LENGTH) {
    throw new Error(
      `The signing sidecar requires a shared bearer token of at least ${MIN_TOKEN_LENGTH} characters.`,
    );
  }
  const host = options.host?.trim() || DEFAULT_SIGNER_HOST;
  if (!isLoopbackHost(host)) {
    throw new Error(
      `The signing sidecar refuses to bind ${host}: only a loopback host is allowed.`,
    );
  }
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  if (!Number.isInteger(maxPayloadBytes) || maxPayloadBytes <= 0) {
    throw new Error("The signing sidecar payload cap must be a positive integer.");
  }
  const port = options.port ?? DEFAULT_SIGNER_PORT;
  const expectedTokenDigest = createHash("sha256").update(token, "utf8").digest();

  const server: Server = createServer((request, response) => {
    void handleRequest(request, response, {
      signer: options.signer,
      expectedTokenDigest,
      maxPayloadBytes,
    });
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end("HTTP/1.1 400 Bad Request\r\ncontent-length: 0\r\n\r\n");
    }
    socket.destroy();
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("The signing sidecar did not bind a listening port.");
  }
  const boundHost = address.address;
  if (!isLoopbackHost(boundHost) && boundHost !== "::1") {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error(
      `The signing sidecar bound ${boundHost}, which is not loopback; refusing to serve.`,
    );
  }

  const urlHost = boundHost.includes(":") ? `[${boundHost}]` : boundHost;
  return {
    url: `http://${urlHost}:${address.port}${SIGNER_PATH}`,
    host,
    port: address.port,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

export function readSigningSidecarConfig(
  environment: NodeJS.ProcessEnv = process.env,
): SigningSidecarConfig {
  const token = environment[SIGNER_TOKEN_ENV]?.trim();
  if (!token) {
    throw new Error(
      `The signing sidecar requires the shared bearer token in ${SIGNER_TOKEN_ENV}.`,
    );
  }
  return {
    token,
    host: environment[SIGNER_HOST_ENV]?.trim() || DEFAULT_SIGNER_HOST,
    port: readPositiveInteger(
      environment[SIGNER_PORT_ENV],
      SIGNER_PORT_ENV,
      DEFAULT_SIGNER_PORT,
    ),
    maxPayloadBytes: readPositiveInteger(
      environment[SIGNER_MAX_PAYLOAD_BYTES_ENV],
      SIGNER_MAX_PAYLOAD_BYTES_ENV,
      DEFAULT_MAX_PAYLOAD_BYTES,
    ),
  };
}

/**
 * Sidecar entrypoint factory. This is the ONLY place that reads
 * `PRIVY_AUTHORIZATION_PRIVATE_KEY` (or the preferred `PRIVY_SIGNER_KEY_FILE`).
 */
export async function startSigningSidecarFromEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): Promise<SigningSidecar> {
  const config = readSigningSidecarConfig(environment);
  const signer = createKeyPayloadSigner(loadAuthorizationPrivateKey(environment));
  return startSigningSidecar({
    signer,
    token: config.token,
    host: config.host,
    port: config.port,
    maxPayloadBytes: config.maxPayloadBytes,
  });
}

async function main(): Promise<void> {
  const sidecar = await startSigningSidecarFromEnvironment();
  // Startup line only: no token, no key, no payload.
  console.error(
    `privy-authorization-signer listening on ${sidecar.url} (loopback only)`,
  );
  const shutdown = (): void => {
    void sidecar.close().then(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

const isDirectRun = /signer\/server\.(ts|js)$/u.test(process.argv[1] ?? "");
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
