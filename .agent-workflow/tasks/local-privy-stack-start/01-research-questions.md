# Research questions

1. Which origins and URLs does the running frontend/API/worker actually use? Compare the reported request, CORS preflight, public runtime settings, and HTTPS probes.
2. Does the backend accept the browser origin? Inspect Fastify CORS configuration and reproduce the exact binding preflight.
3. What does the service-worker trace mean? Inspect frontend mock startup and live backend routing.
4. Is the active API and worker database local or remote? Check only the target classification, then run a read-only connectivity/schema probe without exposing credentials.
5. What existing launch and reverse-proxy paths can be reused? Inspect Compose, Docker Nginx, Vite, scripts, and the prior handoff.
6. Which services or capabilities are absent despite HTTP health returning 200? Inspect provider readiness and signer configuration without exercising signing or payments.
7. Which checks can prove a repeatable startup without treating mocked tests or an unauthenticated page load as a successful live voice session?

Excluded: payment semantics, recipient policy changes, remote data migrations, the Nana Landing project, and changes to unrelated runtimes.
