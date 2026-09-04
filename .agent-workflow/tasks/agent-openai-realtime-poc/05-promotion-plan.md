# 05 — Promotion plan (GPT-Realtime como única ruta de voz)

## Decisión (usuario, 2026-09-04)

La POC funcionó mejor que el pipeline actual (latencia 340–582 ms turno simple, 582–767 ms con tool, barge-in OK). **El pipeline LiveKit actual (Deepgram → WalletConversationLLM → ElevenLabs/silero) se elimina; GPT-Realtime-2.1 Mini pasa a ser la única ruta de voz del worker.** El texto/chat y el transporte grabado nativo no cambian.

## Alcance

### A. Promoción en `src/livekit/`

- `create-agent-session.ts`: eliminar `createPipelineAgentSession`, el import de `@livekit/agents-plugin-elevenlabs`, `inference.*` (Deepgram/TTS/TurnDetector) y `WalletConversationLLM` del path de sesión. `createAgentSession` compone siempre la sesión realtime (mismo Agent Nani + tools). `AgentSessionDependencies` pierde `voiceProvider`/`openaiApiKey` (la key se lee de env/config directamente).
- `src/livekit/wallet-conversation-llm.ts`: eliminar si solo lo consumía el pipeline (verificar imports antes; `collectWalletConversationEvents` y tipos compartidos migrar o conservar según uso real).
- `worker.ts`: dejar de forwards `voiceProvider`; `conversationService` se mantiene para la maquinaria de room (binding, leases, records, revision publisher) — el realtime no lo usa como LLM pero la conversación sigue registrándose.
- `realtime-latency-logger.ts`: se queda (no es andamiaje: es la observabilidad de la ruta oficial). Renombrar/quitar el tono "POC" del módulo y del log.

### B. Config (`src/config/process.ts` + `.env.example`)

- Eliminar `LIVEKIT_VOICE_PROVIDER`, `VoiceProvider` y `readVoiceProvider`; sin switch.
- `readWorkerProcessConfig`: exigir `OPENAI_API_KEY` siempre; dejar de exigir `ELEVENLABS_API_KEY` en el worker (la key de ElevenLabs sigue siendo necesaria para el proceso API por `/v1/voice/speak` del transporte grabado — no tocar eso).
- `.env.example`: quitar `LIVEKIT_VOICE_PROVIDER`; `OPENAI_API_KEY` pasa a requerida del worker; mover comentario.
- El `.env` local de la POC se alinea (quitar la var).

### C. Limpieza de dependencias

- Quitar deps sin uso tras la eliminación: `@livekit/agents-plugin-deepgram`, `@livekit/agents-plugin-elevenlabs`, `@livekit/agents-plugin-silero` (verificar que nadie más las importe — el transporte grabado usa HTTP, no plugins).
- Mantener `@livekit/agents-plugin-openai`.

### D. Tests

- Eliminar tests del pipeline eliminado (`livekit-stream.test.ts` si muere con `WalletConversationLLM`; ajustar mocks de elevenlabs en tests de sesión).
- `voice-provider-config.test.ts` → reescribir como config de worker único: exige `OPENAI_API_KEY`, no exige ElevenLabs, ya no lee provider.
- `realtime-agent-session.test.ts`: queda como la suite de la sesión oficial; quitar el caso "pipeline default".
- Suite completa + typecheck en verde.

## Fuera de scope (tareas siguientes, no este plan)

- Tools reales (balance vía wallet provider, contactos vía DB): hoy quedan fixtures porque la POC lo definió así; portarlas es el siguiente task (`agent-realtime-tools`), con `send_token` + guardas preview→confirm como trabajo separado.
- ELEVENLABS_ZERO_RETENTION / privacy checks de ElevenLabs en la ruta API: sin cambios.
- Frontend: sin cambios (el flujo live es idéntico; el texto sigue con el servicio actual).

## Slices

1. **Worker solo-realtime** — ✓ (2026-09-04): pipeline eliminado (`create-agent-session.ts` siempre realtime, `wallet-conversation-llm.ts` borrado, `voiceProvider`/switch removidos, deps deepgram/elevenlabs/silero uninstall). Suite 274 passed, typechecks OK, worker arranca sin `ELEVENLABS_API_KEY` (solo `OPENAI_API_KEY`).
2. **Limpieza de tests y doc** — ✓ (2026-09-04): tests consolidados (worker-config en vez de provider-switch, suite realtime como oficial, api-health CORS test hecho hermético), `docs/livekit-development-runbook.md` y `docs/architecture.md` actualizados a realtime-only, `.env.example` con `OPENAI_API_KEY` requerida + `LIVEKIT_AGENT_NAME=nani-agent`.
3. **Smoke live de regreso** — ✓ (2026-09-04, usuario): "funciona" sobre la rama promocionada. Worker `nani-agent` despachado por nombre, binding OK, conversación realtime completa con tools y barge-in.

## Resultados de la promoción

- Latencia (de la POC, misma ruta): turno simple 340–582 ms; con tool 582–767 ms.
- Estado final: GPT-Realtime-2.1 Mini es la única ruta de voz del worker LiveKit. Texto y transporte grabado sin cambios.
- Pendiente como tasks siguientes: `agent-realtime-tools` (balance/contactos reales) y `send_token` con guardas preview→confirm.
- Trabajo sin commitear en worktree `feat/openai-realtime-poc` — entrega pendiente de decisión del usuario.

## Riesgos

- Sin fallback: si OpenAI Realtime falla, la voz live cae completa (decisión aceptada por el usuario; el texto sigue operativo).
- `WalletConversationLLM` puede tener consumidores no detectados: verificar con grep antes de borrar (gate del slice 1).
- Si algún test e2e fake del worker ejercita el pipeline, hay que reescribirlo contra la sesión realtime mockeada.
