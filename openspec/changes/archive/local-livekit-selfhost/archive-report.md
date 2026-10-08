# Archive report — local-livekit-selfhost

## Summary

LiveKit self-hosted local (loopback only) con binding Ed25519, sin egress ni recording.

## Delivered

- `docker compose up -d livekit` on `127.0.0.1` only, with `record: false` verified on the worker side.
- `npm run livekit:dev` registering against the local server.
- R1 `RoomConfiguration` field-shape check included in the delivered scope.

## Evidence

- Tasks ledger: 26/29 complete.
- CI green; local stack verified during the Privy Docker launch sessions.

## Open items and deferrals

Three intentionally deferred items (manual or optional, never silently checked):

1. **13.1 Manual runbook check** — human-run verification of the loopback-only guarantee (non-financial turn plus one financial preview→confirm).
2. **13.2 Optional smoke e2e** — `LIVEKIT_URL=ws://localhost:7880 npm run test:e2e:livekit-smoke`.
3. **Bounded review of the candidate** — parent-owned review gate.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
