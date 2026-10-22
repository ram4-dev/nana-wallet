# 07 — Slice: el primer turno tiene que llegar

## Origen

Prueba real en el stack de compose (worker montado desde
`feat/greeting-personalization`, front `routes-DlG6HUs4.js`, LiveKit Cloud
`test-nanna-48u0wazg`). Reporte: "no está dando las opciones", "parece que alguien
le preguntó algo" y "apenas arranca aparece como escuchando".

## Evidencia (logs del worker, 2026-10-08 19:11)

Tres sesiones. Dos de ellas (`job 68`, `job 104`) tocaron `get_balance` y
reprodujeron audio normalmente. La tercera (`job 140`) falló así:

```text
19:11:44.116  INFO  Creating speech handle            ← dispatch del saludo
19:11:44.116  DEBUG AgentActivity.realtimeReply started
19:11:45.431  INFO  onInputSpeechStarted              ← 1,3 s después
19:11:45.432  DEBUG Aborting all realtime generation tasks due to interruption
19:11:45.444  DEBUG response done but not complete: cancelled (reason=turn_detected)
19:11:47.499  INFO  onInputSpeechStarted              ← turno real del usuario
19:11:51.925  INFO  Creating speech handle            ← Nani responde al turno
```

Mecanismo: la home publica el micrófono **antes** del bind ("publish before
binding so the agent input stream sees the track when it starts",
`livekit-web-client.ts`) y la sesión arranca con el input ya vivo. El VAD del
servidor detecta voz —ruido del entorno o las primeras palabras del usuario— y
**cancela la respuesta en vuelo**. El warmup de AEC sólo protege los primeros 3 s
(`aec warmup expired, re-enabling interruptions`).

Consecuencia visible: no se escucha intro ni opciones y el primer texto que
aparece es la respuesta de Nani a un turno, que se lee como "alguien le preguntó
algo".

Dato confirmado en la misma corrida: el idioma de esas conversaciones quedó en
`es` (fix de H2 funcionando; antes eran `en`).

## Decisiones

| ID | Decisión | Fuente |
| --- | --- | --- |
| G1 | El input de audio del saludo se retiene desde el dispatch hasta que termina su playout, con techo de seguridad | esta slice |
| G2 | El interruptor explícito (toque en el avatar → RPC `interrupt_agent`) sigue disponible durante todo el saludo | esta slice |
| G3 | Tras aceptar el bind el front muestra a Nani saludando, no "Te estoy escuchando" | esta slice |

### Trade-off aceptado en G1

Mientras dura el saludo el usuario **no puede interrumpir hablando** (sí con el
botón). Es deliberado: el saludo es corto y lleva la promesa del producto
(presentación + opciones); un saludo cortado a la mitad deja al usuario sin saber
qué puede pedir. La alternativa evaluada —`turn_detection.interrupt_response:
false` mientras dura el turno y restaurarlo después— exige actualización de
`turn_detection` en vivo y no está expuesta hoy en el plugin; queda como
seguimiento si el producto quiere barge-in durante el saludo.

## Outcome observable

1. Al iniciar la sesión, el saludo completo (presentación + saldo + tres opciones)
   se escucha sin que nada lo corte.
2. Lo primero que muestra la home es que Nani está saludando, no "Te estoy
   escuchando".
3. Al terminar el saludo, vuelve a escuchar normalmente y el toque en el avatar
   interrumpe en cualquier momento.

## Acceptance evidence

- `tests/unit/realtime-agent-session.test.ts`: el input se cierra **antes** del
  dispatch, se reabre al terminar el playout, y también con el timeout de
  seguridad; `speakGreeting()` sigue siendo at-most-once.
- `apps/nana-wallet/src/features/agent/voice/live-voice-reducer.test.ts`: el bind
  aceptado deja la fase en `thinking` con la marca de turno de apertura, y la marca
  se limpia con cualquier estado posterior del agente.
- Suites: raíz (`lint`, `typecheck`, `test`) y front (`lint`, `typecheck`, `test`).

## No-goals

- No se cambia el contrato HTTP ni la composición de las opciones.
- No se toca el path de texto ni la detección de idioma.
- No se implementa barge-in durante el saludo (queda documentado).

## Enmienda de copy (2026-10-08, post-prueba)

Con el saludo ya landeado, la prueba en vivo (20:58:24) mostró que las opciones
salían como **lista pelada**, sin encabezado:

```text
Hola Ramiro, soy Nani, tu asistente financiera. Diez USDC en arc-testnet.
Podés ver tu saldo, hacer una transferencia, o ver tus últimos movimientos.
```

El cierre pasó a oración textual (commit `73cfcb4`):

> Te puedo ayudar con: ver tu saldo, hacer una transferencia o ver tus últimos
> movimientos. ¿Qué querés hacer?

Dos consecuencias de agregar el encabezado: los pronombres pasan al usuario
(`ver tu saldo`, no `ver mi saldo`, porque ahora Nani habla de lo que ella puede
hacer por el usuario), y vuelve la pregunta de cierre del intake original.

## Límites de esta evidencia

- El arreglo se valida con fakes en unitarios; el check de oído en la sala sigue
  siendo humano y es el que cierra la slice.
- Con la compuerta de input no hay transcripción del usuario durante el saludo, así
  que el front no puede mostrar lo que dijo en ese lapso.
