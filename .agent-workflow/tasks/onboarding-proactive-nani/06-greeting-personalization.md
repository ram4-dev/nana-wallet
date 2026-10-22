# 06 — Slice: personalización del saludo (nombre + idioma)

## Origen

Revisión de los commits `cb5b167` (saludo proactivo) y `922ca4e` (autoconexión +
audio) sobre `main`. El saludo existe y funciona, pero tiene dos huecos contra el
pedido original ("Hola NOMBRE soy nani tu asistente financiera...").

## Hallazgos que esta slice cierra

### H1 — El saludo no dice el nombre

`createAgentSession({ tools })` no recibe nada del usuario y no hay lookup de
`display_name`, así que Nani se presenta sin nombre. El dato ya existe
(`users.display_name`, también en `GET /v1/me`) y `WorkerDependencies` ya tiene
`database`, así que es plumbing, no diseño nuevo.

### H2 — El saldo se lee en inglés dentro de un saludo en español

La persona ahora habla rioplatense, pero el idioma de la conversación arranca en
`'en'` (`007_conversation_language_default.sql`) y `detectConversationLanguage`
sólo cambia con texto **del usuario**. En el primer turno no hay texto del
usuario, así que `resolveConversationLanguage`
(`src/livekit/realtime-tools/create-realtime-tools.ts`) devuelve `'en'` y
`get_balance` entrega `balanceSpoken` en palabras inglesas
("ninety-seven USDC and ninety-nine cents") dentro de un saludo en español.

El path de texto sí persiste el idioma detectado
(`src/conversations/service.ts:387-397`); el path de voz sólo lo lee. Por eso el
idioma se fija al iniciar la sesión de voz, que es donde se conoce la intención:
la persona de voz es español desde el primer turno.

## Decisiones de esta slice

| ID | Decisión | Fuente |
| --- | --- | --- |
| P1 | El nombre sale de `users.display_name` leído por el worker, no del front ni del binding JWT | esta slice |
| P2 | Se establece `language = 'es'` al iniciar la sesión de voz, si no lo está | esta slice |
| P3 | Ambas cosas son best-effort: no pueden romper el bind/start ni el preview de confirmación | esta slice |
| P4 | El nombre es DATO, no instrucción: se sanitiza antes de entrar a las instrucciones del modelo | esta slice |

## Outcome observable

Al iniciar la sesión de voz, el primer turno de Nani:
1. saluda por su nombre cuando `display_name` tiene un nombre válido;
2. saluda sin nombre cuando no lo hay, sin dejar huecos ni comillas vacías;
3. lee el saldo disponible en español, no en inglés.

## Acceptance evidence

- `tests/unit/voice-greeting-context.test.ts` (nuevo): sanitización (nombre válido,
  nulo, vacío, hostil/demasiado largo), idioma `'es'` fijado sólo si difiere,
  repositorio sin `setLanguage`, y que un fallo de lectura de la DB no propague.
- `tests/unit/realtime-agent-session.test.ts` (extendido): la instrucción del
  primer turno incluye el nombre cuando existe, lo omite cuando no, y no inyecta
  un nombre hostil; el saludo sigue siendo at-most-once y con `allowInterruptions`.
- Suites obligatorias de la raíz en verde (`lint`, `typecheck`, `test`).

## No-goals

- No se cambia el contrato HTTP ni el front.
- No se toca el path de texto ni la detección de idioma existente.
- No se implementa swap (sigue fuera, no hay herramienta).
- No se decide acá el destino de `/v1/voice/speak` (hallazgo aparte de S4).

## Resultado (implementado)

- Branch: `feat/greeting-personalization`
- Worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-greeting-personalization`
- Commit: `a875642 feat(agent): greet the user by name and in Spanish in the opening turn`
  (base `7e60978`; sin pushear)
- Archivos: `src/livekit/greeting-context.ts` (nuevo),
  `src/livekit/create-agent-session.ts`, `src/livekit/worker.ts`,
  `tests/unit/voice-greeting-context.test.ts` (nuevo),
  `tests/unit/realtime-agent-session.test.ts`.

### Verificación

| Check | Resultado |
| --- | --- |
| `npx vitest run tests/unit/voice-greeting-context.test.ts tests/unit/realtime-agent-session.test.ts` | PASS — 2 archivos / 27 tests |
| `npx vitest run tests/unit` | PASS — 101 archivos / 774 tests, 1 skip |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm test` (suite completa) | NO VERIFICABLE en este entorno — ver abajo |

`npm test` no se puede cerrar localmente: el único Postgres accesible en
`127.0.0.1:5432` es el del proyecto `nana-privy-impl-*`, con grants que no
corresponden (`permission denied for function users_ensure_for_privy_did`, RLS,
`permission denied to create database`) → 126 fallos que **reproducen idénticos en
el checkout primario sobre `main` limpio**, así que son del entorno y no del
cambio. Sin `DATABASE_URL`, tres archivos de integración se saltan su propio guard
(15 fallos, preexistentes en `origin/main`). El cambio sólo lo importa
`src/livekit/worker.ts` y sus tests, así que ningún test de integración lo toca.

### Límites de esta evidencia

- El comportamiento real de `setLanguage` contra Postgres queda cubierto sólo por
  fakes: no se corrió integración.
- El saludo no se escuchó en una sala (check manual de S1 sigue pendiente).
- El arranque de voz ahora hace hasta dos round-trips de DB antes de construir la
  sesión; best-effort y sin timeout.

## Fuera de esta slice (hallazgos abiertos)

- H3: `AgentScreen.tsx` + su test quedaron huérfanos sin marca de deprecación.
- H4: el saludo no considera una transferencia pendiente (riesgo 4 del outline).
- H5: `generateReply` devuelve `SpeechHandle`, no una Promise: un saludo que falla
  de forma asíncrona no llega a telemetría y el docstring del caller promete lo
  contrario.
