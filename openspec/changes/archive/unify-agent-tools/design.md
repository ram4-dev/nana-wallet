# Design: unify-agent-tools

Referencia: `.agent-workflow/tasks/agent-tools-unification/03-design-discussion.md`
(decisiones D1–D8 completas). Este documento registra el diseño técnico vinculante.

## Arquitectura

```
src/agent/definition.ts          (única definición + schemas compartidos)
        │
        ├── toAiSdkTools()                    → texto (AI SDK)  [existe]
        └── toLivekitRealtimeTools()          → voz (llm.tool)  [nuevo]
            └── decoradores voice-only: voiceDecisionGate, speakPreview
```

- `WalletAgentContext` gana campos opcionales voice-only: `voiceService?`,
  `voiceConversations?`, `voiceDecisionGate?`, `speakPreview?`. La definición los
  usa condicionalmente para producir `confirm_transfer`/`cancel_transfer` y para
  el read-back hablado en `send_token`.
- `src/agent/definition.ts` no importa `@livekit/*` (tipos propios definidos allí).
- `src/agent/livekit-adapter.ts` (muerto) se elimina; su lógica de flags/allowlist
  se reencarna en el nuevo adapter cuando aplique.

## Contratos clave

- **send_token compartido**: `z.object({ amount, recipientId, recipientVersion,
  memo? }).strict()`. Texto: resolución de destinatario directo persiste
  recipient versionado antes del preview (ya existe en el path de texto; el modelo
  pasa id/version, nunca dirección). Guardas runtime intactas en
  `buildGuardedTools` para el camino broadcast del texto.
- **network opcional**: `balanceInputSchema.network` pasa a `.optional()` con
  default `arc-testnet` aplicado en el execute de la definición (no en el schema,
  para que el modelo vea la red efectiva en el resultado). `get_address` /
  `get_history` igualan el patrón.
- **Resolución por llamada**: `worker.ts` reemplaza
  `bindLiveKitWalletForUser(..., () => config.network)` por
  `bindWalletForUser(walletForUser, userId)` (sin hint); el resolver elige
  chain family por `query.network` en cada llamada.
- **search_recipients** unificado: la definición ya lo produce; el adapter de voz
  deja de mapear `search_contacts`.

## Adapter realtime

`toLivekitRealtimeTools(definition, context, options?)`:
- mapea `definition.tools(context)` → `llm.tool({ name, description, parameters:
  inputSchema, execute })` con `signal: execution.abortSignal` para tools
  cancellables (mismo conjunto CANCELLABLE que el adapter viejo).
- preserve `RealtimeVoiceToolResult` (contrato del front no cambia).
- los decoradores (gate consume, speakPreview read-back) viven en los `execute`
  de `send_token`/`confirm_transfer`/`cancel_transfer` dentro de la definición,
  condicionados a la presencia del contexto de voz (fail-closed: sin gate, la
  tool de confirmación devuelve `confirmation_required` — nunca confirma).

## Instrucciones realtime

`NANI_REALTIME_INSTRUCTIONS` actualizadas: `search_contacts` → `search_recipients`,
mención de multi-red ("consultá el saldo en la red que te pidan; default Arc") y
sin nombres de tools muertos. El parity test valida que los nombres citados en las
instrucciones existan en la superficie de voz.

## Evals

- `evals/agent/scenarios/` nuevos: tool-selection para las 7 tools; multi-red
  (solana/default/invalid); preview-only text path. Mock-model determinista
  (patrón `MockLanguageModelV3` + `handleMessage` real).
- Parity: `tests/unit/agent-tools-parity.test.ts` (comparación estructural con
  `z.toJSONSchema`) + un eval espejo para que quede en `npm run eval`.
- Limpieza: constants/guards/preview scenarios `sepolia`/`USDT` → producto real;
  `evals/voice/realtime/scenarios.ts` → `search_recipients` + multi-red;
  `eval-fixtures.ts` wallet con ambas redes.
- `docs/evals.md`: documentar gate de release `EVAL_REAL=1` (matrix voz real +
  judge real) y el nuevo set de cobertura CI.

## Test-first map (RED → GREEN por tarea)

1. Paridad test (RED: voz produce search_contacts y get_balance sin network) →
   adapter (GREEN).
2. Multi-red voice: test del worker binding + get_balance con network (RED) →
   binding sin hint + schema opcional (GREEN).
3. send_token strict compartido: test de rechazo `to`/`dryRun` en texto (RED) →
   schema compartido + guardas (GREEN).
4. Evals nuevos (RED donde el mock-model muestra la superficie vieja) → escenarios
   (GREEN).
5. Limpieza legacy (sin RED; validación = suite verde + evals verdes).

## Riesgos

- Regresión del modelo de voz por renombre → instrucciones + matrix release +
  paridad.
- Capacidad de dirección directa en texto → cubierta por resolución versionada;
  escenario eval específico.
- Dependencia circular definition↔livekit → prohibida por spec; verificado en
  paridad test (import estático inspeccionado o lint boundary).
