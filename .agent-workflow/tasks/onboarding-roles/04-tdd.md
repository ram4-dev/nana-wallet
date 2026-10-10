# TDD: onboarding de persona usuaria y responsable

Estado: **diseño de sistema aprobado; diseño de programa en preparación**. PRD rector: `03-prd.md`, revisión 3, aprobado por Ramiro el 2026-10-10 y registrado en `1edc62c`.

## Diseño de sistema, revisión 1

### Identidades y propiedad

La identidad autenticada (`actorUserId`) proviene exclusivamente del token Privy verificado y su DID. La persona cuya billetera o datos se consultan es el `subjectUserId`. La persona usuaria mantiene su DID, `users.id`, billetera, firmantes, contactos e historial actuales. El responsable tiene otro DID y `users.id`; puede tener además su propia billetera, pero el rol de responsable no la requiere. La elección visual de perfil nunca sustituye la identidad autenticada.

Un usuario puede tener ambos roles. Una relación activa entre `guardian_user_id` y `beneficiary_user_id` otorga sólo estas capacidades sobre el sujeto: leer contactos, historial y límites; crear/editar/quitar contactos; fijar o quitar el límite de transferencias ordinarias. La relación no da capacidad de preparar, confirmar, firmar, enviar o reintentar transferencias; tampoco de administrar firmantes o autorizaciones delegadas. Varias relaciones por lado son válidas.

```mermaid
flowchart LR
  GP[Privy DID del responsable] --> G[Actor responsable]
  UP[Privy DID de la persona usuaria] --> U[Actor y titular]
  G -->|relación activa y capacidad exacta| M[Servicio de acceso administrado]
  M -->|sujeto autorizado| D[(Contactos, historial, límites)]
  M -->|mutación autorizada| P[Servicio único de políticas]
  U --> W[Billetera Privy de la persona usuaria]
  P -->|intención versionada y firma del servicio| W
  G -.->|prohibido| T[Preview y confirmación de transferencia]
  U --> T
```

### Invitación y vinculación

El responsable autenticado crea una invitación dirigida a un correo normalizado. La invitación tiene identidad, versión, emisor, correo, alcance legible, vencimiento y estado `pending`; crearla no busca ni revela la existencia de una cuenta. La respuesta pública de alta evita enumerar correos. Se limita la tasa de invitaciones y se permite reenviar sin duplicar vínculos activos.

El token de acceso de Privy prueba el DID, **no un correo**. Para mostrar/aceptar invitaciones, un servicio restringido consulta los métodos de correo vinculados y verificados del DID mediante una API de Privy de confianza; sólo devuelve invitaciones que coinciden con esos correos, sin ofrecer búsqueda arbitraria por correo. Si la persona ingresó por teléfono sin verificar el correo invitado, Nana le pide verificar ese correo; no vincula por un texto del navegador. La aceptación enlaza IDs de usuario, no correos, y queda registrada con ambas identidades. Si el correo cambia después, el vínculo no cambia de titular automáticamente. Las invitaciones vencen a los siete días; aceptar, rechazar, revocar y reenviar son idempotentes y versionados.

Estados: `pending → accepted_pending_policy_authorization → active`, o `pending → declined/expired`; ambos estados aceptados pueden pasar a `revoked`. La aceptación y la autorización de administración de políticas se presentan como un flujo único a la persona usuaria. Si la autorización remota o la prueba de propiedad falla, el vínculo queda en `accepted_pending_policy_authorization`: el responsable puede leer los datos autorizados, pero ve que la gestión aún no está habilitada y no puede escribir políticas. Una reanudación desde la sesión de la persona usuaria completa la autorización. La aprobación de la invitación no se interpreta como una firma de transferencia.

La invitación dice en lenguaje claro que el responsable podrá agregar destinos y quitar por completo el límite de monto, sin una aprobación posterior por cada cambio. Así el consentimiento inicial cubre exactamente el alcance solicitado. Para billeteras ya enroladas bajo la política de 0,01 SOL, la ampliación no se deduce de la política antigua: se exige consentimiento nuevo del titular para el alcance amplio y un readback firmado/verificado antes de activar la administración. Si Privy no permite expresar o comprobar este consentimiento de una sola vez, no se activa la ampliación y se vuelve a decidir el producto; nunca se ensancha el firmante silenciosamente.

### Bandeja, inicio y voz

La tabla de invitaciones es la fuente de verdad. La bandeja existente recibe un tipo de notificación de vínculo con sólo el ID y datos de presentación seguros; marcarla leída no modifica la invitación. Antes del saludo y saldo habituales, el arranque consulta invitaciones pendientes. Las muestra en una tarjeta persistida y presenta una a la vez, en orden. Si hay voz, el backend obtiene esa invitación canónica y Nani pronuncia el nombre/correo del responsable y el alcance. El modelo no inventa quién invita ni qué permisos pide.

La voz usa una ventana de decisión de tipo `invitation`, excluyente con `transfer` y `contact`, unida a invitación/version, usuario, conversación y participante autenticado. Sólo cuenta una transcripción final afirmativa o negativa posterior a la presentación audible; se consume una vez mediante compare-and-set del estado persistido. Una respuesta de una ventana no sirve en otra. Si no se puede demostrar la presentación o se interrumpe, la voz no acepta la invitación y la tarjeta permite decidir.

Con el agente de voz actual, un `generateReply` puede parafrasear el texto. El diseño propone una frase redactada por el servidor y reproducida con TTS, esperando el fin de reproducción antes de abrir la ventana. LiveKit documenta `AgentSession.say()` y `SpeechHandle.waitForPlayout()` para esto, pero `say()` requiere un plugin TTS cuando se usa un modelo realtime. El programa debe validar la versión instalada y probar el audio real. No se activa una ventana basándose sólo en que el modelo recibió una instrucción. Referencia: https://docs.livekit.io/agents/multimodality/audio/.

### Autorización de datos y políticas

Las rutas actuales sin sujeto explícito siguen siendo de la persona autenticada. El responsable utiliza un espacio de API separado con `subjectUserId` explícito, por ejemplo `/v1/managed-people/:subjectId/...`; ese parámetro es una solicitud, nunca autoridad. Una capa de acceso administrado comprueba `actorUserId`, relación activa, versión y capacidad exacta en cada solicitud, dentro de la misma transacción que lee o muta los datos. La revocación se serializa con esas operaciones. No se agrega una política RLS general que permita a un responsable ejecutar cualquier consulta de la persona usuaria.

Después de la comprobación, repositorios estrechos ejecutan la operación en el ámbito RLS del titular. No se expone una transacción arbitraria con `app.user_id` cambiado a los controladores; el servicio de acceso administrado sólo ofrece métodos para contactos, historial y límites. Las rutas de conversación, room token, billetera, grants y firma no aceptan un sujeto ajeno. Si Nani atiende al responsable, su catálogo de herramientas se construye para ese rol y omite transferencias y cambios de firmante. El backend rechaza también una invocación manual de esos endpoints, aunque la UI la oculte.

Crear/editar/quitar contactos reutiliza el único servicio de política y su compositor, con `actorUserId` para auditoría y `subjectUserId` como propietario de la billetera. Los cambios de límites pasan por el mismo escritor y la misma cola versionada; no crean un segundo PATCH de Privy. En este diseño el límite editable es el monto **por transferencia ordinaria**: el producto aún no tiene un límite acumulado Solana activo, y las reglas de grants son otra autorización. El límite ordinario es un valor tipado: `capped(maxLamports)` o `unlimited`. El segundo omite sólo la condición de monto de la regla ordinaria; mantiene destinatarios permitidos, firmante canónico, políticas de grants y cualquier otra restricción que Privy tenga. La UI muestra “Sin límite por transferencia” y el antes/después antes de aplicar. El valor predeterminado de billeteras existentes sigue siendo 0,01 SOL hasta una mutación autorizada.

El commit local de una acción del responsable guarda autor, sujeto, relación/version, cambio e intención de política en una transacción. La aplicación remota necesita serialización por billetera, GET antes de reintentar, comparación estructural y readback del hash/revisión. Se notifican por separado “solicitado/pediente” y “aplicado”; un resultado remoto ambiguo sigue pendiente. No se desmonta una política restrictiva como atajo para representar `unlimited`. Si el proveedor no admite una regla de destinatarios sin condición de monto o la comparación detecta restricciones desconocidas, se bloquea el cambio y se conserva la política anterior.

Revocar una relación impide nuevas operaciones de ese responsable inmediatamente; los demás vínculos activos de la misma persona siguen vigentes. Se cancelan sus propuestas aún no consumidas. Un cambio ya aplicado queda en la política de la persona usuaria y se presenta para revisión; no se revierte silenciosamente. Para intenciones pendientes se serializa la revocación con la cola de política y se impide que una ampliación no aplicada aparezca después de revocar. Un resultado remoto en vuelo se reconcilia antes de declarar el estado final.

### Superficies y compatibilidad

- Frontend: selector de rol previo al login, bandeja/tarjeta de invitación al inicio, perfil de responsable, selector de persona a cargo y gestión clara de contactos/límites. Las claves de caché incluyen actor y sujeto; cambiar perfil o cerrar sesión borra datos ajenos.
- Backend: autenticación Privy actual, relación e invitación persistidas, autorización granular, notificaciones, extensión del servicio único de política y actoría auditada. Se duplican los tipos HTTP front/back conforme a AGENTS.md; no hay importación cruzada.
- Wallet: la billetera Solana y sus firmantes siguen perteneciendo a la persona usuaria. El ingreso de un responsable no debe sincronizar una billetera ajena a su DID. La configuración actual crea billeteras embebidas para todos los ingresos; el programa deberá comprobar cómo evitar una billetera incidental de responsable o dejarla inactiva sin vincularla a la persona a cargo.
- Migración: aditiva, sin reasignar wallets existentes. Las relaciones empiezan vacías; nadie obtiene acceso por ser contacto de confianza. El tope actual y el consentimiento actual siguen vigentes hasta que la persona acepta el nuevo alcance y la política remota queda verificada.

### Fallos y prueba del diseño

Los fallos de Privy al consultar correo verificado bloquean aceptación. Un correo no registrado deja la invitación pendiente sin revelar su existencia. Una invitación vencida/rechazada/revocada no se reactiva con replay. Una lectura iniciada antes de revocar termina con el orden de bloqueo establecido; toda lectura posterior se rechaza. Un cambio de perfil invalida la UI anterior. Un fallo de voz deja la tarjeta disponible. Un fallo de aplicación remota no se informa como éxito.

La verificación de la implementación deberá cubrir: matriz de capacidades por actor/sujeto para todos los endpoints y herramientas; carreras aceptación/revocación/mutación; RLS y aislamiento de caché; múltiples vínculos; inicio con invitaciones y respuesta hablada posterior a la reproducción; rechazo de un “sí” dirigido a otra ventana; política con límite finito y sin límite ante un transporte de Privy de prueba; readback y preservación de reglas no relacionadas; browser E2E y LiveKit E2E. Cualquier prueba live de política sobre una billetera real requerirá revisar el cambio exacto antes de ejecutarlo; este diseño no cambia dinero ni políticas remotas.

### Validaciones técnicas pendientes para el diseño de programa

1. Confirmar en la versión concreta del SDK Privy la lectura de correos vinculados verificados y el control de creación automática de billetera por rol. La documentación oficial muestra que el token de acceso contiene el DID y que los correos verificados viven en `linked_accounts`, no en la autorización de la solicitud: https://docs.privy.io/authentication/user-authentication/access-tokens y https://docs.privy.io/guide/server/webhooks/verify.
2. Probar con transporte controlado que Privy acepta y preserva una política Solana con destinatarios permitidos y sin condición `Transfer.lamports`; comprobar que no amplía otras reglas. La documentación general de Privy reconoce listas y límites, pero no prueba por sí sola esta composición exacta: https://docs.privy.io/security/wallet-infrastructure/policy-and-controls.
3. Confirmar la ruta de consentimiento nuevo del titular para que el responsable pueda administrar límites sin aprobaciones posteriores. Si la propiedad/consentimiento del proveedor no permite esa delegación acotada, se bloquea la administración y se reabre el diseño; no se toma el éxito de un PATCH como prueba suficiente.
4. Confirmar el TTS y `waitForPlayout` en la versión instalada de LiveKit y cómo se señala una interrupción; un cierre de reproducción de un mensaje distinto no arma la invitación.

## Puerta: diseño de sistema

Gate ID: onboarding-roles-system-r1
Decision / allowed mutation: aprobar esta arquitectura y habilitar el diseño de programa.
Explicit exclusions: implementación de código, migraciones ejecutadas, políticas remotas o fondos.
Owning artifact / revision or hash: este TDD, diseño de sistema revisión 1.
Decision owner: Ramiro.
Approved by / trusted identity: Ramiro, respuesta explícita «sí» en esta conversación a la solicitud de aprobación de la revisión 1.
Approved at: 2026-10-10
Status: approved
Invalidated by: —

## Diseño de programa

En preparación. Definirá interfaces, estados, contratos HTTP, migraciones espejo, archivos y verificaciones por slice.
