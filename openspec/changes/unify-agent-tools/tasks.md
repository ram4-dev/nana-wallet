# Tasks: unify-agent-tools

Fases con validación contra la spec (`specs/unified-agent-tools/spec.md`).
Strict TDD: RED antes de cada comportamiento nuevo; `npm test` + `npm run
typecheck` por tarea.

## Phase 1 — Paridad estructural (foundation)

- [ ] 1.1 Test RED: `tests/unit/agent-tools-parity.test.ts` — nombres(texto) vs
      nombres(voz): expectiva de igualdad salvo `VOICE_ONLY_TOOLS`; falla con la
      superficie actual (`search_contacts`, `get_balance{}`).
- [ ] 1.2 Adapter `src/agent/livekit-realtime-adapter.ts`
      (`toLivekitRealtimeTools`) consumiendo la definición; contexto voice-only
      opcional en `WalletAgentContext`; flags cancellables; `signal` propagation.
- [ ] 1.3 Definition: producir `confirm_transfer`/`cancel_transfer` solo con
      contexto de voz (gate), y `send_token` con read-back hablado cuando
      `speakPreview` exista. Test: sin contexto de voz esas tools no existen.
- [ ] 1.4 Borrar `src/agent/livekit-adapter.ts` (muerto). Parity GREEN.
- [ ] 1.5 Boundary check: `definition.ts` no importa `@livekit/*` (test o lint).

## Phase 2 — Contrato send_token compartido

- [ ] 2.1 Test RED: schema compartido rechaza `to`/`dryRun`/`network`/`token`/
      `wallet` desde el modelo (texto hoy los acepta).
- [ ] 2.2 `sendTokenInputSchema` → `{amount, recipientId, recipientVersion,
      memo?}` `.strict()`; el path de texto resuelve destinatario versionado
      antes del preview (service layer); guardas `buildGuardedTools` intactas.
- [ ] 2.3 Test GREEN + escenario eval de dirección directa vía resolución
      versionada (texto).

## Phase 3 — Multi-red por llamada

- [ ] 3.1 Test RED: voz — `get_balance{network:'solana-devnet'}` resuelve la
      wallet Solana del usuario (worker binding sin hint; resolver por llamada).
- [ ] 3.2 `worker.ts`: reemplazar binding fijo por `bindWalletForUser` sin hint.
- [ ] 3.3 Definition: `network` opcional (default `arc-testnet`) en
      `get_balance`/`get_address`/`get_history`; invalid network → error tipado.
- [ ] 3.4 `list_tokens`/`get_networks` disponibles en voz (paridad ya lo exige);
      instrucciones realtime actualizadas (`search_recipients`, multi-red).

## Phase 4 — Evals nivel 1 + limpieza legacy

- [ ] 4.1 Escenarios tool-selection para `get_networks`, `list_tokens`,
      `get_address`, `get_history`, `search_user_memory`, `stage_user_memory`,
      `write_user_memory` (mock-model determinista).
- [ ] 4.2 Escenarios multi-red (solana / default / invalid) y preview-only text
      path; narración sin internals (rubric).
- [ ] 4.3 Parity eval espejo del test unitario en `npm run eval`.
- [ ] 4.4 Limpieza: `evals/agent/scenarios/*` sepolia/USDT → producto real;
      `evals/voice/realtime/scenarios.ts` `search_contacts` →
      `search_recipients` + multi-red; `eval-fixtures.ts` wallet dual-network.
- [ ] 4.5 `docs/evals.md`: cobertura CI vs release gate (`EVAL_REAL=1`).

## Phase 5 — Verificación y entrega

- [ ] 5.1 Matriz completa: backend lint/typecheck/test/build + `npm run eval`
      verde; suite de voz/realtime existente sin regresión.
- [ ] 5.2 Spec check contra `specs/unified-agent-tools/spec.md` (cada Requirement
      con su escenario evidenciado).
- [ ] 5.3 PR squash a `main`; CI (backend + frontend) en verde.
