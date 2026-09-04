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
    realtime/                    # E2E speech-to-speech (gpt-realtime-2.1-mini)
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
