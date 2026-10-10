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

- Todavía no se modificó código ni esquema de producto. Los checks de línea de base de abajo verifican el estado previo; evals, browser E2E y LiveKit E2E se correrán por slice con los servicios necesarios levantados.
- No se ejecutó migración, PATCH de Privy ni transacción en Solana.
- Permanecen sin prueba de transporte/runtime en esta app: consentimiento inicial para cambios posteriores del responsable, allowlist Solana sin condición de monto y playout TTS confiable. El Slice 0 los trata como puertas de capacidad, no como hechos resueltos.

## Línea de base antes de implementar (2026-10-10)

- `npm ci` en backend y frontend: pasó. Los avisos de auditoría y de scripts de instalación quedaron registrados por npm; no se ejecutó `npm audit fix` ni se cambiaron lockfiles.
- `npm run lint && npm run typecheck` en backend: pasó.
- `npm run lint && npm run typecheck` en frontend: pasó.
- `npm run build` en backend y frontend: pasó; Vite emitió avisos de compatibilidad de dependencias, sin fallar.
- `npm test` en frontend: 26 archivos, 168 tests pasaron.
- Postgres aislado `nana-onboarding-roles-db-1` en `127.0.0.1:55520`, sano; `npm run db:migrate` aplicó las 17 migraciones actuales sobre esa base.
- `npm test` en backend con esa base: en curso al registrar esta línea; ya se observan fallos de tests de integración y dos tests antiguos de confirmación, antes de cualquier cambio de onboarding. No atribuirlos a la feature sin comparar el resultado final.

## Hallazgos de capacidad (lectura, sin mutación remota)

- `@privy-io/node@0.34.0` expone lectura de usuario por DID y email vinculado con `verified_at`; falta implementar el puerto de servidor y cubrirlo con tests. El token de Nana sólo verifica DID.
- Privy no representa un permiso `guardian DID → contacts/limits only`. Su firmante de servidor puede autorizar PATCH de política, pero Nana tendría que comprobar consentimiento inicial, relación, capacidades y revocación. La enmienda `06-privy-consent-amendment.md` está pendiente de decisión.
- La DSL documenta allowlist Solana sin monto; falta prueba de transporte controlado y readback para esta app. Ningún cap remoto se cambió.
- LiveKit `@livekit/agents@1.7.1` ofrece `SpeechHandle.waitForPlayout()`, pero la sesión actual no configura TTS: `session.say(text)` fallaría. Hace falta TTS explícito y prueba de audio antes de abrir una decisión de invitación.

## Próximo responsable y acción

Ramiro revisa el outline. Si pide implementación, primero se aprueba el alcance de ejecución y se crean los artefactos SDD; después se implementa y verifica cada slice. Si una prueba de capacidad contradice el TDD, se vuelve a la puerta de diseño pertinente antes de ampliar permisos.
