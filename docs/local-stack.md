# Stack local Privy

Desde la raíz del repositorio:

```bash
npm run dev:stack
```

El comando obtiene credenciales desde `vault-env`, valida el proyecto remoto
Nana Wallet, inicia LiveKit, API, worker y los dos sidecars de firma, y publica
el frontend en `https://nana-privy.localhost`.

En la primera ejecución, Portless puede pedir autorización de macOS para abrir
HTTPS en el puerto 443 y confiar su CA local. Completá el diálogo del sistema.
No agregues un puerto a la URL: Privy autoriza ese origen exacto. Se requieren
Node 22.18 o posterior y las CLI `vault-env`, `portless` y Docker. El comando
instala las dependencias Node que falten y puede iniciar Colima en macOS.

Para validar dependencias sin crear contenedores:

```bash
npm run dev:stack -- --check
```

El arranque termina con `Stack listo` cuando pasan HTTPS, API same-origin,
binding sin autenticar, WSS por `/livekit`, una consulta remota de solo lectura,
el signer y el registro del worker. La room usada para WSS se elimina al final.

El proyecto Docker se llama `nana-dev-stack`. Compila una sola imagen antes de
iniciar los servicios; no ejecuta cuatro compiladores al arrancar. El estado
local queda en `.cache/dev-stack` del checkout principal, incluso si ejecutás
desde un worktree. Allí se guardan con permisos restringidos
el par Ed25519 de binding, el token de los sidecars, la clave privada que se
monta solamente en esos sidecars y las claves públicas de Privy. El comando no
ejecuta migraciones ni escribe datos en Supabase.

La conexión SQL usa `sslmode=verify-full` y el certificado público de Supabase,
que se descarga y monta sólo en API y worker. Se comprueban CA y hostname,
siguiendo la [configuración SSL de Supabase](https://supabase.com/docs/guides/platform/ssl-enforcement).

Si habías usado los comandos manuales de esta sesión, no mantengas sus API y
workers duplicados junto al stack nuevo. El error `Exited (137)` con
`OOMKilled=true` indica falta de memoria; en esta máquina ocurrió al conservar
esos duplicados y compilar por separado en cada servicio. El launcher no detiene
otros proyectos para liberar memoria.

Si el rango de media está ocupado, elegí otro inicio:

```bash
NANA_LIVEKIT_MEDIA_START=18892 npm run dev:stack
```

Si `nana-privy.localhost` pertenece a otro frontend, el launcher se detiene
antes de reemplazarlo. Detené ese proceso y reintentá. Las ejecuciones
siguientes reutilizan el frontend iniciado por el launcher cuando conserva los
mismos targets. Si los puertos Docker cambian, reinicia solamente ese proceso.

Para inspeccionar un fallo:

```bash
docker logs nana-dev-stack-backend-1
docker logs nana-dev-stack-voice-worker-1
docker logs nana-dev-stack-backend-signer-1
docker logs nana-dev-stack-voice-worker-signer-1
portless doctor
```

En el health global del backend, Privy informa `provider.status=degraded`
porque la wallet se evalúa por usuario. Ese endpoint no recibe un usuario y por
eso nunca acredita una wallet individual. El
launcher acepta exactamente ese estado de infraestructura si el signer figura
como `verified`; cualquier otro estado degradado o un signer no capaz falla el
arranque. El login, micrófono y audio siguen siendo la comprobación manual por
usuario.

Prueba local del proxy en Chromium, sin base ni wallet remotas:

```bash
node --import tsx apps/nana-wallet/scripts/dev-proxy-e2e.mjs
```

Al abrir el stack real, el front retira su service worker de MSW anterior y
recarga una vez si todavía controlaba la página. Los demás service workers del
origen se conservan.
