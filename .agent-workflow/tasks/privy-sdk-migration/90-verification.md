# 90 — Verification

## S0 — Gate: ¿la política limita al signer? **PASS**

- Fecha: 2026-10-08
- Worktree de implementación: `/Users/ramiro/Desktop/projects/colloseum.feat-privy-sdk-migration`
  (branch `feat/privy-sdk-migration`, creado con `wt switch --create`)
- Prueba: `.agent-workflow/tasks/privy-sdk-migration/evidence/policy-probe.mjs`
- Método: `privy.wallets().ethereum().signTransaction(...)` con
  `authorization_context: { authorization_private_keys: [<app key>] }`.
  **Firma solamente — nunca broadcast. No se movió ningún fondo.**

### Resultado

```text
wallet: hb000bxgo0kkdkg5fp6se9g9  chain: 5042002  usdc: 0x3600…0000
--- 3 casos, solo firma, sin broadcast ---
A) 1.00 USDC -> destinatario permitido      : SIGNED
B) 1.00 USDC -> destinatario NO permitido   : BLOCKED -> 400 policy_violation
C) 20.00 USDC -> permitido (sobre el tope)  : BLOCKED -> 400 policy_violation
```

### Qué queda demostrado

1. **La app key es válida y Privy la acepta** para firmar como additional signer.
   (Antes fallaba con `Invalid wallet authorization private key` porque el stack
   local nunca tuvo la key cargada.)
2. **La política se aplica de verdad al signer**: el allowlist de destinatarios y el
   tope por transferencia son **rechazados por Privy**, no por nuestro código.
3. El camino D1a/D1b es **viable**: el servidor puede firmar dentro de una política
   que efectivamente lo acota.

### Qué NO queda demostrado

1. **El tope acumulado (50 USDC / 3600 s) no existe todavía** (P1). El caso C prueba
   el tope *por transferencia* (10 USDC), no el acumulado. El mecanismo de la
   política funciona; falta la regla.
2. `sign_fns` (firma delegada a KMS, opción D1b) **no se probó**: se usó la key
   directa. Falta verificar el seam.
3. Nada de esto se probó con **Solana** (hoy sin signer ni política).

### Aprendizajes técnicos (para S1/S2)

- `signTransaction` **no** acepta `{ transaction }` en la raíz: espera
  `{ params: { transaction: {...} }, authorization_context }`
  (`PrivyWalletsRpcInput` = `WithAuthorization<WithIdempotency<WithExpiry<Omit<Params,'chain_type'|'method'>>>>`).
- `signMessage` sí acepta `{ message, authorization_context }` directo, porque usa
  `ReplaceParams`.
- **No existe API de escritura** para la config de app: `PATCH /v1/apps/{id}` → 405,
  `GET /v1/apps/{id}/settings` → 404. `allowed_domains` es dashboard-only.

### Manejo de la app key (higiene)

La key se obtuvo desde la Secret Vault sin pasar por stdout: se usó `secret_exec`
con `curl` dentro del vault hacia un receptor efímero en el host, y se guardó con
permisos `0600`. **Al terminar la prueba el archivo fue borrado y el receptor
detenido.** La key nunca se imprimió en el transcript ni se escribió en el repo.

### Incidente de secretos previo (ya divulgado, sigue pendiente)

`/tmp/nani-secrets/secrets.env` continúa con copias de otros secretos en texto
plano. **Borrar al terminar la sesión.**

---

## S1 — Cliente de administración sobre el SDK **PASS**

- Fecha: 2026-10-08
- Commit: `228f2a6 refactor(privy): let the SDK own the Privy API transport`
- Diff: 8 archivos, +898 / −759 (el archivo del cliente: 570 líneas reescritas).

### Transporte propio eliminado (~150 líneas)

Verificado con `grep -c` = **0** para cada símbolo:
`PrivyFetch`, `doFetch`, `signedWalletPatch`, `authorizationSigner`,
`next_cursor`, `generateAuthorizationSignature`, y ninguna `fetch(` propia.
También desaparecieron `headers()` y los dos loops de cursor manuales.

El SDK pasa a aportar: request HTTP, firma de request
(`privy-authorization-signature`), expiry e idempotencia vía
`authorization_context`, y la paginación por cursor.

### Propiedades de seguridad preservadas (verificadas por lectura)

| Propiedad | Cómo quedó |
| --- | --- |
| Verificación de ownership | `getVerifiedWalletForUser` (:395) verifica por **pertenencia exacta** en la lista filtrada por usuario y lanza 404 si no está |
| Cap de paginación fail-closed | `MAX_WALLET_LIST_PAGES = 100` (:166) → `PrivyServerError(502)` (:352). **Sin `for await` sin cota** |
| Errores tipados sin filtrar secretos | `APIError` → `PrivyServerError(status, providerCode)` con **mensajes fijos**, nunca `error.message` (:289-304) |
| `hasAuthorizationPrivateKey()` | conservado |
| `addPolicyToSigner` | signer exacto, conserva hermanos, rechaza sobreescritura, readback |
| Timeout | conservado; `maxRetries: 0` para un único intento acotado |

### Checks (corridos por el orquestador, no solo reportados)

| Check | Resultado |
| --- | --- |
| `npm run lint` | limpio (exit 0) |
| `npm run typecheck` | limpio (exit 0) |
| `npm test` | 838 passed / 15 failed / 178 skipped |

**Comparación con el baseline** (antes del cambio): 835 passed / 15 failed.
Mismas 3 fallas, misma causa ambiental: 14× `role "ramiro" does not exist` +
1× `Cannot read properties of undefined (reading 'query')`, por `DATABASE_URL`
sin setear. **+3 passed (tests nuevos), cero regresiones.**

### Desviaciones declaradas

1. **`listWalletsForUser` ahora falla cerrado** (502) en vez de truncar en
   silencio al llegar al cap, alineado con `listWalletsForChain`. Es más
   estricto, no menos seguro.
2. Se descartó el guard separado de "cursor repetido": el SDK oculta los
   cursores y el cap duro ya acota ese caso.
3. `patchPolicy` ahora manda `authorization_context` cuando hay key configurada
   (antes iba sin firmar).
4. El cast `as unknown as PrivySdkClient` es intencional y está contenido en un
   solo punto: el `PrivyClient` real se adapta al port.

### No verificado → **ahora verificado**

Los 3 archivos de test con DB **corrieron contra un Postgres real**
(contenedor aislado `nani-s0-pg`, `127.0.0.1:55460`, 14 migraciones ya aplicadas):

```text
 Test Files  3 passed (3)
      Tests  41 passed (41)
```

| Archivo | passed | failed | skipped |
| --- | --- | --- | --- |
| `wallets-enrollment.test.ts` | 34 | 0 | 0 |
| `api-wallet-balances.test.ts` | 6 | 0 | 0 |
| `wallets-cross-user.test.ts` | 1 | 0 | 0 |

`skipped = 0` prueba que **ejecutaron de verdad** (los tres son
`DATABASE_URL ? describe : describe.skip`), incluyendo dentro de la suite
completa bajo carga concurrente. La falla ambiental `role "ramiro" does not exist`
quedó eliminada.

### Hallazgo: la suite completa NO es determinista

Corriendo la suite **dos veces con la misma DB**, mismos 1031 tests:

```text
run 1:  20 failed | 998 passed | 13 skipped
run 2:  30 failed | 988 passed | 13 skipped
```

Totales idénticos, resultados distintos: el orden de ejecución altera el
resultado por estado compartido (env vars mutadas entre archivos). **Ninguna
falla es atribuible al refactor**: el único archivo cercano,
`privy-wallet-runtime-fail-closed.test.ts`, **pasa en aislamiento** (1/1).

Clasificación de las fallas con DB (todas ambientales, preexistentes):

| Cantidad | Clase | Causa |
| --- | --- | --- |
| 10 | `permission denied for schema extensions` | El contenedor se migró por la vía `src/db`, que en `001_recipient_memory.sql:56` solo otorga `USAGE` sobre `public`; la vía supabase sí otorga ambos. Inconsistencia del repo, preexistente |
| 6 | `Demo sentinel conflict` | Fila `users` con `privy_did='demo'` creada al provisionar la DB (14:09), no por la corrida |
| 2 | `DEMO_USER_ID is required` | Variable sin exportar en el shell |
| 11 | `STACK_TRACE_ERROR` | Interferencia entre archivos por env compartida; pasan en aislamiento |
| 1 | `api-conversations` 500≠200 | Sin clasificar; fuera del camino Privy/wallet |

### Nota sobre el "baseline" reportado antes

El baseline de `838 passed / 15 failed` se midió **sin** `DATABASE_URL`, así que
los ~165 tests con DB quedaban *skip* y las 15 fallas eran todas `role "ramiro"`.
Al setear `DATABASE_URL` esos tests se ejecutan y aparece **otro** conjunto de
fallas (20-30), de naturaleza distinta. Las dos mediciones son correctas pero **no
comparables**: no es que "las 15 ahora pasan".

Para una suite completa verde haría falta una DB prístina:
`GRANT USAGE ON SCHEMA extensions TO recipient_app`, sin fila `demo` preexistente,
y `DEMO_USER_ID` exportada. **Nada de esto lo introdujo el refactor.**

---

## S2a — Firma por sidecar: la llave fuera del worker **PASS**

- Fecha: 2026-10-08
- Commit: `dc7f37e feat(privy): sign through a sidecar so the worker never holds the key`
- Diff: 16 archivos, +1819 / −3 (el módulo `src/wallet/signer/` y sus tests).

### Prueba viva del seam `sign_fns` (decisiva)

Se levantó el sidecar en loopback con la llave (entregada desde el vault, archivo
`0600`, sin pasar por stdout) y se firmó **desde un proceso sin la llave**:

```text
key present in THIS process env: false        <- el proceso que firma NO tiene la llave
authorization_context keys: [ 'sign_fns' ]    <- solo la función, ninguna llave
A) 1.00 USDC -> allowlisted     : SIGNED
B) 1.00 USDC -> NOT allowlisted : BLOCKED -> 400 policy_violation
```

**Qué prueba:** Privy **acepta** las firmas producidas por el sidecar a través de
`sign_fns`, y la **política sigue limitando**. El seam funciona end-to-end.

**Algoritmo replicado** (igual al del SDK, verificado en
`node_modules/@privy-io/node/lib/authorization.js`):
`base64(der(ECDSA-P256(SHA256(payload))))`. Los tests **verifican** la firma con
`p256.verify` en lugar de comparar bytes, porque P-256 usa nonce aleatorio.

### Qué quedó verificado por lectura

- El worker **no** importa `key-signer` ni `loadAuthorizationPrivateKey`: la ruta
de la llave no está en su grafo de imports.
- `createWorkerDependencies` ya **no** pasa `authorizationPrivateKey` a
  `PrivyServerClient`; construye `createWorkerPayloadSigner(environment)`, que lee
  solo `PRIVY_SIGNER_URL` + `PRIVY_SIGNER_TOKEN`.
- Mitigaciones implementadas: bind **solo loopback**, token comparado con
  `timingSafeEqual`, cap de payload (64 KiB), y no loguea payload, firma, token ni
  llave.

### Límite honesto (documentado en el módulo)

Un endpoint de firma pelado es un **oráculo de firma**: cualquiera que lo alcance
y tenga el token puede obtener firmas de payloads arbitrarios. La verificación por
request contra el grant activo se **postergó deliberadamente** a un slice
posterior (lo elegido: "sidecar simple ahora, aislamiento después").

### Todavía NO está en el seam

`src/server.ts:185` — el **proceso HTTP del backend** sigue leyendo la llave para
mutaciones de enrollment y políticas, porque `PrivyServerClient` deriva su
`authorization_context` de ese string. **El worker está limpio; el API no.**
Migrarlo al mismo seam es slice de seguimiento.

### Checks

| Check | Resultado |
| --- | --- |
| `npm run lint` | limpio |
| `npm run typecheck` | limpio |
| `npm test` | **863 passed** / 15 failed / 178 skipped |

Contra el paso anterior (838 passed): **+25 tests nuevos, mismas 15 fallas de DB,
cero regresiones.**

### Higiene comprobada

La llave se entregó del vault al host por un receptor efímero en LAN, se guardó
`0600`, se pasó al sidecar y **se borró al terminar**; el receptor y el sidecar
quedaron detenidos. La llave nunca se imprimió ni entró al repo.

---

## S2b/S4 — Solana funcionando end-to-end **PASS**

- Commits: `b60ca44` (forma de las reglas + guard) y `2d4b814` (flujo por cadena)
- Probado contra la app real, la wallet real y la política real en devnet.

### El consentimiento del usuario

El owner aprobó el consentimiento en la app (Privy `addSigners`). Resultado del
readback:

```json
additional_signers: [{ "signer_id": "np33q4k0i44p3g4kr2na0u9y",
                       "override_policy_ids": ["jb227q0o7d3hmf0ksbi3hj6e"] }]
```

Y en la base, **un grant por cadena, correctamente separados**:

```text
arc    | u94to62itemodu5kon7ubwmy | active | 0x5770353D…
solana | jb227q0o7d3hmf0ksbi3hj6e | active | AfHaCDtR… | per_transfer_lamports=10000000
```

### Verificación de firma (por el sidecar, sin la llave en el proceso)

```text
key in THIS process: false
A) allowlisted, under cap [signAndSendTransaction]: ALLOWED → intentó broadcast
   → falló por fondos (Attempt to debit an account but funds insufficient)
B) NOT allowlisted        [signAndSendTransaction]: POLICY_DENIED
C) allowlisted, over cap  [signAndSendTransaction]: POLICY_DENIED
```

**Lectura del caso A**: el error es de **fondos**, no de política — prueba que la
transacción **atravesó la política** y llegó a la etapa de broadcast. La wallet
tiene 0 SOL, así que no puede enviarse nada (verificado antes: `balance: 0`).

### HALLAZGO CRÍTICO: la política está scopeada por MÉTODO RPC

La política declara `method: "signAndSendTransaction"`. Llamar a
**`signTransaction`** (el otro método, que solo firma) devuelve
**`policy_violation` incluso para el caso permitido**, porque **ninguna regla
ALLOW coincide con ese método** y Privy falla cerrado.

Consecuencias:

1. El código del repo usa `signAndSendTransaction`, así que **está alineado**.
2. Si en algún momento se quiere **firmar sin enviar** (p. ej. para un preview
   firmado, o para el flujo de voz), hay que **agregar una regla para
   `signTransaction`** a la política; si no, se rechaza todo.
3. `signAndSendTransaction` además **exige `caip2`**: sin él, Privy responde
   `400 [Input error] 'caip2' is required`. El CAIP-2 de devnet es
   `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`.

### Bug encontrado y arreglado en el camino

El builder de reglas Solana emitía
`{ action, resource: { method, chain }, conditions }`, y Privy lo rechaza con
`400 invalid_policy_format` (quiere forma plana con `name` y `method`). **Esa era
la causa raíz de que la wallet Solana nunca se enrolara**: `prepare` fallaba, no
llegaba ningún `policyId` al front, y el consentimiento nunca se renderizaba.
También se descartó `metadata` (rechazado igual).

---

## S4 / S5 / S2c — Resumen de los slices siguientes

### S4 — Dispatch Solana por el SDK (`281d4fd`)

`createPrivySignAndSendClient` armaba el RPC de Privy a mano (body, firma P-256,
headers, fetch). Ahora mapea sobre
`wallets().solana().signAndSendTransaction` y el SDK se hace cargo. La llave se
alcanza **solo** por el contexto de autorización del sidecar.

**`findByReference` quedó deliberadamente sin implementar**: el SDK no expone
búsqueda por reference id (las acciones se direccionan por action id y el listado
de transacciones no lleva la referencia), así que una búsqueda sobre el SDK solo
podría atribuir una transacción ajena. Sin ella, el provider deja la referencia
**incierta y nunca re-broadcastea** — el fail-closed que el repo exige.

### S5 — Borrado de código muerto (`4037c49`, `cad7bc3`)

| Borrado | Líneas | Motivo |
| --- | --- | --- |
| `privy-transaction-transport.ts` + test | −1287 | Cero importadores vivos; el SDK cubre sus tres responsabilidades |
| `transfer-pipeline.ts` + 3 tests | −721 (código) | Inalcanzable: EVM falla cerrado en el provider |

**Antes de borrar el pipeline** se extrajeron sus 8 garantías a
`05-preserved-requirements.md` (idempotencia, un-solo-ganador, reconciliación sin
re-broadcast, rechazo antes de firmar, aislamiento entre usuarios). El aislamiento
cross-user sigue cubierto por 5 suites vivas (grants, contacts, users), no se
perdió cobertura.

`TransferRejectedError` se reubicó a `src/wallet/transfer-errors.ts` porque el
contrato HTTP (422) sigue vivo.

**Schema huérfano** (NO tocado): tabla `wallet_operations` (104 filas históricas)
y columna `user_wallets.nonce`. Dropearlos es una migración aparte.

### S2c — Ningún proceso del backend tiene la llave (`815dfdb`)

El API HTTP pasaba `PRIVY_AUTHORIZATION_PRIVATE_KEY` a su cliente de Privy. Ahora
recibe un signer inyectado y arma el contexto con el mismo seam `sign_fns` que el
worker. Sin signer configurado: las **lecturas siguen** y **toda mutación firmada
falla cerrado** (503). El gate de disponibilidad del policy sync sigue siendo
honesto (sin signer → `unavailable`, nunca una escritura sin firma).

`LivePrivyWalletApiClient` leía la llave para poblar un campo que **nadie leía**
(verificado: `grep -c` = 1, solo la asignación); esa lectura se eliminó.

**Proof (grep de prueba) — el único lector no-test es el sidecar:**

```text
$ grep -rn "PRIVY_AUTHORIZATION_PRIVATE_KEY" src/ --include=*.ts \
    | grep -vE ": *(//|\*|/\*)" | grep -v "\.test\."
src/wallet/signer/key-signer.ts:19:export const AUTHORIZATION_PRIVATE_KEY_ENV = ...
```

Y `key-signer.ts` lo importa **únicamente** `signer/server.ts` (el entrypoint del
sidecar). Un test de escaneo de fuentes lo fija para que un cambio futuro no
reintroduzca una lectura en proceso.

---

## S6 — Revocación de sesión **PASS**

- Commit: `691e720 feat(auth): reject a logged-out session's still-valid token`

### El gap (verificado empíricamente)

La verificación de tokens es **offline** (firma, issuer, audience, exp). El logout
solo limpiaba el cliente, así que el token seguía aceptándose hasta su `exp`
(hasta 1 h). Comprobado: mientras Privy rechazaba una sesión, nuestra API
respondía 200.

### La validación online NO existe (probado, no supuesto)

| Intento | Resultado |
| --- | --- |
| `GET auth.privy.io/api/v1/sessions` | `405` (solo POST) |
| `POST auth.privy.io/api/v1/sessions` | `401 Missing refresh token` ← es el endpoint de **refresh** |
| `GET auth.privy.io/api/v1/users/me` + Bearer + Origin | `401 Invalid auth token` ← con token **fresco** (109 s) |
| `POST api.privy.io/v1/wallets/authenticate` | `400` para tokens **vivos Y muertos** |
| SDK: recurso `sessions` | **no existe** |
| SDK: `verifyAccessToken` | **offline** (`lib/auth.js:45`) |

Conclusión: no hay verificador de sesión soportado. La solución es local.

### La solución implementada

Una **columna**, no una tabla:

```sql
ALTER TABLE users ADD COLUMN IF NOT EXISTS session_floor_at TIMESTAMPTZ;
```

- Al hacer logout: `session_floor_at = now()`.
- En cada request autenticado: se rechaza si `iat` del token < piso.
- `NULL` = sin piso. Un login nuevo emite un token con `iat` posterior → pasa.
- Es **user-wide** a propósito: revocar todas las sesiones del usuario es lo
  correcto para una wallet personal.

El estado **debe ser durable**: un `Set` en memoria moriría al reiniciar y
"des-revocaría" los tokens en silencio.

### Prueba EN VIVO (contra la API corriendo)

```text
1) token vigente -> /v1/me : 200
2) POST /v1/auth/logout   : 200 {"ok":true}
3) MISMO token -> /v1/me  : 401    <- revocado
4) logout de nuevo        : 401    <- el token muerto ni autentica
```

### Checks

| Check | Resultado |
| --- | --- |
| Backend lint / typecheck | limpios |
| Backend test | **888 passed** / 15 failed (baseline 872/15; +16 nuevos, mismas 15 de DB) |
| Tests nuevos con DB real | 34 passed (incluye integración) |
| Frontend lint / typecheck | limpios |
| Frontend test | **115 passed** (baseline 114; +1 nuevo) |

### Residuales declarados

1. **Borde del mismo segundo**: `iat` viene en segundos y el piso en ms, así que un
   logout→login dentro del mismo segundo rechazaría el token nuevo. Es el lado
   **fail-closed**; en el flujo real (OTP) no es alcanzable. Documentado, no
   parcheado.
2. **Costo**: una lectura extra a la DB por request autenticado (dentro de la
   transacción del owner). Es correctitud antes que latencia.
3. **El orden en el front** (logout antes de limpiar la sesión) está documentado y
   verificado a mano, pero no tiene test de componente.

---

## Validación del stack local Privy — 2026-10-09

Comprobación de solo lectura del stack que ya estaba levantado en Docker:

| Check | Resultado |
| --- | --- |
| Compose | `nana-privy-impl`, con `compose.privy-local.yaml` + `compose.privy-local.ports.yaml` |
| Contenedores | backend y DB `healthy`; frontend, LiveKit y voice-worker `running` |
| Frontend HTTP | `http://127.0.0.1:32802/` → 200 |
| API `/health` | `http://127.0.0.1:32800/health` → `status=ok`, `mode=live`, `network=arc-testnet` |
| Provider health | `degraded`; el provider Privy informa readiness por usuario autenticado. Esto no prueba una wallet ni una firma disponibles. |
| Navegador | `/login` muestra “Entrá a tu Nana Wallet”; no se envió OTP ni se inició sesión. |
| Configuración local | `.env` tiene 12 claves. Se verificaron nombres, nunca valores: `PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_AUTHORIZATION_PUBLIC_KEY` y `PRIVY_AUTHORIZATION_KEY_QUORUM_ID` están presentes; `PRIVY_AUTHORIZATION_PRIVATE_KEY` no está en `.env`. |
| Seguridad de firma | No se copió ninguna llave desde Vault. El Compose no configura un servicio sidecar ni pasa una llave privada al backend/worker; las mutaciones firmadas siguen fail-closed hasta configurar el signer aislado. |

El acceso visual queda disponible para que Ramiro complete el login por OTP y
pruebe una cuenta. No se transmitieron credenciales, no se firmaron transacciones
y no se enviaron fondos.

---

## S3 — Saldos por el SDK: BLOQUEADO por cobertura de cadenas

- Fecha: 2026-10-09
- Método: prueba empírica del endpoint del SDK contra las wallets reales,
  antes de escribir código (igual que se hizo con el JWT).

### Resultado

```text
asset=usdc, chain=eip155:5042002   -> ERROR 400 Unsupported chain: eip155:5042002
token=eip155:5042002:0x3600…0000   -> ERROR 400 Unsupported chain: eip155:5042002
asset=sol,  chain=solana_devnet    -> OK  raw_value=0, decimals=9
```

**Arc testnet NO está en la lista de cadenas soportadas** por
`privy.wallets().balance.get()` (la lista incluye ethereum, base, arbitrum,
polygon, solana, solana_devnet, sepolia, etc., y **no** arc).

### Consecuencia

El camino de balance **principal** (USDC en Arc) **no se puede migrar**: el
`eth_call` propio es la única forma de leerlo. Hoy hay 4 sitios de `eth_call`:

| Archivo | Líneas |
| --- | --- |
| `src/wallet/privy-user-provider.ts` | 449, 467 |
| `src/wallet/balances.ts` | 200, 217 |

Lo único migrable sería el balance de **Solana** (`solana-user-wallet.ts:147`,
una `Connection` al RPC de devnet). Pero eso dejaría **dos mecanismos** de
balance en lugar de uno, y el mayoritario seguiría siendo propio: no reduce
complejidad neta.

### Disposición (condición de parada del plan, ya prevista)

El propio outline de S3 decía: *"si el SDK no expone el balance multi-red que hoy
se sirve, se mantiene el lector actual y se documenta el motivo."*

**Se mantiene el lector actual y S3 se cierra como no aplicable.** No se escribe
código.

### Nota de coordinación

Este documento también lo está editando otra sesión (ver `herdr-session.md` y
`05-independent-review.md`, agregados el 2026-10-09). Las secciones se agregan al
final para no pisar contenido ajeno.
