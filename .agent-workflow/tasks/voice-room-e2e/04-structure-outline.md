# 04 — Structure outline

Slices verticales. Cada una tiene resultado observable, checks y stop condition.
Cada slice se verifica antes de arrancar la siguiente.

---

## Slice 1 — Resolver RQ7: qué exige `gate.bind`

- **Outcome:** respuesta verificada a "¿alcanza un `conversationId` cualquiera o
  hace falta una fila sembrada y reclamable?", con la lista exacta de lo que hay
  que sembrar.
- **Files:** ninguno (lectura) + nota en `02-research.md`.
- **Checks:** leer `createRoomConversationGate` y `RoomConversation.claim`;
  identificar tablas, constraints y el lease.
- **Stop condition:** el diseño puede nombrar el fixture mínimo sin adivinar.
- **Por qué primero:** sin esto, el spike adivina y el fallo se ve como "el binding
  no funciona" cuando en realidad falta una fila.

## Slice 2 — El primer audio de Nani (el spike)

- **Outcome:** caller del host entra, emite el binding token, invoca
  `bind_conversation`, recibe `{ok: true}`, y **captura el saludo de Nani en audio**,
  guardado como WAV.
- **Files:** `tests/e2e/voice-room/caller.ts` (conexión, publish, capture),
  `tests/e2e/voice-room/binding.ts` (emisión del token reusando
  `src/auth/live-binding.ts`), `scripts/voice-room-spike.mjs` (runner manual).
- **Automated checks:** el WAV resultante tiene frames > 0 y duración > 1 s.
- **Manual checks:** escuchar el WAV: Nani saluda en español rioplatense y lee el
  saldo real del fixture.
- **Stop condition:** WAV con voz de Nani en disco y binding `{ok: true}`.
- **Riesgo principal:** RQ7 no resuelta → hacer Slice 1 antes.

## Slice 3 — Turno completo de ida y vuelta

- **Outcome:** después del saludo, el caller publica un turno de usuario desde un
  WAV pregrabado y captura la respuesta hablada de Nani. Fin de turno detectado
  por silencio, no por `sleep`.
- **Files:** `tests/e2e/voice-room/fixtures/*.wav` (turnos pregrabados),
  `caller.ts` ampliado (espera por fin de turno).
- **Automated checks:** se captura audio de respuesta después del turno; la
  duración es consistente entre corridas.
- **Manual checks:** escuchar entrada y respuesta: la respuesta contesta lo que se
  preguntó.
- **Stop condition:** conversación de dos turnos completa, determinística en tres
  corridas seguidas.
- **Resuelve RQ10** en el camino.

## Slice 4 — Asertos sobre estado, no solo sobre audio

- **Outcome:** el escenario afirma el resultado en el backend (p. ej. una
  transferencia confirmada en fixture), no solo que hubo audio. Artefactos
  persistidos en `tests/e2e/voice-room/.artifacts/` (gitignored).
- **Files:** asertos por escenario; limpieza/aislamiento entre corridas.
- **Automated checks:** un escenario de transferencia deja el estado esperado; un
  escenario de cancelación **no** deja transferencia. El aserto negativo es el que
  más valor tiene.
- **Stop condition:** dos escenarios (uno positivo, uno negativo) verdes y
  discriminantes.

## Slice 5 — Encaje en vitest, con credenciales explícitas y fallo ruidoso

- **Outcome:** el harness corre como test de vitest, con `LIVEKIT_*` y
  `OPENAI_API_KEY` inyectadas explícitamente, y **falla de forma visible** si falta
  el stack o las credenciales. Nada de `skipIf` mudo.
- **Files:** `tests/e2e/voice-room/*.test.ts`, script npm, `docs/evals.md` o
  `docs/` con el runbook del stack e2e.
- **Automated checks:** con el stack arriba, verde; con el stack abajo, rojo con
  mensaje que dice qué falta; suite existente sigue verde.
- **Stop condition:** `90-verification.md` completo con comandos y resultados.

---

## Dependencias

Slice 1 → 2 → 3 → 4 → 5. Los slices 2 y 3 son I+D: si 2 no produce audio, 3 no
arranca y hay que volver a diseño con la evidencia.

## Fuera de scope

CI, barge-in (RQ8), y la capa de producto (¿lo entiende una persona mayor?).
