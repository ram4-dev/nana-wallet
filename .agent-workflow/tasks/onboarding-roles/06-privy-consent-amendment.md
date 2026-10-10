# Enmienda propuesta: autoridad del responsable sobre políticas

Estado: **pendiente de decisión**. Esta enmienda modifica el límite de confianza del diseño de sistema y de programa revisión 1 de `04-tdd.md`; no cambia el comportamiento de producto aprobado en `03-prd.md`.

## Evidencia que obliga a decidir

El SDK fijado `@privy-io/node@0.34.0` permite obtener un usuario por DID y leer sus `linked_accounts` de tipo email con `verified_at`. El token autenticado prueba el DID, no el correo. Esto permite que Nana vincule una invitación al correo verificado del titular sin confiar en texto del navegador.

Privy autoriza el PATCH de una política mediante una firma de un owner/firmante admitido. La integración actual firma mutaciones con el sidecar del servidor (`src/wallet/privy-server-client.ts`). Privy no contiene una entidad `guardian` ni una capacidad limitada a `contacts.write` o `limits.write` ligada al DID del responsable. Un GET/readback de Privy demuestra la política y el firmante aplicados, pero **no** que la persona usuaria consintió que este responsable pueda ordenar futuros cambios ni que el responsable siga vinculado. Esa prueba y su revocación tienen que ser de Nana. Documentación oficial: https://docs.privy.io/controls/policies/update-a-policy y https://docs.privy.io/controls/authorization-keys/owners/configuration/user/server-updates.

La DSL documenta una regla Solana `ALLOW` restringida por `Transfer.to` sin condición de monto. Esto hace plausible `unlimited` sin quitar la allowlist, pero todavía falta una prueba de transporte controlado y readback del proveedor antes de activarlo. Referencia: https://docs.privy.io/controls/policies/condition-sets.

## Cambio de arquitectura recomendado

1. La persona usuaria autenticada con su DID acepta la invitación y, en un paso explícito, acepta el alcance amplio: el responsable identificado podrá agregar/quitar destinatarios y fijar o quitar el límite por transferencia sin pedir permiso cada vez. La pantalla presenta el estado actual de la billetera, el firmante existente y la diferencia respecto de 0,01 SOL. La acción lleva versión, idempotencia y sesión vigente; el backend verifica que la billetera pertenece a ese DID.
2. Nana persiste una autorización inmutable ligada a `beneficiaryUserId`, `guardianUserId`, relación/version, alcance, texto/version mostrados y momento de la aceptación. No guarda token ni firma secreta. El estado de relación pasa a `active` sólo tras un GET de Privy que comprueba la wallet, el firmante canónico y la política adjunta. El GET no se describe como prueba del consentimiento: la prueba de consentimiento es la decisión autenticada en Nana.
3. Cada solicitud del responsable verifica relación activa y capacidad exacta en el servidor. El servicio de Nana firma la modificación remota mediante el sidecar actual y lee la política después; el DID del responsable nunca recibe una llave ni firma en Privy. Revocar corta inmediatamente las nuevas solicitudes del responsable y la cola cancela/reconcilia las pendientes según el TDD.
4. Privy sigue imponiendo el contenido de la política al ejecutar una transferencia. La autorización para **cambiar** ese contenido según la relación responsable–titular depende del backend de Nana. Un servidor comprometido podría omitir ese chequeo; Privy no ofrece aquí una segunda condición vinculada al DID del responsable. Esto es un límite de confianza explícito, no una garantía del proveedor.
5. Si la versión instalada no permite demostrar la allowlist sin monto o el readback de firma/política, `limits.write` y la ampliación remota quedan cerrados; `contacts.write` sigue sujeto a la prueba de consentimiento de Nana y a la política existente. El estado `accepted_pending_policy_authorization` muestra el bloqueo sin informar éxito.

## Alternativa sin este límite de confianza

Mantener `accepted_pending_policy_authorization` en sólo lectura y no permitir al responsable cambiar contactos ni límites hasta disponer de un mecanismo de Privy que exprese guardian y alcance por DID. Esto conserva el diseño anterior literalmente, pero no entrega la gestión que el PRD pidió.

## Puerta de decisión

Gate ID: onboarding-roles-consent-boundary-r2
Decision / allowed mutation: aceptar que Nana compruebe consentimiento, capacidades y revocación del responsable, con Privy como autoridad del firmante y verificador de la política aplicada, y continuar los slices de gestión.
Explicit exclusions: otorgar claves al responsable, enviar dinero, cambiar una política real en esta aprobación, relajar preview/confirmación, o afirmar que Privy verifica la relación.
Owning artifact / revision or hash: esta enmienda revisión 1; si se aprueba, incorporar la precisión en `04-tdd.md`, `05-structure-outline.md` y SDD antes del código de políticas.
Decision owner: Ramiro.
Approved by / trusted identity: —
Approved at: —
Status: proposed
Invalidated by: —
