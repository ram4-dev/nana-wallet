# 05 — Independent review (outline)

## Desvío de modelo (registrado)

El flujo RPI pide revisar el outline con `nan/glm5.3-flash` y reasoning `high`.
Ese modelo **no es utilizable en esta sesión**: todo subagente configurado con
`nan/glm5.3-flash` falla con `context overflow` en el primer turno, incluso con un
prompt de una sola palabra (probado con `jd-judge-a` y `sdd-design`).

Sustituto usado: `gentle-ai-explore` (`nan/deepseek-v4-flash`, effort `medium`,
read-only por contrato de tools). Config corregida después por pedido de Ramiro:
todos los perfiles `glm5.3-flash` pasaron a `deepseek-v4-flash` en
`~/.pi/agent/subagents.json` (requiere `/reload`).

Consecuencia: la independencia del review se mantiene (otro modelo, otra sesión,
sin tools de escritura), pero **no** es el modelo especificado por el flujo.

## Ronda 1

- Revisión de: `04-structure-outline.md` @ SHA-256
  `86ad3208a6eccac22f016e7095cd1a4992d6b18e2ff5d2164c937aeb861cd771`.
- Revisor: `gentle-ai-explore` (`nan/deepseek-v4-flash`, medium, read-only).
- Sesión: `subtask_gentle-ai-explore_1791464635481_b6cd4f84`.
- Uso: 9 turnos, ctx 45k.
- Veredicto: **approved-with-findings**. Sin hallazgos críticos. Todas las
  afirmaciones sobre el código actual verificadas correctas.

| ID | Clase | Hallazgo | Disposición |
| --- | --- | --- | --- |
| F1 | controlling | S2 exige "el saludo suena" pero el desbloqueo de audio estaba diferido a S3, que a su vez dependía de S2: la slice no podía cerrar y bloqueaba su propio arreglo. | **Resuelto**: el desbloqueo y el control "Escuchar a Nani" pasan a S2, con salida alternativa explícita (audio audible **o** control visible y funcional). |
| F2 | minor | S0 apuntaba a `Info.plist` para `mediaTypesRequiringUserActionForPlayback`, que es una propiedad de `WKWebViewConfiguration` (Swift), no una clave de plist; y `MainActivity.java` está vacío. | **Resuelto**: S0 nombra `ios/App/App/AppDelegate.swift` / `SceneDelegate.swift` (o plugin de config de Capacitor) y exige override nuevo en `MainActivity.java`. |
| F3 | minor | S1 citaba `tests/integration/realtime-agent-session.test.ts`, que no existe. | **Resuelto**: `tests/unit/realtime-agent-session.test.ts` (verificado). |
| F4 | minor | S3 y S4 no fijaban los comandos obligatorios. | **Resuelto**: comandos exactos por slice (front: `lint`/`typecheck`/`test`; raíz: `lint`/`typecheck`/`test`/`eval` cuando se toca backend o contrato). |
| F5 | minor | El botón nuevo de S3 podía leerse como violación de D3 (solo hablado). | **Resuelto**: S3 aclara que el control es la degradación autorizada por D1-web, no un chip de opciones de D3. |
| F6 | minor | S4 declaraba depender solo de S0. | **Resuelto**: S4 depende de S0 positivo **y** de S2. |

### Afirmación menos verificable

"El audio del agente se escucha sin gesto previo dentro del WebView nativo con mic
y parlante simultáneos" (S0). No se puede resolver desde el repo: no hay cobertura
de CI, no existe configuración de playback nativa (verificado en `Info.plist` y en
`MainActivity.java`, que está vacío), y el propio diseño lo llama camino nuevo.
La evidencia que lo resuelve es correr el spike S0 en device/emulador con la config
aplicada y registrar: sala conectada, prompt de micrófono, audio audible sin gesto,
convivencia mic + parlante.

## Ronda 2

- Revisión de: `04-structure-outline.md` @ SHA-256
  `d7849110115e2d8d5db94a88c9e9fc99e1b802810a1e472a4e21acfd4866edf4`.
- Revisor: `gentle-ai-explore` (`nan/deepseek-v4-flash`, medium, read-only).
- Sesión: `subtask_gentle-ai-explore_1791464860093_4a0ded0c`.
- Uso: 9 turnos, ctx 49k.
- Veredicto: **approved-with-findings**. Sin hallazgos críticos ni controlling
  restantes. F1..F6 verificados como resueltos, con evidencia propia del revisor.

| ID | Clase | Hallazgo | Disposición |
| --- | --- | --- | --- |
| N1 | minor | S0 citaba `docs/local-livekit-runbook.md`, que no existe. | **Resuelto**: apunta a `docs/livekit-development-runbook.md`. |
| N2 | minor | S2 listaba `canPlaybackAudio` / `startAudio` como si ya existieran en `livekit-web-client.ts`. | **Resuelto**: se declaran como capacidades **a agregar** (`room.canPlaybackAudio`, `room.startAudio()` de livekit-client). |
| N3 | minor | S2 y S3 se pisaban en el control "Escuchar a Nani". | **Resuelto**: se introduce en S2; S3 solo lo reutiliza junto a la intro escrita. |
| N4 | minor | Destino de evidencia del spike contradictorio (`90-verification.md` vs `02-research.md`). | **Resuelto**: destino único `90-verification.md` + cierre de D1-mobile en `03-design-discussion.md`. |

### Delta post-review (declarado)

Después de la ronda 2 se aplicaron exactamente N1..N4 como correcciones factuales
de texto, sin cambio de alcance, de decisiones ni de slices. La revisión queda
atada a la revisión `d7849110…`; el outline vigente es
`d128809a6b674449751b2738d01aec8b56d91ed285e25daf958bfdab88536b54`. No se abre
otra ronda porque no queda ningún hallazgo crítico ni controlling.

## Estado

Revisión independiente completa (2 rondas). Sin hallazgos críticos ni controlling
pendientes. **Pendiente: aprobación humana del outline.**
