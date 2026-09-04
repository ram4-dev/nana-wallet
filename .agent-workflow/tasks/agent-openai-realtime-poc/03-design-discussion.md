# 03 — Design discussion

## Estado actual

- Pipeline LiveKit: `create-agent-session.ts` compone `AgentSession` con STT Deepgram + LLM adapter (`WalletConversationLLM` → `service.handleTurnStream`) + TTS ElevenLabs/Cartesia + silero/turn-detector. Binding JWT → lease → gate arranca la sesión.
- `src/config/process.ts` exige `ELEVENLABS_API_KEY` para levantar el worker.
- Tests LiveKit: unit (stream, binding, config, privacy, deferred-turn, room-conversation), integración fake worker, smoke E2E opt-in.
- Key OpenAI operativa en Vault (`OPEN_AI_API_KEY`); env estándar del plugin: `OPENAI_API_KEY`.

## Estado deseado (POC)

- Mismo worker LiveKit, misma maquinaria de binding/lease/room, pero con `AgentSession` construido sobre `openai.realtime.RealtimeModel({ model: "gpt-realtime-2.1-mini" })` cuando `LIVEKIT_VOICE_PROVIDER=openai-realtime`. Default sin la variable: pipeline actual intacto.
- Selección por env en un único punto (`create-agent-session.ts`), sin duplicar worker ni rutas.

## Opciones y tradeoffs

| Decisión | Elegida | Alternativas descartadas | Tradeoff aceptado |
| --- | --- | --- | --- |
| Integración | **Plugin LiveKit `RealtimeModel` como `llm` del AgentSession** | WebSocket crudo a OpenAI; servicio realtime propio | Perdemos el control fino del prompt-loop del servicio, ganamos STT+LLM+TTS unificados con VAD semántico nativo |
| Alcance v1 | **Conversación + 2 tools read-only en fixture: `get_balance` y `search_contacts`** | sin tools; portar `send_token` con guardas | La POC mide latencia real de turnos con function calling y observa desambiguación; las guardas de dinero quedan v2 (re-diseño preview→confirm sobre function calling) |
| Instrucciones | **Instrucciones del personaje Nani pasadas al session del realtime** | reutilizar `buildInstructions()` del servicio | Riesgo de drift de prompts aceptado en POC; v2 unifica |
| Selección de modo | **`LIVEKIT_VOICE_PROVIDER=pipeline(default)\|openai-realtime`** | flag aparte por TTS/LLM; auto-detección de key | Una sola var, explícita, fallback seguro |
| Default del pipeline | **Sigue siendo pipeline actual** | realtime por defecto | Hackathon: comparar antes de mover el default |
| Turn detection | **Semantic VAD default del modelo** | server VAD configurado; silero propio | Menos knobs; el default de OpenAI está orientado a voice agents |
| Check de ElevenLabs | **Condicional: solo exigir cuando el provider no es openai-realtime** | mantener check global | El worker realtime puede correr sin key de ElevenLabs |
| Voz | **`marin` configurable por env (`OPENAI_REALTIME_VOICE`)** | cedar | Marin recomendada por OpenAI; env permite comparar |
| Transcript | **Mantener trazabilidad vía eventos de transcript del modelo** | silenciar | Comparabilidad con pipeline actual y debugging |
| Medición | **Log de latencia de primer audio por turno + usage si el SDK lo expone** | sin medición; instrumentación completa | POC con datos mínimos para decidir; instrumentación completa queda v2 |

## Diseño propuesto

### 1. Selección de sesión (`src/livekit/create-agent-session.ts`)

- Nueva función de composición: si `LIVEKIT_VOICE_PROVIDER === "openai-realtime"` → `AgentSession` con `llm: new openai.realtime.RealtimeModel({ model: OPENAI_REALTIME_MODEL ?? "gpt-realtime-2.1-mini", voice: OPENAI_REALTIME_VOICE ?? "marin", apiKey })`; sin `stt`/`tts`/`vad` propios (el modelo los reemplaza).
- Instructions del personaje (español rioplatense, breve, wallet) pasadas al agente/session.
- **Tool `get_balance` (fixture):** function tool read-only registrada en el Agent (tools del agente LiveKit → forwarded al session.tools de OpenAI). Implementación fija: devuelve un balance de fixture (datos estáticos y timeout defensivo). Sin acceso a wallet real en la POC.
- **Tool `search_contacts` (fixture):** function tool read-only que simula la búsqueda de contactos en la DB. Query: texto de nombre; devuelve una lista con **dos contactos distintos, ambos llamados Lucas** (p. ej. `Lucas Gutiérrez` y `Lucas Herrera`, con alias/apodo distinto y dirección diferente) + campo de ambigüedad. El fixture está diseñado para observar el comportamiento del modelo: ante "¿le mando a Lucas?" el modelo debe consultar la tool, ver dos resultados y **pedir desambiguación** en vez de elegir. Sin DB real en la POC.
- Resto del flujo (`RoomConversation`, RPC, gate, interrupt handling) sin cambios: el AgentSession abstrae el pipeline.

### 2. Config (`src/config/` + `.env.example`)

- `LIVEKIT_VOICE_PROVIDER`: `pipeline` (default) | `openai-realtime`.
- `OPENAI_API_KEY`, `OPENAI_REALTIME_MODEL` (default `gpt-realtime-2.1-mini`), `OPENAI_REALTIME_VOICE` (default `marin`).
- Check de proceso: `ELEVENLABS_API_KEY` requerido solo cuando provider ≠ `openai-realtime`; `OPENAI_API_KEY` requerido solo cuando provider = `openai-realtime`.

### 3. Wiring y dependencias

- `package.json`: `@livekit/agents-plugin-openai@1.7.1` (peer exacto con `@livekit/agents@1.7.1` ya presente).
- `src/config/process.ts`: checks condicionales por provider.

### 4. Observabilidad mínima de la POC

- Log estructurado por turno: tiempo hasta primer audio de respuesta (derivado de eventos del SDK si están disponibles; si no, timestamp de transcript delta).
- Cuando el turno incluye tool call, desglose en el mismo log: `speech_end → function_call` (decisión del modelo), `function_call → function_call_output` (ejecución de la tool, esperado ~0ms por ser fixture), `function_call_output → first_audio` (segunda pasada de inferencia + habla). Tres números = se puede ver dónde se va la latencia.
- Nota de comportamiento en el turno de contactos: qué eligió hacer el modelo ante los dos Lucas (preguntó / eligió solo / inventó). Es la observación cualitativa clave de la POC.
- Transcript de usuario y respuesta en los traces existentes (`VOICE_TRACE_*` gates actuales se respetan).

### 5. Fuera de scope v1

- Tools de wallet sobre realtime (function calling) — v2 con re-diseño de guardas.
- Comparación numérica formal de latencia vs pipeline actual — la POC loguea datos, el análisis es manual.
- Frontend, transporte grabado, cambios de pricing/plan.
