# Billetera y Mi perfil

## Why
Mi perfil todavía depende de consultas de agenda, facturas y billetera. Billetera consume un resumen de MSW que no existe en el backend real. La base Privy ya resuelve identidad y wallet propias, pero no expone el saldo de esa wallet. Por eso autenticar al usuario no basta para mostrar su dinero.

## What Changes
- Mostrar nombre existente o estado de dato ausente en /perfil, conservando Salir y el aislamiento de sesión.
- Agregar GET /v1/wallets/current/balances: USDC ERC-20 de seis decimales, Arc testnet, wallet propia derivada de la identidad.
- Mostrar el saldo, moneda, red y fecha de consulta en /mi-plata; diferenciar cero, wallet sin preparar y error.
- Mantener administración de Privy detrás de una acción explícita e independiente del saldo.
- Retirar del render simple agenda, facturas y movimientos; preservar sus componentes y lógica, sin prometer esos accesos en esta feature.
- Validar dos usuarios con backend real, fixture de lectura y pruebas de navegador obligatorias.

## Capabilities
### New Capabilities
- wallet-profile: lectura de perfil y activos personales, estados de UI y aislamiento entre sesiones.
### Modified Capabilities
Ningún cambio normativo a permisos ni pagos de Privy. Se agregan invalidaciones de saldo al recibir resultados existentes, sin alterar preview, confirmación ni idempotencia.

## Impact
Backend: contratos HTTP, rutas wallets, servicio/adaptadores de balances y configuración. Frontend: contratos duplicados, cliente HTTP, queries, rutas perfil/mi-plata, composición del lifecycle e invalidación del saldo desde el agente. Pruebas: Postgres/RLS, adaptador JSON-RPC y E2E browser. Sin paquetes compartidos ni migraciones de identidad.

## Authority and Dependencies
Diseño r1, Q1-Q3 y outline r2 aprobados por Ramiro. Outline SHA-256: 9945e035bad67e4e42abb7f9629411d140a472e0ec401ba6f72610d63655fd32. Recibos: .agent-workflow/tasks/wallet-profile/05-independent-review.md y review-r2.md.

Base documental: main e9fcd84429af92e5b4098f5f92d3aa7a861c6bb5 más la instantánea privy-snapshot.json. Privy continúa sin commit final en su worktree al revisar esta fase; apply requiere reconciliar la base y registrar un worktree de implementación nuevo. No afirmar que su verificación live está completa.

## Non-goals and Rollback
Sin edición de perfil, email/teléfono nuevos, KYC, otras monedas, pesos, mainnet, operaciones de fondos o activación de firma live. WDK fixture permanece por defecto. La lectura RPC es una capacidad opt-in de solo lectura, validada con servidor controlado local.

Rollback futuro: retirar el slice propio o volver su lector a fixture mediante cambio revisable; conservar bindings, pagos y código ajeno. No borrar usuarios, bases compartidas ni wallets. No publicar slices 1–2 aislados.
