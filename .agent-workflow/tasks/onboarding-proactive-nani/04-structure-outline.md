# 04 — Structure outline: onboarding proactivo de Nani

## Decisiones que gobiernan este outline

| ID | Decisión | Fuente |
| --- | --- | --- |
| D1-mobile | LiveKit en el WebView nativo, condicionado al spike S0 | Ramiro, 2026-10-08 |
| D1-web | Autoconexión total al entrar, con degradación a texto si el audio está bloqueado | Ramiro, 2026-10-08 |
| D2 | El agente saluda primero en la sala (intro + saldo + opciones) | Ramiro, 2026-10-08 |
| D3 | Opciones solo habladas, sin botones nuevos | Ramiro, 2026-10-08 |
| D5 | Al confirmar S0, se elimina el path de voz grabada en nativo | Ramiro, 2026-10-08 |
| D4 | Técnica: al entrar, reusar la conversación en modo `live` si existe; si no, crear una vía `/v1/live-bindings` | propuesta, se confirma en S2 |

## Slices verticales

### S0 — Spike: LiveKit dentro del WebView nativo (evidencia, no producto)

**Outcome observable:** en un device/emulador, la app nativa conecta la sala de
voz y el audio del agente se escucha **sin gesto previo**, con micrófono habilitado.

**Files**
- iOS: `apps/nana-wallet/ios/App/App/AppDelegate.swift` o `SceneDelegate.swift`
  (config del `WKWebViewConfiguration`: `mediaTypesRequiringUserActionForPlayback =
  []`), o un plugin de config de Capacitor. **No es `Info.plist`**: esa propiedad no
  es una clave de plist (verificado en F2 de `05-independent-review.md`).
- Android: `apps/nana-wallet/android/app/src/main/java/com/nanawallet/app/MainActivity.java`
  hoy es `public class MainActivity extends BridgeActivity {}` (vacío): hay que
  agregar un override que aplique
  `getBridge().getWebView().getSettings().setMediaPlaybackRequiresUserGesture(false)`.
- Evidencia escrita en `90-verification.md`, y el cierre de D1-mobile se refleja en
  `03-design-discussion.md` (destino único de evidencia del spike).

**Automated checks:** build nativo + arranque (`npx cap sync`, build de Xcode /
Gradle). No hay cobertura de CI para esto.

**Real-route check:** app en device contra el dev server
(`CAPACITOR_DEV_SERVER_URL`) con backend + LiveKit locales
(`docs/livekit-development-runbook.md`).

**Manual checks:** conexión a la sala; prompt de micrófono; audio del agente
audible sin toque; mic y parlante conviviendo.

**Stop condition:** resultado binario. Si NO se logra audio sin gesto o la sala no
conecta en WebView, se documenta la evidencia y se vuelve al plan alternativo
(voz grabada + saludo local) antes de tocar S4.

### S1 — Saludo del agente en la sala (D2a)

**Outcome observable:** al iniciar la sesión de voz, Nani habla primero: se
presenta, lee el saldo disponible y enumera las opciones, sin que el usuario diga
nada.

**Files**
- `src/livekit/create-agent-session.ts` — instrucción de primer turno (intro +
  opciones; el saldo se resuelve con la tool `get_balance`).
- `src/livekit/worker.ts` — disparar el primer turno exactamente una vez después de
  `session.start`.
- `tests/unit/realtime-agent-session.test.ts` (verificado; no existe la versión en
  `tests/integration/`).
- `evals/voice/**` si el eval puede cubrir el saludo.

**Automated checks:** `npm run lint`, `npm run typecheck`, `npm test`, y
`npm run eval` (obligatorio: toca el agente).

**Real-route check:** sesión de voz local contra el worker; escuchar el saludo
completo.

**Manual checks:** que el saludo no se repita en reconexión y que no interfiera con
el read-back del preview de transferencia.

**Stop condition:** no se avanza si el primer turno se duplica, se dispara sin sala,
o rompe el flujo de confirmación.

### S2 — Entrada autoconexión en web + desbloqueo de audio (D1a-web, D4)

**Outcome observable:** entrar a `/` en web conecta la sala y habilita el micrófono
sin apretar el avatar, y el usuario puede escuchar el saludo: **el audio suena, o
bien el control de desbloqueo "Escuchar a Nani" aparece visible y funcionando**.

El desbloqueo de audio y ese control van **dentro de esta slice**, no diferidos:
S3 dependía de S2 para un arreglo que S2 necesitaba para cerrar
(hallazgo controlling F1 de `05-independent-review.md`).

**Files**
- `apps/nana-wallet/src/features/agent/voice/livekit-web-client.ts` — **capacidades a
  agregar** (hoy no existen en el repo): desbloqueo de audio con `room.canPlaybackAudio`
  y `room.startAudio()` de livekit-client.
- `apps/nana-wallet/src/features/agent/useLiveVoiceSession.ts` — arranque automático
  que convive con `pauseForLifecycle` y la reconexión.
- `apps/nana-wallet/src/routes/index.tsx` — disparar el arranque al montar; chip de
  estado coherente.
- Tests: `useLiveVoiceSession.test.tsx`, `AgentScreen.test.tsx`.

El control "Escuchar a Nani" se **introduce en esta slice** (S3 solo lo reutiliza
junto a la intro escrita).

**Automated checks:** `npm run lint`, `npm run typecheck`, `npm test` en
`apps/nana-wallet/`.

**Real-route check:** home en navegador con storage limpio (primer contacto): la
sala conecta, el permiso de micrófono aparece, y se cumple la salida: audio audible
o control de desbloqueo visible y funcional.

**Manual checks:** cerrar y reabrir la pestaña; volver desde otra app (visibilidad);
verificar que no se cree una conversación por visita cuando ya hay una `live`;
tocar el control de desbloqueo y confirmar que recupera el audio.

**Stop condition:** si el arranque automático pelea con la pausa por visibilidad,
genera conversaciones duplicadas, o el control de desbloqueo no recupera el audio,
no se avanza a S3.

### S3 — Degradación a texto del onboarding

**Outcome observable:** si la sala no está disponible (no conecta o el audio no se
puede desbloquear), la intro, el saldo y las opciones se ven en texto en la home.

El botón "Escuchar a Nani" es la **degradación autorizada por D1-web** (control de
desbloqueo), no un chip de opciones: D3 sigue vigente (no se agregan botones de
opciones nuevas).

**Files**
- `apps/nana-wallet/src/routes/index.tsx` — intro escrita; reutiliza el control
  "Escuchar a Nani" introducido en S2.
- `AgentScreen.test.tsx` — caso degradado.

**Automated checks:** suite del front completa: `npm run lint`, `npm run typecheck`,
`npm test` en `apps/nana-wallet/`.

**Manual checks:** navegador con audio bloqueado (autoplay restringido): se ve el
texto y el botón, y al tocarlo arranca el audio.

**Stop condition:** si el texto degradado puede mostrar datos de saldo
desactualizados u huerfanos, no se avanza a S4 sin resolverlo.

### S4 — Mobile a LiveKit y retiro de la voz grabada (D5, depende de S0 positivo Y de S2)

**Outcome observable:** la app nativa usa la misma sesión LiveKit que web y el push-to-talk
grabado ya no existe.

**Files**
- `apps/nana-wallet/src/routes/index.tsx` — retirar la rama `isNative` de grabación.
- `apps/nana-wallet/src/features/agent/voice/recorded-voice-client.ts` y sus tests —
  eliminar.
- `apps/nana-wallet/src/lib/api.ts` — retirar `transcribeAgentAudio` y el cliente de
  `/v1/voice/speak` si quedan sin consumidores.
- Investigar consumidores de `/v1/voice/speak` en backend
  (`src/api/**`, `src/contracts/http.ts`, `docs/api.md`) antes de retirar: decisión
  de si el endpoint se elimina también.

**Automated checks:** front completo (`npm run lint`, `npm run typecheck`,
`npm test` en `apps/nana-wallet/`); si se toca el contrato HTTP o el backend: raíz
completa (`npm run lint`, `npm run typecheck`, `npm test`, `npm run eval`).

**Manual checks:** device: abrir la app y escuchar el saludo; hablar y ser
entendido.

**Stop condition:** S0 sin evidencia positiva, o endpoint `/v1/voice/speak` con
consumidores no identificados.

## Contenido de las opciones (a fijar antes de S1)

Propuesta: "ver mi saldo", "hacer una transferencia", "ver mis últimos
movimientos". **Swap queda fuera**: no existe herramienta que lo ejecute.

## Riesgos

1. **Config del WebView por plugin.** Si iOS necesita más que `Info.plist` (plugin de
   audio session), S0 lo revela y S4 cambia de forma.
2. **Conversaciones por visita.** La autoconexión puede crear una conversación por
   carga si no se reusa la activa (filas y costo). Cubierto por D4 y el stop
   condition de S2.
3. **Latencia del saludo.** Un turno de LLM + `get_balance` antes de escuchar el
   saludo. Se mide en S1.
4. **Solapamiento con el preview pendiente.** Si hay transferencia pendiente al
   reconectar, el saludo no debe pisar el read-back.

## Verificación global

`90-verification.md` se completa al cerrar cada slice con: unit, integración,
estático, build, E2E de ruta real, resultado manual, bloqueos no corridos y
desvíos.

## Estado del gate

```markdown
Gate ID: onboarding-proactive-nani/outline
Decision / allowed mutation: aprobar este outline y habilitar la implementación por slices
Explicit exclusions: slices sin su stop condition cumplida; swap
Owning artifact / revision or hash: 04-structure-outline.md @ sha256:d128809a6b674449751b2738d01aec8b56d91ed285e25daf958bfdab88536b54
Decision owner: Ramiro
Approved by / trusted identity: —
Approved at: —
Status: proposed (revisión independiente hecha: 2 rondas, sin hallazgos críticos ni controlling)
Invalidated by: cambio de alcance o de decisión D1/D2/D3/D5
```

Nota: la fila `files` de la tabla de decisiones se puede omitir; este bloque es el
único registro de aprobación del outline.
