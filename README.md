# Nana Wallet

Wallet agéntica argentina diseñada para personas mayores y personas con discapacidad. Nana reduce la complejidad de una billetera tradicional: el usuario puede pedir una acción con lenguaje cotidiano, revisar claramente qué va a ocurrir y confirmar antes de mover dinero.

> **Estado:** frontend funcional para web, Android e iOS. La demo local usa endpoints simulados con MSW; la conexión con el backend WDK y las transacciones reales todavía está en integración.

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
- Backend WDK planificado con Node.js, Fastify y Tether WDK/MCP

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

La integración prevista usa el backend WDK para consultar la wallet, preparar una transferencia con `dryRun`, solicitar confirmación y recién entonces transmitirla. El plan técnico está en [docs/wdk-agent-development-plan.md](docs/wdk-agent-development-plan.md).

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
- La conexión completa entre el contrato del frontend y el backend WDK sigue pendiente.
