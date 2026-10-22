# 01 — Research questions (estado actual)

Preguntas sobre el PRESENTE del repo. Nada de elecciones de solución.

| # | Pregunta | Por qué importa | Evidencia a inspeccionar |
| --- | --- | --- | --- |
| RQ1 | ¿Qué dispara hoy el arranque de la sesión de voz en web? | Define cuánto código hay que mover para autoconexión | `apps/nana-wallet/src/features/agent/useLiveVoiceSession.ts`, `routes/index.tsx` |
| RQ2 | ¿Existe ya algún saludo o primer mensaje del agente? | Determina si el saludo es nuevo en back, front o ambos | `src/livekit/create-agent-session.ts`, `src/livekit/worker.ts`, `src/agent/instructions.ts` |
| RQ3 | ¿Qué herramientas financieras tiene hoy el agente? | El usuario pidió "swap": hay que ver qué existe realmente | `src/livekit/realtime-tools/`, `src/agent/wdk-tools.ts` |
| RQ4 | ¿Cómo llega el saldo al front hoy? | Define si el saludo puede leer el saldo sin tool-call | `apps/nana-wallet/src/lib/api.ts`, `src/contracts/http.ts` |
| RQ5 | ¿Qué pasa con el permiso de micrófono y el autoplay de audio? | Autoconexión sin gesto puede fallar en web; hay que saber qué hace hoy | `useLiveVoiceSession.ts`, `voice/livekit-web-client.ts` |
| RQ6 | ¿Qué hace el path nativo (Capacitor)? | Hoy la voz nativa es otro cliente (grabación), no LiveKit | `routes/index.tsx` (rama `isNative`), `voice/recorded-voice-client.ts` |
| RQ7 | ¿El front ya tiene datos de saldo y "chips" de sugerencia? | Reutilizar UI existente vs crear nueva | `routes/index.tsx`, `routes/mi-plata.tsx`, `components/` |
| RQ8 | ¿Hay tests de la pantalla del agente y de la sesión de voz? | Costo de verificación y qué contrato no se puede romper | `features/agent/*.test.tsx` |

## Exclusiones de scope

- No se investiga el flujo de gifts/grants ni notificaciones.
- No se investiga el proveedor realtime más allá de qué configura el primer turno.
