# Especificación: Billetera y Mi perfil

Revisión r1, derivada del diseño r1 y outline r2 aprobados. Los términos MUST y MUST NOT son normativos. No implementada todavía.

## ADDED Requirements

### Requirement: WP-001 Perfil con datos existentes

La pantalla /perfil MUST consultar GET /v1/me y mostrar únicamente el nombre disponible. MUST tratar null, vacío o solo espacios como ausente: «Tu perfil» y «Todavía no tenemos tu nombre». MUST NOT mostrar userId, DID, DNI, ciudad, email o teléfono no provistos por un contrato verificado, ni ofrecer edición. No modifica displayName almacenado.

#### Scenario: Nombre conocido

- **GIVEN** /me devuelve displayName «Ana Pérez»
- **WHEN** se abre Perfil
- **THEN** el nombre se muestra sin identificadores internos ni datos inventados

#### Scenario: Nombre ausente

- **GIVEN** displayName es null, vacío o espacios
- **WHEN** se renderiza Perfil
- **THEN** se muestra el estado de nombre ausente y no se escribe ningún dato

### Requirement: WP-002 Perfil independiente y recuperable

Perfil MUST conservar Salir y MUST tener carga, error y reintento propios de /me. MUST NOT esperar ni consultar contactos, agenda, facturas, resumen de wallet o permisos para presentar los datos personales. El error de identidad MUST evaluarse antes de cargas de consultas deshabilitadas.

#### Scenario: Error de identidad

- **GIVEN** /me falla con 401 o 503
- **WHEN** se abre Perfil
- **THEN** aparece el error recuperable y no un spinner indefinido

#### Scenario: Dependencias ausentes

- **GIVEN** agenda/facturas/wallet-summary no existen en el backend
- **WHEN** /me responde correctamente
- **THEN** Perfil carga y no solicita esas rutas

### Requirement: WP-003 Dueño autenticado

GET /v1/wallets/current/balances MUST usar la identidad validada y getCurrentWallet(userId) bajo RLS. MUST NOT aceptar selección de dueño, wallet, dirección, red o token desde query/body. Una query no vacía MUST producir 400 INVALID_QUERY sin leer saldo. Identidad inválida MUST producir 401. MUST NOT usar core.walletReads, una wallet global ni fallback.

#### Scenario: Dos usuarios

- **GIVEN** A y B tienen bindings y saldos distintos
- **WHEN** A consulta balances
- **THEN** solo se resuelve y consulta la dirección verificada de A

#### Scenario: Selección ajena

- **GIVEN** A adjunta address o userId de B en query
- **WHEN** el backend valida la petición
- **THEN** responde 400 sin consultar RPC ni devolver datos de B

#### Scenario: Sin identidad

- **GIVEN** el token falta o está vencido
- **WHEN** se consulta balances
- **THEN** responde 401 y no consulta bindings ni lector

### Requirement: WP-004 Contrato de saldo listo

El sistema MUST devolver el envelope {ok:true,data} con walletState ready, address propia, chainId 5042002, networkName «Arc testnet», testnet true, source fixture|rpc, observedAt ISO UTC y assets de longitud uno. El activo MUST tener tokenId «5042002:0x3600000000000000000000000000000000000000», contract con esa dirección, symbol USDC, name «USD Coin», decimals 6 y balanceAtomic decimal canónico como string dentro de uint256. MUST conservar «0» como saldo válido.

#### Scenario: Respuesta lista

- **GIVEN** la wallet está ready y el lector obtiene 1250000 unidades
- **WHEN** se serializa la respuesta
- **THEN** balanceAtomic es «1250000», decimals es 6 y observedAt refleja la lectura exitosa

#### Scenario: Cero real

- **GIVEN** la wallet está ready y el lector devuelve cero
- **WHEN** se responde
- **THEN** assets contiene USDC con balanceAtomic «0»; no es una lista vacía

### Requirement: WP-005 Estados sin saldo

Para walletState unprovisioned, provisioning, recovery_required, conflict o unavailable, la respuesta MUST ser {ok:true,data} con ese estado, chainId 5042002, networkName «Arc testnet», testnet true, observedAt null y assets []. MUST omitir address/source en esta variante. MUST NOT consultar RPC, mostrar cero ni crear/sincronizar wallets automáticamente.

#### Scenario: Estados no listos

- **GIVEN** cada uno de los cinco estados no ready
- **WHEN** se consulta balances
- **THEN** se devuelve su estado, assets vacío y observedAt null sin llamadas al lector o a syncWallet

### Requirement: WP-006 Catálogo y precisión ERC-20

El lector RPC MUST comprobar eth_chainId=5042002 y consultar decimals()=6 y balanceOf(address) del contrato USDC 0x3600000000000000000000000000000000000000 con eth_call. MUST validar la dirección, IDs y formato JSON-RPC y resultados ABI de 32 bytes. MUST usar strings/BigInt para uint256. MUST NOT consultar eth_getBalance ni interpretar datos nativos de 18 decimales como seis decimales, sumar representaciones o aceptar otro catálogo.

#### Scenario: Método y unidades

- **GIVEN** RPC controlado devuelve seis decimales y 1000000 unidades
- **WHEN** se ejecuta la lectura
- **THEN** solo se observan eth_chainId y eth_call de decimals/balanceOf al contrato fijado y el resultado equivale a 1 USDC

#### Scenario: Respuesta inválida

- **GIVEN** RPC responde con red distinta, decimals distinto de 6, error JSON-RPC, ID distinto, ABI mal formado o uint256 inválido
- **WHEN** se valida
- **THEN** la lectura se rechaza sin devolver monto

### Requirement: WP-007 Fallos explícitos y acotados

La operación RPC completa MUST compartir un deadline de 8 segundos, cancelarse al vencer y MUST NOT reintentar automáticamente. Un timeout, respuesta inválida, red errónea o caída RPC MUST devolver 503 BALANCE_NO_DISPONIBLE. Un binding ready inconsistente o una chainFamily no admitida MUST devolver 409 WALLET_DATOS_INVALIDOS sin consultar RPC. Los errores MUST usar {ok:false,error:{code,message}} con mensaje seguro, sin datos crudos del proveedor.

#### Scenario: Timeout

- **GIVEN** el RPC no termina dentro de ocho segundos
- **WHEN** vence el deadline de la operación
- **THEN** se cancela y responde 503, sin retorno de cero ni segundo intento

#### Scenario: Wallet inconsistente

- **GIVEN** el binding ready tiene dirección inválida o chainFamily distinta de arc
- **WHEN** se resuelve el binding
- **THEN** responde 409 y no usa wallet global

### Requirement: WP-008 Lectura sin firma ni mutaciones

La consulta MUST funcionar independientemente de permission pending, active, revoking, revoked o unavailable. MUST NOT leer credenciales de firma, llamar enrollment, sync, sign, send, broadcast ni modificar bindings, grants u operaciones. El registro normal de autenticación existente puede actualizar last_seen_at; eso no autoriza otra escritura.

#### Scenario: Permiso revocado

- **GIVEN** wallet ready y permiso revoked
- **WHEN** se consulta saldo
- **THEN** el saldo se obtiene sin activar permisos ni llamar al servicio de firma

#### Scenario: Sin side effects financieros

- **GIVEN** se registran contadores DB y spies del servicio antes de consultar
- **WHEN** terminan lecturas listas o fallidas
- **THEN** bindings, grants y operaciones permanecen iguales

### Requirement: WP-009 Configuración y fixtures

BALANCE_READ_SOURCE MUST admitir fixture|rpc con fixture por defecto. BALANCE_RPC_URL MUST exigirse para rpc y nunca exponerse en UI/logs/respuesta. WDK_TOOLS_SOURCE MUST NOT cambiar. El fixture MUST mapear direcciones verificadas a valores deterministas; una dirección no configurada MUST producir error explícito, no cero silencioso. La configuración de servidor MUST NOT poder elegirse desde HTTP público. La UI MUST identificar source fixture como demostración.

#### Scenario: Default seguro

- **GIVEN** no se configura BALANCE_READ_SOURCE
- **WHEN** arranca el servicio
- **THEN** usa fixture y no llama a una red externa

#### Scenario: Fixture por wallet

- **GIVEN** A y B tienen cantidades fixture diferentes
- **WHEN** cada uno consulta
- **THEN** recibe su valor propio y la UI indica demostración

### Requirement: WP-010 Billetera simple y exacta

/mi-plata MUST mantener la etiqueta Billetera y mostrar USDC, su cantidad legible, «Arc testnet» y observedAt. MUST formatear strings/BigInt con convención es-AR sin redondear 0.000001 USDC a cero ni perder precisión en cantidades grandes. MUST NOT mostrar total en pesos, cotización, plazo fijo o movimientos simulados.

#### Scenario: Saldo mínimo

- **GIVEN** balanceAtomic es «1»
- **WHEN** se renderiza
- **THEN** se muestra «0,000001 USDC»

#### Scenario: Saldo grande

- **GIVEN** balanceAtomic es «9007199254740993»
- **WHEN** se renderiza
- **THEN** se muestra exactamente «9.007.199.254,740993 USDC»

### Requirement: WP-011 Refresco y errores de UI

La consulta de balances MUST ejecutarse después de identidad válida y actualizar al entrar a Billetera y al pulsar «Actualizar saldo». MUST usar staleTime 30 s, refetchOnMount always, retry false y no polling. Tras error inicial o de refresco MUST ocultar cualquier monto previo y mostrar error/reintento; observedAt MUST NOT cambiar al render. Con wallet no ready MUST mostrar su estado, sin monto.

#### Scenario: Error después de éxito

- **GIVEN** antes se mostraba saldo y el refresco falla
- **WHEN** termina el refresco
- **THEN** se oculta monto anterior, aparece reintento y no se marca un saldo como actualizado

#### Scenario: Reingreso

- **GIVEN** hay saldo cacheado reciente
- **WHEN** se vuelve a Billetera
- **THEN** se solicita una actualización sin polling continuo

### Requirement: WP-012 Administración explícita

«Administrar billetera» MUST abrir WalletLifecycle únicamente tras acción explícita, con carga/error separados del saldo. La lectura de Billetera MUST NOT montar lifecycle ni consultar contactos/permisos antes de esa acción. El acceso MUST existir también para wallet no ready y MUST NOT provisionar nada por sí mismo.

#### Scenario: Administración falla

- **GIVEN** saldo listo y contacts o permission falla al abrir administración
- **WHEN** se muestra la sección
- **THEN** el error queda dentro de administración y el saldo no desaparece

#### Scenario: Entrada de solo lectura

- **GIVEN** el usuario solo abre Billetera
- **WHEN** se monta la página
- **THEN** no hay peticiones de contactos/permisos/enrollment

### Requirement: WP-013 Aislamiento de sesión y caché

La clave MUST ser queryKeys.balances(userId,5042002) con array [«balances»,userId,5042002], distinta del resumen legado. Logout y cambio de cuenta MUST resetear generación, abortar peticiones y limpiar caché antes de mostrar otro usuario. MUST descartar respuestas tardías y callbacks antiguos. Todas las respuestas de balances MUST usar Cache-Control: private, no-store; ningún cache compartido puede reutilizar saldos.

#### Scenario: Respuesta A tardía

- **GIVEN** A tiene una consulta pendiente y B inicia sesión
- **WHEN** llega la respuesta de A
- **THEN** ni DOM ni caché de B contienen el nombre o saldo de A, aun por un frame

#### Scenario: Logout

- **GIVEN** hay nombre/saldo en pantalla
- **WHEN** se pulsa Salir
- **THEN** se limpian solicitudes y caché de esa sesión antes de navegar

### Requirement: WP-014 Invalidación y regresión del agente

El frontend MUST invalidar exclusivamente balances del usuario actual al observar un resultado de operación sent/confirmado y al refrescar tras resultado financiero ambiguo existente. Los caminos texto, decisión por botón y actualización de estado por voz MUST converger en esa invalidación sin duplicar dispatch ni cambiar preview, confirmación o idempotencia. Una invalidación de sesión antigua MUST descartarse.

#### Scenario: Operación confirmada

- **GIVEN** hay saldo cacheado y el agente confirma una operación de A
- **WHEN** se recibe resultado sent por texto, botón o actualización de voz
- **THEN** se invalida la query de A y la próxima vista obtiene su nuevo saldo sin enviar otra operación

#### Scenario: Resultado ambiguo

- **GIVEN** la resolución existente queda incierta
- **WHEN** se refrescan consultas de dinero
- **THEN** se invalida también balances sin informar rechazo definitivo ni retransmitir

### Requirement: WP-015 Conservación y separación

El cambio MUST preservar código de contactos/agenda/facturas y cuentas/movimientos en componentes secundarios identificados, fuera del render simple. El retiro de sus entradas en estas pantallas es intencional. El agente principal en / y su preview/confirmación MUST permanecer operables. Front y back MUST comunicarse por HTTP con tipos duplicados; MUST NOT agregar imports cruzados o paquetes compartidos. Slices 1–2 MUST NOT publicarse aislados.

#### Scenario: Pantallas simplificadas

- **GIVEN** los componentes legados están preservados
- **WHEN** se abren Perfil y Billetera
- **THEN** no solicitan endpoints legacy y el agente en / sigue accesible

### Requirement: WP-016 Evidencia funcional y accesibilidad

La entrega MUST ejecutar backend lint/typecheck/test/eval/build con Postgres y frontend lint/typecheck/test/build, más E2E Chromium con backend real y VITE_E2E_REAL_BACKEND=1. Los fixtures MUST vivir en dependencias de test, no en interceptaciones de saldo del navegador ni bypass público de identidad. El harness propio MUST devolver exit no cero si Chromium no corre. MUST verificar móvil de 390 px, teclado, nombres/cifras largos, errores anunciados y ausencia de overflow. Un blocker o skip MUST NOT contarse como PASS.

#### Scenario: Navegador ausente

- **GIVEN** Chromium no puede iniciarse tras intentar provisionarlo
- **WHEN** termina el harness
- **THEN** la suite no pasa y se registra el motivo concreto

#### Scenario: Entorno aislado

- **GIVEN** se ejecuta E2E desde el worktree de implementación
- **WHEN** se levantan dependencias
- **THEN** Compose usa recursos propios y web/API usan Portless con URLs estables sin afectar otros servidores
