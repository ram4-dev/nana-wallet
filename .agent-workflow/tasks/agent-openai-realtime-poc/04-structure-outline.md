# 04 — Structure outline

Vertical slices. Cada slice tiene resultado observable, checks y stop condition. Cada slice se verifica antes de arrancar el siguiente.

## Slice 1 — Plugin + config condicional

- **Outcome:** `@livekit/agents-plugin-openai@1.7.1` instalado; `LIVEKIT_VOICE_PROVIDER` y variables `OPENAI_*` documentadas en `.env.example` y leídas en config; checks de proceso condicionales (realtime exige `OPENAI_API_KEY`, pipeline sigue exigiendo `ELEVENLABS_API_KEY`). El worker arranca igual que hoy con el default.
- **Files:** `package.json`, `.env.example`, `src/config/*`, tests de config.
- **Automated checks:** suite existente verde (`vitest run`); nuevo test unit de config condicional (provider realtime sin ElevenLabs OK / pipeline sin OPENAI OK).
- **E2E/real-route:** n/a.
- **Manual checks:** `npm run livekit:dev` levanta sin cambios de comportamiento con el default.
- **Stop condition:** config verde + worker default intacto.

## Slice 2 — Sesión realtime en `create-agent-session.ts`

- **Outcome:** con `LIVEKIT_VOICE_PROVIDER=openai-realtime`, el `AgentSession` se construye con `RealtimeModel` (`gpt-realtime-2.1-mini`, voz configurable, instrucciones Nani en español) + function tools `get_balance` y `search_contacts` (ambas fixture, read-only; la de contactos devuelve dos Lucas para testear desambiguación). Sin Deepgram/ElevenLabs/silero en ese modo. Binding/lease/RPC/interrupciones funcionan igual. Log de latencia con desglose por turno (con y sin tool).
- **Files:** `src/livekit/create-agent-session.ts`, tests unit del select de sesión (mock del plugin).
- **Automated checks:** test unit: provider default compone pipeline actual; provider realtime compone sesión realtime con ambas tools y no exige STT/TTS; fixture de contactos expone exactamente 2 resultados para query "Lucas"; suite existente verde.
- **E2E/real-route:** smoke manual LiveKit Cloud (slice 3).
- **Manual checks:** revisar que `interrupt_agent`, `bind_conversation` y publicaciones de estado siguen registradas.
- **Stop condition:** composición seleccionable cubierta por tests + typecheck verde.

## Slice 3 — POC end-to-end contra OpenAI real (live)

- **Outcome:** conversación de voz real: usuario habla español → el modelo transcribe, razona y responde hablado en una sesión realtime. Transcript visible en traces/log. Latencia de primera respuesta hablada logueada por turno.
- **Files:** sin código nuevo esperado (wiring del slice 2); ajustes menores si el smoke los revela.
- **Automated checks:** suite existente verde.
- **E2E/real-route:** worker live con `LIVEKIT_VOICE_PROVIDER=openai-realtime` + `OPENAI_API_KEY` (Vault), binding por `/v1/live-bindings`, conversación real en la room. Criterios: entiende el pedido (transcript correcto), responde hablado en español rioplatense, soporta interrupción (barge-in) sin colgarse, convoca `get_balance` ante un pedido de saldo con respuesta hablada coherente con el fixture, y ante "¿le mando a Lucas?" convoca `search_contacts`, recibe los dos Lucas y **pide desambiguación en vez de elegir uno**.
- **Manual checks:** escuchar la respuesta; verificar latencia percibida vs pipeline actual; verificar la conducta del modelo ante la ambigüedad (preguntó / eligió solo / inventó); anotar en §Resultados: latencia de turno simple, latencia del turno con tool (desglose speech→call, exec, call→audio), costos/usage si el SDK lo expone.
- **Stop condition:** al menos 3 turnos conversados en vivo con transcript y audio correctos + notas de latencia/costo en este documento.

## Resultados de la POC (Slice 3 ejecutado 2026-09-04, live con usuario)

- Latencia turno simple (habla→habla): **340–582 ms** (speechEndToFirstAudioMs).
- Latencia turno con tool: **582–767 ms** con `get_balance` (exec ~1 ms, fixture) y `search_contacts`; turnos más complejos de la sesión: 1.1–1.6 s.
- Tools convocadas correctamente por el modelo: `get_balance` ✓, `search_contacts` ✓ (ejecución fixture ~1 ms).
- Barge-in verificado: respuestas canceladas por `turn_detected` al interrumpir, sin colgarse ✓.
- Comportamiento ante los dos Lucas: verificado en vivo por el usuario ✓ (convoca la tool y maneja la ambigüedad).
- Veredicto del usuario: **"funciona mejor" que el pipeline actual** → se promueve a modelo principal.
- Costo por sesión/turno: no medido (usage no expuesto en los logs del SDK) — pendiente para la promoción.

## Decisión del usuario (2026-09-04)

Promover GPT-Realtime-2.1 Mini a modelo de voz de LiveKit y eliminar el andamiaje de POC. Plan en `05-promotion-plan.md`.
