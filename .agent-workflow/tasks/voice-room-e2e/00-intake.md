# 00 — Intake

## Outcome

Cubrir el e2e real de voz: un caller que **habla de verdad con Nani** a través de
la sala LiveKit self-hosted, ejercitando el camino real del worker
(dispatch → `waitForParticipant` → RPC `bind_conversation` → sesión S2S → tools).

Hoy ninguna prueba cubre eso.

## Por qué ahora (estado verificado)

- `tests/e2e/livekit-smoke.e2e.test.ts` crea sala, despacha el agente y borra la
  sala. **Nunca entra a la sala.** Lo único que afirma es `dispatch.id` truthy.
  Como el worker hace `await ctx.waitForParticipant()` y después espera un RPC de
  binding, ese test no puede estar ejercitando nada de la conversación.
- `tests/simulation/livekit-voice.simulation.test.ts` se llama "live voice" pero
  es una máquina de estados pura: no importa LiveKit ni `rtc-node`.
- Los evals de `evals/voice/realtime/` hablan **directo con la API de OpenAI** por
  WebSocket, con el modelo y los tools bindeados a mano. Prueban el modelo, **no
  el worker ni la sala ni el binding**.
- Nani es speech-to-speech (`openai.realtime.RealtimeModel` en
  `src/livekit/create-agent-session.ts`), así que inyectar texto con
  `session.run({userInput})` saltea el audio: no es un e2e de voz.

## Acceptance evidence (provisional)

1. Un caller del host entra a la sala, recibe el saludo de Nani **en audio**,
   publica un turno de voz y recibe una respuesta hablada. Evidencia: WAVs
   capturados + conteo de frames.
2. El test falla si el worker no responde (no un `skip` silencioso).
3. Los artefactos (WAV, transcript, veredicto) quedan persistidos para inspección.
4. La suite existente sigue verde y el aislamiento de `.env` no se rompe.

## Granted authority

- Read: repositorio completo, docs.
- Write (planificación): `.agent-workflow/tasks/voice-room-e2e/`.
- Write (implementación): rama `feat/voice-e2e-harness` únicamente.
- Comandos, tests, commits y push: **solo a la rama de trabajo. Nunca a `main`.**

## Read scope

- `src/livekit/**` (worker, room-conversation, token-issuer, create-agent-session)
- `src/auth/live-binding.ts`
- `tests/setup/isolate-provider-env.ts`, `vitest.config.ts`
- `compose.yaml`, `docker/livekit.yaml`, `compose.privy-local.yaml`
- `evals/voice/realtime/**` (antecedente directo)
- Dependencias instaladas: `@livekit/rtc-node`, `livekit-server-sdk`

## Write scope (implementation, tentativo hasta aprobación de diseño)

- `tests/e2e/voice-room/**` (harness + fixtures de WAV)
- `compose.e2e.override.yaml` + `docker/e2e-livekit.yaml` (ya creados en el spike)
- Posible script npm; `package.json`.

## Non-goals (provisional)

- No CI todavía: el stack self-hosted + build de imagen no entra en el workflow actual.
- No reemplazar `evals/voice/realtime/`: mide otra capa (modelo vs sistema).
- No tocar el guard de confirmación ni relajar ninguna guarda financiera: el
  harness **mide**, nunca habilita.
- No modo live de wallet. `WDK_TOOLS_SOURCE=fixture` es obligatorio.
- No adoptar Agent Simulations de LiveKit Cloud: no tenemos Cloud.

## Selected route

Flujo de dos etapas de AGENTS.md. Etapa 1 (`.agent-workflow/`, este scaffold) →
etapa 2 (`openspec/`) para la implementación del harness. El spike de validación
de conversación corre como evidencia de I+D dentro de esta etapa.

## Active gate

Gate de diseño: las decisiones por defecto las fijó el humano (harness en el repo
junto a los tests, conversación sembrada por fixture, WAV pregrabados, vitest,
credenciales explícitas). Falta resolver el sembrado de la conversación y dónde
vive el runner exactamente.
