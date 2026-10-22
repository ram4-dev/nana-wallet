# Nana Wallet

## Empezar

Dos partes separadas: el **frontend** (`apps/nana-wallet/`, corre solo con MSW y
no necesita el backend) y el **backend** (raíz; Fastify + PostgreSQL/pgvector).

```sh
# Frontend — no necesita backend
cd apps/nana-wallet && npm ci && npm run dev -- --host 0.0.0.0 --port 8083

# Backend — from the repo root (local Supabase: disposable dev stand-in for the remote primary DB)
npm ci && npx supabase start && npx supabase db reset && npm run dev
```

El frontend queda en http://localhost:8083 y la API en http://localhost:3000.
Detalle en [Ejecutar localmente](#ejecutar-localmente), el
[runbook Docker](docs/local-docker-runbook.md) y [docs/api.md](docs/api.md).

Wallet agéntica argentina diseñada para personas mayores y personas con discapacidad. Nana reduce la complejidad de una billetera tradicional: el usuario puede pedir una acción con lenguaje cotidiano, revisar claramente qué va a ocurrir y confirmar antes de mover dinero.

> **Estado:** entrega del Aleph Hackathon 2026 para el Track 1 — Build with the WDK CLI. El repositorio contiene un frontend funcional y un backend HTTP que corre una única configuración: Solana devnet a través de Privy, con wallets por usuario.

## Aleph Hackathon 2026 — WDK Track

Track oficial: [WDK Track](https://hacki.crecimiento.build/h/aleph-hackathon-2026/tracks/wdk-track).

Nana es una wallet agéntica para personas mayores y personas con discapacidad. El usuario puede pedir una transferencia en lenguaje cotidiano, revisar red, token, destinatario, importe y fee, y confirmar explícitamente antes de que el agente intente ejecutarla. El backend resuelve una wallet Solana devnet por usuario a través de Privy y firma mediante un sidecar local (`npm run signer:serve`); el proceso de la API y el del worker nunca leen una clave privada.

Para iniciar el stack local con Privy y la Supabase remota de Nana Wallet, seguí [docs/local-stack.md](docs/local-stack.md).

### WDK usado

Los paquetes WDK declarados en [`package.json`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/package.json#L30-L32) son:

- `@tetherto/wdk@1.0.0-beta.14` — runtime WDK.
- `@tetherto/wdk-cli@1.0.0-beta.2` — CLI y proceso MCP (`wdk-mcp`).
- `@tetherto/wdk-wallet-evm@1.0.0-beta.11` — wallet EVM.

Permalinks de la integración WDK en el commit público [`71509cc`](https://github.com/theboyplunger0x/nana-wallet/commit/71509cc1957d90fedd95255f0a1241fddbf0ff0b):

- [`src/wdk/mcp-client.ts#L117-L118`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/wdk/mcp-client.ts#L117-L118) — resuelve el proceso MCP WDK incluido.
- [`src/wdk/mcp-client.ts#L213-L220`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/wdk/mcp-client.ts#L213-L220) — configura el spawn del proceso bundled `wdk-mcp` por stdio.
- [`src/agent/wdk-tools.ts#L39-L49`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wdk-tools.ts#L39-L49) — propaga `WDK_INDEXER_API_KEY` al proceso WDK sin exponerla.
- [`src/agent/wdk-tools.ts#L72-L103`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wdk-tools.ts#L72-L103) — expone las herramientas WDK al agente, incluido `send_token`.
- [`src/api/wallet.ts#L17-L50`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/api/wallet.ts#L17-L50) y [`#L52-L100`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/api/wallet.ts#L52-L100) — adapta las respuestas oficiales de balance e historial WDK al contrato HTTP.
- [`src/agent/wallet-agent.ts#L147-L211`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wallet-agent.ts#L147-L211) y [`#L394-L455`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wallet-agent.ts#L394-L455) — aplica la policy live y las guardas de preview/confirmación al `send_token`.
- [`src/wdk/transaction-receipt.ts#L164-L212`](https://github.com/theboyplunger0x/nana-wallet/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/wdk/transaction-receipt.ts#L164-L212) — verifica chain ID Sepolia, hash, receipt y estado confirmado/revertido después del broadcast.

### Demo

- **BLOCKER DE ENTREGA — video de demo:** TODO — agregar aquí la URL pública del video antes de enviar la candidatura. No se inventa un enlace mientras no exista uno real.
- **Red de referencia:** Solana devnet.
- **Token de demo:** `SOL` nativo (alias WDK `SOL`).
- **Configuración única:** Solana devnet a través de Privy, con wallets por usuario; no hay un modo fixture ni un switch de proveedor que configurar.

Cada usuario firma con su propia wallet alojada en Privy. Este README no contiene seeds, claves privadas ni credenciales.

## Experiencia

La aplicación se organiza en tres espacios sencillos:

- **Mi perfil:** familia y contactos guardados, agenda, facturas y datos personales.
- **Nana:** agente por texto o voz que interpreta pedidos y prepara acciones para confirmar.
- **Mi plata:** saldo disponible, cuentas y movimientos.

El flujo de pago siempre muestra destinatario, importe, cuenta de origen y advertencias antes de habilitar la confirmación. Las confirmaciones usan una clave de idempotencia y distinguen un rechazo definitivo de un error de red ambiguo para evitar informar incorrectamente que una operación falló.

## Stack

- React 19 y TypeScript
- TanStack Start, Router y Query
- Tailwind CSS 4 y shadcn/ui
- Capacitor 8 para Android e iOS
- MSW para la API simulada local
- Vitest y Testing Library
- Backend WDK con Node.js, Fastify y Tether WDK/MCP

## Estructura

Son dos partes bien separadas: el backend vive en la raíz (`src/`) y el frontend en `apps/nana-wallet/`. El backend define el contrato HTTP (zod) y el front lo replica a mano; nunca se cruza el límite.

```text
.
├── src/                        # Backend — Node 22, Fastify, LiveKit Agents, WDK/MCP
│   ├── agent/                  # Definición del agente, herramientas, instrucciones (LLM/determinístico)
│   ├── api/                    # Rutas HTTP (health, wallet, conversaciones, voz)
│   ├── wdk/                    # Cliente MCP WDK, receipt de transacción y lecturas directas
│   ├── wallet/                 # Providers de wallet (wallet Solana devnet por usuario vía Privy)
│   ├── conversations/          # Estado de sesión, idioma, intenciones, registro de tareas financieras
│   ├── livekit/                # Worker de voz (AgentSession nativo, adaptadores, publisher de revisiones)
│   ├── memory/                 # Recipient memory (embeddings, repositorio, runtime, tools)
│   ├── auth/                   # Identidad y bindings Ed25519 para live voice
│   ├── observability/          # Observabilidad implementada (métricas, traces redactados)
│   ├── config/                 # Lectura de env/process/livekit/privacy
│   ├── contracts/              # Contratos HTTP (zod) — fuente de verdad de la API
│   ├── db/                     # DB client + mirror chain `src/db/migrations`
│   └── runtime/                # Dependencias compartidas del runtime
├── apps/
│   └── nana-wallet/           # Frontend web y proyectos Capacitor
│       ├── android/           # Proyecto nativo Android
│       ├── ios/               # Proyecto nativo iOS
│       └── src/               # Rutas, componentes, API y mocks (replica api-types.ts)
├── tests/                      # Suites backend: unit, integration, simulation y e2e
├── evals/                      # Evalite: evalúa turns y voz del agente
├── supabase/                   # Config local (major_version 17, puerto 54322) y migraciones
├── examples/                   # Seeds de demo (recipient-memory.seed.json)
└── docs/                       # Arquitectura, API y runbooks
```

## Ejecutar localmente

Requisitos:

- Node.js `>=22.18.0` (según `package.json` -> `engines`)
- npm

Desde la raíz del repositorio:

```sh
cd apps/nana-wallet
npm ci
npm run dev -- --host 0.0.0.0 --port 8083
```

Abrí [http://localhost:8083](http://localhost:8083). En desarrollo, MSW inicia automáticamente y permite recorrer la demo sin levantar un backend.

### Probar desde un teléfono

El teléfono y la computadora deben estar conectados a la misma red Wi-Fi. En macOS, consultá la IP local con:

```sh
ipconfig getifaddr en0
```

Después abrí `http://TU_IP:8083` desde el navegador del teléfono, por ejemplo `http://192.168.1.20:8083`.

## Aplicación móvil con Capacitor

El build móvil genera una SPA en `dist/client` y la copia en los proyectos nativos. El build web se mantiene separado y conserva la salida de TanStack Start/Nitro.

```sh
cd apps/nana-wallet

# Generar el build móvil y sincronizar Android e iOS
npm run mobile:sync

# Abrir el proyecto correspondiente
npm run mobile:android
npm run mobile:ios
```

Requisitos adicionales:

- **Android:** Android Studio, Java y Android SDK.
- **iOS:** macOS y Xcode. El proyecto utiliza Swift Package Manager.

Para que una app nativa cargue el servidor de desarrollo desde la red local:

```sh
# Terminal 1
npm run dev -- --host 0.0.0.0 --port 8083

# Terminal 2
CAPACITOR_DEV_SERVER_URL=http://TU_IP:8083 npm run mobile:android
```

Para generar una app empaquetada contra un backend real, no definas `CAPACITOR_DEV_SERVER_URL` y configurá una URL HTTPS:

```sh
VITE_API_URL=https://api.ejemplo.com npm run mobile:sync
```

El identificador nativo de Nana Wallet es `com.nanawallet.app`.

## Variables de entorno

Copiá el archivo de ejemplo si querés apuntar el frontend a otro servidor:

```sh
cd apps/nana-wallet
cp .env.example .env.local
```

```env
VITE_API_URL=http://localhost:3000
```

Nunca guardes seeds, claves privadas ni secretos del backend en variables `VITE_*`: quedan incluidas en el bundle que recibe el usuario.

## Comandos útiles

Ejecutalos desde `apps/nana-wallet`:

| Comando | Descripción |
| --- | --- |
| `npm run dev` | Inicia el servidor de desarrollo. |
| `npm run build` | Genera el build web de producción. |
| `npm run build:mobile` | Genera la SPA usada por Capacitor. |
| `npm run mobile:sync` | Compila y sincroniza los proyectos nativos. |
| `npm run mobile:doctor` | Revisa la instalación de Capacitor. |
| `npm run lint` | Ejecuta ESLint. |
| `npm run typecheck` | Valida TypeScript sin emitir archivos. |
| `npm test` | Ejecuta los tests con Vitest. |

## API e integración WDK

El frontend consume un contrato `/v1` tipado para agente, contactos, agenda, facturas, saldo, movimientos e intenciones de pago. Durante el desarrollo esas rutas son respondidas por MSW.

El backend consulta la wallet, prepara una transferencia con `dryRun`, solicita una confirmación separada y recién entonces puede intentar transmitirla. La referencia técnica está en [docs/architecture.md](docs/architecture.md).

La confirmación conversacional es parte de la experiencia de la demo, no una frontera de autorización suficiente para producción. Una versión productiva debe mantener las claves fuera del agente y aplicar almacenamiento seguro, autenticación local, límites y políticas de riesgo.

## Verificación antes de subir cambios

Backend (raíz) y frontend (`apps/nana-wallet/`) se validan por separado. CI
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) corre exactamente esto y
**un PR no se mergea con CI en rojo**.

```sh
# Backend — desde la raíz. Con la base levantada: docker compose up -d db
npm run lint
npm run typecheck
npm test
npm run eval        # obligatorio si tocás el agente
```

```sh
# Frontend
cd apps/nana-wallet
npm run lint
npm run typecheck
npm test
```

Notas:

- `npm test` requiere `DATABASE_URL` para las suites de integración; sin base
  esas suites **se saltean** (y en CI sí corren). Before trusting a local green,
  bring up a database: Supabase local (`npx supabase start` +
  `npx supabase db reset`), or, to mirror CI exactly,
  `docker compose up -d db` with the schema applied via psql. Local runs and
  test suites always use one of these local databases — never the remote
  primary.
- `npm run eval` corre Evalite sobre el agente. Los evals en modo real
  (`EVAL_REAL=1`) no forman parte de CI.
- Si tocás solo el frontend, alcanza con la suite del frontend; si el cambio toca
  el contrato HTTP, corré también el backend completo.

## Alcance actual

- La interfaz web y los proyectos Capacitor están implementados.
- Los flujos locales funcionan con datos simulados.
- No se incluyen fondos reales ni claves privadas.
- El repositorio todavía no produce un APK o IPA automáticamente; esos binarios se compilan con Android Studio o Xcode.
- Por defecto, el frontend usa MSW para sus endpoints locales. Los runbooks bajo `docs/` describen cómo conectar el chat de Nana con el backend real.

## Backend WDK Transaction Agent

Además del frontend, este repositorio incluye un backend HTTP para el Track 1 WDK, que interpreta instrucciones en lenguaje natural y las confirma antes de mover dinero. Cada usuario firma con su propia wallet Solana devnet resuelta vía Privy.

Ver detalles en `docs/architecture.md`, `docs/api.md` y `docs/demo-runbook.md`.

La aplicación corre una sola configuración (Solana devnet a través de Privy,
con wallets por usuario): no hay un modo fixture ni un switch de proveedor que
activar. El procedimiento operativo completo vive en los runbooks bajo `docs/`.

### Setup backend desde un clone limpio

```bash
git clone https://github.com/theboyplunger0x/nana-wallet.git
cd nana-wallet
cp .env.example .env
npm ci
```

Para que el parser determinista resuelva los pedidos sin contactar un proveedor de modelo:

```bash
AGENT_RUNTIME=deterministic npm run dev
```

En otra terminal, ejecutá las verificaciones del clone limpio:

```bash
npm run typecheck
npm test
npm run build
```

Con `AGENT_RUNTIME=deterministic`, las respuestas se generan localmente sin contactar un proveedor de modelo.

No hay un switch que activar para "pasar a live": la aplicación corre una sola configuración. Completá en `.env` las claves de Privy (`PRIVY_APP_ID`, `PRIVY_APP_SECRET`, `PRIVY_VERIFICATION_KEY`, `PRIVY_AUTHORIZATION_KEY_QUORUM_ID`, `PRIVY_AUTHORIZATION_PUBLIC_KEY`), `DATABASE_URL` y —para voz— los valores de LiveKit y OpenAI; el listado completo con los valores por defecto está en [Variables de entorno](#variables-de-entorno) y en los runbooks bajo `docs/`. Las wallets son por usuario y viven en Privy; este repositorio no crea ni desbloquea una wallet local ni define la allowlist. El destinatario permitido y el tope por transferencia los aplica la **policy de Privy** asociada a la wallet en el momento de firmar, no este repositorio.

La firma pasa por un sidecar local, el único proceso que lee la clave de autorización:

```bash
npm run signer:serve
```

Nunca copies una seed o un secreto al repositorio, y no ejecutes una transferencia real sin saber que puede mover fondos de testnet.

## Backend local con Docker

Para levantar el backend y Postgres sin `npm ci` ni `tsx watch`, seguí el
[runbook Docker](docs/local-docker-runbook.md). Un solo comando arranca la base
(pgvector) y la API:

```sh
docker compose --profile dev up -d --build
```

La API queda en `http://localhost:3000`. El esquema de la base se aplica con los
mismos pasos que CI (roles + migraciones vía psql); el runbook los detalla. El
worker de voz usa la misma imagen detrás del perfil `worker`. Este flujo es
local: el deploy en Render/Supabase cloud y el APK Android son work units aparte.

### Stack live (Solana devnet vía Privy)

`compose.yaml` es el stack de desarrollo. El producto corre con
[`compose.privy-local.yaml`](compose.privy-local.yaml), que levanta `db`,
`livekit`, `backend`, `voice-worker`, los dos sidecars de firma y `frontend`.

Los contenedores **recompilan desde el `src` montado al arrancar**
(`npm run build && exec node dist/...`), así que un cambio de código necesita
**reiniciar el contenedor**, no `docker compose build` — y `docker compose up -d`
**no recrea nada** si la imagen no cambió.

> ### El sidecar de firma queda huérfano si reiniciás a su consumidor
>
> El sidecar usa `network_mode: service:<consumidor>` y bindea **loopback**, así
> que solo es alcanzable desde el namespace de red de ese consumidor. Recrear o
> reiniciar el consumidor le da un namespace **nuevo** y deja al sidecar en el
> viejo: sigue corriendo, sigue sano, y es inalcanzable en `127.0.0.1:8789`.
>
> Eso cae justo en el camino del dinero: una transferencia muere firmando su
> autorización y se reporta como `broadcast_uncertain` — "no podemos saber si se
> movió tu plata" — cuando **nada se transmitió**. Pasó en producción: los dos
> sidecars quedaron huérfanos por reinicios de sus consumidores, el historial
> onchain probó que no hubo envío, y al usuario se le informó un resultado
> desconocido.
>
> **Regla: reiniciá el sidecar cada vez que reiniciás su consumidor,** y verificá
> que compartan namespace:
>
> ```sh
> docker exec nana-privy-impl-voice-worker-1        readlink /proc/self/ns/net
> docker exec nana-privy-impl-voice-worker-signer-1 readlink /proc/self/ns/net
> # los dos valores deben ser IGUALES
> ```
>
> Un 401 prueba que el sidecar responde; `ECONNREFUSED` prueba la orfandad.

For the RAG demo, set the following values in `.env`. They match `.env.example`
and target the local development stand-in, Supabase local (PostgreSQL 17 on
`127.0.0.1:54322`) — never the remote primary; the seed is demo data and
contains no credential:

```dotenv
RECIPIENT_MEMORY_ENABLED=true
DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-csearch_path%3Dpublic,extensions
RECIPIENT_MEMORY_SEED_FILE=examples/recipient-memory.seed.json
```

```bash
npx supabase db reset
npm run memory:prefetch
npm run db:seed -- <userId>
npm run dev
```

`npx supabase db reset` applies the Supabase chain (`supabase/migrations/`).
`npm run db:seed -- <userId>` requires the target `<userId>` — the Privy user
id the seed is scoped to — and fails without it. The first prefetch downloads the pinned
embedding model into `.cache/recipient-memory-model`; later starts reuse it.

## What happens to a recipient reference

| User request | Safe result |
| --- | --- |
| `Mandale plata a Lucas` | Busca por nombre y descripción del usuario. Un Lucas exacto puede quedar seleccionado (insensible a acentos: `Sofia` encuentra `Sofía`). |
| `Mandale plata a mi sobrino` | El texto que dijo el usuario **es** la consulta. Si coincide literalmente con la descripción de **un** contacto activo, se resuelve de forma determinística — sin depender del score vectorial, que no puede alcanzarlo (ver más abajo). |
| `Mandale plata a Lucas el electricista` | Regla léxica de nombre + calificador sobre los candidatos, antes que la vía vectorial. |
| Dos contactos descritos igual (dos «mi sobrino») | Pregunta en vez de elegir. La pregunta ofrece **solo** filas plausibles, nunca ruido. |
| Sin match | Devuelve `no_match` **con las filas que sí encontró** como evidencia, para poder decir qué hay en vez de afirmar que el contacto no existe. No hay dirección ni preview. |
| Registro vencido, o falla de DB/modelo | Se detiene antes de la dirección y antes de cualquier preview WDK. |

> **Por qué el match por descripción no puede depender del vector.** El embedding
> guardado es **uno solo**, compuesto como `name: <nombre>\ndescription: <desc>`,
> así que el nombre diluye la descripción: medido contra la stack, `my nephew`
> contra ese vector da `0.5722` (umbral `0.78`) mientras que contra la
> descripción sola da `0.8671`. Una consulta de descripción queda
> estructuralmente por debajo del umbral, por eso un match **literal** se contesta
> de forma literal con una regla determinística. La vía vectorial sigue
> resolviendo lo difuso y lo cross-language.

Once there is one stable `recipientId` and `version`, `get_selected_recipient_address`
(takes no arguments) may obtain the current address internally. That exact string
is passed unchanged as `send_token.to`. The record is checked once before `dryRun: true` and again
before the matching approved `dryRun: false`; a changed, deleted, inactive, or
foreign record clears the selection and approval.

## RAG memory model

Supabase PostgreSQL 17 + pgvector holds the durable data: the remote project
(`jnhemqouecznsziytzhm`) is the primary store, local Supabase is a disposable
development stand-in, and the compose PostgreSQL 16 is only the docker/CI
database. The local multilingual model
is `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` through
`@huggingface/transformers@4.2.0`, with 384-dimensional normalized embeddings.
No embedding API key is needed.

| Table | Purpose | Retrieval / privacy boundary |
| --- | --- | --- |
| `recipients` | `id`, `user_id`, name, normalized name, description, exact address, version, status, provenance, confirmation time, and a 384D embedding | Embeds only normalized name + description. Search returns id, version, name, description, evidence, and score — never address. |
| `user_memories` | User-relative facts such as `Lucas is my grandson`, kind, version, status, provenance, confirmation time, and a 384D embedding | Embeds the fact, returns minimal evidence, and is only a lead for recipient search. It is not identity proof. |

Both tables have tenant filters in each query plus PostgreSQL row-level security
under the restricted `recipient_app` role. Each request scopes its queries to the
authenticated Privy user. There is no fixed demo tenant, and the API exposes no
separate login surface of its own.

### Memory tools

| Tool | Input | Result and boundary |
| --- | --- | --- |
| `search_recipients` | `{ query }` | Busca entre los contactos del usuario **por nombre o por descripción**, y puede ligar un ID/versión a la sesión. Un match literal de descripción resuelve de forma determinística; lo demás usa el score vectorial. En `no_match` **devuelve igual las filas encontradas** como evidencia, y la pregunta de clarificación solo ofrece filas por encima del floor. Nunca incluye direcciones. |
| `list_contacts` | `{ limit? }` | Enumera los contactos activos (nombre, descripción, red, si tiene alias) con `total` y `truncated`. Para "¿qué contactos tengo?"; nunca devuelve direcciones. |
| `search_user_memory` | `{ query }` | Returns current-user relationship evidence only. |
| `get_selected_recipient_address` | *(no arguments)* | Returns the exact address for the recipient already selected and version-bound in this session. |
| `stage_user_memory` | Recipient draft or relationship fact | Stages exact user-provided content for five minutes; no data is yet written. |
| `write_user_memory` | `{ confirmationId }` | Consumes a single-use, unexpired confirmation and writes atomically. |

Una **descripción** es una consulta válida: el usuario describe a la persona
("mi sobrino") y ese texto es lo que se busca. El nombre que el usuario no dijo
**no se inventa nunca** — inventarlo busca a un desconocido, no encuentra nada y
le hace creer que su contacto desapareció.

The session inspection endpoint never exposes a staged address or confirmation
ID. The tool may show an exact staged address to the user for confirmation, but
search output, embeddings, session inspection, and release evidence must not
contain it.

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENCODE_GO_API_KEY` | — | API key for OpenCode Go (`opencode.ai/auth`), used as the model provider. |
| `OPENCODE_GO_BASE_URL` | `https://opencode.ai/zen/go/v1` | OpenCode Go-compatible API base URL. |
| `OPENCODE_GO_MODEL` | `deepseek-v4-flash` | Default conversational agent model. |
| `WDK_WALLET_NAME` | `privy-user` | Wallet name used by the wallet tools. |
| `WDK_NETWORK` | `solana-devnet` | Default network. This value drives chain routing: any non-Solana value resolves an EVM wallet family. |
| `WDK_TOKEN` | `SOL` | Default token alias (native Solana devnet). |
| `AGENT_RUNTIME` | `llm` | `llm` uses the conversational `ToolLoopAgent`; `deterministic` uses the parser-only path. |
| `PORT` | `3000` | Fastify HTTP port. |
| `RECIPIENT_MEMORY_ENABLED` | `false` | Feature flag. When false, no DB/model/memory tools are initialized and explicit-address transfers remain available. |
| `DATABASE_URL` | — | Application login connection. Locally use the stand-in URL `postgresql://postgres:postgres@127.0.0.1:54322/postgres?options=-csearch_path%3Dpublic,extensions`. The deployed value points at the remote primary and is provisioned from platform/vault environment (Render env, Secret Vault) — it must never be committed, and local `.env`/test suites must never point at the remote. Required when memory is enabled. Each transaction then runs under the restricted `recipient_app` role with `app.user_id` set. |
| `RECIPIENT_MEMORY_MODEL_CACHE` | `.cache/recipient-memory-model` | Reusable local Transformers.js cache. |
| `RECIPIENT_MEMORY_SCORE_FLOOR` | `0.55` | Relevance floor. Below it nothing is selectable, so the lookup answers `no_match` — but the rows found still travel back as evidence. Between the floor and the threshold the contact is plausible and unproven, so the caller asks. |
| `RECIPIENT_MEMORY_SCORE_THRESHOLD` | `0.78` | Minimum semantic score for a non-exact candidate to resolve on its own. |
| `RECIPIENT_MEMORY_SCORE_MARGIN` | `0.08` | Required lead over the runner-up; otherwise clarification is required. |
| `RECIPIENT_MEMORY_SEED_FILE` | — | Confirmed-only JSON seed consumed by `npm run db:seed -- <userId>`; the argument is the Privy user id the seed is scoped to. |

### Voz (worker de LiveKit + OpenAI Realtime)

| Variable | Default | Meaning |
| --- | --- | --- |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime-2.1-mini` | Modelo realtime de la sesión de voz. |
| `OPENAI_REALTIME_VOICE` | `marin` | Voz TTS. |
| `OPENAI_REALTIME_TURN_EAGERNESS` | `high` | Agresividad del detector de fin de turno (`semantic_vad`). `high` responde antes; `medium`/`low` esperan más. Un valor no reconocido cae a `high`. |
| `OPENAI_REALTIME_NOISE_REDUCTION` | `far_field` | Reducción de ruido del micrófono (`far_field` para laptop/parlante, `near_field` para auricular). Desactivarla hace que el ruido de piso retrase el fin de turno. |
| `OPENAI_TRANSCRIPTION_MODEL` | `gpt-4o-mini-transcribe` | Modelo de transcripción del audio de entrada. |
| `OPENAI_TRANSCRIPTION_LANGUAGE` | *(sin fijar)* | Pin opcional del idioma de transcripción. **Sin fijar por defecto**: la app es bilingüe y un pin fijo hace que el audio del otro idioma se decodifique mal. |
| `OPENAI_TRANSCRIPTION_PROMPT` | *(guía del producto)* | Contexto que se le da al transcriptor (nombres y dominios que la app usa). |

El fin de turno es `semantic_vad`, no un umbral de silencio: la sesión es bilingüe
y el usuario confirma transferencias hablando, así que el turno lo decide un
modelo que entiende si la frase terminó. `EAGERNESS=high` es lo que evita la
espera larga sin volver al criterio de silencio.

`compose.yaml` arranca PostgreSQL/pgvector y persiste sus datos en el volumen
`recipient_memory_postgres`. Con el perfil `dev` también levanta el backend API
(`docker compose --profile dev up -d --build`); ver el
[runbook Docker](docs/local-docker-runbook.md). Un Postgres compatible con
pgvector cambia solo las URLs de arriba.

> **Database hierarchy — three Postgres setups, three distinct roles:**
>
> 1. **Remote Supabase project — the Nana Wallet primary database.** `nana_app`
>    (ref `jnhemqouecznsziytzhm`, region us-east-1, PostgreSQL 17.11). The
>    repository is linked here and all 18 versioned migrations plus the
>    `recipient_app` role bootstrap have been applied. For future changes, use
>    the official `supabase` CLI v2.113.0 or newer: inspect
>    `supabase db push --dry-run`, then apply with `supabase db push`. The
>    repo-pinned npm wrapper v2.80.0 fails parsing `per_transfer_atomic6`.
>    Nana Landing is a separate waitlist project; do not use it as a migration
>    target or copy its data. The deployed `DATABASE_URL` must be provisioned
>    through platform/Vault (runtime connectivity not verified here) and never
>    committed. `.env.example` keeps the local stand-in URL; local `.env` and
>    tests must never point at
>    the remote project.
> 2. `npx supabase start` — **disposable development stand-in**: local
>    Supabase, PostgreSQL 17 on `127.0.0.1:54322` (+ Studio, Inbucket). Apply
>    its schema with `npx supabase db reset`. The demo, live, and E2E runbooks
>    use it for local work.
> 3. `docker compose up -d db` — `pgvector/pgvector:0.8.1-pg16` on
>    `127.0.0.1:5432` (service `db` in `compose.yaml`): the docker-stack and CI
>    database only. CI applies the same Supabase chain to it with psql
>    (`.github/workflows/ci.yml`).
>
> **Migration chains.** Two mirrored chains exist:
> `supabase/migrations/` is the Supabase chain (applied to the remote primary
> by `supabase db push`, locally by `npx supabase db reset`, and in CI by psql
> on the compose Postgres);
> `src/db/migrations/` is the local-runner mirror applied by
> `npm run db:migrate`. Running `npm run db:migrate` against a database already
> migrated by the Supabase chain fails with `relation "conversations" already
> exists` — that is expected; use `npx supabase db reset` there.

La red por defecto del repositorio es Solana devnet con el token nativo `SOL`
(ver `.env.example`); no hay un modo fixture ni live que elegir.

## Approval and WDK

Recipient-memory enablement does not authorize a transfer. Every transfer
still follows:

1. Resolve one recipient safely, or ask for clarification.
2. Revalidate it and call WDK `send_token` with `dryRun: true`.
3. Return the network, token, recipient, amount, and estimated fee.
4. Require a separate `confirm` / `confirmar` in the same session.
5. Revalidate again and make one matching `dryRun: false` call.

Every signature is authorized by the **Privy policy** attached to the user's
wallet, which enforces the recipient allowlist and the per-transfer cap at
signing time, not this repository. Use only a dedicated, limited-funds testnet
wallet, and never run a transfer without knowing it can move real testnet funds.

## Verification and scripts

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:wdk-mcp
```

`npm run test:e2e:wdk-mcp` starts the bundled MCP server, discovers the Track 1
tools, and reads chain and token metadata only. It does not call `send_token`.
For the full recipient-memory rehearsal, follow
[the demo runbook](docs/demo-runbook.md); HTTP details are in
[the API reference](docs/api.md) and the architecture rationale is in
[the architecture document](docs/architecture.md).

Other useful commands:

- `npm run db:migrate` — applies the local-runner mirror chain
  (`src/db/migrations/`) exactly once. On a database already migrated by the
  Supabase chain it fails with `relation "conversations" already exists`; that
  is expected — use `npx supabase db reset` there instead.
- `npm run db:seed -- <userId>` — embeds and inserts only explicitly confirmed
  seed data for the given Privy user id; it fails without the argument.
- `npm run memory:prefetch` — downloads/validates the local embedding model.
- `npm run test:wdk-manual` — opt-in manual live read/preview harness; broadcast
  remains separately gated and is not a CI command.
