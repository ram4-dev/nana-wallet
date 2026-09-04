# Observability proposal

> **Status: FUTURE PROPOSAL — not implemented.** Langfuse, Sentry, and OpenTelemetry exporters are NOT implemented yet. The observability that exists today lives in `src/observability/` (voice metrics, redacted voice traces, redaction helpers). Treat the content below as a design target, not a description of working code.

Nana will keep LiveKit Agent Insights for voice-session diagnosis and send application telemetry to the services already in use.

- Langfuse receives redacted OpenTelemetry traces from LiveKit and the wallet domain. It is where we inspect agent turns, tool execution, latency, and model usage.
- Sentry receives application errors, worker failures, and release context from Fastify, the LiveKit worker, and the web app.
- LiveKit Agent Insights remains the place to inspect room lifecycle, STT, LLM, TTS, interruptions, and media failures.

No transcript, audio, wallet address, amount, transaction hash, tool argument, binding token, or provider payload is exported in application telemetry. Production voice sessions keep audio and transcripts disabled unless the privacy policy changes.

Before enabling the exporters, add a small redaction contract and verify it with tests. The first dashboard should answer four questions: are turns completing, where does latency occur, which provider is failing, and are preview and confirmation outcomes reaching a terminal state.
