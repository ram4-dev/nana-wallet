# Validación documental SDD

Fecha: 2026-09-09. Rama: docs/wallet-profile-rpi. Worktree: /private/tmp/nana-wallet-profile-rpi-20260909. Fase completada: proposal → spec → design → tasks. Apply/verify de aplicación/archive no iniciados.

## Comprobaciones

- npm exec --yes --package=@fission-ai/openspec@1.13.0 -- openspec validate wallet-profile --strict --no-interactive --json: exit 0, valid true, issues [], 1 passed, 0 failed.
- npm exec --yes --package=@fission-ai/openspec@1.13.0 -- openspec status --change wallet-profile --json: proposal/specs/design/tasks done; isPlanningComplete true. isComplete aquí describe artefactos de planificación, no implementación.
- git diff --check: exit 0. Comprobación adicional de archivos nuevos: newline final y sin whitespace sobrante.
- Trazabilidad: 16 requisitos únicos, 31 escenarios con GIVEN/WHEN/THEN; cada requisito tiene fila de trazabilidad; referencias a las 26 tareas existentes y todas sin ejecutar.
- Integridad: 123 archivos heredados coinciden con privy-snapshot.json; outline r2 mantiene SHA-256 9945e035bad67e4e42abb7f9629411d140a472e0ec401ba6f72610d63655fd32.

OpenSpec se ejecutó desde la caché de npm, sin instalar dependencias del proyecto ni cambiar package.json/lockfiles. Se corrigieron solo tres líneas del contexto OpenSpec obsoleto que restringía todo a backend: este cambio aprobado incluye front/back separados por HTTP.

## Evidencia y límites

No se ejecutaron unitarios, integración, lint, typecheck, build, eval ni E2E de aplicación: esta fase modifica únicamente planificación/configuración documental. Validar la spec no acredita que Perfil o Billetera funcionen.

La base Privy continúa en /private/tmp/nana-privy-specs-20260908 sobre e9fcd84429af92e5b4098f5f92d3aa7a861c6bb5 con cambios sin commit final (118 entradas de status observadas en este turno, cantidad que incluye directorios). No se actualizaron esos archivos ni se absorbieron cambios posteriores a la instantánea.

Antes de apply: reconciliar commit final y contratos Privy, registrar worktree de implementación y mantener el alcance autorizado. La respuesta «si» de este turno aprobó el plan y avanzar a SDD. No se solicitaron aprobaciones adicionales para redactar o validar estos artefactos.

## Fuentes técnicas

- <https://docs.arc.io/arc/references/contract-addresses>: contrato e interfaz USDC de seis decimales.
- <https://docs.arc.io/arc/concepts/stablecoin-native-model>: representación nativa de 18 decimales y ERC-20 de seis del mismo saldo.
- <https://github.com/Fission-AI/OpenSpec/blob/main/docs/cli.md>: CLI validate, strict y no-interactive.

Fuentes consultadas el 2026-09-09. La verificación RPC operativa se realizará con el adaptador y servidor controlado en la implementación.

## Open questions registrados post-apply (2026-09-10, decisión de Ramiro)

1. **Límites de permiso dinámicos**: `PER_TRANSFER_USDC="10"` y `ROLLING_TOTAL_USDC="50"` son constantes compiladas (src/wallet/privy-client.ts) y se hornean en la política Privy al enrollment (`lte 10000000` atomic6 en buildEnrollmentPolicyRules). No existe hoy forma de cambiarlos en runtime. Cambiarlos exige actualizar la política en Privy + re-attach del signer: cambio de alcance sobre privy-embedded-wallets, no de wallet-profile. Opciones anotadas: (A) env var por arranque, (B) endpoint PATCH de límites con preview+confirmación, (C) default por env + override por usuario.
2. **Alta de contactos en las pantallas simplificadas**: el CRUD de contactos existe completo en el backend (/v1/contacts) y su UI está preservada y funcional en LegacyProfileSections.tsx (WP-002/015), pero /perfil simplificada no la monta por decisión de alcance. Re-exponerla es una decisión de producto explícita, no trabajo faltante.

Ninguna de las dos bloquea el PR de wallet-profile; se resuelven como changes de OpenSpec propios si Ramiro las aprueba.
