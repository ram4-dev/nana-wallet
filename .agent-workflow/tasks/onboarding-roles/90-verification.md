# Verificación: onboarding de roles

Estado: **diseño y outline; implementación no iniciada**. Este registro separa la evidencia de planificación de futuras pruebas de código.

## Evidencia de planificación

| Comprobación | Resultado |
| --- | --- |
| PRD revisión 3 | Aprobado por Ramiro; decisión asentada en `03-prd.md`. |
| Diseño de sistema revisión 1 | Aprobado por Ramiro; decisión asentada en `04-tdd.md`. |
| Diseño de programa revisión 1 | Aprobado por Ramiro; decisión asentada en `04-tdd.md`. |
| Outline revisión 1 | Escrito para revisión en `05-structure-outline.md`; sin aprobación de ejecución. |
| `git diff --cached --check` de los cambios documentales | Pasó sin errores antes del commit. |

## Validaciones aún no ejecutadas

- No se modificó código ni esquema, por lo que lint, typecheck, build, tests, evals, browser E2E y LiveKit E2E no verifican un cambio de runtime de este turno. Se correrán por slice con la base y los servicios necesarios levantados.
- No se ejecutó migración, PATCH de Privy ni transacción en Solana.
- Permanecen sin prueba en la versión instalada: correo verificado de Privy, consentimiento inicial para cambios posteriores del responsable, allowlist Solana sin condición de monto y playout TTS confiable. El Slice 0 los trata como puertas de capacidad, no como hechos resueltos.

## Próximo responsable y acción

Ramiro revisa el outline. Si pide implementación, primero se aprueba el alcance de ejecución y se crean los artefactos SDD; después se implementa y verifica cada slice. Si una prueba de capacidad contradice el TDD, se vuelve a la puerta de diseño pertinente antes de ampliar permisos.
