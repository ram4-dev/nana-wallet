# 00 — Intake: restyle UI con estructura LuckGnome

## Outcome

Adoptar la **estructura/layout** del prototipo `luckgnome-voice-wallet.html`
para todas las vistas de Nana Wallet, **manteniendo la paleta violeta/crema de
Nana y la mascota Nani** (decisión del owner, 2026-10-07: "Colores Nana +
estructura luckgnome").

## Elementos de estructura a adoptar (del HTML)

1. **Bottom nav píldora flotante**: `border-radius:999px`, backdrop-blur, 3
   columnas `1fr 66px 1fr`, con el botón central de voz elevado (`top:-13px`,
   orb 56px) y label debajo. Reemplaza la nav actual.
2. **Vista de voz**: pantalla con pregunta grande arriba ("¿Qué quieres
   hacer?"), mascota centrada dentro de **doble anillo orbit** con ondas de
   sonido animadas por estado (`idle/listening/speaking/thinking`),
   label de estado, helper, **suggestion chips** (píldoras), transcript y
   **result card**.
3. **Vista cartera**: page-title, **balance card** destacada (borde accent
   suave, fondo tintado), dos acciones grandes (Enviar/Recibir), acciones
   secundarias de texto, **asset rows** (icono circular tintado + nombre +
   símbolo + valor derecha) y **activity rows**.
4. **Vista perfil**: **profile card** (avatar circular + nombre + dirección
   mono + badge verificado) y **settings groups** (título uppercase pequeño +
   lista de filas con chevron).
5. **Vista contactos**: topbar con back + título centrado + acción "+",
   **search field** píldora, **contact rows** (avatar inicial + nombre +
   detalle + chevron), contador y empty state.

## Mantener de Nana (NO cambiar)

- Paleta: `--primary #684cf6`, `--brand-ink #4631ba`, fondos crema
  `#f4f1ea`/`#fdfbf8`, superficies de estado oklch existentes.
- Mascota: `assets/nani/nani-{lista,escuchando,pensando}.png` en el orb
  central (los estados de luckgnome mapean 1:1 a los estados de Nani).
- Fuentes Fredoka/Nunito, radios grandes, utilidad `press`.
- Toda la lógica, rutas, hooks y contratos — SOLO cambia la capa visual.

## Acceptance evidence (provisional)

- Las 5 rutas (`/`, `/mi-plata`, `/perfil`, `/notificaciones`, `/login`)
  usan la estructura luckgnome con paleta Nana.
- El nav inferior es la píldora flotante con orb Nani central.
- Suite front verde (tests existentes adaptados), sin cambios de contrato
  HTTP ni de hooks de datos.

## Non-goals

- No cambiar backend, contratos ni lógica de estado.
- No introducir la paleta verde de luckgnome.
- Sin nuevas rutas (contactos vive dentro de perfil, como hoy).
