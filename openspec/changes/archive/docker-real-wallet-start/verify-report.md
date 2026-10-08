# Verificación

Base: origin/main e80e568. Rama: feat/docker-real-wallet-start. Worktree: /Users/ramiro/Desktop/projects/personales/aleph-hackathon.feat-docker-real-wallet-start. Cambios preservados en el checkout original. Sin commit, push ni merge.

## Resultado

Script y skill local implementados. CLI exige proveedor real explícito, valida credenciales sin mostrarlas, inicia todos los servicios (incluido daemon con perfil para WDK), migra DB y verifica modo live/saldo. Skill validada por quick_validate.py.

## Evidencia

- node --test scripts/docker-real-wallet.test.mjs: 9/9. Incluye CLI completa con Docker/Portless simulados, orden DB/migración/servicios, perfil daemon y prohibición de declarar éxito ante fallo del health.
- Backend: npm run lint, npm run typecheck, npm run build en verde; npm test con Postgres: 359 pasaron, 10 omitidos.
- Frontend: lint, typecheck en verde; npm test: 52/52.
- npm run eval: 16 evals fixture, score 100%, threshold configurado 0%. Las variantes reales no fueron ejecutadas.
- Imagen backend origin/main: construida y HTTP /health, address, balance, history y creación de conversación verificados en Docker con fixture para revisión.
- Nueva imagen frontend: build Docker completo (build:mobile como SPA de producción, sin MSW), nginx sirve index.html y fallback SPA; proxy /api/health y /livekit/ comprobados.
- Portless HTTPS: /agente y /api/health respondieron 200 en nana-start-review.localhost.
- Compose generado validado: db, livekit, backend, frontend, voice-worker, wdk-daemon.
- Migraciones reales en Postgres nuevo: primera ejecución 3 migraciones; segunda mantiene 3. Checksum diferente aborta y hace rollback.
- Preflight real WDK mediante vault-env: exit 1, enumera solamente nombres faltantes.

## Límites y bloqueos

El script completo NO fue ejecutado con wallet real. Faltan LIVE_VOICE_BINDING_PRIVATE_KEY, LIVE_VOICE_BINDING_PUBLIC_KEY, WDK_MAX_TRANSFER_AMOUNT, WDK_ALLOWED_RECIPIENTS, NANA_WDK_VOLUME, WDK_WALLET_NAME y WDK_TOKEN en la configuración de esta ejecución. La selección de proveedor permanece pendiente del usuario. Circle Arc requiere integrar las PRs #9–#11 y provisionar CIRCLE_API_KEY, CIRCLE_ENTITY_SECRET, CIRCLE_SENDER_WALLET_ID (no listados en Vault).

Los E2E externos opt-in de LiveKit, WDK live preview y recipient-memory LLM no se ejecutaron; no se emitieron transferencias. HTTP de infraestructura validado con API fixture de prueba, no prueba wallet real ni conversación de voz en navegador. La UI general conserva endpoints aún simulados/no implementados en el backend de base; este cambio conecta el agente real, no implementa productos fuera del alcance.

Los contenedores de prueba y el alias temporal se detienen al finalizar; se preservan volúmenes de prueba y el worktree para revisión.

## Actualización 2026-09-08: proveedor y configuración integrados

La PR #12 (Circle Arc) reemplazó #9–#11 y se mergeó a main con ambos checks de CI en verde. Este worktree avanzó por fast-forward a 48fecb6, preservando los artefactos del script todavía sin commit.

Se enlazó .env al archivo existente del worktree arc-migration; se verificó que está ignorado y no está tracked. No se imprimieron ni copiaron valores al código.

Preflight real: node scripts/docker-real-wallet.mjs --provider circle-arc --env-file .env --check, exit 0, circle-arc / arc-testnet / USDC. Esto reemplaza los bloqueos anteriores de ausencia de proveedor y configuración para Circle. Las nueve pruebas del script, incluidas las dos pruebas de orquestación con comandos simulados, volvieron a pasar.

No se ejecutó el arranque completo ni transacciones en esta actualización. La validación de voz y del stack real completo sigue pendiente. El checkout principal con cambios locales quedó intacto.

## Validación completa 2026-09-08 en la rama de integración

El bloqueo de arranque Circle quedó resuelto. Se ejecutó el script completo dos veces con la configuración existente de arc-migration: build de imágenes, DB y migraciones, LiveKit, API, worker y frontend. Ambos arranques terminaron con health live y lectura de saldo USDC en Arc. Portless sirvió la SPA y la API con HTTP 200. Se corrigió además una colisión del archivo LiveKit entre proyectos: ahora vive bajo el nombre del proyecto Docker.

Suites actuales: backend 453 tests pasados/10 opt-in omitidos; frontend 52; script 9; 16 evals con score 100%; E2E MCP 1. Lint, typecheck y build en verde. La interacción visual y la conversación de voz siguen sin validar porque Browser no tiene navegadores disponibles. El flujo WDK completo no se probó con wallet desbloqueada; Circle sí. No se hicieron transferencias. El inventario y la evidencia actual están en `.agent-workflow/tasks/local-work-consolidation/90-verification.md`.
