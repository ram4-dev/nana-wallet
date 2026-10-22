# Research

Fecha: 2026-10-22

- Supabase CLI está autenticada y ve la organización de Nana Landing `qaodimxknesgkicsqtoo`; el proyecto anterior está en `us-east-1`.
- `npx supabase projects create --help` requiere o acepta `--db-password`; la contraseña debe llegar desde una vía segura para que el runtime también pueda conectarse. La referencia oficial indica que CLI la solicita si no se provee.
- El repo estaba enlazado a `aitxhgxmiwfazynmcchs`; se ejecutó `npx supabase unlink --yes`. La lista confirma `linked: false` para `nana_wallet_landing`; el ref ignorado local fue removido.
- La lista de proyectos no muestra un Nana Wallet aislado aún.
- `vault-env` no pudo conectarse a `http://100.94.34.87:8100` (timeout); `VAULT_URL=http://127.0.0.1:8100 vault-env list` devolvió conexión rechazada.
- Por falta de una vía autorizada para provisionar la nueva contraseña, no se creó el proyecto ni se enlazó un ref nuevo.
- No se inspeccionaron valores de credenciales.

## Evidence sources

- CLI local: `npx supabase projects list --output json`, `npx supabase projects create --help`, `npx supabase unlink --yes`.
- Supabase CLI reference: https://supabase.com/docs/reference/cli/supabase-db-remote
- Supabase local workflow (password prompt): https://supabase.com/docs/guides/local-development/cli-workflows

## Updated evidence (2026-10-22)

- Vault is available again and Supabase CLI project listing shows a separate active healthy project `nana_app`, ref `jnhemqouecznsziytzhm`, in the intended org/region. Its `NANA_SUPABASE_URL` secret matches this ref (checked without printing the value).
- User directed inline execution. The existing project was adopted; no duplicate project was created. Current CLI link, dry-run, and migration ledger evidence is in `05-implementation-evidence.md`.
