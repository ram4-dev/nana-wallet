# 01 — Research questions

Estado: RQ1–RQ6 y RQ8–RQ9 cerradas con evidencia en `02-research.md`.
RQ7 y RQ10 abiertas: bloquean el outline, no el spike.

| # | Pregunta | Estado | Respuesta |
|---|---|---|---|
| RQ1 | ¿Un cliente `rtc-node` en el host puede intercambiar media con el LiveKit self-hosted en Docker? | **CERRADA** | Sí. 354 frames, 3540 ms, 449 ms al primer frame. |
| RQ2 | ¿Qué necesita el worker para arrancar una sesión? | **CERRADA** | Participante presente + RPC `bind_conversation` con `bindingToken`. El dispatch solo no alcanza. |
| RQ3 | ¿Cómo se emite y verifica el binding token? | **CERRADA** | JWT EdDSA, `iss: nani-api`, `aud: nani-livekit-worker`, `purpose: live_voice_binding`, con `conversationId` y `jti`. Firma `LIVE_VOICE_BINDING_PRIVATE_KEY`, verifica `..._PUBLIC_KEY`. Emisor reusable en `src/auth/live-binding.ts`. |
| RQ4 | ¿Cómo se alinea el puerto del rango RTC con LiveKit para no romper ICE? | **CERRADA** | LiveKit anuncia `rtc.udp_port` **desde su propio archivo de config**, no desde el mapeo de compose. Cada stack aislado necesita su config con rango propio. |
| RQ5 | ¿El aislamiento de `.env` de vitest bloquea las credenciales del harness? | **CERRADA** | Sí. `isolate-provider-env.ts` borra `LIVEKIT_*` y `OPENAI_API_KEY`. El harness debe inyectarlas explícitamente. |
| RQ6 | ¿Cómo se captura el audio del agente y se afirma sobre él? | **CERRADA** | `AudioStream(track)` → frames PCM. Con `TrackKind.KIND_AUDIO` (numérico) como filtro. |
| RQ7 | ¿Qué exige exactamente `gate.bind` para aceptar? | **CERRADA** | Cuatro condiciones. Ver abajo. |
| RQ8 | ¿Puede el caller disparar barge-in de verdad? | **ABIERTA** | El worker registra un segundo RPC, `interrupt_agent`. Hay que ver si el harness debe usarlo o si el barge-in se logra publicando audio encima. |
| RQ6b | ¿Cómo se resuelve el wallet del usuario para el fixture de voz? | **CERRADA** | Sembrando una fila `ready` en `user_wallets` para `(user_id, chain_family='solana')`. `core.wallet` es fail-closed, no un fixture: apagar las claves Privy **no** cae a fixture. Ver `02-research.md` §10. |
| RQ9 | ¿El runner es vitest, evalite, o comando propio? | **DECIDIDA** | vitest (decisión del humano). El harness es un test de sistema, no un eval con score. |
| RQ10 | ¿Cómo se evita que el test se vuelva flaky por tiempos de turno del modelo S2S? | **ABIERTA** | Hay que definir espera por silencio/fin de turno en vez de `sleep` fijo, o los tests van a ser inestables en CI. |

## RQ7 — respuesta detallada

`RoomConversation.bind` (`src/livekit/room-conversation.ts:60`) exige, en orden:

1. **Token válido**: `verifyLiveVoiceBinding` contra `LIVE_VOICE_BINDING_PUBLIC_KEY`.
2. **Identidad coincidente**: si se pasa `participantIdentity`, tiene que ser
   **igual a `binding.sub`**. O sea que el caller debe entrar a la sala **con
   identidad = userId**, no con un nombre libre. Si no,
   `{ok: false, code: "conversation_forbidden"}`.
3. **Conversación existente**: `conversations.get(binding.sub, binding.conversationId)`
   tiene que devolver un snapshot. Si no → `conversation_not_found`. **Esto
   confirma que hace falta sembrar la fila: un `conversationId` inventado no sirve.**
4. **Lease libre**: `acquireLiveLease` tiene que devolver `acquired`. Si hay otra
   sesión viva → `conversation_already_live`.

Fixture mínimo, entonces: un usuario con id conocido, una conversación de ese
usuario con id conocido, sin lease activo, y el token emitido con
`sub = userId` y `conversationId = <ese id>`.
