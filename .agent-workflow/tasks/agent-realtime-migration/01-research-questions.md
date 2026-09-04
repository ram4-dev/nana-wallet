# 01 — Research questions

## Current-state questions

### Answered by repo scan (2026-09-04, scout + corrección de §6 sobre el worktree POC)

- **R1 — ¿Dónde viven las guardas financieras?**
  Dos capas: `buildGuardedTools` (`src/agent/wallet-agent.ts:389`) con errores tipados (`confirmation_required | recipient_revalidation_required | policy_rejected`), y `runFinancialTransfer` en `src/conversations/service.ts` (valida policy + claim + broadcast + finality). El estado preview→confirm es `session.pendingTransfer` (network/token/to/amount/wallet/preview/recipientId/version) + `claimPendingTransfer` con `previewId` + índice único parcial `conversation_one_active_transfer_idx` (una transferencia activa por conversación). **El invariant vive en el repositorio, no en el tool.**
- **R2 — ¿El balance es callable fuera del LLM?**
  Sí: `WalletProvider.getBalance` (fixture o WDK live vía `callWdkTool`) — los endpoints de lectura `GET /v1/wallet/*` ya lo usan directo.
- **R3 — ¿Qué hay de contactos en DB?**
  `public.recipients` (id, user_id, name, normalized_name, address, version, status, embedding vector(384)) + `user_memories`. Búsqueda: `RecipientMemoryService.searchRecipients` con clasificación (`classifyRecipientCandidates`): exact-name → resuelto; similaridad coseno + bonus 0.15; umbrales 0.78/0.08 → `clarification_required` si ambiguo. **Los candidates NO exponen address por diseño** (la dirección se revela solo tras selección/confirmación).
- **R4 — ¿Qué espera el frontend?**
  `AgentScreen` renderiza la tarjeta Confirm/Cancel desde `conversationState.pendingTransfer` (siempre, incluso en liveMode). Las revisiones llegan por data topic `conversation_state_changed` → refetch. Si un tool de voz bypassara el servicio: sin `pendingTransfer` → sin tarjeta → sin end-live warning de trabajo financiero en vuelo. **Cualquier flujo financiero por voz debe persistir pendingTransfer + emitir revisions.**
- **R5 — ¿Estado actual del realtime tras la promoción?**
  (Corrección del scout: su §6 leyó el worktree viejo.) En `feat/openai-realtime-poc`: `create-agent-session.ts` compone siempre la sesión realtime con `Agent{instructions, tools:[get_balance, search_contacts fixtures]}`; `realtime-fixtures.ts` + `realtime-latency-logger.ts` existen; el servicio NO participa en los turnos de voz. **No hay seam de sesión/dependencias para tools con estado.**

### Open — decisión de producto (para design)

- **R6 — ¿Cómo confirma el usuario por voz?** Opciones: (a) el modelo llama `confirm_transfer` cuando el usuario dice "sí, confirmá" (voz pura, tarjeta del frontend sigue apareciendo como respaldo visual); (b) solo el botón del frontend confirma (voz solo preview). Tradeoff: (a) mantiene la promesa "la voz hace todo", requiere detección de intención de confirmación robusta.
- **R7 — ¿search_contacts revela direcciones?** Los candidates no exponen address por diseño (privacidad del modelo). Recomendado: los tools de voz respetan ese invariant — selección por id/nombre resuelto, la dirección viaja solo dentro de la maquinaria del servicio.

## Scope exclusions

- No se toca `/v1/voice/speak` (transporte grabado, ElevenLabs) — decisión separada.
- No se cambia el flujo de texto.
- Sin migraciones nuevas salvo que el modelo de contactos lo exija (no parece).
