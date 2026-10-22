# 03 — Design discussion

## El problema

No hay ninguna prueba que ejecute el camino real por el que pasa una persona que
habla con Nani. Los tres candidatos actuales miden otra cosa:

| Artefacto | Qué mide realmente |
|---|---|
| `tests/e2e/livekit-smoke.e2e.test.ts` | que la sala se crea y el dispatch devuelve id |
| `tests/simulation/livekit-voice.simulation.test.ts` | una máquina de estados sin LiveKit |
| `evals/voice/realtime/*` | el modelo realtime, hablándole directo a OpenAI |

Ninguna entra a la sala, y ninguna pasa por el worker.

## Las tres capas de un test de voz

Conviene separarlas explícitamente porque se confunden:

1. **Modelo** (ya cubierta): ¿el S2S entiende y responde? → `evals/voice/realtime`.
2. **Sistema** (este trabajo): ¿el worker arranca con un binding real, la sala
   transporta audio en las dos direcciones, los tools ejecutan contra el backend
   real, y la conversación termina como debe?
3. **Producto** (sin cubrir, fuera de scope): ¿una persona de 75 años puede
   completar una transferencia sola?

Este diseño ataca la capa 2.

## Forma del harness

Un **caller simulado del host** con `@livekit/rtc-node`, orquestado por vitest:

```
test (vitest)
  │
  ├─ 1. siembra la conversación en la DB e2e (fixture)
  ├─ 2. crea la sala + dispatch("nani-agent")   [livekit-server-sdk]
  ├─ 3. entra como participante                 [rtc-node]
  ├─ 4. emite el binding token                  [src/auth/live-binding.ts]
  ├─ 5. invoca RPC bind_conversation            [rtc-node performRpc]
  ├─ 6. recibe el saludo de Nani en audio       [AudioStream → WAV]
  ├─ 7. publica el turno de usuario (WAV)       [AudioSource]
  ├─ 8. captura la respuesta de Nani            [AudioStream → WAV]
  └─ 9. afirma: audio recibido, duración, y el estado final del backend
```

## Decisiones

Las marcadas **[humano]** las fijó ramiro; no se reabren sin evidencia.

| Decisión | Elección | Motivo |
|---|---|---|
| Ubicación | `tests/e2e/voice-room/` junto a los tests existentes **[humano]** | El harness es un test de sistema, no un eval con score. |
| Runner | vitest **[humano]** | Ya es el runner del repo; hereda el aislamiento de `.env`. |
| Estado inicial | conversación sembrada en la DB e2e por fixture **[humano]** | El gate liga contra `conversationId`; sin fila no hay binding. |
| Audio del caller | WAV pregrabados por turno **[humano]** | Audio determinístico → expectativa determinística. Es lo único que prueba si el modelo *escucha* "veinticinco" y no "25". |
| TTS en runtime | solo como opción, no default **[humano]** | Flexible pero no reproducible y con costo por corrida. |
| Credenciales | `LIVEKIT_*` inyectadas explícitamente **[humano]** | El aislamiento las borra; inyectarlas es la forma correcta, no un workaround. |
| Wallet | fixture, `WDK_TOOLS_SOURCE` sin tocar | AGENTS.md lo manda; el harness mide, nunca habilita. |
| Stack | aislado (`nana-e2e`), no reusar otros | No interfiere con `nana-privy-impl` ni `nana-real`. |

## Afirmaciones: qué es aserto y qué es evidencia

Separación deliberada para que el test no sea frágil:

- **Asertos duros (el test falla):** Nani emitió audio; el audio dura más de un
  mínimo; el worker resolvió el binding (`{ok: true}`); el estado final del backend
  coincide con lo esperado para el escenario.
- **Evidencia (se persiste, no falla):** audio de ambos lados en WAV, transcript
  si está disponible, latencias (TTFA, duración del turno).

Esto deja el test binario donde importa y observacional donde el modelo tiene
varianza.

## Alternativas descartadas

- **Agent Simulations de LiveKit**: exige LiveKit Cloud y corre en Cloud. No
  tenemos Cloud (self-hosted en Docker). Descartada con evidencia.
- **`livekit-agent-simulator` (`lks`)**: soporta self-hosted y trae log forense y
  `compare --baseline`, pero es v0.1.0, un solo maintainer, Python, y necesita una
  key de Gemini/OpenAI. Se puede reconsiderar si el harness propio se vuelve caro.
- **Delegar en `evals/voice/realtime/`**: mide la capa de modelo, no la de sistema.
- **Texto con `session.run({userInput})`**: para un agente S2S saltea el audio.
  No es e2e de voz.

## Riesgos

| Riesgo | Mitigación |
|---|---|
| Flakiness por tiempos del S2S | Esperar fin de turno, nunca `sleep` fijo (RQ10). |
| El test se saltea en silencio sin credenciales | Fallar explícito, no `skipIf` mudo. |
| Fuga de credenciales live al harness | El stack e2e no lee `PRIVY_*`; `.env` está gitignored. |
| CI sin el stack | Fuera de scope; se documenta como test local opt-in. |
| Deriva entre test y worker real | El harness usa el worker real, no un doble. Es el punto. |

## Abierto antes de implementar

- **RQ7**: qué exige `gate.bind` exactamente. Define cuánto fixture hace falta.
- **RQ8**: si el barge-in se hace por RPC `interrupt_agent` o publicando encima.
