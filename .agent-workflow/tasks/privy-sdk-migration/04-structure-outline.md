# 04 — Structure outline: migración al SDK de Privy

Cada slice es vertical: resultado observable, archivos, checks automatizados,
verificación de ruta real y condición de parada que puede fallar de verdad.

---

## S0 — Gate: ¿la política limita al signer? (bloquea todo lo demás)

**Outcome observable:** con la app key presente, la política permite una
transferencia de 1 USDC a un destinatario del allowlist y **rechaza** (a) un
destinatario fuera del allowlist y (b) un monto por encima del tope.

**Precondición:** `PRIVY_AUTHORIZATION_PRIVATE_KEY` en el env local (está en el
vault; el contenedor no la tiene).

#### Files
- Script de verificación en `.agent-workflow/tasks/privy-sdk-migration/evidence/`
  (evidencia, no producto).
- Resultado en `90-verification.md`.

**Automated checks:** ninguna suite; la evidencia es la respuesta de la API.

**Real-route check:** `signTransaction` (firma, **nunca** broadcast) en 3 casos:
1 USDC → allowlist · 1 USDC → no allowlist · 20 USDC → allowlist.

**Manual checks:** ninguna humana (es programática).

**Stop condition:** si **20 USDC pasa**, la política no limita y **no se habilita
la firma** hasta arreglar P1/P2 en el dashboard. Si el caso (a) pasa, el allowlist
no está rigiendo.

---

## S1 — Cliente de administración sobre el SDK

**Outcome observable:** la sincronización de wallet y la lectura/creación de
políticas pasan por `privy.wallets()` / `privy.policies()`, sin HTTP propio ni
headers armados a mano.

#### Files
- `src/wallet/privy-server-client.ts` — reemplazar los 6 endpoints REST por el SDK;
  conservar solo lo que el SDK no cubre.
- `src/wallet/grants/privy-policy-runtime.ts`, `grants/privy-policy-admin.ts`.
- Tests: `tests/unit/privy-*` existentes.

**Automated checks:** raíz `npm run lint`, `npm run typecheck`, `npm test`.

**Real-route check:** sync de wallet y lectura de la política real contra la app de
Privy; comparar el readback con lo que devuelve la API cruda hoy.

**Stop condition:** si el SDK no expone algún campo que hoy se verifica en el
readback, no se avanza sin reemplazar esa verificación.

---

## S2 — Firma sobre el SDK con la llave fuera del worker (D1b)

**Outcome observable:** el worker firma y envía usando `client.wallets` con un
`AuthorizationContext` cuyo firmado se delega a un KMS/sidecar. **Ningún proceso del
worker lee `PRIVY_AUTHORIZATION_PRIVATE_KEY`.**

#### Files
- `src/wallet/privy-user-provider.ts` — reemplazar `signingUnavailable()` por el
  camino del SDK; quitar el threading de `authorizationPrivateKey`.
- `src/wallet/signer/` (nuevo) — la función de firmado delegada (`sign_fns`).
- `src/runtime/dependencies.ts`, `src/server.ts` — sacar la lectura de la key.
- Tests: `tests/unit/privy-transaction-transport.test.ts` (migrar o retirar).

**Automated checks:** raíz `lint`/`typecheck`/`test`/`eval` (toca el agente).

**Real-route check:** transferencia real en Arc testnet dentro de los límites, con
preview + confirmación, verificando el hash en el explorer.

**Stop condition:** si `sign_fns` no funciona como documenta Privy, se cae a D1a
(llave en el worker) y se registra la desviación; el resto no cambia. Si el envío
no respeta la idempotencia actual, no se avanza.

---

## S3 — Saldos sobre el SDK

**Outcome observable:** `/v1/wallets/current/balances` y el `get_balance` del
agente leen por `client.wallets.balance`, no por `eth_call` propio.

#### Files
- `src/wallet/privy-user-provider.ts` (getBalance), `src/wallet/balances.ts`.

**Automated checks:** raíz `lint`/`typecheck`/`test`.

**Real-route check:** saldo real del usuario, comparado contra Arc RPC directo.

**Stop condition:** si el SDK no expone el balance multi-red que hoy se sirve, se
mantiene el lector actual y se documenta el motivo.

---

## S4 — Paridad Solana

**Outcome observable:** la wallet Solana del usuario tiene signer y política; el
agente puede operar en Solana devnet bajo los mismos límites.

**Precondición:** P3 del dashboard.

#### Files
- `src/wallet/solana-user-wallet.ts`, `src/wallet/solana-devnet-provider.ts`,
  `src/wallet/grants/solana-enrollment-rules.ts`, `solana-policy-provisioner.ts`.

**Automated checks:** raíz `lint`/`typecheck`/`test` + el smoke devnet existente.

**Real-route check:** `signAndSendTransaction` en devnet, firma verificable en el
explorer.

**Stop condition:** si Solana no soporta el mismo modelo de signer+política, se
limita el alcance a EVM y se registra explícitamente (no se inventa paridad).

---

## S5 — Borrado del código muerto

**Outcome observable:** el transporte y el pipeline propios ya no existen.

#### Files
- Eliminar `src/wallet/privy-transaction-transport.ts` (salvo lo vivo:
  `privyNodeAuthorizationSigner`, que se mueve si aún se usa) y
  `src/wallet/transfer-pipeline.ts`; retirar sus tests.

**Automated checks:** raíz `lint`/`typecheck`/`test`/`eval`.

**Stop condition:** si algo sigue usándolos, no se borra; primero se migra.

---

## S6 — Chequeo de revocación (si se aprueba en D4)

**Outcome observable:** las operaciones sensibles rechazan tokens que Privy ya
considera inválidos.

#### Files
- `src/auth/privy-identity.ts`, y los call sites sensibles.

**Automated checks:** raíz `lint`/`typecheck`/`test`.

**Real-route check:** token válido que pasa; token revocado que se rechaza.

**Stop condition:** si agregar el chequeo degrada la latencia de forma inaceptable,
se acota a operaciones financieras y se documenta.

---

## Prerrequisitos humanos (no son slices)

| # | Acción | Bloquea a |
| --- | --- | --- |
| P1 | Tope acumulado 50 USDC/3600 s | S0, S2 |
| P2 | Ampliar allowlist | S0, S2 |
| P3 | Signer + política Solana | S4 |
| P4 | Registrar app id nativo | Verificación en device |
| P5 | Alinear `sms_auth` / `create_on_login` | Onboarding de usuarios nuevos |

## Orden

S0 → (P1, P2) → S1 → S2 → S3 → S5 → S4 → S6

S0 es gate: sin su resultado no se habilita ninguna firma.

## Fuera de alcance

- D1c (JWT del usuario): bloqueado por Privy; requiere soporte.
- D1d (firma en el cliente): no cumple "firma el worker"; se evalúa aparte.
- Mainnet y `WDK_TOOLS_SOURCE=live`.

```markdown
Gate ID: privy-sdk-migration/outline
Decision / allowed mutation: aprobar este outline y habilitar la implementación
Explicit exclusions: S2 sin S0 verde; S2 sin P1/P2
Owning artifact / revision or hash: 04-structure-outline.md @ pendiente de revisión
Decision owner: Ramiro
Approved by / trusted identity: —
Approved at: —
Status: proposed (revisión independiente pendiente)
Invalidated by: cambio de modelo de firma o de alcance
```
