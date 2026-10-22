# Intake: broadcast uncertainty defects

Date: 2026-10-22. Status: resumed planning; implementation gate is not active.

## Outcome

Complete D-B with truthful pre-dispatch outcomes while preserving `uncertain` after a request may have left the process. For D-C, define the minimum evidence needed to prove absence; leave it open if the real Privy path cannot provide that evidence.

## Acceptance evidence

- Deterministic tests show known pre-dispatch wallet resolution, identity, blockhash, and request-validation failures never reach signing and produce the appropriate `not_dispatched` cause.
- A generic error at or after `signAndSend` remains `uncertain` and is never retried or re-signed.
- D-C remains `uncertain` unless a lookup can authoritatively correlate the reference and prove absence; a bounded history page is insufficient.
- Relevant tests, typecheck, lint, and the applicable E2E route pass before completion.

## Authority and boundaries

- User asked to resume this work and previously authorized D-D, D-E, D-B, and D-C in order, with decisions recorded rather than blocking on Rama.
- Read scope: wallet provider, conversation service, existing tests, task docs, and relevant OpenSpec conventions.
- Write scope: the existing `fix/broadcast-uncertain-defects` worktree only.
- No live payment, live RPC, secret access, `main` changes, PR, or destructive action.
- Controlling artifacts: `odd/tasks/broadcast-uncertain-defects.md` and this RPI packet. `handoff.md` records the resume point.

## Route and gate

Route: RPI plus SDD, required by repository instructions for a resumed development task. Research is in progress. Implementation requires an independent Pi review of the outline and explicit approval of that outline. Pi review is currently blocked by the Nan monthly quota reset date recorded in `05-independent-review.md`.
