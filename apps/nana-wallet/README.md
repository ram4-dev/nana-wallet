# Nana Wallet

Frontend accesible de una wallet agéntica argentina para personas mayores y personas con discapacidad. Incluye agente por texto o voz, perfil y agenda familiar, saldos, movimientos y confirmación segura de pagos.

## Development

Necesitás Node.js y npm.

```sh
npm install
npm run dev
```

## Mobile con Capacitor

Los proyectos nativos viven en `android/` e `ios/`. El build mobile usa el modo SPA de TanStack Start y genera `dist/client/index.html`, que Capacitor copia dentro de cada aplicación. El build web conserva por separado su salida Cloudflare/Nitro en `.output/`.

```sh
# Compilar la web y sincronizar Android/iOS
npm run mobile:sync

# Abrir el proyecto nativo
npm run mobile:android
npm run mobile:ios
```

Para probar desde un teléfono contra el servidor de desarrollo, exponé Vite en la red local y pasá una URL accesible desde el dispositivo. Esa URL sólo se copia a la configuración nativa durante el sync y no queda fija en el repositorio.

```sh
npm run dev -- --host 0.0.0.0
CAPACITOR_DEV_SERVER_URL=http://192.168.1.20:8083 npm run mobile:sync
```

Para un build empaquetado, omití `CAPACITOR_DEV_SERVER_URL` y configurá el backend HTTPS al momento de compilar:

```sh
VITE_API_URL=https://api.nanawallet.app npm run mobile:sync
```

Requisitos nativos:

- Android Studio, Java y Android SDK para Android.
- Xcode para iOS; el proyecto generado usa Swift Package Manager.
- La app móvil no debe incluir seeds ni claves privadas en variables de Vite.

## Built with

- TanStack Start
- TypeScript
- React
- Tailwind CSS
- shadcn/ui
- TanStack Query
- MSW + Vitest
- Capacitor 8
