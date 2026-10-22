# 00 — Intake: Onboarding proactivo de Nani

## Outcome

Al entrar a la app (ruta `/`), la conversación de voz con Nani arranca sin que el
usuario tenga que apretar el avatar: Nani se presenta (quién es, qué hace), lee el
saldo disponible y ofrece opciones concretas (ver saldo, transferir, etc.) que el
usuario puede elegir hablando o tocando.

## Acceptance evidence (borrador, se confirma en diseño)

- Entrar a `/` en web dispara la conexión a LiveKit y Nani habla primero.
- El primer mensaje de Nani contiene: presentación + saldo + al menos 2 opciones
  accionables.
- El usuario puede responder por voz o por chips/atajos sin escribir.
- Si el micrófono o el audio fallan, la UI degrada a texto sin bloquear la app.
- Suites del front en verde (`npm run lint`, `npm run typecheck`, `npm test` en
  `apps/nana-wallet/`); backend completo si el cambio toca el contrato HTTP.

## Granted authority

- Exploración read-only del repo: granted.
- Escritura de artefactos de planificación en `.agent-workflow/`: granted.
- Mutación de código fuente: NOT granted (requiere aprobación del gate de diseño).

## Read scope

- `apps/nana-wallet/src/routes/index.tsx`
- `apps/nana-wallet/src/features/agent/**` (hook, reducer, clientes de voz)
- `apps/nana-wallet/src/lib/api.ts` (endpoints de conversación y voz)
- `src/livekit/**` (worker, create-agent-session, room-token)
- `src/agent/instructions.ts` (persona y reglas de Nani)
- `docs/api.md`, `docs/livekit-development-runbook.md`

## Write scope

- `.agent-workflow/tasks/onboarding-proactive-nani/**` únicamente.

## Non-goals (borrador)

- No cambiar el flujo de preview + confirmación de transferencias.
- No habilitar `WDK_TOOLS_SOURCE=live` ni tocar credenciales.
- No crear paquetes compartidos ni cruzar el límite front/back.
- No introducir "swap" si no existe la herramienta correspondiente en el agente
  (decisión de alcance pendiente).

## Selected route

RPI (`$humanlayer-rpi-workflow`). Motivo: hay estado actual que investigar
(cómo arranca hoy la sesión de voz) y una discusión de diseño con decisiones de
producto (autoconexión, quién genera el saludo, opciones ofrecidas) antes de tocar
código.

## Active gate

Research questions → scope cubre el estado actual desconocido.

## Approval record

```markdown
Gate ID: onboarding-proactive-nani/design
Decision / allowed mutation: aprobar el diseño de la discusión 03
Explicit exclusions: toda mutación de código fuente
Owning artifact / revision or hash: 03-design-discussion.md (sin revisión aún)
Decision owner: Ramiro
Approved by / trusted identity: —
Approved at: —
Status: proposed
Invalidated by: —
```
