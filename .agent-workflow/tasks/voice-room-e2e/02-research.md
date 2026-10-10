# 02 — Research

Todo lo de abajo está verificado contra el repo o contra el stack corriendo, no
inferido. Los números salen de corridas reales.

## 1. El worker exige un binding por RPC, no un dispatch

`src/livekit/worker.ts` → `runJob`:

1. Falla al arrancar si falta `LIVE_VOICE_BINDING_PUBLIC_KEY`.
2. `await ctx.connect(undefined, AutoSubscribe.AUDIO_ONLY)`.
3. **`await ctx.waitForParticipant()`** — el worker espera a que entre alguien.
4. `agentParticipant.registerRpcMethod("interrupt_agent", ...)` y
   `registerRpcMethod("bind_conversation", createBindingRpcHandler(...))`.
5. **`const binding = await bindingAccepted;`** — bloquea hasta que el caller
   invoque el RPC. Si `!binding.ok`, hace shutdown de la conversación.

`createBindingRpcHandler` (`src/livekit/room-conversation.ts:310`) parsea
`{"bindingToken": string}` y llama `gate.bind({token, participantIdentity, workerId})`.
Payload inválido → `{ok: false, code: "invalid_binding"}`.

**Consecuencia:** un dispatch sin caller no produce conversación. Esto explica por
qué el smoke actual no puede estar cubriendo nada.

## 2. Forma del binding token

`src/auth/live-binding.ts`:

- Claims: `conversationId`, `purpose: 'live_voice_binding'`, `jti`.
- `iss: 'nani-api'`, `aud: 'nani-livekit-worker'`.
- Algoritmo **EdDSA**. Firma con `LIVE_VOICE_BINDING_PRIVATE_KEY`, verifica con
  `LIVE_VOICE_BINDING_PUBLIC_KEY`.
- El verificador rechaza si `purpose !== 'live_voice_binding'` o falta `jti`.

El emisor vive en el mismo archivo: el harness puede reusarlo en vez de
reimplementar la firma.

## 3. ICE host ↔ contenedor: funciona, con una condición no obvia

Stack: `livekit/livekit-server:v1.13.6` en Docker, cliente `@livekit/rtc-node`
0.13.34 corriendo en el host.

Evidencia de los logs del server: `participant active`, `connectionType: "udp"`,
par seleccionado `192.168.48.2:38881` ↔ `192.168.0.91:55813`,
`mediaTrack published` con `ssrc`.

Resultado del spike: **354 frames, 3540 ms recibidos, 449 ms al primer frame.**

**La condición no obvia:** LiveKit anuncia el rango `rtc.udp_port` desde **su
propio archivo de config**, no desde el mapeo de puertos de compose. Publicar
puertos distintos mientras el server sigue anunciando el rango viejo entrega
candidatos inalcanzables y ICE falla. El rango del host **debe** igualar el del
archivo. Cada stack aislado necesita su propio config:

| Stack | Config | Rango RTC |
|---|---|---|
| base | `docker/livekit.yaml` | 7881-7891 |
| privy | `docker/privy-livekit.yaml` | 17881-17891 |
| e2e (nuevo) | `docker/e2e-livekit.yaml` | 38881-38891 |

## 4. Conflictos de puerto reales en esta máquina

| Recurso | Ocupado por | Override usado |
|---|---|---|
| TCP 5432 | túnel ssh | 5433 |
| UDP 7881-7891 + TCP 7881 | `nana-real-livekit-1` | 38881-38891 |
| TCP 7880 | túnel ssh (por eso el base mapea 7882) | 7882 |

El base `compose.yaml` mapea el signaling a **`127.0.0.1:7882:7880`** a propósito.
Los contenedores hablan `ws://livekit:7880`; el harness en el host debe usar
`ws://127.0.0.1:7882`.

## 5. El stack fixture no necesita credenciales Privy

- `compose.yaml` (base) = stack fixture. `voice-worker` bajo `profiles: ["worker"]`,
  `env_file: [.env]`, `WDK_NETWORK: solana-devnet`, wallet fixture. **Cero `PRIVY_*`.**
  No setea `WDK_TOOLS_SOURCE`, así que cae al default `fixture` por código.
- `compose.privy-local.yaml` = camino live, exige `PRIVY_*` con `:?` (obligatorio)
  y usa LiveKit en 17881.

## 6. El aislamiento de tests borra las credenciales del harness

`tests/setup/isolate-provider-env.ts` (cargado por `vitest.config.ts` como
`setupFiles`) borra, entre otras: `LIVEKIT_URL`, `LIVEKIT_API_KEY`,
`LIVEKIT_API_SECRET`, `LIVEKIT_AGENT_NAME`, `LIVEKIT_AGENT_RUNTIME`,
`LIVE_VOICE_BINDING_*`, `OPENAI_API_KEY`, y todos los `PRIVY_*`.
Opt-out: `VI_TEST_AMBIENT_PROVIDER_ENV=1`.

Es correcto por diseño, pero significa que un test de sala **no ve** las
credenciales salvo que las inyecte explícitamente. `DATABASE_URL` y `DEMO_USER_ID`
se dejan intactos a propósito.

## 7. Trampas de API encontradas a golpes

1. **`track.kind` es numérico.** `TrackKind.KIND_AUDIO === 1`, **no** el string
   `'audio'`. El filtro `track.kind !== 'audio'` descarta todos los tracks **sin
   error**: cero frames, cero pistas. Costó ~4 ciclos de debugging.
2. **Un `AudioStream` vivo mantiene el event loop despierto** y
   `room.disconnect()` no resuelve con un reader attached → el script cuelga para
   siempre. Hay que salir con `process.exit()` explícito.
3. `AudioStream extends ReadableStream<AudioFrame>`: `for await` o `getReader()`,
   ambos válidos.

## 8. Estado del stack aislado (ya operativo)

Proyecto compose `nana-e2e`, archivos `compose.yaml` + `compose.e2e.override.yaml`:

| Contenedor | Estado |
|---|---|
| `nana-e2e-livekit-1` | healthy, 7882 + 38881-38891 |
| `nana-e2e-db-1` | healthy, host 5433 |
| `nana-e2e-voice-worker-1` | registrado como `nani-agent`, LiveKit 1.13.6 |

Log del worker: `"msg":"registered worker","agentName":"nani-agent"`.
Los stacks `nana-privy-impl` y `nana-real` quedaron intactos (no se detuvo nada).

## 9. RQ7: qué exige `gate.bind` (resuelto)

`RoomConversation.bind` (`src/livekit/room-conversation.ts:60`) encadena cuatro
guardas; cualquiera falla y el binding se rechaza:

1. `verifyLiveVoiceBinding({token, publicKey})` — JWT EdDSA válido.
2. **`participantIdentity === binding.sub`** si se pasa identidad. El caller debe
   entrar a la sala **con identidad igual al userId**, no con un nombre libre.
   Si no: `conversation_forbidden`.
3. **`conversations.get(binding.sub, binding.conversationId)` tiene que devolver
   snapshot.** Si no: `conversation_not_found`. **Un `conversationId` inventado no
   sirve: hay que sembrar la fila.**
4. `acquireLiveLease(...)` debe devolver `acquired`; otra sesión viva da
   `conversation_already_live`.

Fixture mínimo derivado: usuario con id conocido → conversación de ese usuario con
id conocido → sin lease activo → token con `sub = userId` y ese
`conversationId`.

## 10. Antecedente que no hay que duplicar

`evals/voice/realtime/` ya resuelve el e2e **contra la API directa de OpenAI**
(cliente WebSocket propio, tools bindeados a fixture en memoria, asertos de
secuencia de tools y narración, incluye un turno por audio). Nuestro trabajo mide
la capa de arriba: worker + sala + binding + sesión real. Son complementarios y
no deben fusionarse.
