# Estado actual verificado en código

## Entrada e identidad

- `apps/nana-wallet/src/routes/login.tsx`: `/login` muestra un único botón de ingreso; `useLogin` de Privy acepta correo o teléfono y redirige a `/`.
- `apps/nana-wallet/src/routes/__root.tsx`: el guard redirige toda ruta sin sesión a `/login`; el usuario autenticado que visita `/login` vuelve a `/`. No existe selección de rol.
- `apps/nana-wallet/src/features/wallet/privy-config.ts`: Privy está configurado para crear billeteras embebidas para *todos* los usuarios que ingresan, en Solana y Ethereum. Un responsable con login propio recibiría billetera automáticamente si se reutiliza esa configuración.
- `src/auth/privy-identity.ts` y `src/db/migrations/004_users.sql`: el DID validado de Privy se convierte de forma idempotente en un único UUID de `users`. No hay un campo de rol ni un vínculo entre dos usuarios.

## Acceso a datos y operaciones

- `src/api/me.ts`: `/v1/me` sólo devuelve el UUID y nombre del propio usuario autenticado.
- `src/db/client.ts`: cada transacción de datos usa `app.user_id`; RLS deja ver las filas del titular. La identidad de un responsable no puede consultar filas de otra persona con el contrato actual.
- `src/api/contacts.ts` y `src/wallet/policy/service.ts`: el contacto de confianza se crea, edita o elimina bajo el usuario autenticado. La mutación sincroniza la intención de política de destinatarios con Privy.
- `apps/nana-wallet/src/routes/perfil.tsx` y `apps/nana-wallet/src/features/wallet/WalletLifecycle.tsx`: los permisos de pago y contactos se administran desde Perfil. El alta de firmante usa autorización del propietario de la billetera.
- `apps/nana-wallet/src/routes/mi-plata.tsx`, `src/api/wallets.ts` y `src/api/wallet.ts`: saldo y actividad pertenecen al usuario resuelto; el historial de la billetera se obtiene desde su billetera, no desde una relación familiar.
- `src/api/grants.ts`: hay API para crear, listar y revocar autorizaciones delegadas de pagos, también limitada al titular autenticado. Esa autorización de pagos no equivale a un rol humano de responsable.
- `src/db/migrations/006_embedded_wallets.sql`: el modelo permite una sola billetera Solana activa por `user_id` interno. Dos perfiles con billetera bajo el mismo DID no funcionan hoy sin separar identidad de cuenta y titularidad de billetera.
- La documentación oficial de Privy indica que se pueden vincular varios métodos de ingreso a una misma cuenta, pero también que las acciones de una billetera responden a sus claves de autorización y políticas. Vincular otro método de ingreso al mismo DID no le daría a esta API una identidad distinta para atribuir quién confirmó una acción: https://docs.privy.io/authentication y https://docs.privy.io/security/wallet-infrastructure/policy-and-controls.
- `apps/nana-wallet/src/features/notifications/useNotificationsFeed.ts` y `src/api/notifications.ts`: ya existe una bandeja autenticada, lectura y marcado de leído, pero no presenta invitaciones de vinculación ni tiene una acción de aceptar/rechazar.
- `src/livekit/create-agent-session.ts`: Nani inicia la sesión con un saludo y lectura de saldo. La lectura de invitaciones al comienzo necesita una precedencia explícita y una confirmación tipada de vínculo, distinta del gate de transferencia.
- `src/wallet/embedded.ts`, `src/wallet/policy/composer.ts`, `src/wallet/policy/service.ts` y `src/contracts/http.ts`: el tope de 0,01 SOL está fijado y validado en más de una capa, además de la política remota. “Sin tope” es un cambio de contrato y de autorización, no sólo un campo nuevo de interfaz.

## Implicaciones

1. Un selector visual de rol por sí solo no otorga acceso: hacen falta identidades separadas o una decisión explícita de cuenta compartida, vínculo verificable, autorización por operación y revisión de RLS.
2. El correo escrito por el responsable sirve para invitar o buscar una vinculación pendiente; por sí solo no prueba que controle la cuenta de la persona usuaria ni autoriza leer su billetera.
3. “Modificar políticas” necesita un alcance exacto. Las políticas actuales incluyen destinatarios permitidos, el tope de transferencia, firmantes y autorizaciones delegadas; no conviene asumir que todas son editables por igual.
4. Con dos ingresos Privy, el titular de la billetera y quien puede firmar deben seguir siendo inequívocos. El acceso de consulta o gestión del responsable necesita revocación y auditoría independientes de Privy login.
5. La decisión recibida es que la cuenta del responsable pueda abrir ambos perfiles mientras la persona usuaria conserva identidad propia. El diseño técnico deberá distinguir `cuenta que ingresa`, `perfil que se muestra` y `billetera que se opera`. No se puede reutilizar `user_id` como si esas tres cosas fueran siempre la misma.

## Decisiones abiertas

- ¿La persona usuaria ingresa con su Privy propio y acepta un vínculo, o el responsable crea y usa ambos perfiles desde su login?
- ¿Puede el responsable sólo administrar contactos/límites/políticas, o también preparar/confirmar transferencias y activar/revocar firmantes?
- ¿Quién acepta la vinculación si la persona usuaria no puede completar el ingreso? Hay que definir el mecanismo de consentimiento o representación antes de otorgar acceso.
- ¿Un usuario puede tener varios responsables y un responsable varias personas a cargo? ¿Cómo se revoca y qué ocurre con invitaciones pendientes?
