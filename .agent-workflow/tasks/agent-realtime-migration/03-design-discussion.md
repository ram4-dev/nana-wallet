# 03 — Design discussion

## Estado actual

- Voz realtime (rama `feat/openai-realtime-poc`): Agent con 2 tools fixture estáticas, sin acceso a wallet/DB/servicio, sin seam de dependencias.
- Servicio de conversación: dueño del invariant financiero (pendingTransfer persistido + claim + índice único + revisions al frontend).
- Frontend: tarjeta Confirm/Cancel desde `conversationState.pendingTransfer`; revisiones por data topic.

## Estado deseado

La voz realtime opera las capacidades reales: balance del provider, contactos de la DB, y transferencias con el MISMO invariant financiero del texto. Nada de lógica de guardas duplicada: los tools de voz son una puerta hacia la maquinaria existente.

## Opciones y tradeoffs

| Decisión | Elegida | Alternativas descartadas | Tradeoff aceptado |
| --- | --- | --- | --- |
| Arquitectura de tools | **Tools como puerta al servicio**: `send_token`/`confirm_transfer` delegan en la maquinaria persistida del servicio (pendingTransfer, claim, revisions), NO reimplementan guardas | portar `buildGuardedTools` a closures con sesión reconstruida; solo botón del frontend | Requiere nuevo seam de sesión por room; a cambio, invariante DB + UI intactos y cero duplicación |
| Seam de sesión | **Tools construidos por conversación en el bind** (`createRealtimeTools({conversationId, wallet, recipientMemory, service, financialTasks, publish})` inyectados al Agent al momento del `bind_conversation`) | tools estáticos con lookup por conversationId en cada call; sesión global | LiveKit permite actualizar tools del Agent; construir por bind da closures correctas por room sin lookups globales |
| Confirmación por voz | **Voz pura: el modelo llama `confirm_transfer` ante "sí, confirmá"**; la tarjeta del frontend sigue apareciendo (dos caminos, un mismo claim en DB) | solo botón; modelo decide solo con frases hardcodeadas | El claim con `previewId` + índice único hace que ambos caminos sean seguros; el tool falla cerrado si no hay preview |
| Direcciones al modelo | **Invariant de privacidad intacto**: los candidates de `search_contacts` no exponen address; el to real viaja solo dentro de la maquinaria (recipientId/version) | exponer address al modelo para que la incluya en el input del tool | Menos "naturalidad" para el modelo; privacidad del address book preservada |
| Balance y contactos | **Reales**: `WalletProvider.getBalance` y `RecipientMemoryService.searchRecipients` (con su clasificación/ambigüedad) | fixtures | Dependencia de DB/WDK en la sesión de voz; misma disponibilidad que la ruta de texto |
| Errores de tools | **Mismos errores tipados** (`confirmation_required`, `recipient_revalidation_required`, `policy_rejected`) + `clarification_required` de contactos; el modelo los narra, no los interpreta | códigos nuevos de voz | El modelo puede explicarlos en español; el frontend/registros comparten contrato |

## Diseño propuesto

### 1. Seam de sesión (`src/livekit/realtime-tools/`)

- Nuevo módulo `createRealtimeTools(deps)` con `deps = { conversationId, wallet, recipientMemory, conversationService, financialTasks, publishRevision }`.
- `create-agent-session.ts` recibe `createTools: (binding) => Tool[]` (o el worker arma las deps y las pasa al bind). El Agent se actualiza con los tools reales al momento del bind (`session.updateTools`/recreación del Agent según API del SDK — a verificar en implementación).
- Instrucciones Nani ampliadas: cuándo llamar cada tool, que no invente direcciones, que ante ambigüedad pregunte, que la confirmación siempre pase por `confirm_transfer`.

### 2. Tools

- `get_balance` → `wallet.getBalance()` (fixture/live). Sin estado.
- `search_contacts` → `recipientMemory.searchRecipients(userId, query)` → lista de candidates (sin address) + `count`/`ambiguous`. Ante ambigüedad el modelo pregunta. **El runtime de recipient memory se construye por binding (`binding.sub`), no reutiliza el singleton de `demoUserId`.**
- `send_token` → flujo de preview del servicio: resuelve recipient (candidates ya confirmados por voz → id/version), `validateWalletTransferPolicy`, persiste `pendingTransfer` + emite revision (la tarjeta aparece) → devuelve `confirmation_required` con el resumen hablado. Errores tipados tal cual.
- `confirm_transfer` → `resolveDecision(confirm)` del servicio (claim + broadcast + finality + revisions). Devuelve receipt o estado (`submitted/uncertain`) para narrar. `cancel_transfer` → `resolveDecision(cancel)`.

### 2.b Correcciones del review adversarial (2026-09-04) — obligatorias

1. **(BLOCKER V2)** No existe entry point de preview reutilizable: `WalletConversationService` solo expone `handleTurn/handleTurnStream/resolveDecision`; `repository.setPendingTransfer` no revalida recipient ni emite revision a `financialTasks.publish`. El Slice 2 DEBE definir primero una función de servicio `previewTransfer(input)` que reuse revalidación + policy + persistencia + publish — no es "reuso puro", es una función nueva dentro del servicio.
2. **(MAJOR V3)** Wiring de memoria roto hoy: `createWorkerDependencies` construye el servicio **sin `memory`** → `isClaimedRecipientValid` devuelve `false` siempre → ninguna transferencia con recipient-versioned broadcastea. Y `getConfiguredRecipientMemoryRuntime()` es singleton de `demoUserId`, no por-binding. Slice 1 debe: construir runtime por `binding.sub` y conectar `memory` en `createWorkerDependencies`.
3. **(MAJOR V6)** Schema del voice `send_token` **preview-only por zod**: sin `dryRun:false`, sin campo `to` (el recipient va por `recipientId`+`recipientVersion` resueltos internamente). El broadcast es EXCLUSIVO de `confirm_transfer`. Enforced en schema, no en instrucciones. (Nota: el fixture actual de `search_contacts` SÍ filtra addresses al modelo — esta migración lo corrige de raíz.)
4. **(MINOR V1)** `confirm_transfer` lee el `previewId` ACTUAL de la preview persistida en cada call (nunca capturado en el bind); drena el `AsyncIterable` de `resolveDecision`; test de preview stale.
5. **(MINOR V5)** Mapear `missing` del claim a `stale_preview` (hoy el servicio lo confunde con `broadcast_in_progress`); TTL o cancelación explícita de previews superados.
6. **(MAJOR V7)** `endLive` con `stale_revision`: retry o exigir estado terminal de la transferencia antes de permitir end-live; garantiza por TEST que el path tool → `financialTasks.publish(state-revision)` emite en preview, claim y finality.

### 3. Revisions y frontend

- Las revisiones salen por el mismo `financialTasks.publish`/data topic actual → la tarjeta Confirm/Cancel sigue funcionando; el usuario puede confirmar por voz O por botón — ambos van al mismo claim en DB.

### 4. Fuera de scope

- `/v1/voice/speak` (ElevenLabs del transporte grabado).
- `get_history`/`list_tokens` como tools de voz (quedan para después si el usuario las pide).
- Cambios de auth/modelo multiusuario.
