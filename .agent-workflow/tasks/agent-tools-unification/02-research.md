# 02 — Research findings (evidence)

Respuestas con evidencia de código a las preguntas de `01-research-questions.md`.

## Q1 — Superficies actuales y divergencias

Confirmado en código:

| Tool | Texto (definition.ts) | Voz (create-realtime-tools.ts) | Divergencia |
| --- | --- | --- | --- |
| get_balance | `{network*, token?, wallet?}` | `{}` (sin input) | voz fija `config.network` (arc-testnet) |
| get_networks | `{}` | — | voz no la tiene |
| list_tokens | `{network?}` | — | voz no la tiene |
| get_address | `{network*, wallet?}` | — | voz no la tiene |
| get_history | `{network*, token?, wallet?}` | — | voz no la tiene |
| send_token | `{network*, token*, to*, amount*, wallet*, dryRun*}` | `{amount, recipientId, recipientVersion, memo?}` `.strict()` preview-only | contratos opuestos |
| search_recipients / search_contacts | `search_recipients{query}` | `search_contacts{query}` | nombre distinto, misma función |
| confirm_transfer / cancel_transfer | — | `{}` | voice-only (gate hablado) |
| memory tools (stage/write/user_memory/selected_address) | 4 tools | — | voz no las tiene |

## Q2 — Contrato de `send_token` que gana

Evidencia:
- `wallet-agent.ts:256-356` (`buildGuardedTools`): wrapper que exige preview previo
  (`pendingMatches`), inyecta `previewId` (CAR-006) y revalida destinatario por versión.
  El `send_token` de texto con `dryRun` es la API interna; la llamada con
  `dryRun:false` sin preview matching es rechazada (`confirmation_required`).
- `create-realtime-tools.ts` voice `send_token`: preview-only `.strict()`, delega en
  `service.previewTransfer` y el broadcast pasa por `resolveDecision` (gate hablado).

Decisión: **un solo contrato compartido preview-only** (`amount + recipientId +
recipientVersion + memo?`). El texto conserva su capacidad de dirección directa vía
la resolución de destinatario existente (`search_recipients` + dirección explícita ya
validada por el path de texto); el `dryRun`/`to` libre del texto pasa a ser **código
interno** (service layer), no superficie del modelo. Esto elimina la mayor divergencia
de seguridad y deja a ambos agentes con la misma restricción: ningún modelo inventa
direcciones.

## Q3 — Resolución de wallet multi-red

- `worker.ts:109-115` fija la red al crear la sesión: `bindLiveKitWalletForUser(...,
  () => getWalletAgentConfig().network)` → siempre `arc-testnet`.
- Seam correcto ya existe: `bindWalletForUser(walletForUser, userId)` sin hint
  resuelve chain family por llamada a partir de `query.network`
  (`privy-user-provider.ts:59-76` + `resolve()` sin hint en `bindWalletForUser`).
- Verificado live en el backend container (2026-10-07): resolver sin hint +
  `getBalance({network:'solana-devnet'})` → `0 SOL` de la wallet Solana del usuario;
  `getBalance({network:'arc-testnet'})` → `9.999553 USDC`.

Cambio: las tools compartidas reciben el resolver **sin hint**; la network viene del
input del modelo (opcional en `get_balance`/`get_address`/`get_history`, default
`arc-testnet`).

## Q4 — Adapter LiveKit

**Descubrimiento**: `src/agent/livekit-adapter.ts` ya implementa `toLiveKitTools`
(con `llm.tool()`, flags CANCELLABLE, allowlist) pero es **código muerto**: cero
importers en `src/`, `tests/`, `evals/` (verificado por grep + knip lo lista como
unused file). Fue construido para el path LiveKit chat (no realtime) que nunca se
conectó.

Decisión: reusar ese adapter como base (borrar lo muerto de paso — knip lo señala),
adaptándolo al contexto de voz realtime y al contrato preview-only. El eval
`tool-binding.ts` usa `z.toJSONSchema` para declarar tools al modelo: el adapter
debe exponer los zod schemas para que ese binding siga funcionando.

## Q5 — Decoradores legítimamente voice-only

- `voiceDecisionGate` (evidence-based confirm): tools `confirm_transfer` /
  `cancel_transfer` quedan voice-only por diseño — en texto la confirmación es un
  turno de chat (`confirmation_required` → usuario responde), en voz el gate exige
  decisión hablada tras read-back sin interrupción. Excepción explícita y documentada.
- `speakPreview` (read-back hablado): decorador del flujo preview compartido.
- `balanceSpoken`: ya resuelto por `formatBalanceForAgent(language)` — compartido.

## Q6 — Fixtures/escenarios muertos

- `evals/agent/scenarios/**` usan `sepolia`/`USDT` (demo-legacy) en constants y
  guards. Producto real: `arc-testnet`/`USDC` + `solana-devnet` (privy mode) con
  WDK demo como modo de desarrollo.
- 7 tools de texto sin ningún escenario: `get_networks`, `list_tokens`,
  `get_address`, `get_history`, `search_user_memory`, `stage_user_memory`,
  `write_user_memory`.
- Cero escenarios multi-red (Arc + Solana): el caso que originó este cambio
  ("¿cuánto tengo en solana?" por voz) no está testeado en ningún nivel.

## Q7 — Verdad del set de tools

La lista canónica vive en `createWalletAgentDefinition()`. Parity test propuesto:
`definition.tools(voiceContext).map(t => t.name)` vs las tools producidas por el
adapter de voz, con excepciones declaradas en una constante (`VOICE_ONLY_TOOLS =
['confirm_transfer','cancel_transfer']`). Las instrucciones realtime
(`NANI_REALTIME_INSTRUCTIONS`) se generan/validan contra la misma lista.

## Hallazgos adicionales

- `evals/voice/realtime/tool-binding.ts` ya implementa el binding genérico
  (zod → JSON schema + execute con validación estricta): el eval real podrá probar
  las tools unificadas sin duplicación.
- knip reporta 89 unused files (config mal scopeada para apps/) — issue separado;
  no bloquea este cambio pero se anota para el pase de higiene.
