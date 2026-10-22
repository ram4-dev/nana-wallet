# Research questions

1. ¿Qué organización, región y autenticación CLI están disponibles?
   - Confirmar con `supabase projects list`; nunca asumir una sesión.
2. ¿Qué requiere la creación de un proyecto nuevo?
   - Confirmar flags y estado con `supabase projects create --help` y documentación oficial.
3. ¿Hay un camino autorizado para entregar una contraseña nueva sin pasarla por el agente?
   - Usar `vault-env`; informar el nombre de clave requerido y el error sin imprimir valores.
4. ¿Qué pruebas demuestran que el proyecto nuevo quedó aislado y enlazado correctamente?
   - Consultar lista/status, `supabase link`, migraciones, rol y conexión de runtime.

Alcance excluido: cambios a Nana Landing, lectura de secretos, reset o despliegue de datos de prueba.

## Answers from final execution (2026-10-22)

1. Supabase CLI authenticated; target is active healthy `nana_app` in the intended organization and region.
2. A separate project already existed, so we adopted it instead of creating a duplicate.
3. Credentials were provided through Vault; values were never printed or read.
4. `supabase migration list --linked` matched all 18 local/remote versions; `supabase db push --dry-run --include-roles` reported no pending migrations. Runtime app connection proof remains pending deployment secret-store configuration.
