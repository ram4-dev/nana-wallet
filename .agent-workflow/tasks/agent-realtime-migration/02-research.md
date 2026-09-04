# 02 — Research

## Hallazgos del scout (2026-09-04)

### Guardas y estado (R1)

- `buildGuardedTools` (`src/agent/wallet-agent.ts:389`): valida policy live (`validateLiveTransferPolicy`: cap `WDK_MAX_TRANSFER_AMOUNT`, allowlist `WDK_ALLOWED_RECIPIENTS`, wallet/network/token/amount exactos), revalida recipient por versión, y en broadcast exige `pendingMatches(session, input)` contra `session.pendingTransfer`.
- `runFinancialTransfer` (`service.ts`): `validateWalletTransferPolicy` → `isClaimedRecipientValid` → `wallet.broadcastTransfer` → manejo `not_dispatched/uncertain/submitted` → `markTransferSubmitted` → `waitForFinality` → `confirmed/reverted/receipt_invalid`. Reconciliación por evidencia, nunca replay.
- Confirm/cancel: `resolveDecision(confirm|cancel)` en el servicio, con `claimPendingTransfer` + `previewId` + índice único parcial (invariante DB).

### Lecturas reutilizables (R2)

- `WalletProvider.getBalance` / `listTokens` / `getAddress` / `getHistory` — callable directo, ya lo usan los endpoints HTTP de lectura. Fixture y WDK live comparten interfaz.

### Contactos (R3)

- `RecipientMemoryService.searchRecipients` → `classifyRecipientCandidates`: resuelto único / `clarification_required` (multiples exact-name, o score < threshold 0.78, o gap < margin 0.08). Embeddings pgvector + bonus exact-name.
- **Invariant de privacidad**: `RecipientCandidate` no incluye `address` — la dirección solo se obtiene vía `getRecipientForVersion` tras selección confirmada.

### Frontend (R4)

- Tarjeta Confirm/Cancel se renderiza desde `conversationState.pendingTransfer` (GET con ETag + revision monotónica). Voz: revisiones por data topic `conversation_state_changed` + polling 750ms en working/verifying.
- Consecuencia de diseño: cualquier tool financiera de voz debe pasar por la misma persistencia (`setPendingTransfer`/`claimPendingTransfer`/`markTransferSubmitted`) y emitir revisions; NO puede mantener estado en memoria de sesión del modelo.

### Estado realtime actual (R5, corregido)

- Tras la promoción: `Agent{instructions, tools:[get_balance, search_contacts fixtures]}` en `create-agent-session.ts`; sin seam de inyección de dependencias por conversación; el worker tiene `conversationService`/`financialTasks` a mano en `WorkerDependencies`.

## Contradicciones y gaps

- El scout recomendó "no declarar function tools y seguir por texto" — eso era válido para el pipeline viejo, donde la voz ERA texto. Hoy la voz es realtime speech-to-speech: la decisión correcta es portar los tools con la maquinaria del servicio detrás (persistencia + invariante DB), no duplicar guardas.
- Falta el seam: los tools del Agent se crean en `create-agent-session` (scope estático) pero necesitan `wallet`, `recipientMemory`, y acceso a la sesión de la conversación (per-room). `RoomConversation`/`worker` ya tienen `conversationId` — el seam natural es construir los tools por sesión en el momento del bind, no al crear la AgentSession.
- Los phrasings de confirmación (`CONFIRM_PHRASES`/`isConfirmation`) son del servicio; en realtime el modelo interpreta lenguaje natural — el tool `confirm_transfer` debe exigir que exista un `pendingTransfer` claimed-able y fallar cerrado si no.

## Gaps restantes

- Ninguno bloqueante para diseñar. Detalle de API de LiveKit para re-crear tools por sesión (destructuring del Agent actual) se resuelve en implementación.
