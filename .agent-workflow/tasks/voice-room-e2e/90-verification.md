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

## Slice 3 — turno completo: **NO RESUELTO** (infraestructura entregada)

Lo que sí funciona y está verificado:

- Fixtures de voz pregrabados (3 WAV en `tests/e2e/voice-room/fixtures/`),
  generados una sola vez con `synthesizeSpeech`.
- `tests/e2e/voice-room/turn-detector.ts` — detección de fin de turno por
  silencio, con **17 tests de unidad verdes**.
- `caller.ts` / `audio.ts` / `fixture.ts` / `config.ts`: conexión, publicación,
  captura y seed reutilizables.
- `scripts/voice-room-roundtrip.ts`: corre 3 veces completo y escribe los WAV de
  ambos lados.
- El agente **sí entiende y responde** al turno inyectado. Evidencia: el
  transcript de run3 es `"Tus balances de SOL son cuarenta y dos con cincuenta."`
  — una respuesta directa a la pregunta, con el saldo real del fixture, y no el
  formato del saludo.

**El defecto abierto:** la captura de audio del segundo turno devuelve silencio.
El WAV de respuesta pesa 3 MB y dura 32 s, pero su RMS máximo es **32** contra
**9000-18000** del saludo: frames llegan, audio no. Por eso el runner reporta
`FAIL: 3/3 round trip(s) failed` con `speech=0 ms, ended=false, timedOut=true`.

O sea: el agente habla, el harness no lo oye. El fallo es de captura, no del
agente. Queda como el próximo trabajo concreto, y el runner **falla ruidosamente**
en vez de dar un verde falso.

## Slice 5 — vitest y runbook: **NO INICIADO**

No existe `tests/e2e/voice-room/vitest.voice-room.config.ts` ni el test de
vitest. Se quitó del `package.json` el script que apuntaba a esa config
inexistente, para no dejar un entry point colgado.

## No-regresión

Suite completa: **860 pasan, 174 skipped, 16 fallan**. Los mismos 16 fallos en
las mismas 4 suites que en la base `feat-solana-operational` (14 de integración
contra una DB que no está disponible, 2 unit de realtime), verificados como
preexistentes corriendo la misma suite en ese worktree sin ningún cambio mío.
Ningún fallo nuevo. `npm run typecheck` y `npm run lint` limpios.

## Estado del stack

Proyecto compose `nana-e2e` (aislado): livekit en 7882 + 38881-38891, db en 5433,
worker registrado como `nani-agent`. Los stacks `nana-privy-impl` y `nana-real`
nunca se tocaron.
