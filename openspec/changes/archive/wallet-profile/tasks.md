# Tareas: Billetera y Mi perfil

Plan: outline r2 aprobado; diseño SDD r1. Apply ejecutado el 2026-09-10 sobre la snapshot Privy verificada (sin commit final de Privy: dependencia registrada, autorizado por Ramiro). Evidencia por tarea: .agent-workflow/tasks/wallet-profile/90-verification.md. Los IDs WP remiten a specs/wallet-profile/spec.md. No publicar slices 1–2 aislados.

## 0. Base y preparación (requisito para apply)

- [x] 0.1 Identificar commit final de Privy; comparar contratos/rutas con privy-snapshot.json y registrar diferencias. No copiar cambios nuevos ni hacer commit del trabajo ajeno. Si falta commit final, registrar dependencia y detener apply (todos los WP).
- [x] 0.2 Crear worktree Worktrunk de implementación desde base reconciliada; registrar ruta/rama/HEAD, preservar originales y trasladar solo artefactos aprobados. Revisar cualquier decisión afectada por la reconciliación (WP-015).
- [x] 0.3 Instalar dependencias, crear Compose/DB/volumen de pruebas propios, migrar y provisionar fixtures; preparar URLs Portless API/web, CORS y tokens ES256 de test. Registrar modo fixture y verificar ausencia de bypass público de identidad (WP-003, WP-009, WP-016).
- [x] 0.4 Ejecutar baseline de checks relevantes sobre base Privy aislada antes de atribuir fallos a estos slices. Registrar suites omitidas como omitidas (WP-016).

## 1. Perfil independiente

- [x] 1.1 Extraer contactos/agenda/facturas y confirmaciones a LegacyProfileSections preservando lógica y documentar ubicación; retirar render y queries secundarios de /perfil sin borrar trabajo ajeno (WP-002, WP-015).
- [x] 1.2 Implementar nombre o ausencia, quitar etiqueta userId y datos ficticios, conservar Salir, error/carga/reintento y limpieza de sesión. Cubrir null, vacío, espacios, 401 y error de backend (WP-001, WP-002, WP-013).
- [x] 1.3 Ejecutar frontend lint/typecheck/test/build y E2E de Perfil con backend real: nombre conocido/ausente, error/reintento, Salir y cero requests a agenda/bills/wallet-summary. Inspeccionar móvil y teclado (WP-001, WP-002, WP-016).

## 2. Servicio y contrato de balances

- [x] 2.1 Definir schemas Zod y tipos duplicados frontend para ready/no-ready/error. Agregar API client y queryKeys.balances con raíz balances. Validar envelopes y fixtures de ambos lados sin imports cruzados (WP-004, WP-005, WP-007, WP-013, WP-015).
- [x] 2.2 Crear BalanceReader y WalletBalancesService con reloj, resolución de binding propio y lector inyectables; fixtures por dirección, error para fixture desconocido y ninguna dependencia de firma/permisos (WP-003, WP-005, WP-008, WP-009).
- [x] 2.3 Implementar adaptador RPC: eth_chainId, eth_call decimals/balanceOf al catálogo cerrado, uint256/ABI/IDs, deadline de operación 8 s, cancelación, sin retries. Configuración BALANCE_READ_SOURCE fixture por defecto y BALANCE_RPC_URL solo para rpc; documentar ejemplos sin secretos (WP-006, WP-007, WP-009).
- [x] 2.4 Agregar GET /v1/wallets/current/balances con auth, rechazo de query/body, no-store en éxito/error y fallos seguros; wiring separado de core.walletReads. Actualizar docs/api.md (WP-003, WP-004, WP-005, WP-007, WP-013).
- [x] 2.5 Ejecutar unitarios del adaptador con JSON-RPC local controlado: selectores/dirección/contrato, 6 vs 18 decimales, uint256 máximo, cero, cadena errónea, ABI/ID inválido, error RPC y deadline total (WP-006, WP-007).
- [x] 2.6 Ejecutar integración Postgres/RLS y HTTP servidor real con dos identidades: cada binding/saldo propio, query ajena rechazada, 401, cada no-ready, ready inválido, permisos revocados y ausencia de llamadas a sync/sign/broadcast o escrituras financieras (WP-003..WP-009, WP-013).
- [x] 2.7 Correr backend lint/typecheck/test/eval/build con DB y frontend lint/typecheck/test/build por cambio de contrato. Registrar resultado E2E HTTP anterior, sin confundirlo con E2E browser (WP-016).

## 3. Billetera conectada

- [x] 3.1 Extraer cuentas/movimientos legados a LegacyMoneySections preservado; cambiar /mi-plata a identidad más balances, quitar promesas de pesos y endpoints MSW legados (WP-010, WP-015).
- [x] 3.2 Implementar formato exacto string/BigInt, indicador Arc testnet, demostración en fixture, observedAt, variantes no-ready y error; ocultar monto previo tras fallo de refresco. Fijar staleTime, refetchOnMount, retry y botón Actualizar saldo conforme spec (WP-004, WP-005, WP-010, WP-011).
- [x] 3.3 Restituir acceso explícito Administrar billetera con WalletLifecycle montado bajo demanda y estados independientes. No consultar contactos/permisos al leer saldo y no provisionar al abrir página (WP-008, WP-012).
- [x] 3.4 Incorporar invalidación de balances a refreshMoneyQueries de index.tsx, resultados de conversación por botón/voz y callbacks activos de receipt/unknown. Fijar ID/revisión de deduplicación según contrato final Privy. Asegurar generación vigente y no enviar otra operación (WP-013, WP-014).
- [x] 3.5 Ejecutar frontend lint/typecheck/test/build; E2E navegador con backend real para USDC positivo/cero/mínimo/grande, no-ready, 401, error/refresh, permisos revocados, administración fallida y ausencia de endpoints legacy (WP-010..WP-012, WP-016).

## 4. Aislamiento y verificación final

- [x] 4.1 Crear harness browser propio con VITE_E2E_REAL_BACKEND=1, Chromium obligatorio y exit no cero si no corre. Usar identidad/lector de test con HTTP real; no interceptar balances del navegador ni cambiar exit del harness legado (WP-016).
- [x] 4.2 Probar A→logout→B y cambio directo A→B con respuesta A demorada; observar DOM durante transición y caché final, y comprobar cancelación/descarte de callbacks. Ajustar solo faltantes demostrados de resetSession/estado local (WP-013).
- [x] 4.3 Probar invalidación tras sent por texto, decisión por botón y estado por voz; resultado ambiguo no retransmite ni se informa fallido. Agente /, preview, confirmación e idempotencia mantienen regresión verde (WP-014, WP-015).
- [x] 4.4 Inspeccionar 390 px, nombres largos y uint256, teclado/foco y anuncios de error/carga. Guardar evidencia visual y resultados por escenario (WP-001, WP-010, WP-016).
- [x] 4.5 Ejecutar matriz completa: backend lint/typecheck/test/eval/build con DB, frontend lint/typecheck/test/build y E2E browser; reportar cada blocker/skip separado de PASS. No cerrar con E2E pendiente (WP-016).

## 5. Cierre y entrega

- [x] 5.1 Completar verificación contra WP-001..WP-016 y actualizar .agent-workflow/tasks/wallet-profile/90-verification.md y verify de OpenSpec con comandos, resultados, base y limitaciones (WP-016).
- [x] 5.2 Preservar referencia de sesiones y cerrar solo servidores/panes/recursos de esta tarea; conservar worktree revisable. Archivar solo con evidencia completa; sin merge, publicación ni cambios de fondos automáticos (WP-015, WP-016).

## Trazabilidad de aceptación

| Requisito | Tareas principales | Evidencia requerida |
| --- | --- | --- |
| WP-001 | 1.2, 1.3, 4.4 | Nombre conocido/ausente y móvil |
| WP-002 | 1.1, 1.2, 1.3 | Error recuperable y consultas independientes |
| WP-003 | 0.3, 2.2, 2.4, 2.6 | Auth, rechazo query ajena, dos usuarios |
| WP-004 | 2.1, 2.4, 3.2 | Envelope y USDC positivo/cero |
| WP-005 | 2.1, 2.2, 2.6, 3.2 | Cada readiness state, sin RPC |
| WP-006 | 2.3, 2.5 | Método ERC-20, unidades y uint256 |
| WP-007 | 2.3, 2.4, 2.5 | 409/503, red/ABI/timeout |
| WP-008 | 2.2, 2.6, 3.3 | Permisos revocados y cero side effects |
| WP-009 | 0.3, 2.2, 2.3 | Default fixture y mapa por dirección |
| WP-010 | 3.1, 3.2, 3.5, 4.4 | Formato exacto y moneda/red |
| WP-011 | 3.2, 3.5 | Refresh y ocultación tras error |
| WP-012 | 3.3, 3.5 | Administración independiente |
| WP-013 | 1.2, 2.4, 3.4, 4.2 | no-store, cache y respuestas tardías |
| WP-014 | 3.4, 4.3 | Invalidación texto/botón/voz/ambiguo |
| WP-015 | 0.2, 1.1, 3.1, 4.3, 5.2 | Código preservado, agente y boundaries |
| WP-016 | 0.3, 0.4, 1.3, 2.7, 3.5, 4.1, 4.4, 4.5, 5.1 | Suites, E2E real y recibo |
