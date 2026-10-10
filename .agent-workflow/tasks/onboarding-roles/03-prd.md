# PRD: onboarding de persona usuaria y responsable

Estado: **borrador para discusión; sin aprobación**. Fecha: 2026-10-10.

## Persona y problema

Nana Wallet hoy lleva a cualquier visitante a un único ingreso de Privy. No explica si viene a manejar su propia billetera o a acompañar a otra persona, y no dispone de un vínculo entre esas funciones. Una persona responsable necesita entrar, identificar a quien acompaña y consultar contactos, transacciones y límites, además de modificar las políticas que se le permitan.

## Decisión de producto recibida

Ramiro eligió **una cuenta del responsable para ambos perfiles**. Esto define que el responsable inicia con su cuenta de Privy y puede acceder a su propio perfil y al perfil de la persona a cargo. Falta precisar si la persona usuaria también tendrá un ingreso propio vinculado a su perfil o si comparte el ingreso del responsable. Esa diferencia afecta quién puede confirmar pagos y qué puede atribuirse a cada persona.

| Forma de entrar de la persona usuaria | Qué puede distinguir Nana | Implicación para la billetera |
| --- | --- | --- |
| Misma credencial Privy del responsable | Sólo un DID; ambos usan la misma autoridad | El responsable controla la billetera y no se puede atribuir quién escuchó a Nani o confirmó un pago. |
| Otro método de ingreso asociado a la misma cuenta Privy | Sigue siendo un DID para esta API | Diferentes correos o teléfonos no equivalen a distintos actores autorizados. |
| Identidad Privy propia vinculada al perfil creado por el responsable | Dos DID y acciones atribuibles | Requiere definir titular de la billetera, consentimiento y delegación de gestión. El responsable conserva acceso a ambos perfiles desde su cuenta. |
| La persona usuaria no entra | Sólo el responsable opera | Nana funciona para la persona a cargo exclusivamente a través del responsable; no preserva el uso directo anterior. |

## Flujo propuesto

1. Al abrir Nana sin sesión, aparece una pantalla simple: “¿Vas a usar tu billetera o acompañás a otra persona?” con acciones “Uso mi billetera” y “Soy responsable”. Se explica qué permite cada opción antes de pedir datos.
2. “Uso mi billetera” conserva la experiencia de ingreso Privy y acceso a Nani/billetera. Si todavía no existe perfil, se crea al completar el ingreso. No se pierde una billetera ya existente.
3. “Soy responsable” inicia sesión con Privy y crea un perfil de responsable dentro de su cuenta. Desde ahí agrega a una persona a cargo mediante un dato de contacto verificable, en lugar de recibir acceso por escribir un correo arbitrario.
4. La relación queda **pendiente** hasta que se cumpla el mecanismo de vinculación que se apruebe. Mientras tanto no se muestran saldo, contactos ni transacciones de la otra persona.
5. Una vez activa, el responsable elige el perfil de la persona a cargo desde un selector claro y entra a un panel identificado permanentemente con su nombre. Ve contactos de confianza, actividad y límites vigentes. Las acciones de política requieren una revisión clara de qué permiso cambia y un resultado remoto verificado o un estado pendiente visible.
6. La relación se puede terminar; al hacerlo cesan inmediatamente las lecturas y escrituras del responsable sobre ese perfil. Queda un registro de quién hizo cada cambio y cuándo.

## Comportamiento y límites propuestos

- Elegir “responsable” o “usuario” organiza la experiencia inicial; no concede permisos por sí mismo.
- El cambio de perfil modifica el contexto visible y el sujeto autorizado en el servidor. Nunca se decide sólo en el navegador ni por el correo declarado.
- El responsable puede consultar contactos, historial y límites de la persona vinculada. El alcance exacto de “modificar políticas” y cualquier capacidad de mover dinero se resuelve antes de implementación.
- En una sesión con perfil ajeno, todas las pantallas y confirmaciones indican claramente de quién es la billetera.
- El usuario existente conserva su acceso y sus datos; no se reasigna automáticamente su billetera a una cuenta nueva.
- Si se comparte una única credencial de Privy, el sistema no puede atribuir una acción a una persona física distinta de quien controla esa credencial. El producto no afirmará lo contrario.

## Éxito observable

- Dos caminos de entrada visibles antes del login.
- El responsable puede iniciar sesión, crear su perfil y solicitar un vínculo sin ver datos de una persona sólo por conocer su correo.
- Una vinculación activa habilita exactamente las lecturas y los cambios de política aprobados para el perfil correcto.
- Un responsable sin vínculo, con vínculo pendiente o revocado no puede acceder a esos datos por API, voz o UI.
- Cada cambio de política muestra el antes/después y el estado real de aplicación en Privy; no presenta como aplicado lo que sigue pendiente.
- El ingreso existente de la persona usuaria sigue funcionando con su billetera y sus confirmaciones de pago.

## No objetivos en esta etapa

- Compartir claves, semillas o tokens Privy.
- Dar acceso a la billetera por mera coincidencia de correo.
- Cambiar el flujo de preview y confirmación de transferencias.
- Habilitar modos EVM o cambiar la red Solana devnet.

## Preguntas de producto pendientes

1. ¿La persona usuaria tiene ingreso propio vinculado a su perfil, comparte el login de Privy del responsable o no entra sola? Pregunta enviada a Ramiro.
2. ¿Cómo se demuestra y acepta la relación cuando la persona usuaria no puede completar el ingreso?
3. ¿Qué cambios precisos puede hacer el responsable: destinatarios, tope por transferencia, límites acumulados, autorizaciones delegadas y/o firmantes? ¿Puede alguna vez confirmar envíos?
4. ¿Se permiten varios responsables por persona, y varias personas por responsable?

## Puerta de aprobación

Gate ID: onboarding-roles-prd-r1
Decision / allowed mutation: aprobar comportamiento de producto; luego elaborar diseño de sistema.
Explicit exclusions: implementación, cambios de políticas, fondos y credenciales.
Owning artifact / revision or hash: este PRD, revisión 1 (pendiente de cerrar preguntas).
Decision owner: Ramiro.
Approved by / trusted identity: —
Approved at: —
Status: proposed
Invalidated by: —
