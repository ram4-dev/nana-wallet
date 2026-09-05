# AGENTS.md — Nana Wallet

Instrucciones para agentes de código (Pi, Codex u otros) que trabajen en este repositorio.

## Qué es este proyecto

Nana Wallet es una wallet agéntica argentina para personas mayores y con discapacidad, entregada en el Aleph Hackathon 2026 (WDK Track). El usuario pide acciones en lenguaje cotidiano (texto o voz), revisa un preview claro (red, token, destinatario, importe, fee) y confirma explícitamente antes de mover dinero.

Es un monorepo con dos partes estrictamente separadas:

| Parte | Ubicación | Stack | Rol |
| --- | --- | --- | --- |
| **Backend** | raíz (`src/`) | Node 22, Fastify, LiveKit Agents, Tether WDK/MCP, Supabase, Vitest, Evalite | API HTTP, agente de voz/texto, herramientas WDK (wallet EVM), base de datos |
| **Frontend** | `apps/nana-wallet/` | React 19, TanStack Start/Router/Query, Tailwind 4, shadcn/ui, Capacitor 8, livekit-client, Vitest + Testing Library | App web y mobile (iOS/Android), con MSW para API simulada local |

El front se comunica con el back solo por HTTP (`apps/nana-wallet/src/lib/api.ts`) y se conecta a las rooms de LiveKit con `livekit-client` usando un token que emite el backend. La lógica del agente (STT, LLM, TTS, herramientas WDK) vive íntegramente en el worker backend (`src/livekit/`, `src/agent/`).

## Regla dura: separación front / back

**NUNCA se cruza el límite entre front y back.**

- El código de la raíz (`src/`, `tests/`, `evals/`) NUNCA importa nada de `apps/nana-wallet/`.
- El código de `apps/nana-wallet/` NUNCA importa nada del `src/` de la raíz ni de sus dependencias de Node (`@livekit/agents`, `@tetherto/wdk`, `@huggingface/transformers`, etc.).
- Los tipos compartidos (contrato de API) se duplican deliberadamente: el backend define los suyos y el front los refleja en `apps/nana-wallet/src/lib/api-types.ts`. Si cambiás el contrato HTTP, actualizá ambos lados en el mismo PR.
- Si una feature necesita lógica compartida, duplicala (es aceptable en este repo) o negociá un contrato HTTP explícito. No crees paquetes compartidos ni workspaces sin decisión explícita de la persona que conduce.

## Seguridad de la plata (no negociable)

- El modo por defecto es `WDK_TOOLS_SOURCE=fixture`. Nunca habilites el modo live (`WDK_TOOLS_SOURCE=live`) ni toques seeds, claves privadas ni credenciales.
- Los flujos de pago requieren preview + confirmación explícita con clave de idempotencia. No "simplifiques" ese flujo.
- Un rechazo definitivo y un error de red ambiguo son distintos: nunca informes que una operación falló si no sabemos si se ejecutó.
- Nunca hagas commit de secretos ni valores de entorno.

## Validación obligatoria antes de cada PR

Todo PR debe llegar con esta validación ejecutada y en verde. **GitHub Actions (`.github/workflows/ci.yml`) la verifica por PR**: job de backend (lint, typecheck, tests y evals contra una base Postgres con pgvector levantada con el mismo `compose.yaml` local) y job de frontend (lint, typecheck, tests). El PR no se puede mergear con CI en rojo.

Backend (raíz):

```bash
npm run lint
npm run typecheck
npm test
npm run eval
```

Frontend (`apps/nana-wallet/`):

```bash
npm run lint
npm run typecheck
npm test
```

Reglas:

1. Si tocás solo el front, corre igual la suite del front; si el cambio toca el contrato HTTP, corré también el backend completo.
2. Si tocás el agente, los evals (`npm run eval`) son obligatorios, no opcionales.
3. Si un test o eval falla por tu cambio, no abras el PR: arreglalo primero. Si falla por algo preexistente, documentalo explícitamente en la descripción del PR.
4. Incluí en la descripción del PR el resultado de las validaciones locales (qué comandos corriste y que pasaron); el CI las repite igual.
5. Corré los tests con la base levantada (`docker compose up -d db`) cuando toque código de integración: sin `DATABASE_URL` esos tests se saltean y en CI sí corren.

## Convenciones

- Comandos del backend: `npm run dev`, `npm test`, `npm run test:simulation`, `npm run db:migrate`, `npm run eval`.
- Comandos del front: `npm run dev`, `npm test`, `npm run mobile:sync` (en `apps/nana-wallet/`).
- Los comentarios y UI del front están en español rioplatense; seguí esa convención en cada parte.
- Tests: backend en `tests/{unit,integration,simulation,e2e}`, evals en `evals/`; front colocaliza tests junto al código.

## Dónde encontrar más

- [docs/architecture.md](docs/architecture.md) — arquitectura, límites de evidencia y boundary WDK.
- [docs/api.md](docs/api.md) — contrato HTTP `/v1` (fuente de verdad: `src/contracts/http.ts`).
- [docs/evals.md](docs/evals.md) — evalite, cómo correr y leer los evals del agente.
- [docs/demo-runbook.md](docs/demo-runbook.md) — rehearsel de recipient memory en fixture.
- [docs/local-live-runbook.md](docs/local-live-runbook.md) — integración live completa (wallet WDK local + Supabase).
- [docs/livekit-development-runbook.md](docs/livekit-development-runbook.md) — live voice (LiveKit Cloud + binding Ed25519).
- [docs/create-wallet.md](docs/create-wallet.md) — crear y habilitar la wallet dedicada del agente.
- [docs/observability-proposal.md](docs/observability-proposal.md) — propuesta futura de observabilidad (no implementada).

## Flujo de desarrollo en dos etapas

Para cada feature el repo trabaja en dos etapas, con un límite claro entre **pensar** y **escribir código**.

### Etapa 1 — planificación humana (`.agent-workflow/`)

Antes de escribir código se planifica en `.agent-workflow/`. Es el flujo RPI (intake, research questions, design discussion): el lado humano, el que arranca con la entrada de la idea, arma las preguntas de investigación y discute el enfoque de diseño SIN tocar código. Acá se define el problema y se negocian las decisiones; si la feature no tiene aún un scaffold en `.agent-workflow/`, se arma primero.

### Etapa 2 — implementación (SDD en `openspec/`)

Una vez que el diseño está claro, la implementación va por `openspec/` (SDD): `proposal → spec → design → tasks → apply → verify → archive`. Los artefactos viven en `openspec/changes/<change>/` y el contexto raíz en `openspec/config.yaml`. Cada fase se valida contra la anterior; `apply` escribe código y `verify` chequea el resultado contra la spec.
