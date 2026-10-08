/**
 * S2a: worker-facing surface of the Privy authorization signing sidecar.
 *
 * Only the key-free half is exported here. The key-holding modules
 * (`key-signer.ts`) and the sidecar process (`server.ts`) are imported by the
 * sidecar entrypoint alone, so a worker process can build an authorization
 * context without ever linking the key path.
 *
 * See `README.md` in this directory for how to run the sidecar.
 */
export {
  PayloadSignerError,
  type PayloadSigner,
  type PayloadSignerErrorCode,
} from "./port.js";
export { signerAuthorizationContext } from "./authorization-context.js";
export {
  DEFAULT_SIGNER_TIMEOUT_MS,
  SIGNER_TIMEOUT_MS_ENV,
  SIGNER_TOKEN_ENV,
  SIGNER_URL_ENV,
  createHttpPayloadSigner,
  createWorkerPayloadSigner,
  readPayloadSignerConfig,
  type PayloadSignerConfig,
} from "./client.js";
