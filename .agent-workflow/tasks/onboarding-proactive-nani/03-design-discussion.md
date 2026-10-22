# 03 — Design discussion: onboarding proactivo de Nani

## Current state (resumen de 02)

1. La voz arranca solo con un toque en el avatar (`handleAvatarPress` → `start()`).
2. El agente nunca habla primero: no hay instrucción de saludo ni `generateReply`
   inicial.
3. No existe tool de swap (voz: balance/búsqueda de contactos/enviar/confirmar/cancelar).
4. El saldo llega al front por REST (`/v1/wallets/current/balances`), no a la home.
5. No hay manejo de desbloqueo de audio (`startAudio`) y el micrófono se pide en el
   mismo gesto de conexión.
6. `POST /v1/live-bindings` crea una conversación nueva si no se reusa una.
7. Nativo no usa LiveKit (grabación push-to-talk + `/v1/voice/speak`).

## Desired state

Entrar a la home y encontrarse a Nani ya presente: intro, saldo y opciones
accionables, sin que el usuario tenga que descubrir que hay que apretar algo.

## Decisiones abiertas

### D1 — Cómo se resuelve la entrada (autoconexión, audio y micrófono)

Esta decisión está condicionada por dos límites del navegador, no por preferencia:

- **Autoplay:** sin gesto previo del usuario, la reproducción de audio remoto puede
  quedar bloqueada. Hoy el repo no llama `room.startAudio()` en ningún lado.
- **Permiso de micrófono:** pedirlo sin contexto en la carga de la página se rechaza
  con más frecuencia y deja la app en un estado raro.

| Opción | Qué hace | Tradeoff |
| --- | --- | --- |
| D1a Autoconexión total | Al montar la home: binding + token + sala + mic; el agente saluda. | Cero toques, pero en navegador nuevo el primer saludo puede salir **mudo**, el prompt de mic aparece sin explicación y se crea una conversación por visita. |
| D1b Un toque de entrada (recomendada) | Al entrar se ve la intro y el saldo **en texto** ya renderizados + un botón grande "Escuchar a Nani". Ese toque desbloquea audio, pide mic y Nani saluda hablando al instante. | Un toque real (no cero), pero la voz funciona siempre y el permiso de mic llega con contexto. Reusa la degradación a texto ya existente. |
| D1c Texto + voz local primero | Saludo inmediato en texto y `useVoicePlayback.speak()`; LiveKit se conecta al primer uso real. | Máxima robustez y cero dependencia de LiveKit en la carga; la intro no la dice la misma Nani de la sala (dos voces posibles). |

#### D1-mobile — Re-evaluación: foco en la app mobile

Evidencia verificada del shell nativo:

- La app nativa empaqueta la MISMA app React (`capacitor.config.ts` → `webDir:
  dist/client`), así que corre la rama `isNative`.
- Esa rama NO usa LiveKit: usa `MediaRecorder` push-to-talk + `POST /v1/voice/speak`
  (`routes/index.tsx:29-40`).
- Permisos ya declarados: `NSMicrophoneUsageDescription` (iOS) y
  `RECORD_AUDIO` (Android). No hay plugin de audio session instalado ni
  configuración de playback en el proyecto nativo.

Lo que se vuelve realmente más fácil en mobile:

- **Autoplay deja de ser lotería del navegador.** En el shell propio se configura
  WKWebView (`mediaTypesRequiringUserActionForPlayback = []`) y Android WebView
  (`setMediaPlaybackRequiresUserGesture(false)`); el audio deja de depender de un
  gesto. D1a pasa a ser confiable.
- **El micrófono se pide una vez por app**, no por carga de página, y con contexto.

Lo que NO se simplifica, y hay que verificar antes de comprometer:

- Que el SDK web de LiveKit funcione dentro del WKWebView/WebView nativo (WebRTC +
  micrófono + parlante simultáneos, categoría de audio de iOS). Hoy no hay
  evidencia en el repo de live voice en nativo: es camino nuevo, no un ajuste.
- La verificación exige build en device/emulador; el CI no cubre esto.

Alternativa barata en mobile: mantener el path de voz grabada y hacer el saludo
instantáneo y local (texto + `useVoicePlayback`, que ya existe) al abrir la app.
Cero riesgo WebRTC, pero no es "Nani conectada a LiveKit".

**Pregunta abierta D1-mobile:** ¿mobile va a LiveKit en el WebView (verificando
primero que funcione en device) o mantenemos voz grabada y saludo local?

**DECISIÓN D1-mobile (2026-10-08 09:54 -03, Ramiro): spike primero.**
Mobile va a LiveKit en el WebView, condicionado a un spike de verificación en
device/emulador. El spike decide: si LiveKit funciona en el WebView con mic +
parlante simultáneos y audio desbloqueado por configuración del shell, mobile usa
LiveKit y Nani saluda sola con sonido. Si no funciona, se cae a la alternativa
barata (voz grabada + saludo local) y se registra la evidencia.

Alcance del spike (evidencia, no producto):

1. Configurar el playback del WebView en ambos proyectos nativos
   (`mediaTypesRequiringUserActionForPlayback` en iOS,
   `setMediaPlaybackRequiresUserGesture(false)` en Android).
2. Correr la app en device/emulador contra el dev server, abrir la home y conectar
   la sala de voz con el backend local.
3. Observar y registrar: conexión a la sala, permiso de micrófono, audio del agente
   audible sin gesto, y si el mic y el parlante conviven.
4. Registrar el resultado en `02-research.md` (o en un anexo del spike) y recién
   entonces cerrar D1-mobile.

**Sigue abierto:** D1 para web (toque de entrada vs autoconexión total) y D2/D3/D5.

**Sigue abierto:** D1 para web (toque de entrada vs autoconexión total) y D3/D5.

**DECISIÓN D2 (2026-10-08, Ramiro): D2a — el agente saluda primero en la sala.**

Consecuencias aceptadas (registradas para el outline):

- El saludo (intro + saldo + opciones) lo produce el primer turno del agente, con
  `get_balance` para el saldo.
- Latencia: un turno de LLM + una tool call en cada entrada.
- **En web, sin gesto no hay saludo ni en audio ni en texto**: el saludo existe solo
  si la sala conecta y la reproducción está desbloqueada. Esto obliga a resolver
  D1-web antes del outline.
- El read-back del preview sigue igual: nada de esto toca el flujo de confirmación.

### D2 — Quién genera el saludo (intro + saldo + opciones)

| Opción | Qué hace | Tradeoff |
| --- | --- | --- |
| D2a Agente | Instrucción de primer turno en `create-agent-session` + `generateReply` al iniciar la sesión; el agente llama `get_balance`. | Una sola fuente de persona y verdad del saldo. Latencia y costo de un turno de LLM en **cada** entrada; el saludo queda atado a que la sala conecte. |
| D2b Front | El front compone el saludo con `api.getBalances()` y lo dice con `useVoicePlayback`. | Cero cambios de backend, funciona aun sin sala. Duplica la persona/voz en el front y el agente no sabe qué se dijo (riesgo de repetir el saludo). |
| D2c Endpoint `GET /v1/agent/greeting` (recomendada para etapa 2) | El backend devuelve texto + opciones + saldo; el front lo renderiza y lo habla; el mismo payload siembra el contexto del agente. | Una sola fuente, testeable con eval/test de contrato, no depende de LiveKit. Más trabajo: toca `src/contracts/http.ts`, `docs/api.md` y ambos lados. |

**DECISIÓN D1-web (2026-10-08, Ramiro): D1a-web — autoconexión total en web.**

- Al entrar, la home conecta la sala y habilita el micrófono sola.
- Si el navegador bloquea el audio, queda un cartel "Tocá para escuchar a Nani" y la
  intro se muestra escrita en el front. Aceptado: la persona queda duplicada en el
  front **solo** para ese caso degradado.
- Riesgos aceptados: prompt de micrófono en la carga, y una conversación nueva por
  visita si no se reusa la binding activa (ver D4).

**Sigue abierto:** D3 (opciones) y D5 (destino del path de voz grabada en nativo).

**DECISIÓN D3 (2026-10-08, Ramiro): D3a — solo habladas.**

- Nani enumera las opciones en voz; no se agregan botones ni chips nuevos a la home.
- Alcance de UI del onboarding baja a: entrada, saludo hablado y degradación a texto
  cuando el audio está bloqueado.
- Queda pendiente el contenido exacto de las opciones ofrecidas (se fija en el outline).

**Sigue abierto:** D5 (destino del path de voz grabada en nativo).

**DECISIÓN D5 (2026-10-08, Ramiro): D5-remove — eliminar la voz grabada al confirmar.**

- Si el spike (S0) confirma LiveKit en el WebView nativo, mobile usa LiveKit y se
  elimina el path `MediaRecorder` + `POST /v1/voice/speak` (y sus consumidores
  huérfanos), quedando el texto como degradación.
- El retiro es parte de la slice S4 y depende del resultado positivo de S0.

**Sigue abierto:** D4 (reuso de conversación al autoconexión) — se resuelve como
decisión técnica en el outline; y el contenido exacto de las opciones ofrecidas.

### D3 — Cómo se ofrecen las opciones

- **D3a** solo habladas ("decime qué necesitás").
- **D3b** chips en UI que disparan un turno.
- **D3c Chips + habladas (recomendada):** chips para tocar (accesibilidad para
  personas mayores) y la misma lista dicha por Nani.

Contenido propuesto de las opciones: "Ver mi saldo", "Hacer una transferencia",
"Últimos movimientos". **Swap queda fuera** hasta que exista herramienta: hoy el
agente no puede ejecutarlo y ofrecerlo sería prometer algo que no hace.

### D4 — Ciclo de vida y costo de la conversación

Autoconexión en cada carga puede crear una conversación nueva por visita
(`/v1/live-bindings`). Opciones: reusar la conversación en modo `live` activa, o
crear una por sesión de app y persistir el id en el front. Decisión de alcance
técnico a resolver en la etapa 2 según lo que se elija en D1.

### D5 — Nativo (Capacitor)

El nativo no tiene LiveKit. Propuesta: misma intro/saldo/opciones en texto + TTS
local (`useVoicePlayback`), sin sala. Se puede entregar como slice separado.

## Recomendación

**D1b + D2c + D3c**, con nativo (D5) como slice posterior y swap explícitamente
fuera de alcance. Razón: es la única combinación donde "Nani te saluda al entrar" es
verdad de forma confiable en navegador (audio desbloqueado por un gesto) y donde el
saludo tiene una sola fuente de verdad testeable sin depender de la sala.

## Preguntas abiertas (en orden de resolución)

1. **D1:** ¿aceptamos el toque de entrada (D1b) o forzamos autoconexión total (D1a)
   asumiendo audio mudo en navegador nuevo? ← pregunta en curso.
2. **D2:** ¿el saludo lo genera el agente (D2a) o el backend por endpoint (D2c)?
3. **D3:** ¿chips solo, hablado solo, o ambos? ¿Qué opciones exactas?
4. **D5:** ¿nativo en el mismo alcance o después?

## Approval record

```markdown
Gate ID: onboarding-proactive-nani/design
Decision / allowed mutation: aprobar este diseño y habilitar el outline (04)
Explicit exclusions: mutación de código fuente hasta aprobar el outline
Owning artifact / revision or hash: 03-design-discussion.md @ 4cd8092 + D1-mobile
Decision owner: Ramiro
Approved by / trusted identity: Ramiro (chat)
Approved at: 2026-10-08 09:54 -03 (solo D1-mobile: spike primero)
Status: proposed (gate completo pendiente: D1-web, D2, D3, D5)
Invalidated by: cambio de alcance en mobile o resultado negativo del spike
```
