# 00 — Intake

## Outcome

Un solo conjunto de herramientas del agente para texto y voz. Hoy el agente de texto
(AI SDK) y el de voz (LiveKit realtime) definen tools en paralelo, con superficies
divergentes: `get_balance` de voz no acepta `network` (lee solo Arc) mientras la de
texto sí; el binding de sesión de voz fija la red al crear la sesión. El resultado
observable: "¿cuánto tengo en Solana?" funciona por texto y falla por voz. Objetivo:
definición neutral compartida (`AgentToolDefinition`), adapters finos por runtime
(`toAiSdkTools` existe; agregar `toLivekitTools`), wallet resuelta por llamada según
la red pedida, y un test de paridad que impida que las superficies vuelvan a divergir.

## Acceptance evidence (provisional)

- Las tools de voz se generan desde la misma definición neutral que las de texto
  (adapter `toLivekitTools`); ningún `name`/`description`/schema duplicado a mano.
- `get_balance` por voz acepta `network` opcional (default `arc-testnet`) y el
  resolver devuelve la wallet correspondiente (Arc o Solana) por llamada.
- Test de paridad: el conjunto de tools expuesto a ambos runtimes es idéntico en
  nombre, descripción y shape de schema (excluyendo los decoradores de voz:
  `confirm_transfer`/`cancel_transfer`, que son gate de decisión hablada).
- Suite backend verde: lint, typecheck, tests, build.
- Evals nivel 1 (CI, sin red): escenarios con mock-model para las tools hoy sin
  escenario (`get_networks`, `list_tokens`, `get_address`, `get_history`,
  `search_user_memory`, `stage_user_memory`, `write_user_memory`) + escenarios
  multi-red (Arc/Solana).
- Fixtures legacy (`sepolia`/`USDT`) limpiados donde el producto ya no los usa
  (privy mode es `arc-testnet`/`USDC` + `solana-devnet`).

## Granted authority

- Read: entire repository, docs, evals.
- Write (planning artifacts): `.agent-workflow/tasks/agent-tools-unification/`.
- Write (implementation): granted for the approved design (see 03-design-discussion.md
  and openspec change `unify-agent-tools`).

## Read scope

- `src/agent/definition.ts` (definición neutral, schemas), `src/agent/ai-sdk-adapter.ts`,
  `src/agent/wallet-agent.ts` (guardas), `src/agent/instructions.ts` (config).
- `src/livekit/realtime-tools/create-realtime-tools.ts` (tools de voz a migrar),
  `src/livekit/worker.ts` (binding de wallet por sesión),
  `src/livekit/create-agent-session.ts` (instrucciones realtime).
- `src/wallet/privy-user-provider.ts` (`bindWalletForUser`, `walletChainFamilyForNetwork`),
  `src/conversations/service.ts` (resolver por llamada).
- `evals/agent/**`, `evals/voice/realtime/**` (superficie de evals a extender/limpiar).
- `.github/workflows/ci.yml` (gate de evals).

## Write scope (implementation)

- `src/agent/definition.ts` (extender schemas: `network` opcional en voice-shared tools).
- `src/agent/livekit-adapter.ts` → reemplazar por `toLivekitTools` real que consuma la
  definición neutral (hoy lista nombres para el adapter viejo).
- `src/livekit/realtime-tools/create-realtime-tools.ts` → reescribir como adapter +
  decoradores de voz (`voiceDecisionGate`, `speakPreview`).
- `src/livekit/worker.ts` → binding de wallet por llamada (seam `walletForUser` ya existe).
- `tests/**` nuevos: paridad de tools, balance multi-red por voz, adapter livekit.
- `evals/agent/scenarios/**`: escenarios nuevos para las 7 tools + multi-red.
- `evals/voice/realtime/**`: limpiar fixtures legacy; matrix alineada a la superficie unificada.

## Non-goals

- No cambiar el protocolo OpenAI Realtime ni el modelo de voz.
- No tocar el frontend salvo que un contrato de tool result lo exija (no debería).
- No migrar el judge/realtime a CI con red (queda `EVAL_REAL=1`, gate de release).
- Sin MCP: consumidores en el mismo proceso; un servidor MCP agregaría latencia por
  tool call (crítico en voz) sin resolver nada que el patrón adapter no resuelva.

## Selected route

Two-stage repo flow: this scaffold → design approval → openspec change
`unify-agent-tools` → apply → verify. PRs squasheados a `main` (branch protection
exige linear history).
