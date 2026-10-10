# Privy authorization signing sidecar (S2a)

The Privy **authorization key** can mint an authorization signature for any
payload. It used to be read as `PRIVY_AUTHORIZATION_PRIVATE_KEY` inside the
voice worker process. This module moves the key into a separate, tiny process —
the signing sidecar — and lets the worker ask it to sign through the official
SDK's `sign_fns` seam.

```
worker process                      signing sidecar process
--------------                      -----------------------
Privy SDK (formats payload)         PRIVY_AUTHORIZATION_PRIVATE_KEY  (key)
        |                            or PRIVY_SIGNER_KEY_FILE
        v                                    |
  sign_fns[0] = client(PRIVY_SIGNER_URL, PRIVY_SIGNER_TOKEN)
        |  POST /sign  (bytes verbatim, Bearer token)
        +---------------------------------->  base64(der(ECDSA-P256(SHA256(payload))))
                                             |
        <------------------------------------+
```

The sidecar has exactly one operation:

```
sign(payload: Uint8Array) -> base64(der(ECDSA-P256(SHA256(payload))))
```

The payload arrives **already formatted** by the SDK
(`formatRequestForAuthorizationSignature`, RFC 8785 canonical JSON over the
exact HTTP request). The sidecar must not re-format, re-serialize or trim those
bytes, and it never sees the request itself.

## Layout

| File | Side | Responsibility |
| --- | --- | --- |
| `port.ts` | both | `PayloadSigner` port + `PayloadSignerError` codes |
| `authorization-context.ts` | worker | `signerAuthorizationContext(signer)` → `{ sign_fns: [signer] }` |
| `client.ts` | worker | HTTP client, bounded timeout, typed failure mapping |
| `key-signer.ts` | sidecar only | loads the key (env or 0600 file), signs |
| `server.ts` | sidecar only | loopback HTTP endpoint, token check, size cap, entrypoint |
| `index.ts` | worker | worker-facing barrel (never links `key-signer.ts`/`server.ts`) |

## Running it locally

```bash
# 1. shared bearer token (at least 16 chars), same value in both processes
export PRIVY_SIGNER_TOKEN="$(openssl rand -hex 32)"

# 2a. sidecar holds the key — prefer a 0600 file owned by the sidecar user:
export PRIVY_SIGNER_KEY_FILE="/run/secrets/privy-authorization-private-key"
# 2b. or inline (base64 PKCS#8 DER, no PEM headers):
# export PRIVY_AUTHORIZATION_PRIVATE_KEY="<base64-pkcs8-der>"
export PRIVY_SIGNER_HOST="127.0.0.1"   # default; anything else is refused
export PRIVY_SIGNER_PORT="8788"        # default
# export PRIVY_SIGNER_MAX_PAYLOAD_BYTES="65536"  # default

npm run signer:serve
# → privy-authorization-signer listening on http://127.0.0.1:8788/sign (loopback only)

# 3. the worker only learns the url and the token (never the key)
export PRIVY_SIGNER_URL="http://127.0.0.1:8788/sign"
# export PRIVY_SIGNER_TIMEOUT_MS="5000"  # default
npm run livekit:dev
```

A partial configuration fails closed:

- `PRIVY_SIGNER_URL` without `PRIVY_SIGNER_TOKEN` (or vice versa) throws at
  worker boot instead of silently signing nothing.
- No `PRIVY_SIGNER_*` configuration at all ⇒ the worker has no signer, so the
  wallet path keeps its previous fail-closed behaviour.
- The sidecar refuses to start without a key and refuses any bind host that is
  not loopback.

## HONEST LIMITATION: this endpoint is a signing oracle

A bare sign endpoint signs whatever it is given. **Anything that can reach this
port AND holds the token can have arbitrary payloads signed** — including a
transaction that only the Privy wallet policy would otherwise stop. The
signature itself proves nothing about which user or flow requested it.

Mitigations implemented here reduce the blast radius; they do not remove the
oracle:

- **loopback-only bind** — a non-loopback `PRIVY_SIGNER_HOST` is refused (error,
  not warning), and the bound address is re-checked after `listen`;
- **shared bearer token** on every request, compared in constant time over
  SHA-256 digests (no length or prefix leak);
- **hard payload cap** (`PRIVY_SIGNER_MAX_PAYLOAD_BYTES`, default 64 KiB)
  enforced both on the declared `content-length` and while reading the body;
- **exactly one route** (`POST /sign`); every other path/method is refused and
  no route returns the key, the token or any key material;
- **no logging** of the payload, the signature, the token or the key — not even
  on failure (failures are reported as a generic `signing_failed`).

**Deliberately deferred (later slice):** per-request authorization — proving
that a specific user/authz flow asked for this exact signature, and issuing the
token per request or per user instead of one static shared secret. Until then
the sidecar must run beside the worker on the same host and its port must never
be published.

## Verifying a signature

ECDSA P-256 uses a random per-signature nonce, so **two signatures over the same
payload are never byte-identical**. Never assert byte equality; assert
verification instead:

```ts
verify("sha256", payload, { key: publicKeyObject, dsaEncoding: "der" }, signature)
```

## Not in this slice (S2a scope)

- `src/runtime/dependencies.ts` (the voice worker entry) no longer reads the
  authorization key at all; `src/server.ts` (the HTTP API process) still
  constructs its Privy server client with the process-held key for enrollment
  and grant policy writes. Moving those to the sidecar is a follow-up, because
  `PrivyServerClient` still derives its authorization context from the key
  string.
- Wiring `previewTransfer` / `broadcastTransfer` / `waitForFinality` to use the
  signer is S2b; they stay fail-closed.
- The legacy Solana dispatch client
  (`src/wallet/solana-devnet-provider.ts`) still builds its own authorization
  signature from the environment key; migrating it to this sidecar is a
  follow-up.

## Deployment wiring (compose)

`compose.privy-local.yaml` runs **one sidecar per consumer namespace**, because the
sidecar refuses any non-loopback bind and can therefore only serve a process that
shares its network namespace:

| Service | Namespace | Loopback endpoint | Key material |
|---|---|---|---|
| `backend-signer` | `service:backend` | `127.0.0.1:8788` | mounts `PRIVY_SIGNER_KEY_DIR` read-only as `/run/secrets`; reads `PRIVY_SIGNER_KEY_FILE` |
| `voice-worker-signer` | `service:voice-worker` | `127.0.0.1:8789` | same, distinct port (belt-and-braces; the namespaces are already distinct) |

Neither service declares `ports:`. The absence of a published port is the first
line of defence; the loopback bind is the second.

The two consumers (`backend`, `voice-worker`) get the capability, never the key:

| Variable | Meaning |
|---|---|
| `PRIVY_SIGNER_URL` | Absolute sidecar url on the consumer's own loopback, e.g. `http://127.0.0.1:8788/sign`. |
| `PRIVY_SIGNER_TOKEN` | Shared bearer token required on every sign request. A capability, not a key. |
| `PRIVY_SIGNER_TIMEOUT_MS` | Bounded attempt in milliseconds; a hung sidecar must fail the request, never block it. |
| `PRIVY_SIGNER_KEY_DIR` | Host directory the compose signer services mount read-only at `/run/secrets`. Never referenced by `backend`, `voice-worker` or `frontend`. |

`frontend` keeps `VITE_PRIVY_APP_ID` only. `PRIVY_AUTHORIZATION_PRIVATE_KEY` and
`PRIVY_SIGNER_KEY_FILE` must appear in no consumer environment, and no consumer
mounts `privy-authorization-private-key`; `tests/unit/policy-signer-compose-structural.test.ts`
asserts all of that structurally, without reading or printing any value.
