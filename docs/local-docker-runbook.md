# Runbook: backend local con Docker

Este runbook reemplaza el flujo local `npm ci` + `tsx watch src/server.ts` por
una experiencia 100% Docker: un solo `docker compose --profile dev up` levanta
Postgres (pgvector) + el backend API. No hay deploy cloud (Render, Vercel,
Supabase cloud) acá: eso es otra work unit.

La imagen es la misma para la API y para el worker de voz (`api` y `worker`),
y queda lista para producción cuando se le pasan las variables obligatorias
(`NODE_ENV=production` + `DATABASE_URL` + `DEMO_USER_ID` +
`LIVE_VOICE_BINDING_PRIVATE_KEY`). El perfil de desarrollo local NO setea
`NODE_ENV=production`, así que arranca sin ese gate.

## Requisitos

- Docker + Docker Compose v2 instalados y el daemon corriendo.
- Node.js `>=22.18.0` **solo** si querés correr `npm run typecheck` / `npm run lint`
  contra el repo. El entorno Docker no lo necesita.

## Arranque del entorno

```bash
# Levanta Postgres (pgvector) + la API, y construye la imagen si hace falta.
docker compose --profile dev up -d --build

# Estado de los servicios.
docker compose ps
```

La API queda en `http://localhost:3000` y el healthcheck en
`http://localhost:3000/health`.

> **Caché del modelo de embeddings.** Por defecto la imagen NO hornea el modelo
> (`EMBED_MODEL_PREFETCH=0`); la primera vez que se usa se descarga solo
> (`sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2`) y necesita
> red. Para una imagen autosuficiente, hornealo en el build:
>
> ```bash
> EMBED_MODEL_PREFETCH=1 docker compose --profile dev up -d --build
> ```
>
> `npm run memory:prefetch` corre sin credenciales (no requiere
> `DATABASE_URL`/`DEMO_USER_ID`), así que se puede bakear.

## Voz live contra el LiveKit self-hosted (default local)

El mismo stack Docker incluye el server LiveKit self-hosted (servicio `livekit`,
pinned `v1.13.6`, puertos publicados solo en `127.0.0.1`, sin egress/recording):

```bash
# Levanta Postgres + API + LiveKit self-hosted:
docker compose --profile dev up -d --build

# Suma el worker de voz (se registra contra ws://livekit:7880 interno):
docker compose --profile dev --profile worker up -d --build
```

Requisitos en el `.env` (git-ignored): `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`,
`OPENAI_API_KEY`, `LIVE_VOICE_BINDING_PUBLIC_KEY` y
`LIVE_VOICE_BINDING_PRIVATE_KEY`. La URL del server **no** va en el `.env`
para este modo: la API y el worker la fijan por compose (`ws://livekit:7880`).

Dos URLs para LiveKit (ambas necesarias cuando el backend corre en Docker):

| Variable | Valor | Para qué |
| --- | --- | --- |
| `LIVEKIT_URL` (compose) | `ws://livekit:7880` | Registro del worker y firma de tokens dentro de la red de compose. |
| `LIVEKIT_BROWSER_URL` (.env, default `ws://localhost:7880`) | `ws://localhost:7880` | `serverUrl` que la API devuelve al browser; debe ser alcanzable desde el navegador. |

La firma del room token es del backend (`POST /v1/voice/room-token`); el front
no configura ningún source de LiveKit: siempre usa ese endpoint autenticado.
Contrato de privacidad sin cambios: `record: false`, sin Egress, sin
observability recording, audio solo por loopback.

## Aplicar el esquema de la base

El init de Postgres (`docker/init/001-recipient-app.sql`) crea solo el rol
`recipient_app`. Las tablas y la RLS viven en `supabase/roles.sql` +
`supabase/migrations/*.sql`; hay que aplicarlas como lo hace CI
(`.github/workflows/ci.yml`):

```bash
# Crea el schema "extensions" (vector / pgcrypto van ahí).
docker compose exec -T db psql -U postgres -d wdk_agent -v ON_ERROR_STOP=1 \
  -c "CREATE SCHEMA IF NOT EXISTS extensions;"

# Aplica roles + migraciones, en orden, idempotente como en CI.
for f in supabase/roles.sql supabase/migrations/*.sql; do
  echo "Aplicando $f"
  docker compose exec -T db psql -U postgres -d wdk_agent -v ON_ERROR_STOP=1 < "$f"
done
```

> Este paso replica CI y está pensado para una base recién creada. Las
> migraciones de `conversations` no usan `IF NOT EXISTS`, así que no las
> repitas sobre un esquema ya aplicado: si las corriste una vez, no hace falta
> volver a aplicarlas (o reseteá con `docker compose down -v` para recrear el
> volumen). Es obligatorio para que las rutas de conversación (que dependen de
> `DATABASE_URL` + `DEMO_USER_ID` con `RECIPIENT_MEMORY_ENABLED=true`) puedan
> escribir en la base. Si el esquema no está aplicado, la API arranca pero los
> turns fallan al tocar la base.

### Sembrar datos demo de recipient memory

Para que el agente resuelva destinatarios por nombre ("Lucas"), sembrá los
datos demo (usan el `DEMO_USER_ID` del compose, sin credenciales):

```bash
docker compose exec -T backend node dist/memory/seed.js
```

La primera ejecución descarga el modelo de embeddings (~120MB) al cache del
contenedor; con `EMBED_MODEL_PREFETCH=1` en el build ya viene horneado.

## Variables de entorno

| Variable | Valor por defecto (compose) | Significado |
| --- | --- | --- |
| `HOST` | `0.0.0.0` | Bind de la API dentro del contenedor. |
| `PORT` | `3000` | Puerto HTTP. |
| `DATABASE_URL` | `postgresql://postgres@db:5432/wdk_agent` | Conexión a Postgres del compose. |
| `DEMO_USER_ID` | `00000000-0000-4000-8000-000000000001` | Tenant demo fijo (mismo que CI). |
| `WDK_TOOLS_SOURCE` | `fixture` | Modo seguro sin wallet; `live` requiere el proceso WDK. |
| `RECIPIENT_MEMORY_ENABLED` | `true` | Habilita recipient memory (necesita esquema aplicado + modelo). |
| `AGENT_RUNTIME` | `llm` (si no se setea) | `llm` usa el agente conversacional (requiere `OPENCODE_GO_API_KEY`); `deterministic` es parser-only sin proveedor de modelo. |
| `CORS_ORIGINS` | default `http://localhost:8083` | El backend ya permite el front de dev en `:8083` por defecto. |

Si querés un smoke de texto que no dependa de un proveedor de modelo, sumá
`AGENT_RUNTIME=deterministic` a la sección `backend.environment` del
`compose.yaml` (o levantá el servicio con `docker compose run --rm --profile dev
-e AGENT_RUNTIME=deterministic backend`). Para el flujo LLM completo, proveé
`OPENCODE_GO_API_KEY`.

## Flujo fixture de texto (smoke)

Con el esquema aplicado y el backend arriba, probá un turn.

Con `AGENT_RUNTIME=deterministic` (default del compose si no exportás
`OPENCODE_GO_API_KEY`) el parser entiende balance y envíos con dirección
explícita:

```bash
# Balance:
CONVERSATION_ID=$(curl -s -X POST http://localhost:3000/v1/conversations | jq -r .conversationId)
curl -s -X POST "http://localhost:3000/v1/conversations/$CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' \
  -d '{"message":"Cuanto plata tengo?"}' | jq

# Transferencia a dirección explícita (preview + confirmación):
curl -s -X POST "http://localhost:3000/v1/conversations/$CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' \
  -d '{"message":"manda 1 USDT a 0x1234567890abcdef1234567890abcdef12345678"}' | jq
curl -s -X POST "http://localhost:3000/v1/conversations/$CONVERSATION_ID/turns" \
  -H 'Content-Type: application/json' -d '{"message":"confirmar"}' | jq
```

Con `WDK_TOOLS_SOURCE=fixture` no hay wallet, unlock ni broadcast: la respuesta
es un preview de confirmación (o una aclaración si hay ambigüedad).

Para lenguaje natural completo ("Mandale plata a Lucas", retrieval por
nombre/relación, memoria) necesitás el runtime LLM: exportá
`OPENCODE_GO_API_KEY` antes del `docker compose --profile dev up -d` y seguí la
secuencia de [docs/demo-runbook.md](demo-runbook.md).

## Worker de voz

El worker usa la misma imagen pero arranca `node dist/livekit/worker.js start`.
Está detrás del perfil `worker` y **no** se levanta con `--profile dev`. Necesita
estas variables desde el shell; si falta alguna, el proceso falla al arrancar
(fail-closed):

```bash
# Exportá las env del worker desde el shell, luego levantá el perfil worker.
export LIVEKIT_URL=wss://tu-proyecto.livekit.cloud
export LIVEKIT_API_KEY=...
export LIVEKIT_API_SECRET=...
export LIVE_VOICE_BINDING_PUBLIC_KEY=...   # clave pública Ed25519 del binding
export OPENAI_API_KEY=...

docker compose --profile worker up -d voice-worker
```

## Apuntar el frontend

En `apps/nana-wallet`, setea la URL de la API al backend Docker:

```bash
cd apps/nana-wallet
cp .env.example .env.local
```

```env
VITE_API_URL=http://localhost:3000
```

El backend ya acepta por CORS el front de dev en `http://localhost:8083` (y
`http://127.0.0.1:8083`). Levantá el front con:

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 8083
```

> Con `AGENT_RUNTIME=llm` el backend necesita un proveedor de modelo
> (`OPENCODE_GO_API_KEY`). Para una demo determinista sin red, usá
> `AGENT_RUNTIME=deterministic`.

## Teardown

```bash
# Baja los servicios (sin borrar el volumen de Postgres).
docker compose --profile dev down

# Baja todo, incluido el worker.
docker compose --profile worker down

# Si querés borrar los datos de Postgres:
docker compose down -v
```

## Limitaciones

- `WDK_TOOLS_SOURCE=fixture` es el modo por defecto: **no hay wallet real**, no
  hay unlock ni broadcast. Para wallet live usá el perfil `live` (fuera del
  alcance de este runbook).
- `RECIPIENT_MEMORY_ENABLED=true` requiere que el esquema esté aplicado (paso de
  arriba) y que el modelo de embeddings esté disponible (bakeado o descargado en
  runtime). Sin eso, la API arranca pero los turns fallan al tocar la base o el
  modelo.
- El worker de voz **no** arranca sin las env de LiveKit + `OPENAI_API_KEY`; si
  faltan, se cierra fail-closed. No hay voz live por defecto.
- Este flujo es **local**. El deploy en Render/Supabase cloud y el APK Android
  son work units aparte.
- La imagen no lleva `NODE_ENV=production` de fábrica: el gate de producción se
  activa solo cuando un deploy provee `NODE_ENV=production` + `DATABASE_URL` +
  `DEMO_USER_ID` + `LIVE_VOICE_BINDING_PRIVATE_KEY`.

## Voz live con la wallet real (todo en Docker)

El daemon WDK corre como servicio compose (`wdk-daemon`, perfil `daemon`) y
mantiene el unlock en memoria: sobrevive a recreaciones de backend/worker.

```bash
# 1) Levantar el daemon + stack (el store de wallets vive en el volume wdk_config;
#    se puebla una vez desde el host con docker cp de ~/.config/wdk-cli).
docker compose --profile daemon --profile dev --profile worker up -d

# 2) El humano desbloquea (passphrase, terminal interactiva):
docker compose --profile daemon exec wdk-daemon ./node_modules/.bin/wdk wallet unlock --name agent-dev --ttl 30

# 3) Verificar modo live y balance real:
curl -s http://localhost:3001/health   # {"mode":"live","wallet":"unlocked",...}
```

Notas:
- El token demo se registra en el daemon como **`usdt-test`** (contrato custom de
  Sepolia `0xc4DCC3…5927`); `WDK_TOKEN=usdt-test` en `.env` — el símbolo `USDT`
  suelto no resuelve.
- El socket del daemon comparte el volume `wdk_config` (mismo docker VM); el
  daemon fuerza umask 077, y el entrypoint re-aplica chmod 666 al socket para
  que backend/worker (usuario `node`) puedan conectar.
- En macOS/Colima los mounts de unix sockets del host son `ENOTSUP`: por eso el
  daemon corre dentro de la VM de docker, nunca en el host con mount.
- Gates de broadcast (`WDK_LIVE`, `WDK_ALLOW_BROADCAST`, `WDK_BROADCAST_APPROVED`)
  son decisión explícita del humano en `.env`.
