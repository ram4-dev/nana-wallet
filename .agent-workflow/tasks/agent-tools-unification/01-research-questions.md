# 01 — Research questions

Preguntas de investigación para el cambio `agent-tools-unification`. Cada una se
responde con evidencia de código antes del design discussion.

## Q1 — ¿Qué superficies exactas exponen hoy texto y voz, y dónde difieren?

- Texto (`src/agent/definition.ts`): `get_networks`, `list_tokens`, `get_address`,
  `get_balance{network*, token?, wallet?}`, `get_history{network*, token?, wallet?}`,
  `send_token{network*, token*, to*, amount*, dryRun*...}`, + 6 memory tools.
- Voz (`src/livekit/realtime-tools/create-realtime-tools.ts`):
  `get_balance{}` (sin input, red fija), `search_contacts{query}`,
  `send_token{amount, recipientId, recipientVersion, memo?}` (preview-only, estricto),
  `confirm_transfer{}`, `cancel_transfer{}`.
- Divergencias a reconciliar: (a) `get_balance` sin network en voz; (b) `send_token`
  con dos contratos opuestos (texto libre vs voz preview-only); (c) nombres de
  búsqueda de contactos distintos (`search_contacts` vs `search_recipients`).

## Q2 — ¿Qué contrato de `send_token` debe ganar y por qué?

El de voz (preview-only, `.strict()`, sin `to`/`dryRun`/`network`/`token`) es el más
seguro: impide que el modelo invente direcciones o fuerce broadcast. El de texto
necesita operar direcciones directas (chat permite pegar una address). Pregunta de
diseño: ¿una sola tool con campos opcionales y guardas por modo, o dos nombres
distintos (`send_token` preview-only compartido + `send_token_direct` para texto)?
La historia de guardas (CAR-006, pendingTransfer match, idempotency) vive en
`buildGuardedTools` — verificar qué parte es runtime-agnostic.

## Q3 — ¿Cómo resuelve hoy la voz la wallet, y qué hay que cambiar para multi-red?

- `worker.ts:109-115`: binding fijo `bindLiveKitWalletForUser(..., () => config.network)`
  al crear la sesión.
- `create-realtime-tools.ts`: `dependencies.wallet.getBalance({ network: config.network })`.
- El seam correcto existe: `bindWalletForUser(walletForUser, userId)` sin hint resuelve
  por llamada según `query.network` (verificado live: solana-devnet → 0 SOL, arc → 9.99 USDC).
  Cambio: pasar el resolver sin hint a las tools y derivar chain family de la network
  pedida por el modelo.

## Q4 — ¿Qué hace el adapter `toLivekitTools` necesario?

`@livekit/agents` `tool({ name, description, parameters: zodSchema, execute })`. La
definición neutral ya es `{ name, description, inputSchema: zod, execute(input, context) }`.
El adapter es un map 1:1 + inyección del contexto de voz (userId, conversationId,
service, gate, speakPreview). Verificar tipado de `parameters` (zod v4 JSON schema) y
cómo el eval `tool-binding.ts` declara tools al modelo (`z.toJSONSchema`).

## Q5 — ¿Qué decoradores son legítimamente voice-only?

- `voiceDecisionGate` (anti-confirmación fantasma: la confirmación debe ser hablada
  tras el read-back): envuelve `confirm_transfer`/`cancel_transfer` — tools que no
  existen en texto porque ahí la confirmación es un turno de chat.
- `speakPreview` (read-back hablado antes de pedir decisión): decorador del preview.
- Idioma de sesión para `balanceSpoken`: ya resuelto por `formatBalanceForAgent(lang)`.
Conclusión tentativa: las tools financieras (`get_balance`, búsqueda, `send_token`)
son compartidas; `confirm_transfer`/`cancel_transfer` son voice-only por diseño del
gate, documentado en la paridad (lista de excepciones explícita).

## Q6 — ¿Qué fixtures/escenarios de eval están muertos?

- `evals/agent/scenarios/constants.ts` y guard/preview scenarios usan sepolia/USDT
  (modo demo-legacy). El producto real (privy) es arc-testnet/USDC + solana-devnet.
- Los escenarios con `MockLanguageModelV3` siguen válidos como determinismo de CI;
  hay que migrar constantes a la realidad del producto y agregar: tools no cubiertas
  (7), multi-red, y el caso que originó el cambio (balance de solana por voz → texto).

## Q7 — ¿Dónde vive la verdad del set de tools para la paridad?

Propuesta: export de `createWalletAgentDefinition()` la lista canónica; un test
compara `definition.tools(context).map(t => t.name)` contra la lista producida por
`toLivekitTools` (menos las excepciones declaradas) y contra los nombres declarados
en las instrucciones realtime (`NANI_REALTIME_INSTRUCTIONS`). Evitar string literals
repetidos en tres lugares.
