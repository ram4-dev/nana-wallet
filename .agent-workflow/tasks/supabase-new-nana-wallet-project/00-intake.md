# Nuevo proyecto Supabase para Nana Wallet

## Outcome
Crear `nana-wallet-primary` en un proyecto Supabase nuevo y aislado, y enlazar el repositorio de Nana Wallet. Nana Landing y su waitlist quedan fuera de alcance.

## Acceptance evidence
- El proyecto nuevo existe en la organización aprobada y está `ACTIVE_HEALTHY`.
- Este repo está enlazado al nuevo ref, nunca al proyecto de Nana Landing.
- La cadena `supabase/migrations/` y `supabase/roles.sql` quedan aplicadas y verificadas en el proyecto nuevo.
- La conexión de runtime se provisiona por Vault y una conexión real de app queda verificada.

## Authority and boundaries
- Ramiro indicó: crear y enlazar un proyecto nuevo para Nana Wallet, sin tocar Nana Landing.
- Parámetros inferidos para completar el pedido: nombre `nana-wallet-primary`, organización existente `qaodimxknesgkicsqtoo`, región `us-east-1`.
- Read scope: configuración y migraciones de Nana Wallet; metadatos de organización/proyectos Supabase.
- Pending external write: crear el nuevo proyecto, enlazarlo y aplicar su esquema.
- Secret boundary: no generar, mostrar ni leer contraseñas manualmente; requiere el flujo aprobado `vault-env`.
- Exclusiones: no volver a enlazar ni modificar `nana_wallet_landing`, no tocar Nana Landing repo, no hacer reset ni incluir datos seed de producción.

## Route
RPI: la decisión de separar los proyectos ya fue tomada; se conserva investigación, un outline verificable y validación antes de la provisión externa.

## Active state
Decisión de arquitectura aprobada por Ramiro el 2026-10-22. Provisión bloqueada hasta recuperar el acceso a Vault para pasar una contraseña nueva mediante `vault-env`.

## Prior actions to disclose
Antes de la aclaración de Ramiro, se aplicó `supabase/roles.sql` al proyecto Nana Landing. El repo ya fue desenlazado localmente de ese proyecto. No se aplicó ninguna migración de Nana Wallet ni se modificaron tablas/datos de waitlist. El rol `recipient_app` quedó creado allí; no se intentará retirarlo sin una instrucción explícita, para respetar el pedido actual de no tocar Nana Landing.

## Final status amendment (2026-10-22)
The active healthy separate project already existed as `nana_app` (`jnhemqouecznsziytzhm`), so it was adopted instead of creating a duplicate named `nana-wallet-primary`. Repo link and 18 Nana Wallet migrations plus role bootstrap are verified. The deployed runtime connection acceptance item remains pending; see `05-implementation-evidence.md`.
