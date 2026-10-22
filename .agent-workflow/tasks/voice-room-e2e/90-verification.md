# 90 — Verification

Estado al cerrar esta sesión de trabajo. Se escribe lo verificado y lo que
**no** funciona, sin maquillar.

## RQ6b — wallet del fixture de voz: RESUELTO

No era un problema de seed, como suponía el outline. `createSolanaWalletForUser`
además de la fila `user_wallets` llama a Privy y exige exactamente un wallet que
coincida en `provider_wallet_id` **y** dirección, así que sembrar la fila sola
falla más adelante.

La causa real: **el worker no tenía camino a un wallet fixture**.
`createWorkerDependencies` llegaba a `createCoreDependencies` sin inyección y caía
en el provider fail-closed; la única alternativa configurada era el resolver
Privy por usuario.

Se agregó el mismo seam de inyección que ya usa el helper HTTP de tests, con dos
detalles que solo aparecieron al correrlo:

1. Inyectar los providers **no alcanza**: el camino de voz prefiere
   `walletForUser` cuando está definido, así que el seam también tiene que
   suprimir el resolver. Un primer intento que solo cambiaba `core.wallet` dejó
   la corrida en el camino Privy y `get_balance` siguió fallando.
2. El par no es intercambiable: `FixtureWalletProvider` sirve la escritura y
   `createLegacyToolSourceWalletReads()` la lectura, igual que
   `tests/fixtures/test-server.ts`.

El flag está **apagado por defecto** y lanza error si se combina con
`WDK_TOOLS_SOURCE=live`.

Evidencia: `get_balance` ejecuta con **cero errores** sobre la sala real, y Nani
lee el saldo del fixture (42,50 SOL).

Cubierto por 2 tests de unidad (`tests/unit/worker-fixture-wallet-seam.test.ts`):
el seam suprime el resolver, y sin seam la producción queda intacta.

## Slice 1 — RQ7: RESUELTO

`RoomConversation.bind` exige cuatro guardas: token válido, identidad igual a
`binding.sub`, conversación existente en la DB, y lease libre.

## Slice 2 — audio del saludo: RESUELTO

`npm run test:e2e:voice-room-spike` → PASS. Bind `{ok:true}`, ~2000 frames,
~20 s capturados, 17,8 s de habla detectada, 43 ms al primer frame y ~2,3 s a la
primera palabra. Más una corrida negativa que falla cerrada con
`{"ok":false,"code":"invalid_binding"}`.

## Slice 3 — turno completo: RESUELTO

`npm run test:e2e:voice-room-roundtrip` → **PASS 3/3**, con el worker recreado y
sin instrumentación. Respuestas habladas reales de 2,9 a 5,9 s, latencia a la
primera palabra ~2,3 s, y el transcript de la sala muestra el turno del usuario
reconocido (`"Che nani, ¿me..."`), que es prueba directa de que el agente escucha.

### La causa raíz del defecto de captura

El síntoma era que la respuesta se capturaba como 32 s de silencio. La conclusión
previa —"el agente no responde"— era **incorrecta en la dirección opuesta**: el
agente no tenía nada que responder porque el harness publicaba silencio.

`AudioFrame.protoInfo()` entrega al FFI `new Uint8Array(frame.data.buffer)`: el
ArrayBuffer **completo**, ignorando `byteOffset` y `byteLength`. El loop de
publicación construía cada frame con `samples.subarray(...)`, cuyo `.buffer` es el
WAV entero, así que **cada frame transmitía los primeros 20 ms de la fixture** en
lugar de su porción. Todos los receptores medían ~268 RMS constante mientras el
loop enviaba 6263 — los primeros 20 ms de esa fixture están justo en ese nivel.

Se confirmó aislando el path de media con un participante monitor independiente,
sin agente: **267 RMS antes del fix, 9742 después**.

El fix copia cada slice a un buffer propio. Ver `tests/e2e/voice-room/caller.ts`.

### Diagnóstico que vale conservar

Cuando "el agente no responde", separar publish-side de subscribe-side con un
monitor independiente es lo que resuelve la ambigüedad en un solo paso. Y medir
el RMS dentro del loop que envía, contra el RMS que recibe el otro lado, distingue
"envío mal" de "no llega". Las dos mediciones juntas fueron concluyentes.

## Slice 5 — vitest y runbook: RESUELTO

- `npm run test:e2e:voice-room` → **PASS**, ~31-40 s. Config propia en
  `tests/e2e/voice-room/vitest.voice-room.config.ts`.
- Excluido del suite default por glob en `vitest.config.ts`, con el motivo escrito
  al lado. `npm test` queda **idéntico al baseline**: 16 fallos preexistentes,
  860 pasan, 174 skipped.
- Credenciales inyectadas explícitamente con `injectWorktreeCredentials()`; la
  suite no hereda nada del ambiente.
- **Falla ruidosa, nunca skip.** Verificado en los dos caminos:
  - sin credenciales → `missing credentials: LIVEKIT_API_KEY, LIVEKIT_API_SECRET,
    LIVE_VOICE_BINDING_PRIVATE_KEY, LIVE_VOICE_BINDING_PUBLIC_KEY, OPENAI_API_KEY`
  - stack caído → `the isolated LiveKit stack is not reachable at <url>`, con el
    comando exacto para levantarlo y el runbook.
- Runbook en `docs/voice-room-e2e-runbook.md`, incluidos los puertos del stack,
  por qué el rango de media no es libre, y las cuatro trampas de API.

## Slice 4 — asertos sobre estado del backend: RESUELTO

`npm run test:e2e:voice-room` → **3/3 PASS**: el round trip de saldo, la
transferencia confirmada y la cancelada. Evidencia cruda en la DB:

```
 e2e00000-...-0003 | status=confirmed | has_tx=t
 e2e00000-...-0004 | status=cancelled | has_tx=f
```

El aserto negativo —una cancelación no deja transferencia activa— es el que más
valor tiene, y es el que atrapa bugs de plata reales.

### Tres defectos reales que el slice destapó

Los tres tenían el mismo síntoma (*"la conversación se ve sana, la transferencia
no se concreta"*) y **ninguno era del agente**. Vale la pena escribirlos porque el
síntoma es idéntico en los tres y cada uno se arregla en un lugar distinto:

**1. Faltaba el esquema `extensions`.** Toda conexión de la app fija
`search_path=public,extensions`, y CI lo crea explícitamente
(`.github/workflows/ci.yml:39`). Una DB construida solo con `runMigrations()` nunca
lo tiene, y el error aparece recién al confirmar, *después* de escribir la fila
`previewed`.

**2. Faltaba el grant.** Con el esquema creado pero sin
`GRANT USAGE ON SCHEMA extensions TO recipient_app`, el error pasa a
`permission denied for schema extensions`. La transacción de runtime hace
`SET ROLE`, así que el esquema es inusable sin ese grant.

**3. Las extensiones estaban en el esquema equivocado.**
`src/db/migrations/001_recipient_memory.sql` las instala sin `WITH SCHEMA`, así que
caen en `public`, mientras la cadena de supabase que CI aplica las instala
`WITH SCHEMA extensions`. La SQL de la app **califica** el llamado
([postgres-repository.ts:372](/Users/ramiro/Desktop/projects/colloseum.feat-voice-e2e-harness/src/conversations/postgres-repository.ts:372)
usa `extensions.gen_random_uuid()`), así que con pgcrypto en `public` el confirm
muere con `function extensions.gen_random_uuid() does not exist`.

Conclusión de fondo: **las dos cadenas de migración no son equivalentes**, y el
fixture de voz tenía que reproducir el estado de CI, no el de la cadena local.

### Un cuarto defecto, este sí del harness

El caller se desconectaba a los ~16 s de llamar `confirm_transfer`, abortando la
transferencia en vuelo. Una confirmación hablada **no** es una transferencia
asentada: el broadcast sobrevive al turno. Se agregó un hook `afterTurns` que
espera a que el estado deje de moverse **con la sala abierta**, en vez de dormir un
tiempo fijo — por la misma razón que el detector de turno espera silencio y no un
timer.

### Verificación

`test:e2e:voice-room` 3/3 verde con el stack recreado desde cero (volumen borrado),
que también valida el camino de arranque limpio. Suite default **sin cambios**: 16
fallos preexistentes, 860 pasan, 174 skipped. `typecheck` y `lint` limpios.

## Slice 6 — barge-in: RESUELTO

`npm run test:e2e:voice-room` → **4/4 verde** (round trip, confirmada, cancelada,
barge-in), en 3 corridas consecutivas.

### RQ8: cómo se dispara realmente

Hay dos mecanismos y **el producto usa uno solo**.

**El contrato: RPC `interrupt_agent`.** En Nana el barge-in es una acción
**deliberada** del usuario. El reducer del front
(`live-voice-reducer.ts:157`) emite `interrupt_agent` **solo** ante
`AVATAR_PRESSED` con la fase en `speaking`. El recorrido es
`interruptAgentSpeech()` → `performRpc({method:"interrupt_agent"})` →
`registerRpcMethod` en el worker → `session.interrupt({force:true})`.

**Lo acústico: del SDK, no del producto.** El modelo realtime tiene VAD del
servidor y el saludo se genera con `allowInterruptions:true`, así que hablar
encima *puede* interrumpir. Pero eso es emergente del proveedor y depende de
umbrales que no controlamos.

Por eso el escenario **afirma** sobre el RPC (contrato determinístico del que
depende la UI) y **mide** lo acústico como evidencia. Un caller simulado no puede
tocar un avatar, pero invocar el mismo RPC expresa la misma intención por el mismo
canal que la app: es fiel, no una aproximación.

### Evidencia

```
speech antes    : 940 / 880 / 840 ms   (interrumpe a mitad de frase)
interrupt ok    : true en las 3
yield latency   : 367 / 15 / 118 ms    (silencio tras el RPC)
respuesta luego : 3070 / 3230 / 2830 ms (la sesión sobrevive)
```

La precondición `minSpeechBeforeInterruptMs` (800 ms) existe para que el test no
sea vacuo: interrumpir en el primer frame no probaria nada. Y el segundo aserto —
que la conversación siga respondiendo después — importa más que el primero: un
interrupt que corta el audio pero mata la sesión se ve como que funcionó.

## HALLAZGO: carrera real entre la transcripción y el gate de decisión

Al correr el suite completo, las transferencias empezaron a fallar de forma
**intermitente**, y no por el barge-in: la corrida 1 falló la cancelada, la
corrida 2 falló la **confirmada**. O sea que el verde de Slice 4 fue, en parte,
suerte.

### Mecanismo

`decideTransfer` (`src/agent/definition.ts:852`) exige
`voiceDecisionGate.consume(previewId, decision)`, y el gate
(`src/livekit/voice-decision-gate.ts:82`) solo acepta si **ya registró evidencia**
—una transcripción **final**, de un speaker autenticado, posterior al preview.

El proveedor realtime transcribe de forma **asincrónica**: el modelo entiende el
audio antes de que llegue el evento de transcripción final. Si el modelo llama a
`confirm_transfer`/`cancel_transfer` en esa ventana, `consume` no encuentra
evidencia y el tool devuelve `confirmation_required`.

Evidencia: en las corridas fallidas el agente dijo, textual,

- confirmada: *"Opa, parece que todavía no hay una confirmación válida en el
  sistema. No pasó el sí final."*
- cancelada: *"Aunque dijiste 'no', para cancelar necesito una respuesta corta
  siguiendo el flujo"*

es decir, el mensaje `notYet` del gate — pese a que la transcripción correcta
(`"No, cancela, déjalo."`, que clasifica como cancelación) **sí** existía en el
stream.

**Impacto de producto:** una persona dice "sí, confirmo" y Nani responde que no
hay confirmación válida. Para adultos mayores es un callejón: repiten y puede
volver a pasar.

### Qué hice y qué NO

**No toqué el gate.** Relajar una guarda de confirmación de pagos es exactamente
la clase de atajo que AGENTS.md prohíbe tomar sin decisión explícita.

Lo que hice fue quitar una irrealidad del harness: **las fixtures terminaban en el
último fonema**, sin pausa. Ningún micrófono produce eso. Agregué **1200 ms de
silencio final** (sin tocar el audio de voz) y la carrera dejó de manifestarse:
3/3 corridas con las dos transferencias verdes.

**Residual, dicho con honestidad:** 3 corridas no prueban que la carrera esté
eliminada. El silencio le da tiempo a la transcripción, pero un usuario real que
corta y se calla rápido puede volver a caer en la ventana. La causa raíz —el gate
depende de un evento asincrónico que puede llegar después del tool call— sigue en
el producto y **necesita decisión de Rama**.

## Estabilidad verificada

El suite de voz quedó en **6 corridas verdes consecutivas** después del fix del
silencio: 3 del spec de transferencias y 3 del suite completo (4/4). Se hizo a
propósito: hoy la lección más caras fue que **verde aislado no es verde en
conjunto** — Slice 4 pasó solo y falló al correr todo junto.

## Pasada de honestidad sobre artefactos

Dos tests del repo decían cubrir más de lo que cubren, y la clase de defecto es la
misma que el resto del día: un artefacto que miente sobre la realidad.

**`tests/e2e/livekit-smoke.e2e.test.ts`** — crea sala, despacha el agente y borra
la sala. **Nunca entra a la sala**, así que no distingue un camino de voz sano de
uno roto: como el worker espera participante y después se bloquea en el RPC de
binding, una sala despachada y vacía da el mismo resultado funcione el agente o no.
Ahora su header lo dice, y aclara que es complementario de `tests/e2e/voice-room/`
(este verifica el *deployment*, aquel la *conversación*).

**`tests/simulation/livekit-voice.simulation.test.ts`** — no importa LiveKit ni
abre sala. Su `simulateConversation` es una máquina de estados definida **en el
propio archivo**, no el reducer del producto, así que no puede fallar cuando el
reducer real se rompe. Su header ahora lo aclara y apunta a los tres lugares donde
sí está cubierto: `tests/unit/resolution-phrases.test.ts`,
`live-voice-reducer.test.ts` del front, y `tests/e2e/voice-room/`.

**Ninguno se borró.** El smoke sigue cubriendo algo real que el stack aislado no:
que un deployment vivo (Cloud o self-hosted) sea alcanzable y despachable. El de
simulation todavía atrapa regresiones en cómo se **componen** las frases en
secuencia, algo que los unit tests directos no ven. Se documentaron en vez de
reestructurarlos: renombrar el segundo dejaría huérfano el script
`test:simulation`, que existe solo para ese archivo.

## Registro en `openspec/` (etapa 2)

AGENTS.md pide dos etapas: diseño en `.agent-workflow/` e implementación SDD en
`openspec/`. La etapa 1 está en este directorio; la etapa 2 se completó **al
final**, no antes, porque el trabajo se ejecutó en el mismo hilo que lo diseñaba.

`openspec/changes/voice-room-e2e-harness/` contiene ahora proposal, spec (7
requerimientos, 16 escenarios con GIVEN/WHEN/THEN y RFC 2119), design con su
diagrama de secuencia, tasks y verify-report. `state.yaml` marca `archive: pending`
a propósito: el trabajo vive en `feat/voice-e2e-harness` y no se mergeó.

**Desvío registrado:** lo canónico era escribir esos artefactos antes de
implementar. El resultado es el mismo contrato, pero el registro es retrospectivo y
conviene decirlo en vez de aparentar que siguió el orden previsto.

## No-regresión

Suite completa: **860 pasan, 174 skipped, 16 fallan**. Los mismos 16 fallos en
las mismas 4 suites que en la base `feat-solana-operational` (14 de integración
contra una DB que no está disponible, 2 unit de realtime), verificados como
preexistentes corriendo la misma suite en ese worktree sin ningún cambio mío.
Ningún fallo nuevo. `npm run typecheck` y `npm run lint` limpios.

## Desvío: cambios en `src/`

Slice 3 requirió dos cambios fuera de las superficies de solo-test, ambos
revisables por separado:

1. `src/runtime/dependencies.ts` + `src/livekit/worker.ts` — el seam de wallet
   fixture (commit propio, apagado por defecto, con 2 tests de unidad).
2. `vitest.config.ts` — un glob de exclusión, para que la suite de voz no entre
   en `npm test`.

## Estado del stack

Proyecto compose `nana-e2e` (aislado): livekit en 7882 + 38881-38891, db en 5433,
worker registrado como `nani-agent`. Los stacks `nana-privy-impl` y `nana-real`
nunca se tocaron.
