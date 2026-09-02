# LiveKit development runbook

The first live-voice implementation is development-only. Start Supabase, Fastify, and the worker as independent processes. Configure `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`, and the Ed25519 binding keys before starting the worker. `DEMO_USER_ID` is a single-user development seam, not production authentication.

Application audio is not persisted. Keep Egress and automatic recording disabled, and keep detailed traces disabled unless the redaction and seven-day development retention controls have been reviewed. ElevenLabs provider retention depends on the account plan; do not claim end-to-end zero retention without verifying that capability.

Before production multiuser access, replace the demo identity provider, issue LiveKit tokens from Fastify, rotate binding keys, add authorization tests, rate limits, and abuse controls. Never enable live WDK broadcast without the existing explicit approval gates.
