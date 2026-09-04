# 00 — Intake

## Outcome

Completar la migración a OpenAI Realtime: el agente de voz realtime deja de usar fixtures y opera las capacidades reales de Nani por function calling — balance real del wallet provider, contactos reales de la DB, y el flujo financiero (`send_token`) con las guardas preview→confirm portadas a tools del agente realtime. Objetivo final: la voz hace todo lo que hacía la ruta de texto, con OpenAI Realtime como único motor de voz.

## Acceptance evidence (provisional)

- `get_balance` consulta el wallet provider real (fixture/live según `WDK_TOOLS_SOURCE`), no datos estáticos.
- `search_contacts` consulta la DB real (contactos/recipient memory de Supabase).
- Pedir una transferencia por voz produce el mismo contrato de guardas que el texto: preview obligatorio, `confirmation_required`, `policy_rejected`, revalidación de destinatario; el broadcast solo ocurre tras confirmación explícita.
- El transcript/estado de la conversación refleja los turnos de tool (comparabilidad con la ruta de texto).
- Suite de tests verde con cobertura de las guardas portadas.

## Granted authority

- Read: entire repository, docs, supabase migrations.
- Write (planning artifacts): `.agent-workflow/tasks/agent-realtime-migration/`.
- Write (implementation): NOT yet granted — bound to design approval and structure outline gates.

## Read scope

- `src/agent/wallet-agent.ts` (guardas, tools, handleTurnStream), `src/conversations/service.ts`, `src/wallet/`, `src/livekit/`
- `supabase/migrations/` (modelo de contactos/recipient memory), `src/memory/`
- `apps/nana-wallet/src/features/agent/voice/` (qué espera el frontend del flujo financiero)
- `docs/wdk-agent-development-plan.md`

## Write scope (implementation, tentative until design approval)

- `src/livekit/realtime-fixtures.ts` → `src/livekit/realtime-tools/` (tools reales)
- Posibles seams pequeños en `src/agent/` para reusar guardas/provider sin duplicar
- Migraciones/supabase solo si el modelo de contactos lo exige (evitar)

## Non-goals (provisional)

- No migrar `/v1/voice/speak` del transporte grabado (queda ElevenLabs; decisión separada).
- No tocar el transporte grabado ni el flujo de texto.
- Sin cambios de frontend salvo los que exija el flujo de confirmación por voz.

## Selected route

RPI workflow (misma convención). Current phase: intake → research questions.

## Active gate

Research gate: mapear la superficie real del servicio financiero y las guardas antes de diseñar el port a function calling.
