# Nana Wallet

Wallet agéntica argentina diseñada para personas mayores y personas con discapacidad. Nana reduce la complejidad de una billetera tradicional: el usuario puede pedir una acción con lenguaje cotidiano, revisar claramente qué va a ocurrir y confirmar antes de mover dinero.

> **Estado:** entrega del Aleph Hackathon 2026 para el Track 1 — Build with the WDK CLI. El repositorio contiene un frontend funcional y un backend HTTP WDK con modo fixture seguro por defecto y un modo live explícito para una wallet de prueba en Sepolia.

## Aleph Hackathon 2026 — WDK Track

Track oficial: [WDK Track](https://hacki.crecimiento.build/h/aleph-hackathon-2026/tracks/wdk-track).

Nana es una wallet agéntica para personas mayores y personas con discapacidad. El usuario puede pedir una transferencia en lenguaje cotidiano, revisar red, token, destinatario, importe y fee, y confirmar explícitamente antes de que el agente intente ejecutarla. El backend conecta el agente con las herramientas de `wdk-mcp`; el modo fixture permite reproducir el flujo sin fondos ni claves, mientras que `WDK_TOOLS_SOURCE=live` habilita la integración con una wallet WDK local de prueba.

### WDK usado

Los paquetes WDK declarados en [`package.json`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/package.json#L30-L32) son:

- `@tetherto/wdk@1.0.0-beta.14` — runtime WDK.
- `@tetherto/wdk-cli@1.0.0-beta.2` — CLI y proceso MCP (`wdk-mcp`).
- `@tetherto/wdk-wallet-evm@1.0.0-beta.11` — wallet EVM.

Permalinks de la integración WDK en el commit público [`71509cc`](https://github.com/rober8b/aleph-hackathon/commit/71509cc1957d90fedd95255f0a1241fddbf0ff0b):

- [`src/wdk/mcp-client.ts#L117-L118`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/wdk/mcp-client.ts#L117-L118) — resuelve el proceso MCP WDK incluido.
- [`src/wdk/mcp-client.ts#L213-L220`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/wdk/mcp-client.ts#L213-L220) — configura el spawn del proceso bundled `wdk-mcp` por stdio.
- [`src/agent/wdk-tools.ts#L39-L49`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wdk-tools.ts#L39-L49) — propaga `WDK_INDEXER_API_KEY` al proceso WDK sin exponerla.
- [`src/agent/wdk-tools.ts#L72-L103`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wdk-tools.ts#L72-L103) — expone las herramientas WDK al agente, incluido `send_token`.
- [`src/api/wallet.ts#L17-L50`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/api/wallet.ts#L17-L50) y [`#L52-L100`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/api/wallet.ts#L52-L100) — adapta las respuestas oficiales de balance e historial WDK al contrato HTTP.
- [`src/agent/wallet-agent.ts#L147-L211`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wallet-agent.ts#L147-L211) y [`#L394-L455`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/agent/wallet-agent.ts#L394-L455) — aplica la policy live y las guardas de preview/confirmación al `send_token`.
- [`src/wdk/transaction-receipt.ts#L164-L212`](https://github.com/rober8b/aleph-hackathon/blob/71509cc1957d90fedd95255f0a1241fddbf0ff0b/src/wdk/transaction-receipt.ts#L164-L212) — verifica chain ID Sepolia, hash, receipt y estado confirmado/revertido después del broadcast.

### Demo

- **BLOCKER DE ENTREGA — video de demo:** TODO — agregar aquí la URL pública del video antes de enviar la candidatura. No se inventa un enlace mientras no exista uno real.
- **Red de referencia:** Ethereum Sepolia.
- **Token de demo:** alias WDK `usdt-test` (USD₮ de prueba).
- **Contrato del token:** `0xc4DCC311c028e341fd8602D8eB89c5de94625927`.
- **Modo seguro reproducible:** `WDK_TOOLS_SOURCE=fixture` (valor predeterminado; no requiere wallet, unlock ni broadcast).

La demo live requiere una wallet dedicada, desbloqueada por la persona que ejecuta la prueba y con fondos limitados. Este README no contiene seeds, claves privadas ni credenciales.

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

```text
.
├── apps/
│   └── nana-wallet/           # Frontend web y proyectos Capacitor
│       ├── android/           # Proyecto nativo Android
│       ├── ios/               # Proyecto nativo iOS
│       └── src/               # Rutas, componentes, API y mocks
└── docs/
    └── wdk-agent-development-plan.md
```

## Ejecutar localmente

Requisitos:

- Node.js 22.22 o superior
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

El backend WDK consulta la wallet, prepara una transferencia con `dryRun`, solicita una confirmación separada y recién entonces puede intentar transmitirla en modo live. El plan técnico está en [docs/wdk-agent-development-plan.md](docs/wdk-agent-development-plan.md).

La confirmación conversacional es parte de la experiencia de la demo, no una frontera de autorización suficiente para producción. Una versión productiva debe mantener las claves fuera del agente y aplicar almacenamiento seguro, autenticación local, límites y políticas de riesgo.

## Verificación antes de subir cambios

```sh
cd apps/nana-wallet
npm run lint
npm run typecheck
npm test
npm run build
npm run mobile:sync
```

## Alcance actual

- La interfaz web y los proyectos Capacitor están implementados.
- Los flujos locales funcionan con datos simulados.
- No se incluyen fondos reales ni claves privadas.
- El repositorio todavía no produce un APK o IPA automáticamente; esos binarios se compilan con Android Studio o Xcode.
- Por defecto, el frontend usa MSW para sus endpoints locales. El [runbook live](docs/local-live-runbook.md) conecta el chat de Nana con el backend WDK para la prueba de integración en Sepolia.

## Backend WDK Transaction Agent

Además del frontend, este repositorio incluye un backend HTTP para el Track 1 WDK, que interpreta instrucciones en lenguaje natural y opera con `wdk-mcp` a través de un `ToolLoopAgent`.

Ver detalles en `docs/wdk-agent-development-plan.md`, `docs/api.md` y `docs/demo-runbook.md`.

Para ejecutar la integración completa contra la wallet local de Sepolia, seguí
el [runbook local live](docs/local-live-runbook.md). Ese es el único flujo que
puede emitir una transacción; la demo por defecto permanece en fixture.

### Setup backend desde un clone limpio

```bash
git clone https://github.com/rober8b/aleph-hackathon.git
cd aleph-hackathon
cp .env.example .env
npm ci
```

El flujo mínimo de evaluación usa el fixture y no necesita Docker, wallet ni credenciales. Para que también use el parser determinista y no intente contactar un proveedor de modelo:

```bash
AGENT_RUNTIME=deterministic WDK_TOOLS_SOURCE=fixture npm run dev
```

En otra terminal, ejecutá las verificaciones del clone limpio:

```bash
npm run typecheck
npm test
npm run build
```

Con `AGENT_RUNTIME=deterministic WDK_TOOLS_SOURCE=fixture`, las respuestas son locales y deterministas: no se solicitan credenciales, no se requiere wallet y no hay broadcast.

Para habilitar la integración live local desde ese mismo clone, seguí el [runbook live](docs/local-live-runbook.md). Si la wallet `agent-dev` todavía no existe, creala una sola vez; después agregá el token de prueba y desbloqueá la wallet durante 30 minutos:

```bash
npx wdk wallet create --name agent-dev
npx wdk token add '{"network":"sepolia","token":"usdt-test","symbol":"USD₮","decimals":6,"isNative":false,"address":"0xc4DCC311c028e341fd8602D8eB89c5de94625927"}'
npx wdk wallet unlock --name agent-dev --ttl 30
```

No ejecutes `wallet create` si `agent-dev` ya existe. Fondeá esa wallet con montos mínimos de Sepolia ETH para gas y del token de prueba; nunca copies una seed o secreto al repositorio. Configurá en `.env` `WDK_TOOLS_SOURCE=live`, `WDK_WALLET_NAME=agent-dev`, `WDK_NETWORK=sepolia`, `WDK_TOKEN=usdt-test`, `WDK_MAX_TRANSFER_AMOUNT=0.05` y `WDK_ALLOWED_RECIPIENTS=<direcciones EVM aprobadas separadas por coma>`. El límite y la allowlist son obligatorios y fail-closed: reemplazá el ejemplo por el destinatario real aprobado de Sepolia antes de iniciar el backend. `WDK_INDEXER_API_KEY` es opcional para transferencias, pero necesario para consultar historial indexado. Configurá la URL del backend en el frontend según el runbook. Una ejecución live puede emitir una transacción real de testnet. Los tests `npm run test:e2e:wdk-mcp` son de lectura/metadatos y no llaman `send_token`.

For the RAG demo, set the following values in `.env` (the supplied UUID and
seed are demo data and contain no credential):

```dotenv
RECIPIENT_MEMORY_ENABLED=true
DATABASE_URL=postgresql://recipient_app@127.0.0.1:5432/wdk_agent
DATABASE_ADMIN_URL=postgresql://postgres@127.0.0.1:5432/wdk_agent
DEMO_USER_ID=11111111-1111-4111-8111-111111111111
RECIPIENT_MEMORY_SEED_FILE=examples/recipient-memory.seed.json
```

```bash
npm run db:migrate
npm run memory:prefetch
npm run db:seed
npm run dev
```

The first prefetch downloads the pinned embedding model into
`.cache/recipient-memory-model`; later starts reuse it. With the default
`WDK_TOOLS_SOURCE=fixture`, no wallet, unlock, or broadcast is required.

## What happens to a recipient reference

| User request | Safe result |
| --- | --- |
| `Mandale plata a Lucas` | Searches this demo user's recipient name and description. One exact Lucas may be selected. |
| `Mandale plata a Lucas el electricista` | Uses hybrid lexical + vector retrieval over the current user's names and descriptions; the response contains candidates, never addresses. |
| `Send money to my grandson` | Reads confirmed relationship facts, then still resolves one recipient record before address lookup. |
| Two plausible Lucas records | Asks a description-based question such as “Lucas (mi nieto) or Lucas (el electricista)?” No preview is created. |
| No match, stale record, DB/model failure | Stops before address lookup and before any WDK preview. |

Once there is one stable `recipientId` and `version`, `get_recipient_address`
may obtain the current address internally. That exact string is passed unchanged
as `send_token.to`. The record is checked once before `dryRun: true` and again
before the matching approved `dryRun: false`; a changed, deleted, inactive, or
foreign record clears the selection and approval.

## RAG memory model

PostgreSQL 16 + pgvector holds the durable data. The local multilingual model
is `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` through
`@huggingface/transformers@4.2.0`, with 384-dimensional normalized embeddings.
No embedding API key is needed.

| Table | Purpose | Retrieval / privacy boundary |
| --- | --- | --- |
| `recipients` | `id`, `user_id`, name, normalized name, description, exact address, version, status, provenance, confirmation time, and a 384D embedding | Embeds only normalized name + description. Search returns id, version, name, description, evidence, and score — never address. |
| `user_memories` | User-relative facts such as `Lucas is my grandson`, kind, version, status, provenance, confirmation time, and a 384D embedding | Embeds the fact, returns minimal evidence, and is only a lead for recipient search. It is not identity proof. |

Both tables have tenant filters in each query plus PostgreSQL row-level security
under the restricted `recipient_app` role. This demo injects one UUID from
`DEMO_USER_ID`; there is deliberately no login surface yet. A production
deployment must replace that fixed demo identity with the authenticated
principal before enabling the feature.

### Memory tools

| Tool | Input | Result and boundary |
| --- | --- | --- |
| `search_recipients` | `{ query }` | Finds current-user candidates and may bind one ID/version to the session. Addresses are omitted. |
| `search_user_memory` | `{ query }` | Returns current-user relationship evidence only. |
| `get_recipient_address` | `{ recipientId, expectedVersion }` | Returns an address only for the session-bound, still-current selection. |
| `stage_user_memory` | Recipient draft or relationship fact | Stages exact user-provided content for five minutes; no data is yet written. |
| `write_user_memory` | `{ confirmationId }` | Consumes a single-use, unexpired confirmation and writes atomically. |

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
| `WDK_WALLET_NAME` | `agent-demo` | WDK wallet used by wallet tools. |
| `WDK_NETWORK` | `sepolia` | Default WDK network. |
| `WDK_TOKEN` | `USDT` | Default token alias. |
| `WDK_TOOLS_SOURCE` | `fixture` | `fixture` requires no WDK process; `live` starts the real `wdk-mcp` process. |
| `AGENT_RUNTIME` | `llm` | `llm` uses the conversational `ToolLoopAgent`; `deterministic` uses the parser-only path. |
| `PORT` | `3000` | Fastify HTTP port. |
| `RECIPIENT_MEMORY_ENABLED` | `false` | Feature flag. When false, no DB/model/memory tools are initialized and explicit-address transfers remain available. |
| `DATABASE_URL` | — | Application connection as `recipient_app`; required when memory is enabled. |
| `DATABASE_ADMIN_URL` | — | Migration-only admin connection. Do not use it for the application runtime. |
| `DEMO_USER_ID` | — | UUID tenant injected server-side for this demo; required when memory is enabled. |
| `RECIPIENT_MEMORY_MODEL_CACHE` | `.cache/recipient-memory-model` | Reusable local Transformers.js cache. |
| `RECIPIENT_MEMORY_SCORE_THRESHOLD` | `0.78` | Minimum semantic score for a non-exact candidate. |
| `RECIPIENT_MEMORY_SCORE_MARGIN` | `0.08` | Required lead over the runner-up; otherwise clarification is required. |
| `RECIPIENT_MEMORY_SEED_FILE` | — | Confirmed-only JSON seed consumed by `npm run db:seed`. |

`compose.yaml` starts only PostgreSQL/pgvector and persists its data in the
named `recipient_memory_postgres` volume. A hosted pgvector-compatible
PostgreSQL changes only the URLs above.

El fixture local conserva `WDK_TOKEN=USDT` para las respuestas deterministas.
Para reproducir la configuración live del track, definí explícitamente
`WDK_NETWORK=sepolia` y `WDK_TOKEN=usdt-test`; ese alias corresponde al token de
prueba cuyo contrato está documentado en la sección de demo.

## Approval and WDK

Recipient-memory enablement does not authorize a transfer. Every transfer
still follows:

1. Resolve one recipient safely, or ask for clarification.
2. Revalidate it and call WDK `send_token` with `dryRun: true`.
3. Return the network, token, recipient, amount, and estimated fee.
4. Require a separate `confirm` / `confirmar` in the same session.
5. Revalidate again and make one matching `dryRun: false` call.

`WDK_TOOLS_SOURCE=fixture` is the safe default. `live` starts the bundled MCP
server through `WdkMcpClient`; use only a human-unlocked, dedicated, limited-
funds test wallet. The read-only MCP smoke below never broadcasts.

## Verification and scripts

```bash
npm run typecheck
npm test
npm run build
npm run test:e2e:wdk-mcp
```

`npm run test:e2e:wdk-mcp` starts the bundled MCP server, discovers the Track 1
tools, and reads Sepolia/USD₮ metadata only. It does not call `send_token`.
For the full recipient-memory rehearsal, follow
[the demo runbook](docs/demo-runbook.md); HTTP details are in
[the API reference](docs/api.md) and the architecture rationale is in
[the architecture document](docs/architecture.md).

Other useful commands:

- `npm run db:migrate` — applies each migration exactly once.
- `npm run db:seed` — embeds and inserts only explicitly confirmed seed data.
- `npm run memory:prefetch` — downloads/validates the local embedding model.
- `npm run test:wdk-manual` — opt-in manual live read/preview harness; broadcast
  remains separately gated and is not a CI command.
