# 90 — Verification

## S0 — Spike: LiveKit dentro del WebView nativo (Android)

- **Resultado automático: PASS — `shell-allows-autoplay`.**
  El WebView nativo de la app (no un navegador del host) se conectó a la sala de
  LiveKit, obtuvo permiso de micrófono y reprodujo audio remoto **sin ningún gesto
  del usuario**.
- **Check manual humano: PENDIENTE** (escuchar el tono en el emulador).
- Fecha: 2026-10-08.
- Worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-onboarding-proactive-nani-s0`
  (branch `feat/onboarding-proactive-nani-s0`).
- Ejecutores: `gentle-ai-verify` (`nan/deepseek-v4-flash`, high) — intento 1
  (bloqueado por JDK) y reanudación tras instalar `openjdk@21`.

### Evidencia automática

Identidad del WebView: todas las entradas nuevas de `reports.jsonl` traen
`ua = ... Android 16; sdk_gphone64_arm64 ... (wv) ... Chrome/133.0.6943.137`.
Las 44 entradas previas eran `Macintosh; Intel Mac OS X` → baseline del host, **no**
el device. Antes de esta corrida había cero entradas de device.

Último snapshot del WebView (`tag=heartbeat`, 13:40:27Z):

| Campo | Valor |
| --- | --- |
| `connectionState` | `connected` |
| `micGranted` / `micError` | `true` / `null` |
| `canPlaybackAudio` | `true` |
| `audioPaused` | `false` |
| `audioCurrentTime` | `87.908` (monotónico desde 0.00) |
| `subscribedAudioTracks` | `1` |
| `firstAudioPlayingAt` | `13:38:59.868Z` |
| `audioPlayError` / `explicitPlayProbeError` | `null` / `null` |
| `isSecureContext` / `hasMediaDevices` | `true` / `true` |
| `gestureCount` / `gestureEvents` | `0` / `[]` |
| `userActivationHasBeenActive` | `false` |
| `userActivationAtAudioStart` | `false` |
| `errors` | `[]` |

**El orden prueba que nada lo disparó:** `track-subscribed` 13:38:59.811 →
`paused=false, t=0.00` 13:38:59.868 → **después** `local-track-published` y
`mic-attempted` 13:38:59.975. El audio remoto ya estaba sonando antes de tocar el
micrófono.

**Salida de audio a nivel device (no solo estado del DOM)** —
`adb shell dumpsys media.audio_flinger`: un `AudioTrack` activo del **pid 4411 /
uid 10213 = `com.nanawallet.app`** escribiendo PCM al HAL, con `Total writes`
creciendo 3971 → 4194 en 5 s.

**Logs de Chromium:** `audioHardwareBufferSize = 4360`, y **ninguna** ocurrencia de
`NotAllowedError` ni de rechazo por autoplay en el device. La cadena
`NotAllowedError: play() failed because the user didn't interact` aparece **solo** en
la entrada del host Mac, nunca en el device.

**Config viva del WebView:** `adb logcat | grep Capacitor` →
`Loading app at http://127.0.0.1:17950` y
`connected to Livekit Server edition: 0, version: 1.13.6, protocol: 17`.

**Sin contaminación por gestos:** la única acción de lanzamiento fue
`adb shell am start -S -n com.nanawallet.app/.MainActivity`; nunca se enviaron
`input tap|swipe|keyevent`. Confirmado además por `gestureCount=0`,
`userActivation.hasBeenActive=false` y `userActivationAtAudioStart=false`.

### Hallazgos de entorno (transferibles)

1. **Gradle exige Java 21** con `@capacitor/android@8.5.0`
   (`node_modules/@capacitor/android/capacitor/build.gradle:66-67`). Se instaló
   `openjdk@21` (keg-only) y el build pasa con
   `JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home`.
2. **El LiveKit del stack local no sirve para devices**: `node_ip: 127.0.0.1`,
   `use_external_ip: false`, publica solo en loopback. Se usó un nodo dedicado
   (`spike-s0-livekit`) con `node_ip: 192.168.0.91`, publicando en `0.0.0.0`
   (17900 control, 17901 TCP + 17901-17911 UDP). El stack existente intacto.
3. **Un origen http con IP de LAN no es contexto seguro** → `navigator.mediaDevices`
   queda `undefined` y el micrófono es imposible. El dev server en device debe ser
   **loopback vía `adb reverse`** o https. Verificado con probe de origen.
4. `CAPACITOR_DEV_SERVER_URL` se **hornea en `cap sync`**, no se lee al lanzar.
5. `npm run build` del front produce `.output/` (Nitro); el target de Capacitor es
   `npm run build:mobile` → `dist/client`.
6. `npx cap` debe correr desde `apps/nana-wallet`; Gradle necesita
   `ANDROID_HOME=$HOME/Library/Android/sdk` exportado.

### Límites de esta evidencia (declarados por el ejecutor)

- **Fidelidad de red:** la página del harness se sirve por loopback (origen
  correcto para el test) pero el cliente LiveKit se conecta al nodo por LAN
  (`ws://192.168.0.91:17900`). La política de autoplay depende del origen y de la
  config del WebView, no del host del websocket, así que el veredicto se sostiene;
  el camino de red no es el de producción.
- **No es el flujo real de la app:** el WebView levantó la **página del harness**,
  no la UI de Nana Wallet. Esto aísla exactamente la variable del shell (que era el
  objetivo de S0). La verificación con la app real queda para S2, donde la home debe
  autoconexionarse y mostrar/decir el saludo.
- `remoteParticipants: 0` es esperado: el publisher ya estaba en la sala cuando el
  viewer entró; el track remoto se prueba con `subscribedAudioTracks: 1`.

### Incidente de secretos (divulgado)

Dos comandos de diagnóstico imprimieron el **valor de la API key de LiveKit** de
este entorno local (15 caracteres; el secret nunca se imprimió). Si esa key se
comparte fuera del entorno local, conviene rotarla.

### Check manual pendiente (no sustituible)

Todo quedó corriendo: contenedor `spike-s0-livekit`, harness en `:17950`, publisher
vivo, `adb reverse` activo, app en foreground
(`topResumedActivity=com.nanawallet.app/.MainActivity`), pantalla encendida.

- Escuchar en la salida de audio del host un tono sintético repetitivo (el publisher
  usa el device simulado de Chrome, así que es un tono, no voz).
- El cartel del emulador debe decir `AUDIO PLAYING, NO GESTURE (gestures=0)`.
- Verificar que ni el emulador ni la Mac estén en mute.

Silencio audible = la evidencia objetiva y el oído discrepan: hay que reportarlo.

### Estado

- S0 automático: **PASS**. S0 manual: **pendiente**.
- Sin commits. `git status` idéntico al baseline previo; sólo las 3 ediciones de
  config de S0 (fuera de `.spike-s0/`). APK en
  `apps/nana-wallet/android/app/build/outputs/apk/debug/app-debug.apk`.
