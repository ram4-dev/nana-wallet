# PRD: onboarding de persona usuaria y responsable

Estado: **PRD completo aprobado**. Fecha: 2026-10-10.

## Persona y problema

Nana Wallet hoy lleva a cualquier visitante a un único ingreso de Privy. No explica si viene a manejar su propia billetera o a acompañar a otra persona, y no dispone de un vínculo entre esas funciones. Una persona responsable necesita entrar, identificar a quien acompaña y consultar contactos, transacciones y límites, además de modificar las políticas que se le permitan.

## Decisiones de producto recibidas

- El responsable entra con su **propia cuenta Privy** y desde ella puede abrir su perfil y los perfiles de personas vinculadas. “Una cuenta del responsable para ambos perfiles” describe el acceso desde su sesión, no una credencial compartida.
- La persona usuaria conserva **su propio ingreso Privy**, su billetera y el flujo actual de Nani. Puede aceptar una invitación del responsable desde su sesión. El correo indicado por el responsable no concede acceso por sí solo.
- La invitación pendiente aparece **al comienzo de la experiencia**. Nani la lee en voz alta, identifica al responsable y pregunta si la persona quiere vincularlo. También hay aceptar/rechazar en pantalla.
- El responsable puede consultar contactos, transacciones y límites; puede cambiar contactos y límites. **No puede mover dinero** desde la billetera de la persona usuaria.
- Se permiten varios responsables por persona usuaria y varias personas a cargo por responsable.
- El responsable puede fijar un límite o **quitarlo por completo**. “Sin límite” permite a la persona usuaria confirmar transferencias de cualquier importe que su saldo y las demás reglas permitan; no habilita al responsable a enviarlas.
- El responsable puede aplicar **sin una aprobación adicional** los cambios de contactos y límites de una persona vinculada. La persona usuaria recibe una notificación del cambio y puede revisar el estado de la política y revocar el vínculo.

## Flujo propuesto

1. Al abrir Nana sin sesión, aparece una pantalla simple: “¿Vas a usar tu billetera o acompañás a otra persona?” con acciones “Uso mi billetera” y “Soy responsable”. Se explica qué permite cada opción antes de pedir datos.
2. “Uso mi billetera” conserva la experiencia de ingreso Privy y acceso a Nani/billetera. Si todavía no existe perfil, se crea al completar el ingreso. No se pierde una billetera ya existente.
3. “Soy responsable” inicia sesión con su propio Privy y crea su perfil. Escribe el correo de la persona a cargo para enviarle una invitación. Puede invitar a varias personas, incluso si todavía no entraron a Nana; la invitación espera hasta que la persona verifica ese correo en su propio ingreso.
4. La relación queda **pendiente**. Mientras tanto el responsable no ve saldo, contactos, transacciones ni límites ajenos.
5. Al entrar la persona usuaria, Nana consulta las invitaciones pendientes antes de mostrar la experiencia habitual de Nani. La tarjeta muestra quién invita y qué podrá ver y cambiar. Si hay sesión de voz, Nani lee esa misma propuesta y pregunta si quiere vincularse. Una aceptación por voz corresponde sólo a la invitación narrada en esa sesión; no sirve para confirmar una transferencia. Rechazarla es igual de sencillo. Si la voz falla, la tarjeta sigue disponible.
6. La aceptación activa el vínculo. El responsable cambia de perfil mediante un selector claro y entra a un panel identificado permanentemente con el nombre de la persona a cargo. Ve contactos, actividad y límites; cada cambio muestra qué permiso se modifica y su estado real en Privy. Los cambios de contactos o límites se aplican por su acción autenticada, sin otra confirmación de la persona usuaria, y ella recibe una notificación del antes/después.
7. La persona usuaria puede revocar el vínculo. Al hacerlo cesan inmediatamente las lecturas y escrituras del responsable sobre ese perfil. Queda un registro de quién hizo cada cambio y cuándo.

## Comportamiento y límites propuestos

- Elegir “responsable” o “usuario” organiza la experiencia inicial; no concede permisos por sí mismo.
- El selector aparece antes del primer ingreso o cuando no hay sesión. En visitas posteriores con sesión activa, Nana recuerda el perfil visible; siempre se puede cambiar de perfil. El responsable no necesita una billetera propia para acompañar a otra persona. Si también usa Nana para sí, su billetera personal es un perfil distinto.
- El cambio de perfil modifica el contexto visible y el sujeto autorizado en el servidor. Nunca se decide sólo en el navegador ni por el correo declarado.
- El responsable puede consultar contactos, historial y límites de la persona vinculada y aplicar cambios de contactos y límites por su cuenta. No puede iniciar, preparar ni confirmar transferencias ajenas por UI, API o agente. Tampoco puede administrar firmantes ni autorizaciones delegadas de pago en este alcance.
- En una sesión con perfil ajeno, todas las pantallas y confirmaciones indican claramente de quién es la billetera.
- El usuario existente conserva su acceso y sus datos; no se reasigna automáticamente su billetera a una cuenta nueva.
- La notificación de invitación se muestra al abrir, antes del saldo y de cualquier pregunta sobre transferencias. Marcarla como leída no equivale a aceptarla. Una decisión se aplica una sola vez y queda registrada con ambas identidades.
- Cada cambio del responsable queda atribuido a su identidad y genera una notificación para la persona usuaria. Si Privy todavía no lo aplicó o no se pudo comprobar, ambas pantallas muestran ese estado, no el cambio como efectivo.
- Al revocar el vínculo se corta el acceso futuro del responsable. Los cambios de política que ya se aplicaron quedan visibles para la persona usuaria, que puede revisarlos o modificarlos; la revocación no altera silenciosamente destinatarios ni límites.
- Hasta que se implemente y verifique el nuevo modelo de límites, la política vigente de 0,01 SOL permanece como está; este PRD no modifica el control remoto. Quitar el límite de monto tampoco elimina la lista de destinatarios permitidos ni el preview y la confirmación de cada envío.

## Éxito observable

- Dos caminos de entrada visibles antes del login.
- El responsable puede iniciar sesión, crear su perfil y solicitar un vínculo sin ver datos de una persona sólo por conocer su correo.
- La persona usuaria ve la invitación al entrar, escucha a Nani leerla si usa voz y puede aceptarla o rechazarla sin confundir esa respuesta con una autorización de pago.
- Una vinculación activa habilita exactamente las lecturas y los cambios de política aprobados para el perfil correcto.
- Un responsable sin vínculo, con vínculo pendiente o revocado no puede acceder a esos datos por API, voz o UI.
- Ninguna ruta o herramienta del responsable puede enviar fondos desde la billetera ajena.
- Cada cambio de política muestra el antes/después y el estado real de aplicación en Privy; no presenta como aplicado lo que sigue pendiente.
- La persona usuaria recibe notificación cuando el responsable agrega o quita un contacto, aumenta o baja un límite, o lo desactiva. El responsable no puede ocultar esa actividad.
- El ingreso existente de la persona usuaria sigue funcionando con su billetera y sus confirmaciones de pago.

## Escenarios de aceptación

1. El responsable entra primero, invita a una persona que aún no tiene Nana y sale. Cuando ella verifica su correo en Privy y entra por primera vez, ve la invitación antes de su cartera; no se transfieren datos ni permisos hasta su aceptación.
2. La persona usuaria ya tiene billetera: recibe la invitación en su sesión actual. Al decir “sí” después de que Nani lee quién invita y qué acceso pide, se activa únicamente ese vínculo. Si dice “no”, no se activa. Si no hay voz, puede decidir en la tarjeta.
3. Una transferencia pendiente y una invitación no comparten confirmación. La interfaz y Nani muestran sólo una pregunta accionable a la vez; un “sí” no resuelve la otra operación.
4. El responsable vinculado abre una de varias personas a cargo y ve su nombre, contactos, transacciones y límites correctos. Cambiar de perfil no reutiliza datos cacheados de la persona anterior.
5. El responsable intenta confirmar una transferencia ajena por voz, texto o HTTP: se rechaza sin crear preview ejecutable ni operación.
6. La persona usuaria revoca el vínculo mientras el responsable tiene una pantalla abierta. La siguiente lectura o mutación se rechaza; la pantalla deja de mostrar datos ajenos al actualizarse.
7. El responsable quita el límite de monto. Ve una revisión que indica “Sin límite por transferencia” y confirma el cambio; la persona usuaria recibe la notificación. Hasta verificar la política en Privy, Nana no afirma que el cambio esté activo. La siguiente transferencia de la persona usuaria todavía requiere preview y confirmación propios.
8. El responsable modifica la lista de destinatarios. Si quitar un contacto afecta pagos automáticos, la revisión muestra esos efectos antes de aplicar el cambio. Ningún permiso adicional aparece oculto en la nueva política.

## No objetivos en esta etapa

- Compartir claves, semillas o tokens Privy.
- Dar acceso a la billetera por mera coincidencia de correo.
- Cambiar el flujo de preview y confirmación de transferencias.
- Habilitar modos EVM o cambiar la red Solana devnet.

## Límite del producto definido

Si la persona usuaria no puede entrar a Privy y aceptar la invitación, este flujo no activa el vínculo. Un mecanismo de representación asistida sería un producto separado y requiere una decisión explícita posterior.

## Puerta de aprobación

Gate ID: onboarding-roles-prd-r3
Decision / allowed mutation: aprobar comportamiento de producto; luego elaborar diseño de sistema.
Explicit exclusions: implementación, cambios de políticas, fondos y credenciales.
Owning artifact / revision or hash: este PRD, revisión 3.
Decision owner: Ramiro.
Approved by / trusted identity: Ramiro, respuesta directa “Sí, apruebo el PRD completo (recomendado)” a la pregunta sobre esta revisión.
Approved at: 2026-10-10.
Status: approved
Invalidated by: —
