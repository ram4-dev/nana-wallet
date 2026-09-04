# 02 — Research

## Respuestas a las preguntas abiertas

### R6 — Plugin LiveKit JS para OpenAI Realtime (fuentes: docs.livekit.io/agents/models/realtime/plugins/openai/, github.com/livekit/agents-js)

- Plugin oficial: `@livekit/agents-plugin-openai` (1.x). Exporta `openai.realtime.RealtimeModel`.
- Uso: se pasa como `llm` del `AgentSession`:

  ```ts
  import * as openai from "@livekit/agents-plugin-openai";
  const session = new voice.AgentSession({
    llm: new openai.realtime.RealtimeModel({ model: "...", voice: "marin" }),
  });
  ```

- Cuando `llm` es `RealtimeModel`, el AgentSession no usa los `stt`/`tts` propios: STT+inferencia+TTS ocurren dentro del modelo realtime (speech-to-speech nativo).
- **Compatibilidad verificada con npm:** `@livekit/agents-plugin-openai@1.7.1` declara peer `@livekit/agents@1.7.1` (exacto) — el repo tiene `@livekit/agents@^1.7.1`. Match directo, sin bumps.
- Autenticación: `OPENAI_API_KEY` en env o parámetro `apiKey` del modelo.

### R7 — Modelo y parámetros (fuente: developers.openai.com)

- Modelo: `gpt-realtime-2.1-mini` (GPT-Realtime-2.1 Mini) — existe y está disponible vía API; audio+text in/out por WebSocket o WebRTC. Mejoras sobre 2.1 base en reconocimiento alfanumérico; variante "distilled reasoning" para menor latencia/costo.
- Voz: parámetro `voice` del session; voces actuales incluyen `marin` y `cedar` (recomendadas por OpenAI). La voz no puede cambiarse después del primer audio de la sesión.
- Turn detection: **semantic VAD** (default) con `eagerness` configurable (`auto|low|medium|high`); alternativa server VAD. Reemplaza al silero + `inference.TurnDetector` actuales.
- Modalidades: `output_modalities: ["audio"]` para voz completa (o `["text"]` + TTS separado — no aplica en POC).
- Key verificada operativa: la sesión `POST /v1/realtime` autentica OK con la key del Vault (`OPEN_AI_API_KEY`); el nombre env estándar del plugin es `OPENAI_API_KEY`.

### R8 — Comportamiento del AgentSession con RealtimeModel

- El modelo maneja su propio historial de conversación dentro de la sesión (máx 60 min por sesión).
- Soporta function calling nativo (session.tools / response.tools) — porting de tools de wallet sería posible en v2 registrándolas como function tools del agente.
- Carga de historial previo puede causar respuestas en texto pese a modalidad audio (workaround oficial: TTS separado + modalidad text — no aplica a POC, sesiones frescas por binding).

## Contradicciones y gaps

- LiveKit docs de plugin solo muestran Python para video input; para POC solo se usa audio (sin gap).
- El worker actual exige `ELEVENLABS_API_KEY` en `src/config/process.ts` — con el modo realtime esa key ya no es necesaria para la sesión LiveKit, pero el check es global al worker. Decidir en design si el check pasa a ser condicional según `LIVEKIT_VOICE_PROVIDER`.
- El costo por sesión realtime (tokens de audio) no se puede estimar sin una corrida real; la POC debe loguear usage si el SDK lo expone.

## Gaps restantes para research

- Ninguno bloqueante. La medición exacta de latencia/costo se obtiene en implementación.
