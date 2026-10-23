# 03 — Design discussion: cómo firma el agente

## Current state

El worker de LiveKit firma hoy de dos maneras posibles, y **ninguna está activa**:

1. **Signer de app** (configurado): quorum `np33q4k0i44p3g4kr2na0u9y` con
   `PRIVY_AUTHORIZATION_PRIVATE_KEY` adjunto como additional signer de la wallet
   EVM, con una política que permite `eth_signTransaction` hasta 10 USDC a **un**
   destinatario. El código está escrito (`privy-transaction-transport.ts`) pero
   **fail-closed** en `PrivyUserWalletProvider.signingUnavailable()`.
2. **JWT del usuario**: no declarado en el código; **probado y bloqueado** por Privy.

En ambos casos el worker lee la clave privada de firma desde el entorno.

## Desired state

El agente firma operaciones sobre la wallet del usuario (EVM y Solana), con límites
aplicados por Privy, y **sin que el worker tenga acceso a ninguna clave privada**.

## D1 — Modelo de firma (DECISIÓN PRINCIPAL)

La doc oficial de *Server-side access to user wallets* establece que el mecanismo
soportado para que el servidor firme sin el usuario en el loop es **un signer
restringido por política**. Cuatro opciones:

| Opción | Dónde vive la llave | Estado | Cuándo conviene |
| --- | --- | --- | --- |
| **D1a** App key en el worker | En el env del worker | Configurado; código fail-closed | Prototipo rápido. La llave está en un proceso que corre código de agente |
| **D1b** App key detrás de `sign_fns` (KMS/sidecar) | En un KMS o servicio aparte | Soportado por el SDK, **no implementado** | **Recomendada**: cumple "el worker no ve la llave" con un primitivo soportado |
| **D1c** JWT del usuario | No hay llave; Privy emite una temporal | **BLOQUEADO** (probado) | Sería lo ideal, pero Privy rechaza su propio token. Requiere soporte de Privy |
| **D1d** Firma en el cliente (`useSendTransaction`) | Key share en el dispositivo | Funciona hoy, no implementado | Si el usuario siempre está presente. No cumple "firma el worker" |

**Recomendación: D1b.** Cumple el objetivo de seguridad (ninguna llave en el
worker), usa un primitivo documentado por Privy (`AuthorizationContext.sign_fns`),
y no depende de destrabar D1c.

**Riesgo honesto**: D1b no está verificado contra un KMS real. Si el seam de
`sign_fns` no funciona como dice la doc, se cae a D1a (mismo diseño, la llave en el
worker) sin rehacer nada más — el resto del plan es idéntico.

## D2 — Alcance de la delegación al SDK

| Pieza | Veredicto |
| --- | --- |
| Firma/envío de transacciones | **Delegar** a `client.wallets` |
| Lectura de saldo | **Delegar** a `client.wallets.balance` |
| Administración de políticas y quorums | **Delegar** a `client.policies` / `keyQuorums` |
| Composición de la política (límites, allowlist) | **Manual** (wrapper): es decisión de producto |
| Preview + confirmación explícita | **Manual**: control de producto |
| Idempotencia y reconciliación por hash | **Manual**: nadie más lo garantiza |
| Verificación del payload firmado vs intent | **Manual**: guarda contra firmar algo distinto |

## D3 — Precondiciones de dashboard (solo humano, sin API)

Verificado que **no existe API de escritura** para esto (`PATCH /v1/apps/{id}` → 405;
`GET /v1/apps/{id}/settings` → 404; el SDK solo expone lectura).

| # | Qué | Dónde | Por qué |
| --- | --- | --- | --- |
| P1 | Tope acumulado 50 USDC / 3600 s | Policies | El diseño lo exige; hoy **no existe** |
| P2 | Ampliar allowlist de destinatarios | Policy rule | Hoy **un solo** destinatario |
| P3 | Signer + política para Solana | Wallet Solana + Policies | Hoy **vacío** (`additional_signers: []`) |
| P4 | Registrar `com.nanawallet.app` | App settings → Domains → Native | `allowed_native_app_ids: []` |
| P5 | Alinear `sms_auth` / `create_on_login` | App settings / Embedded wallets | `sms_auth: false` pero el login ofrece SMS; `create_on_login: off` pero el front pide `all-users` |

P1 y P2 son **bloqueantes**: sin tope acumulado efectivo no se habilita la firma.

## D4 — Chequeo de revocación (hallazgo independiente)

Nuestro backend verifica tokens offline (`privy-identity.ts:75`) y **nunca consulta
revocación**. Verificado: aceptaba tokens que Privy rechazaba.

| Opción | Tradeoff |
| --- | --- |
| No hacer nada | La ventana de un token revocado es ≤1 h (su `exp`) |
| Chequeo activo contra Privy | Correcto pero agrega una llamada por request |
| Chequeo solo en operaciones sensibles | Compromiso: firma, grants, decisiones |

**Recomendación**: chequeo en operaciones sensibles, no en cada request.

## Open questions

1. **D1**: ¿D1b (KMS) con la llave fuera del worker, o D1a para avanzar rápido?
2. **KMS concreto**: ¿qué destino? (AWS KMS, servicio propio, sidecar local)
3. **D4**: ¿se incluye el chequeo de revocación en este alcance o va aparte?

## Requisito de producto registrado: la autorización de pago por VOZ

**Pedido explícito del usuario (2026-10-08).** Hoy la autorización del permiso de
pagos (el consentimiento del signer) **solo se puede dar desde la pantalla**:
`useSigners().addSigners(...)` en `PrivySignerEnrollment`, alcanzable desde
Perfil. No hay camino por voz.

El objetivo es que **el usuario pueda autorizar ese permiso hablando con Nani**
(por LiveKit), no solo tocando la UI.

### Por qué no es trivial (contexto técnico verificado)

1. **`addSigners` es una operación del SDK del cliente** (`@privy-io/react-auth`),
   que corre en el navegador/WebView con la sesión del usuario. El worker de
   LiveKit es **otro proceso**, sin acceso a esa sesión.
2. **La autorización de la wallet la da el OWNER**, y el owner es el key quorum
   del usuario (`nlgiiwtdpe59j4xd24cffe58`), no la app. Verificado: el PATCH de
   `additional_signers` con la app key da **401**, igual desde backend que desde
   el sidecar.
3. **El intercambio de JWT del usuario está bloqueado** (ver S0/verificación):
   `POST /v1/wallets/authenticate` rechaza el access token con
   `400 Invalid JWT token provided`, en web y en nativo, con token fresco y
   `kid` vigente. **Ese era el camino para que el servidor actuara en nombre del
   usuario**, y hoy no está disponible.
4. **Alternativa viable sin bloquearse**: `privy.intents` (`rpc`, `list`, `get`,
   `reject`) modela *aprobaciones con el usuario en el loop*. El worker podría
   **crear una intención** y el usuario **aprobarla** desde su dispositivo. Eso
   encaja con "autorizar por voz" sin que el worker necesite la clave del owner.
5. **Restricción adicional**: el permiso se ata a la **allowlist de contactos**;
   por voz habría que definir de dónde sale esa lista (¿los contactos guardados?
   ¿los que el usuario nombre en la conversación?).

### Estado

Registrado como requisito, **no implementado**. Depende de resolver (3) o de
adoptar (4). Es un slice propio, con su diseño y su evidencia.

```markdown
Gate ID: privy-sdk-migration/design
Decision / allowed mutation: aprobar el modelo de firma y el alcance
Explicit exclusions: mutación de código antes de aprobar el outline
Owning artifact / revision or hash: 03-design-discussion.md @ pendiente
Decision owner: Ramiro
Approved by / trusted identity: —
Approved at: —
Status: proposed
Invalidated by: cambio de modelo de firma o de alcance
```
