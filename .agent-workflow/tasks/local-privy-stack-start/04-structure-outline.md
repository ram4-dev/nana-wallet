# Structure outline

The user approved same-origin routing and waived intermediate permission requests on 2026-10-22. Independent Pi outline review was not performed; Pi quota exhaustion and continuation in this conversation were already specified by the user. No completed Pi review is claimed.

1. Add opt-in Vite proxies for `/api` and `/livekit`, with no frontend/backend imports. Verify real health and unauthenticated bindings through HTTPS.
2. Add `npm run dev:stack`: Vault injection, linked Supabase validation, isolated Docker services and signing sidecars, persistent restricted voice keys, strict Portless HTTPS, dynamic backend/signaling ports, and the frontend using those proxies. Restart only the owned frontend process/route. Verify repeated startup and readiness failures.
3. Add focused launcher tests and a short runbook. Run backend/frontend checks plus meaningful browser/proxy and LiveKit E2E. Keep tests off the remote database; remote startup probes remain read-only.

Worktree: `/Users/ramiro/Desktop/projects/colloseum.fix-local-privy-stack-start`, branch `fix/local-privy-stack-start`, base `22cb8e1`.

Rollback: stop only this launcher's owned processes/Compose project, restore the previous Portless route if necessary, and revert the launcher/proxy changes. No volume deletion or remote migration.
