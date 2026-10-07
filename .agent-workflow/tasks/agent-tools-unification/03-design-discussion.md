# 03 — Design discussion

Decisión de diseño basada en `02-research.md`. Autorizada por el owner
(2026-10-07): "total libertad… hasta que quede todo funcionando".

## D1 — Una definición neutral, dos adapters

Single source of truth: `createWalletAgentDefinition()` en `src/agent/definition.ts`.

- `toAiSdkTools(definition, context)` (existe) → agente de texto.
- `toLivekitRealtimeTools(definition, voiceContext)` (nuevo, base en el adapter
  muerto `src/agent/livekit-adapter.ts` que se borra) → agente de voz, produciendo
  `llm.tool()` de `@livekit/agents` con `parameters` = zod schema.

Contexto de voz (`WalletAgentContext` extendido con campos voice-only opcionales:
`service`, `conversations`, `voiceDecisionGate`, `speakPreview`). Los decoradores
de voz viven DENTRO de la definición condicionados a la presencia de esos campos —
así la definición sigue siendo una y la paridad es estructural, no una lista copiada.

## D2 — Contrato compartido preview-only para send_token

- Schema compartido: `{ amount, recipientId, recipientVersion, memo? }` `.strict()`.
  Ni texto ni voz exponen `to`/`network`/`token`/`wallet`/`dryRun` al modelo.
- La red/token/dirección los resuelve el service layer a partir del destinatario
  versionado (ya existe: `service.previewTransfer` resuelve network + token por
  contacto; el texto directo con address se maneja en la resolución de destinatario
  por texto, que persiste y versiona el recipient antes del preview).
- `buildGuardedTools` conserva las guardas runtime (pendingMatches, previewId,
  idempotency) para el path de texto; la voz llega por `service.previewTransfer` +
  gate. Mismas reglas, un solo contrato de modelo.

## D3 — Multi-red: network en el input, wallet por llamada

- `get_balance` / `get_address` / `get_history`: `network` opcional (default
  `arc-testnet`), `token` opcional.
- `get_networks` y `list_tokens` pasan a estar disponibles en voz también.
- El binding de voz deja de fijar la red: el worker pasa
  `bindWalletForUser(walletForUser, userId)` (sin hint) y cada tool resuelve el
  chain family desde la network pedida (`walletChainFamilyForNetwork`).
- Fail-closed: network no soportada → `wallet_config_error` (ya tipado) — el modelo
  lo narra, no inventa.

## D4 — Naming unificado: search_recipients

La tool compartida se llama `search_recipients` (el nombre de texto, más preciso).
El nombre `search_contacts` desaparece de la superficie; las instrucciones realtime
y los evals se actualizan. Riesgo de regresión de comportamiento del modelo de voz:
mitigado por la matrix real (`EVAL_REAL=1`) y las instrucciones actualizadas.

## D5 — Paridad estructural

- `VOICE_ONLY_TOOLS = ['confirm_transfer','cancel_transfer']` única excepción
  declarada (gate hablado — D5 en 02-research).
- Test de paridad (`tests/unit/agent-tools-parity.test.ts`):
  1. nombres(texto) == nombres(voz) − VOICE_ONLY_TOOLS
  2. por cada tool compartida: description idéntica y shape de schema idéntico
     (comparando `z.toJSONSchema`).
  3. `NANI_REALTIME_INSTRUCTIONS` menciona exactamente las tools de voz producidas.
- `TEXT_ONLY_TOOLS` debe quedar vacío: si algún día hay una, la constante la declara
  y el test la verifica explícitamente (sin excepciones silenciosas).

## D6 — Evals nivel 1 (CI, determinista, sin red)

Nuevos escenarios con `MockLanguageModelV3` (patrón existente):

1. **Tools hoy sin cobertura** (texto): `get_networks`, `list_tokens`,
   `get_address`, `get_history`, `search_user_memory`, `stage_user_memory`,
   `write_user_memory` — selección correcta de tool y parámetros, y narración sin
   filtrar internals (rubric de `conversational-quality`).
2. **Multi-red**: "¿cuánto tengo en solana?" → `get_balance{network:'solana-devnet'}`;
   "¿cuánto tengo?" sin red → default `arc-testnet`; network inválida → narración del
   error tipado sin inventar datos.
3. **Preview-only en texto**: el modelo ya no puede llamar `send_token` con
   `dryRun`/`to` — escenario que verifica la selección del camino
   search → (stage) → send_token{amount, recipientId, recipientVersion}.
4. **Voz (offline)**: los decoradores de voz (`voiceDecisionGate`, speakPreview)
   ya tienen tests unitarios; se agregan los casos multi-red del D3 al test del
   adapter realtime.

## D7 — Limpieza eval legacy

- `evals/agent/scenarios/constants.ts` y guard/preview scenarios: migrar
  `sepolia`/`USDT` → `arc-testnet`/`USDC` (o `solana-devnet`/`SOL` donde el escenario
  lo pida), manteniendo la cobertura semántica.
- `evals/voice/realtime/scenarios.ts`: `search_contacts` → `search_recipients`;
  matrix alineada a la superficie unificada; fixture wallet con ambas redes.
- Los evals `EVAL_REAL=1` (matrix real + judge real) quedan documentados como gate
  de release en `docs/evals.md`, fuera de CI.

## D8 — Higiene asociada (acotada)

- Borrar `src/agent/livekit-adapter.ts` (código muerto, knip) — su lógica útil se
  reencarna en el adapter realtime.
- No tocar knip config (89 falsos positivos de apps/) — issue separado, anotado.

## Riesgos y mitigaciones

| Riesgo | Mitigación |
| --- | --- |
| Regresión del modelo de voz por cambio de nombre de tool | instrucciones actualizadas + matrix real en release + paridad test |
| El modelo de texto pierde capacidad de dirección directa | la resolución de destinatario por texto persiste dirección versionada antes del preview; escenario eval lo cubre |
| Contexto de voz introduce dependencia de livekit en definition.ts | la definición solo conoce tipos abstractos (gate/service via tipos propios en definition); livekit importa definition, nunca al revés |
| Compatibilidad frontend | contratos de tool result no cambian (RealtimeVoiceToolResult sigue); front no se toca |

## Estado

APPROBADA (owner, 2026-10-07, autoridad total delegada). Siguiente: openspec change
`unify-agent-tools` (proposal → spec → design → tasks → apply → verify).
