# Proposal: unify-agent-tools

## Intent and Outcome

El agente de texto (AI SDK) y el de voz (LiveKit realtime) exponen **un solo
conjunto de herramientas** definido una vez (`createWalletAgentDefinition()`),
con adapters finos por runtime. El caso disparador: "¿cuánto tengo en Solana?"
funciona por texto y falla por voz porque la voz fija la red al crear la sesión
y su `get_balance` no acepta `network`. Outcome: paridad estructural garantizada
por test, multi-red real en ambos agentes, contrato `send_token` preview-only
compartido (el más seguro de los dos), y cobertura de evals nivel 1 (CI
determinista) para las tools hoy sin escenario + escenarios multi-red + limpieza
de fixtures legacy (sepolia/USDT).

## Design Resolutions (del design discussion aprobado)

D1: una definición neutral, dos adapters (`toAiSdkTools` existe; nuevo
`toLivekitRealtimeTools`; se borra `src/agent/livekit-adapter.ts`, código muerto
con la lógica útil que se reencarna). D2: `send_token` preview-only compartido
`{amount, recipientId, recipientVersion, memo?}` `.strict()` — el texto conserva
dirección directa vía resolución/persistencia de destinatario, no vía surface del
modelo. D3: `network` opcional en las tools de lectura (default `arc-testnet`),
wallet resuelta por llamada (`bindWalletForUser` sin hint), fail-closed con error
tipado. D4: `search_contacts` → `search_recipients` (un nombre). D5:
`confirm_transfer`/`cancel_transfer` voice-only declarados como única excepción
(`VOICE_ONLY_TOOLS`). D6/D7: evals — nuevos escenarios mock-model para 7 tools
sin cobertura + multi-red + preview-only-texto; limpieza legacy; `EVAL_REAL=1`
(documentado como release gate). D8: higiene acotada (borrar adapter muerto).

## Scope

In: `src/agent/definition.ts`, nuevo `src/agent/livekit-realtime-adapter.ts`,
`src/livekit/realtime-tools/create-realtime-tools.ts` (reesrito como adapter +
decoradores), `src/livekit/worker.ts` (binding sin hint),
`src/livekit/create-agent-session.ts` (instrucciones), `tests/**` (paridad,
multi-red, adapter), `evals/agent/scenarios/**` (nuevos escenarios + limpieza),
`evals/voice/realtime/**` (alineación), `docs/evals.md` (release gate).

Out: protocolo/modelo de voz; frontend; judge/realtime con red en CI; knip config;
`src/agent/wallet-agent.ts` guardas runtime (pendingMatches/previewId quedan);
WDK fixture stack; contratos HTTP (`RealtimeVoiceToolResult` no cambia).

## Rules (RFC 2119)

- El set de tools de texto y voz DEBE ser idéntico salvo `VOICE_ONLY_TOOLS`.
- Ningún modelo DEBE recibir un schema que acepte `to`/`dryRun` para transferencias.
- `network` en tools de lectura DEBE ser opcional con default `arc-testnet` y
  resolver fail-closed para redes no soportadas.
- `src/agent/definition.ts` NO DEBE importar de `@livekit/*` (dependencia solo
  livekit→definition).
- La paridad DEBE estar cubierta por un test que falle ante divergencia.
- Evals nuevos DEBEN correr en CI sin red (mock-model) y estar en `npm run eval`.
- Fixtures de eval NO DEBEN usar redes/tokens fuera del producto salvo tests del
  modo demo explícitos.
- Strict TDD: RED primero por cada comportamiento nuevo (paridad, multi-red,
  adapter), luego GREEN; `npm test` + `npm run typecheck` por tarea.

## Delivery

New capability `unified-agent-tools`. PR squash a `main` (linear history).
`delivery_strategy: exception-ok` no requerido (cambio acotado, sin migraciones).
Validación completa: backend lint/typecheck/test/build + `npm run eval` verde.

## Epistemic Status

Code evidence: `.agent-workflow/tasks/agent-tools-unification/02-research.md`.
Design gate: satisfied (owner delegó autoridad total, 2026-10-07). Live probe:
resolver multi-red verificado contra el backend real (solana 0 SOL, arc 9.99 USDC).
