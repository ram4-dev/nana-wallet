# 00 — Intake

## Outcome

Probar (POC) que Nani puede conversar por voz en tiempo real usando **GPT-Realtime-2.1 Mini de OpenAI** (`gpt-realtime-2.1-mini`) como pipeline unificado: speech-to-text + inferencia + text-to-speech en **una sola sesión realtime**, integrado al worker LiveKit existente. La POC debe permitir comparar latencia y calidad de voz contra el pipeline actual (Deepgram STT → OpenCode LLM → ElevenLabs TTS) y medir el costo por sesión.

## Acceptance evidence (provisional)

- El worker LiveKit arranca y atiende una conversación de voz completa con el modelo realtime, seleccionable por env (`LIVEKIT_VOICE_PROVIDER=openai-realtime`).
- El usuario habla en español y recibe respuesta hablada del modelo realtime sin ElevenLabs ni Deepgram en ese modo.
- Transcript del usuario y de la respuesta quedan visibles (conserva la trazabilidad mínima actual).
- Una tool read-only (`get_balance`, fixture) está registrada como function tool del agente y el modelo la convoca al menos una vez en la POC.
- Una tool de búsqueda de contactos (`search_contacts`, fixture) está registrada y devuelve **dos contactos llamados Lucas**; ante un pedido ambiguo ("mandale a Lucas"), el modelo debe pedir desambiguación y no elegir uno solo por su cuenta.
- Medición por turno: latencia a primera respuesta hablada y, cuando interviene la tool, desglose (habla→function_call, ejecución de tool, function_call→habla).
- Suite de tests existente sigue en verde.

## Granted authority

- Read: entire repository, docs.
- Write (planning artifacts): `.agent-workflow/tasks/agent-openai-realtime-poc/`.
- Write (implementation): NOT yet granted — bound to design approval and structure outline gates.

## Read scope

- `src/livekit/` (worker, create-agent-session, wallet-conversation-llm, room-conversation), `src/agent/`, `src/config/`
- `.env.example`, `package.json`, `docs/`, `tests/unit/livekit-*`
- External (web): docs OpenAI Realtime API, docs LiveKit Agents JS plugin OpenAI.

## Write scope (implementation, tentative until design approval)

- `src/livekit/create-agent-session.ts` (seam principal)
- `package.json` (+ `@livekit/agents-plugin-openai@1.7.1`)
- `.env.example`, `src/config/` (nuevas variables de entorno)
- Posible wiring mínimo en `src/livekit/worker.ts` si el select de sesión lo exige

## Non-goals (provisional)

- No migrar el pipeline actual: Deepgram + OpenCode + ElevenLabs queda como default.
- Sin tools que muevan dinero: `send_token` y las guardas preview→confirm quedan fuera de la POC v1. Se incluyen únicamente `get_balance` y `search_contacts`, ambas read-only y en modo fixture (decisión del usuario para medir latencia con tool calling y observar desambiguación).
- Sin cambios en el transporte grabado nativo (`/v1/agent/transcribe`, `/v1/voice/speak`).
- Sin cambios de frontend.

## Selected route

RPI workflow (misma convención que `agent-voice-evals`). Current phase: intake → research questions.

## Active gate

Research gate: scope debe cubrir el estado actual (respondido por repo scan previo) y la investigación externa del plugin LiveKit↔OpenAI Realtime.
