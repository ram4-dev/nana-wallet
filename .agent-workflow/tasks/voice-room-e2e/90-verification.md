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
