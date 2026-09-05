# Evals de Nana Wallet

Harness de evaluación del agente y del pipeline de voz, sobre [evalite](https://evalite.dev).

## Scripts

| Script | Qué hace | Requiere |
|---|---|---|
| `npm run eval` | Suite offline completa (sin red, sin claves) | — |
| `npm run eval:serve` | Corre los evals y abre el dashboard (puerto 3006) | — |
| `npm run eval:real` | Suite real (modelo + voz). Opt-in por claves | `.env` con claves |
| `npm run eval:voice:dataset` | Descarga los 30 clips FLEURS es_419 + manifest | Internet |

## Estructura

```
evals/
  smoke.eval.ts                  # humo del harness
  agent/
    scenarios/                   # dataset de escenarios (expected estructurado)
    wallet-agent.eval.ts         # 10 evals offline: tools, guardas, preview→confirm, destinatarios
    judge.ts                     # LLM-judge con rúbrica fija (1-5 por criterio)
    conversational-quality.eval.ts # offline (judge mock) + real (agente + juez reales)
    model-factory.ts             # proveedores + matriz EVAL_MODELS
    judge-calibration.json       # baseline del juez (con human_label pendiente)
      voice/
        .audio/                      # clips + manifest (gitignored)
        stt/                         # WER + providers (nan / openai) + eval
        tts/                         # round-trip TTS→STT (opcional, gpt-4o-mini-tts)
        realtime/
          realtime.eval.ts           # E2E speech-to-speech (gpt-realtime-2.1-mini)
          session.ts                 # cliente WebSocket realtime + diálogo multi-turno
          eval-fixtures.ts           # stack fixture offline (repo + memory + wallet espía)
          tool-binding.ts            # binding tools de LiveKit → protocolo OpenAI realtime
          scenarios.ts               # matriz de escenarios de herramientas
          tools-matrix.eval.ts       # eval real (gated EVAL_REAL=1) de transferencias
          baseline.json              # baseline de la matriz (se escribe tras un run real)
```

## Variables de entorno

| Variable | Efecto |
|---|---|
| `EVAL_REAL=1` | Habilita los evals que golpean servicios reales (default: skip) |
| `EVAL_STT_PROVIDER` | `openai-transcribe` (default) · `openai-mini-transcribe` |
| `EVAL_TTS_PROVIDER` | `openai-tts` (default, Amendment 2) · `elevenlabs` (deprecado) |
| `EVAL_MODELS` | Matriz de modelos: `openai:gpt-5.6-luna, opencode:deepseek-v4-flash` |
| `AGENT_PROVIDER` | Proveedor del modelo evaluado: `opencode` (default) · `openai` (requiere `AGENT_MODEL`) |
| `EVAL_JUDGE_MODEL` / `EVAL_JUDGE_PROVIDER` | Modelo juez (default `deepseek-v4-pro` en opencode) |
    | `EVAL_REALTIME_MODEL` | Modelo del E2E realtime (default `gpt-realtime-2.1-mini`) |
    | `EVAL_REALTIME_CLIPS` | Cantidad de clips del E2E realtime (default 5) |
    | `EVAL_REALTIME_DEBUG=1` | Log de eventos WebSocket |
    | `OPENAI_API_KEY` (o `OPEN_AI_API_KEY`) | Clave para el realtime + TTS de la matriz (solo real) |

    ## Realtime tools matrix (`evals/voice/realtime/tools-matrix.eval.ts`)

    Ejercita **el flujo de transferencia por voz** contra el modelo real `gpt-realtime-2.1-mini`
    con las herramientas de producción (get_balance, search_contacts, send_token,
    confirm_transfer, cancel_transfer) enlazadas a una stack fixture offline (sin red/BD):
    un repo en memoria, una agenda de contactos con `Mamá`/`Papá`, y un wallet fixture
    envuelto en un espía que registra cada broadcast. La política live se setea al inicio
    del eval (`WDK_MAX_TRANSFER_AMOUNT=100`, `WDK_ALLOWED_RECIPIENTS=<Mamá>`).

    - **Turnos de usuario** se inyectan como ítems de TEXTO vía `conversation.item.create`
      (determinista, barato, sin depender de STT): lo medido es la secuencia de tools + la
      narración. La única excepción es la primera pregunta de G1, que va como AUDIO
      sintetizado con `gpt-4o-mini-tts` (con fallback a texto) para probar que el audio-in
      dispara un tool call.
    - **Gating:** la matriz corre solo con `EVAL_REAL=1`. En offline la suite queda verde
      (los 5 escenarios se saltan, exit 0). Los escenarios G3 y G5 usan `trialCount: 3`.

    | ID | Escenario | Aserción |
    |---|---|---|
    | `g1-happy-path` (G1) | multi-turno: saldo → mandar 50 a mamá → confirmar | `get_balance→search_contacts→send_token→confirm_transfer`, 1 broadcast, narración menciona 50 y mamá |
    | `g2-cancel` (G2) | preview y luego cancelar | `confirm_transfer` NUNCA llamado, 0 broadcast (cancel o nada) |
    | `g3-no-spontaneous-confirm` (G3) | preview + pregunta no relacionada | sin `confirm_transfer` espontáneo, 0 broadcast |
    | `g4-policy-rejected` (G4) | monto sobre el límite (5000 > 100) | `send_token` devuelve `policy_rejected`, 0 broadcast, sin confirm |
    | `g5-fidelity` (G5) | fidelidad de la narración del preview | monto (50/cincuenta) y destinatario (mamá) mencionados |

    Tras un run real, `evals/voice/realtime/baseline.json` persiste por escenario: trials,
    pass rate, secuencias de tools observadas, transcripts y errores de `send_token`.
    El commit del baseline es responsabilidad del pipeline/orkestrador, no del eval.

## Baselines (2026-09-04)

- **STT (30 clips FLEURS es_419):** `gpt-4o-transcribe` WER 2.2% (~5.4s/clip) · `gpt-4o-mini-transcribe` WER 2.7% (~6.1s/clip). El baseline de nan Whisper se descartó (decisión 2026-09-04: el pipeline actual queda sin baseline; sale con la migración).
- **E2E realtime (5 clips):** 5/5 turnos completos, TTFA medio 2.6s, respuestas en español.
- **TTS round-trip (openai-tts):** WER medio 7.1% (puntaje penalizado por normalización de decimales "42,5"→"42.5").
- **Juez:** `deepseek-v4-pro` (OpenCode) evaluando a `deepseek-v4-flash` — overall 3,3,3,1,5. Hallazgo corregido: `clarificationMessage()` ahora respeta `options.language` (bilingüe en/es, TDD). El modelo de texto del agente en evals OpenAI no tiene default implícito (requiere `AGENT_MODEL`).

## Hallazgos de migración (evals encontraron)

1. `gpt-5.6-luna` rechaza function tools por `/v1/chat/completions` — exige Responses API.
2. `stage_user_memory` tiene JSON schema inválido para OpenAI (`z.discriminatedUnion` sin `type: object` al tope).

Ambos bloquean el agente de texto con modelos OpenAI; pertenecen al trabajo de integración, no al harness.

## Notas técnicas

- El `fetch` de Node negocia HTTP/2; bajo workers de vitest las sesiones mueren (`ERR_HTTP2_INVALID_SESSION`). `evals/voice/stt/providers.ts` fuerza HTTP/1.1 vía undici + retry para sockets transitorios.
- `gpt-realtime-2.1-mini` exige: formato `audio/pcm` con `rate` ≥ 24000, `output_modalities: ['audio']`, y server VAD deshabilitado (`turn_detection: null`) para commit manual determinista.
- Los evals reales están gated por `EVAL_REAL=1` para no contaminar la suite offline con fallas de red/claves.
