# 04 — Structure outline

Vertical slices sobre la rama `feat/openai-realtime-poc` (acumulativa). Cada slice se verifica antes del siguiente.

## Estado de implementación

- **Slice 1 ✓** (2026-09-04): seam por binding (`createRealtimeTools` con `userId` de `binding.sub`), `memory` conectado en worker deps (V3), tools de lectura reales (balance provider + contacts DB con strip explícito de address/userId), fixture file eliminado. 277 tests, typechecks OK.
- **Slice 2 ✓** (2026-09-04): `previewTransfer` como entry point del servicio (V2), `send_token` preview-only `.strict()` por zod sin `dryRun` ni `to` (V6), `confirm_transfer`/`cancel_transfer` leyendo `previewId` vivo por call (V1), mapeo `stale_preview` (V5), race de claim doble contra Postgres real como integration test DB-gated (V8.5), revisions tool→`financialTasks.publish` cubiertas por test (V8.4). Per-binding `voiceService` en el worker (memoria scoped a binding.sub, repository/wallet/financialTasks compartidos → el claim DB es el único árbitro). 289 tests, typechecks OK.
- **Slice 3** — smoke live pendiente (usuario). V7 endLive: el gate backend ya existe (409 `unresolved_financial_work` / `stale_revision`); el retry/refresh frontend queda como follow-up fuera de este task.

## Slice 1 — Seam de sesión, wiring de memoria y tools de lectura reales

- **Outcome:** `src/livekit/realtime-tools/createRealtimeTools(deps)` con `get_balance` → `WalletProvider.getBalance` (fixture/live según env) y `search_contacts` → `RecipientMemoryService.searchRecipients` (candidates sin address, con `count`/`ambiguous`). Los tools se inyectan al Agent en el bind (SDK 1.7.1: `new Agent({ tools })` antes de `session.start`; `Agent.updateTools` como fallback — verificado factible). Fixture file eliminado. **Además (V3): runtime de recipient memory por `binding.sub` (no singleton demoUserId) y `memory` conectado en `createWorkerDependencies` → `createWalletConversationService`.** Instrucciones Nani actualizadas.
- **Files:** `src/livekit/realtime-tools/**`, `src/livekit/create-agent-session.ts`, `src/livekit/worker.ts`, `src/runtime/dependencies.ts`.
- **Automated checks:** tests de tools con provider/recipientMemory mockeados (balance fixture vs live selector, contacts ambiguos → `ambiguous:true` y SIN address en el payload); test de tenant: runtime por binding.sub ≠ demoUserId; suite completa verde; typecheck doble.
- **E2E/real-route:** smoke manual: "¿cuánto tengo?" devuelve el balance real del provider; "¿le mando a Lucas?" devuelve los contactos reales de la DB.
- **Stop condition:** lecturas reales en vivo + suite verde.

## Slice 2 — Flujo financiero por voz (preview + confirm/cancel)

- **Outcome:** **Nueva función de servicio `previewTransfer(input)`** (V2: revalidación de recipient + policy + persistencia + `financialTasks.publish(state-revision)` — la maquinaria hoy no existe como entry point). `send_token` **preview-only por zod**: sin `dryRun:false`, sin `to` libre — recipient por `recipientId`+`recipientVersion` (V6). `confirm_transfer`/`cancel_transfer` → `resolveDecision` del servicio leyendo el `previewId` actual por call (V1). Mapeo `stale_preview` para claims sobre previews superados (V5). La tarjeta Confirm/Cancel del frontend funciona durante el flujo por voz.
- **Files:** `src/conversations/service.ts` (entry point de preview + mapeo de errores), `src/livekit/realtime-tools/**`, tests.
- **Automated checks:** guardas portadas: broadcast sin preview → falla; doble confirmación → segunda falla por claim (test de concurrencia real contra DB claim, no mock — V8.5); `policy_rejected` en live con cap/allowlist; recipient revalidado por versión (con y sin memory — V3); `send_token(dryRun:false)` y `to` arbitrario RECHAZADOS por schema (V6); previewId stale → `stale_preview` (V1); tool → `financialTasks.publish` emite en preview/claim/finality (V8.4); `endLive` retry sobre `stale_revision` o gate de estado terminal (V7).
- **E2E/real-route:** smoke en fixture mode: "mandale 10 USDT a [contacto real]" → preview hablado + tarjeta en pantalla → "confirmá" → receipt hablado; cancelación por voz; confirmación por botón durante el flujo de voz (mismo claim).
- **Stop condition:** flujo completo por voz en fixture mode + suite verde.

## Slice 3 — Cierre de migración

- **Outcome:** docs actualizados (runbook/architecture: la voz opera wallet real por function calling con invariant del servicio), task cerrado con resultados. Limpieza de referencias a fixtures en docs/comentarios.
- **Stop condition:** docs consistentes + suite verde + smoke final.

## Riesgos

- API del SDK para actualizar tools del Agent post-bind (verificar en Slice 1; fallback: Agent recreado con tools antes de `session.start`, ya que el bind ocurre antes de arrancar la sesión).
- El modelo puede intentar inventar parámetros (direcciones/amounts raros): las guardas del servicio y la validación de schema fallan cerrado — cubierto por tests del Slice 2.
- `resolveDecision` y el claim no fueron diseñados para ser llamados concurrentes desde HTTP y voz: el índice único + claim es el árbitro (verificar en tests de Slice 2).
