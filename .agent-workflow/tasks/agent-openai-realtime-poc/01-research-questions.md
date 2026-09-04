# 01 — Research questions

## Current-state questions

### Answered by repo scan (2026-09-04)

- **R1 — ¿Dónde se compone el pipeline de voz actual?**
  `src/livekit/create-agent-session.ts`: `AgentSession` con STT `inference.STT` (Deepgram nova-3), LLM `WalletConversationLLM` (adapter custom que puentea a `service.handleTurnStream`), TTS ElevenLabs (`createTTS()`) o Cartesia vía `LIVEKIT_TTS_PROVIDER=inference`. Turn detection con `inference.TurnDetector` + silero.
- **R2 — ¿Qué importa cambiar y qué no?**
  Solo la composición de `AgentSession`. El binding/lease/RPC/room-dispatch (`room-conversation.ts`, `worker.ts`) y el transporte grabado nativo quedan intactos.
- **R3 — ¿Dónde está la API key de OpenAI?**
  Secret Vault: `OPEN_AI_API_KEY` (cargada para nana wallet). Verificada vía API: crea sesión realtime OK; es una key de pago con créditos.
- **R4 — ¿Qué limitaciones tiene hoy la conversación LiveKit?**
  Pipeline de 3 servicios en cadena: latencia compuesta (STT → LLM → TTS), dos proveedores extra con costo, y transcript gating vía `RoomConversation`. El texto del usuario entra a `service.handleTurnStream` que corre el tool-loop de wallet.
- **R5 — ¿Qué pasa con las tools de wallet si el LLM pasa a ser realtime?**
  `WalletConversationLLM` desaparecería del camino: el modelo realtime hace inferencia propia. Las tools (`send_token` con guardas) NO están registradas como function-calling del AgentSession sino dentro del servicio → sin porting explícito, el realtime conversa pero no opera la wallet. Riesgo de producto: decidir alcance de la POC.

### Open — requiere investigación externa (web)

- **R6 — ¿Qué plugin LiveKit soporta OpenAI Realtime en JS y cómo se conecta?** (verificado en 02)
- **R7 — ¿Qué ID exacto de modelo y qué parámetros (`voice`, turn detection, modalidades) acepta?** (verificado en 02)
- **R8 — ¿Cómo se comporta el AgentSession de LiveKit con un `RealtimeModel` como `llm`?** (STT/TTS propios quedan anulados, VAD semántico del modelo)

### Open — decisión de producto (para design)

- **R9 — Alcance de la POC:** ¿voz realtime solo conversacional (sin tools de wallet), o incluir al menos una tool de lectura (balance)? — **Decidido por el usuario (2026-09-04): incluir `get_balance` read-only en fixture para poder ver la latencia de un turno con tool calling.**
- **R9b — Tool de contactos (decidido por el usuario 2026-09-04):** agregar `search_contacts` mockeada que devuelve **dos contactos llamados Lucas** — no solo mide latencia con segunda tool, sino que testea el comportamiento del modelo ante ambigüedad: debe pedir desambiguación ("¿cuál Lucas?"), no adivinar. Espeja el criterio ya definido en los evals del agente de texto (`agent-voice-evals` 03-design §1: "nombres ambiguos → pregunta, no adivina").
- **R10 — ¿Se mide latencia/costo en la POC o solo "funciona"?** (impacta cuánta instrumentación se agrega)
- **R11 — Default del env:** ¿`openai-realtime` como modo opt-in (`LIVEKIT_VOICE_PROVIDER`) con pipeline actual como default, correcto?

## Scope exclusions

- No se investiga el transporte grabado nativo ni el frontend.
- No se evalúan modelos realtime alternativos (Gemini Live, etc.).
- No se implementa la integración real de pagos/transferencias sobre realtime en v1.
