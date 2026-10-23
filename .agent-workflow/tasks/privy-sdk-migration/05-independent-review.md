# 05 — Revisión independiente del outline

## Estado

**Pendiente — no se obtuvo una revisión.** Pi no pudo ejecutar el análisis porque el proveedor `nan` rechazó el turno por cuota mensual agotada. No se deben interpretar estos datos como aprobación ni como ausencia de hallazgos.

## Artefacto objetivo

- Archivo: `04-structure-outline.md`
- SHA-256 solicitado: `ac18bac414f1e1d621bddfae9d0b794c8b508067334e7a1c502678924ee615b5`
- Resultado del chequeo local antes del intento: hash coincidente.
- Alcance pedido: revisar S0 y la frontera sin broadcast; SDK/D1b y aislamiento de claves; límites, fees y scope de identidad; prerequisitos Solana; revocación; pruebas E2E; gates humanos/dashboard; orden y dependencias.

## Intento de revisión

- Fecha: 2026-10-09.
- Agente: Pi por Herdr, provider `nan`, modelo `glm5.3-flash`, razonamiento `high`.
- Sesión: `/Users/ramiro/.pi/agent/sessions/--Users-ramiro-Desktop-projects-colloseum.review-privy-sdk-migration-outline-20261009--/2026-10-09T10-20-59-087Z_01a1202e-2b4e-7349-8370-657be185d796.jsonl`.
- Resultado: error HTTP 402 `monthly_cap_reached`; cuota indicada como agotada hasta `2026-11-01 00:00 UTC`.
- Archivos revisados por el agente: ninguno; el turno de revisión no llegó a ejecutarse.
- Hallazgos: no disponibles.
- Gate de outline: sigue propuesto y requiere revisión Pi efectiva más aprobación humana explícita.
- Implementación: no iniciada.

## Próximo paso

Reintentar la revisión independiente del mismo hash cuando `nan/glm5.3-flash` vuelva a estar disponible. Si se modifica el outline antes, calcular un nuevo hash y revisar esa revisión exacta.

## Auditoría adicional de estado actual (no sustituye la revisión Pi)

El orquestador comparó el outline con `90-verification.md` y el código de `main`:

- `90-verification.md` ya documenta **PASS** para S0 (política probada sin broadcast), S1 (cliente de administración SDK), S2a/S2c (firma delegada y llave fuera del backend), Solana SDK/política, S5 (código muerto eliminado) y S6 (revocación local de sesión). El outline refleja trabajo ya implementado y necesita revisión de vigencia antes de asignar slices como si fueran nuevos.
- La lectura de balances sigue usando Arc JSON-RPC (`src/wallet/privy-user-provider.ts` y `src/wallet/balances.ts`). El paquete instalado `@privy-io/node@0.34.0` expone `wallets().balance.get`, pero sus tipos enumeran cadenas testnet como `sepolia` y `solana_devnet`, no `arc-testnet`; admitir el string en TypeScript no prueba soporte del servicio. El comportamiento de Arc sigue sin comprobarse en una wallet autenticada.
- P1/P2 de dashboard siguen siendo prerrequisitos humanos en el outline. No se modificó configuración de Privy.
- El stack local ya estaba servido: frontend HTTP 200, API `/health` 200, `IDENTITY_PROVIDER=privy`, operaciones en `WDK_TOOLS_SOURCE=fixture`; la pantalla del navegador llega al login `/login`. No se inició sesión ni se envió OTP.

Implicación: **no se debe iniciar S3 como implementación** hasta que la revisión independiente determine si el outline sigue vigente, el soporte real de balance para Arc esté demostrado o se aplique la condición de parada del outline, y Ramiro apruebe el outline revisado. Esta auditoría es evidencia del estado local, no aprobación independiente ni autorización de implementación.
