# 02 — Research: estado actual de la integración Privy

Todo lo de abajo está verificado en esta sesión: leyendo el código, el paquete
instalado, la API viva de Privy y la documentación oficial. Nada es supuesto.

## 1. El SDK oficial ya está instalado y tiene todo lo necesario

`@privy-io/node@0.34.0` (backend) y `@privy-io/react-auth@3.40.0` (front).

API moderna del cliente (verificada en `public-api/PrivyClient.d.ts`):

```text
privy.wallets() · privy.policies() · privy.keyQuorums()
privy.intents() · privy.transactions() · privy.users() · privy.apps()
```

Métodos de firma/lectura (`public-api/services/`):

| Servicio | Métodos |
| --- | --- |
| `wallets().ethereum()` | `signMessage` · `signTransaction` · `signTypedData` · `signUserOperation` · `sendTransaction` · `sendCalls` |
| `wallets().solana()` | equivalentes Solana |
| `wallets()` | `create` · `update` · `rpc` · `rawSign` · `transfer` · `export` |
| `policies()` | `create` · `get` · `getRule` · condition sets |
| `keyQuorums()` | `create` · `get` |
| `intents()` | `rpc` · `list` · `get` · `reject` · `createPolicyRule` |

Contexto de autorización (`lib/authorization.d.ts`):

```ts
export interface AuthorizationContext {
  authorization_private_keys?: string[];  // llave de app
  user_jwts?: string[];                   // sesión de usuario
  signatures?: string[];                  // firmas precalculadas
  sign_fns?: AuthorizationContext.SignFn[]; // ← delega el firmado (KMS)
}
```

## 2. Estado real de la configuración en Privy (consultado por API)

```text
app_id:              cmtu85txp027b0cjo82gb96vl
allowed_domains:     ["http://127.0.0.1:32802","https://nana-privy.localhost"]  ← cargados en esta sesión
allowed_native_app_ids: []
custom_jwt_auth:     false
email_auth:          true
sms_auth:            false          ← el login ofrece SMS → ese camino falla
embedded.mode:       user-controlled-server-wallets-only
embedded.create_on_login: off       ← el front pide "all-users" → usuarios nuevos sin wallet

Wallets del usuario:
  ethereum  hb000bxgo0kkdkg5fp6se9g9  0x5770353D…
    owner_id: nlgiiwtdpe59j4xd24cffe58  (key quorum del USUARIO, 1-de-1, con su DID, sin app keys)
    additional_signers: [ quorum np33q4k0i44p3g4kr2na0u9y ]  ← "Nana backend signer - Arc Testnet"
       override_policy_ids: [ u94to62itemodu5kon7ubwmy ]
  solana    mb8lz733x37gldmywtejfg14  AfHaCDtRK2…
    additional_signers: []   ← NADA configurado
    policy_ids: []

Política u94to62itemodu5kon7ubwmy ("nana-5431c7514f") — 1 regla ALLOW / eth_signTransaction:
  chain_id       eq  5042002
  to             eq  0x3600…0000   (USDC de Arc)
  value          eq  0
  transfer._amount  lte 10000000   (10 USDC por transferencia)
  transfer._to   in   ["0x1531F7AA…"]  ← UN SOLO destinatario
  → FALTA el tope acumulado (50 USDC / 3600s) que exige el diseño
```

El quorum `np33q4k0i44p3g4kr2na0u9y` tiene **1 authorization key y 0 users**.
`PRIVY_AUTHORIZATION_PRIVATE_KEY` está en el vault (184 chars, PKCS8 base64) pero
**no está en el env del stack local**, por eso el camino del signer no se pudo
probar todavía.

## 3. Inventario de código escrito a mano (a reemplazar)

**~12 call sites** reemplazables por el SDK.

### 3.1 Cliente REST propio
`src/wallet/privy-server-client.ts` — cliente HTTP desde cero con `generateAuthorizationSignature`
y armado manual de `privy-authorization-signature` / `privy-request-expiry`.

| Endpoint | Método | Reemplazo |
| --- | --- | --- |
| `GET /wallets?user_id&chain_type` | :274,:336 | `wallets()` list / `getWalletByAddress` |
| `GET /wallets/:id` | :418 | `wallets().update`-family get |
| `PATCH /wallets/:id` | :217,:438 | `wallets().update` |
| `POST /policies` | :496 | `policies().create` |
| `GET /policies/:id` | :518 | `policies().get` |
| `PATCH /policies/:id` | :537 | `policies()` |

### 3.2 Transporte de transacción propio
`src/wallet/privy-transaction-transport.ts` — EIP-1559 manual, RLP de `ethers`,
`eth_signTransaction` a mano, `eth_sendRawTransaction` propio, receipt propio.

`src/wallet/transfer-pipeline.ts` — `WalletTransferPipeline` maneja nonce/claim/
broadcast/reconcile + ABI ERC-20 manual (`encodeTransferCalldata`).

### 3.3 Balance propio
`src/wallet/privy-user-provider.ts:547` y `src/wallet/balances.ts:143` — `eth_call`
manual de `decimals()` y `balanceOf()`. Reemplazo: `wallets().balance`.

### 3.4 DSL de políticas propio
`src/wallet/enrollment-policy.ts:73` (reglas EVM) y
`src/wallet/grants/solana-enrollment-rules.ts:28` (reglas Solana) — composición
manual de `field_source`/`operator`/`abi`. Reemplazo: `policies()` + condition sets.

### 3.5 Solana
`src/wallet/solana-devnet-provider.ts:766` — `POST /wallets/:id/rpc` con
`signAndSendTransaction` + headers propios (:783,:799,:838-855).

### 3.6 Código MUERTO (solo tests)
- `PrivyTransactionTransport`, `createLivePrivyTransactionTransport`,
  `JsonRpcHttpClient`, `ethersSignedTransactionCodec`, `assertDecodedMatches`
- `WalletTransferPipeline` (+ sus helpers de ABI)
- De todo el transport, lo único vivo es `privyNodeAuthorizationSigner`

### 3.7 Frontend
Usa `usePrivy` (auth), `useWallets` (señal de sync), `useSigners` (consentimiento
de enrollment). **No firma nada.** No hay `useSendTransaction` ni `delegateWallet`.

## 4. Lo que hay que PRESERVAR (no es reemplazable por SDK)

| Pieza | Dónde | Por qué es nuestra |
| --- | --- | --- |
| Preview + confirmación explícita | `src/conversations/service.ts` | Control de producto; la doc lo dice: Privy no prueba que el usuario confirmó |
| Idempotencia por `previewId` | `transfer-pipeline.ts` | Nadie más lo garantiza |
| Verificación del payload firmado contra el intent | `privy-transaction-transport.ts:392` | Evita que Privy firme algo distinto a lo mostrado |
| Reconciliación por hash ante incertidumbre | `transfer-pipeline.ts` | Regla dura del repo |
| Gate de decisión de voz | `src/livekit/voice-decision-gate.ts` | Confirmación por voz |

## 5. Intento del camino "user JWT" — PROBADO Y BLOQUEADO

`POST /v1/wallets/authenticate` con `user_jwt`:

| Auth | Origen | Resultado |
| --- | --- | --- |
| `Basic` (lo que usa el SDK) | web y nativo | `400 Invalid JWT token provided` |
| `Bearer <jwt>` | web y nativo | `401 Invalid auth token` (403 antes de cargar orígenes) |

Descartado: token viejo (probado con 22 s de antigüedad), clave rotada (`kid`
coincide con el JWKS vivo), HPKE (el SDK lo usa internamente), token equivocado
(probados `privy:token` y `privy:pat`), origen (mismo resultado en web y nativo).

**Conclusión**: Privy rechaza su propio access token en ese endpoint. Y la doc
oficial de *Server-side access to user wallets* indica que el mecanismo soportado
para que el servidor firme es **un signer restringido por política**, no el JWT.

## 6. Hallazgo de seguridad colateral

`src/auth/privy-identity.ts:75` verifica los tokens **offline**: firma, `iss`,
`aud`, `exp`. **Nunca consulta revocación.** Verificado empíricamente: mientras
Privy rechazaba una sesión, nuestra API respondía 200.

## 7. Gaps que quedan abiertos

1. **No verificado**: si la política de Privy limita efectivamente al signer
   (prueba de 3 casos diseñada, requiere la app key en el env local).
2. **No verificado**: `sign_fns` contra un KMS real (solo teoría de la doc).
3. **No verificado**: si el modo nativo necesita `com.nanawallet.app` registrado
   (`allowed_native_app_ids` está vacío).
4. No se revisó el camino de `intents` (aprobación con el usuario) en profundidad.
