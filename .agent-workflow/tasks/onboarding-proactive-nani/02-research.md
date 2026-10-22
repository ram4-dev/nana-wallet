# 02 — Research (estado actual, con evidencia)

## RQ1 — Qué dispara hoy la sesión de voz en web

**Respuesta:** un toque explícito en el avatar. No hay autoconexión.

- `useLiveVoiceSession.start()` solo se invoca desde `handleAvatarPress` cuando
  `avatarAction(state) === "start"` (fases `idle`/`failed`).
  Evidencia: `apps/nana-wallet/src/features/agent/useLiveVoiceSession.ts:129-160`.
- La home cablea el click del avatar a `liveVoice.handleAvatarPress()` en web y a
  `handleMicrophone()` en nativo. Evidencia:
  `apps/nana-wallet/src/routes/index.tsx:497-520`.
- La sesión se auto-pausa y se reanuda por ciclo de vida
  (`visibilitychange`, `pagehide` → `pauseForLifecycle`), y tiene reconexión con
  deadline. Evidencia: `useLiveVoiceSession.ts:64-107`.
  **Implicancia:** cualquier autoconexión tiene que convivir con ese pause/resume.

## RQ2 — ¿Existe ya un saludo / primer mensaje del agente?

**Respuesta:** no. El agente nunca habla primero.

- `NANI_REALTIME_INSTRUCTIONS` define persona y reglas de tools, sin instrucción de
  primer turno ni mensaje inicial.
  Evidencia: `src/livekit/create-agent-session.ts:6-19`.
- `AgentSession.start()` (worker) no dispara saludo; el único `session.say(text)` es
  el read-back del preview de transferencia.
  Evidencia: `src/livekit/worker.ts:200`.
- El agente de texto usa otra persona (`buildWalletAgentInstructions`), también sin
  saludo. Evidencia: `src/agent/instructions.ts:19-60`.

## RQ3 — Herramientas financieras disponibles hoy

**Respuesta:** no existe swap.

- Voz: `get_balance`, `search_recipients`, `send_token`, `confirm_transfer`,
  `cancel_transfer`. Evidencia: `src/livekit/create-agent-session.ts:6-19`.
- Texto: `get_balance`, `get_selected_recipient_address`, `send_token`,
  `stage_user_memory`, `write_user_memory`.
  Evidencia: `src/agent/instructions.ts:19-60`.
- **Consecuencia:** "podemos hacer un swap" del pedido no tiene herramienta. Es una
  decisión de alcance, no un detalle de UI.

## RQ4 — Cómo llega el saldo al front hoy

**Respuesta:** por REST, y por separado del agente de voz.

- `api.getBalances()` → `GET /v1/wallets/current/balances`; también existe
  `/v1/wallet/balance?network=arc-testnet&token=USDC`.
  Evidencia: `apps/nana-wallet/src/lib/api.ts:438-446`, `api.ts:368-375`.
- La home del agente NO lee balances; `mi-plata` sí (`routes/mi-plata.tsx:85-98`).
- El agente de voz obtiene saldo por la tool `get_balance`, no por el front.
  **Implicancia:** si el saludo debe leer el saldo, hay que elegir dueño: el agente
  (tool call) o el front (REST + TTS local).

## RQ5 — Micrófono y autoplay de audio

**Respuesta:** hoy no hay manejo de desbloqueo de audio, y el micrófono se pide en
el mismo gesto de conexión.

- `connect()` crea la binding, conecta a la sala y recién después
  `setMicrophoneEnabled(true)` → el prompt de permiso aparece en ese momento.
  Evidencia: `livekit-web-client.ts:130-200`.
- **No existe ninguna llamada a `room.startAudio()` ni uso de
  `room.canPlaybackAudio` en todo el front** (grep sobre `apps/nana-wallet/src`).
  **Riesgo real:** en un navegador nuevo, la reproducción de audio remoto puede
  quedar bloqueada por la política de autoplay hasta que haya un gesto del usuario.
  Es decir: "Nani habla sola al entrar" puede salir muda en la primera visita.
- `POST /v1/live-bindings` **crea una conversación nueva** si no se le pasa
  `conversationId`. Evidencia: `src/api/conversations.ts:49-70`.
  **Implicancia:** autoconexión en cada carga de la home crea una conversación por
  visita; hay que decidir si reusar una conversación activa.

## RQ6 — Path nativo (Capacitor)

**Respuesta:** no usa LiveKit.

- `isNative` → `createRecordedVoiceClient` + `MediaRecorder` push-to-talk y
  `POST /v1/voice/speak`, `api.transcribeAgentAudio`.
  Evidencia: `routes/index.tsx:29-40`, `routes/index.tsx:277-300`.
- Existe `useVoicePlayback` con `speak()` (TTS del navegador) que hoy se usa para
  leer la respuesta del turno de texto. Evidencia: `routes/index.tsx:105-115,255`.
  **Implicancia:** el "saludo proactivo" tiene una implementación plausible en
  nativo sin LiveKit (texto + TTS local), pero es una rama distinta.

## RQ7 — UI disponible para mostrar saldo y opciones

**Respuesta:** hay tarjeta de saldo en `mi-plata`, pero la home no tiene chips.

- Home: avatar, chip de estado, tarjeta de turno/preview, input de texto.
  Evidencia: `routes/index.tsx:470-751`.
- `mi-plata` arma la tarjeta "Tu saldo" con `balancesQuery`.
  Evidencia: `routes/mi-plata.tsx:175-200`.
- No hay componente de sugerencias/quick-replies reutilizable.

## RQ8 — Tests existentes en la zona de cambio

- `features/agent/AgentScreen.test.tsx`, `useConversationState.test.tsx`,
  `useLiveVoiceSession.test.tsx`.
- Contratos observados que no deberían romperse: degradación a texto con mensaje
  tipado (`onTypedFallback`), y que ninguna acción financiera ocurra sin
  confirmación explícita.

## Gaps que quedan abiertos

1. No verifiqué comportamiento real de autoplay por navegador (requiere prueba
   manual en Chrome/Safari con storage limpio).
2. No verifiqué si LiveKit Cloud/self-host emite algún mensaje inicial del agente
   por configuración del dispatch (el código local no lo hace).
3. No medí latencia/costo de un `get_balance` en el primer turno.
4. No revisé evals del agente de voz para un caso "saludo".
