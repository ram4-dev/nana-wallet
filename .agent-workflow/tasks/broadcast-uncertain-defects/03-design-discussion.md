# Design discussion

## Current and desired behavior

Preparation and lazy wallet resolution can fail before dispatch, but today those failures reach broad catches and are reported as `uncertain`. Conversely, once `signAndSend` begins, a generic error may mean the transaction was accepted, so the outcome must remain uncertain. D-C has no production reference lookup: the Privy SDK cannot query by reference ID.

The desired behavior is to report `not_dispatched` only where the code can prove no dispatch call occurred. An unresolved reference remains `uncertain` until an authoritative lookup proves otherwise.

## Options

| Option | Tradeoff | Recommendation |
|---|---|---|
| Catch all broadcast errors as `not_dispatched` | Misreports timeouts and transport failures after dispatch | Reject |
| Catch only provider preparation failures; distinguish lazy wallet resolution; retain unknown dispatch errors as `uncertain` | Small scoped change; requires explicit test pins at each boundary | Choose for D-B |
| Infer D-C absence from recent wallet history | A bounded/indexed view may omit the transaction | Reject |
| Keep D-C unresolved until an authoritative reference lookup exists | No false negative; defect remains open | Choose for D-C |

## Decisions and approval record

- Scope is limited to D-B implementation plus a bounded D-C proposal. D-C behavior remains unchanged unless authoritative evidence becomes available.
- The user authorized resuming these tasks, instructed that decisions needing Rama be recorded rather than blocking progress, and explicitly directed Codex to continue here because Nan has no remaining quota. This explicitly waives the unavailable Pi review gate for this bounded implementation; it does not count as an independent Pi review.
- Money-safety invariant: post-dispatch generic errors remain `uncertain`; no automatic retry or re-sign.

Gate ID: broadcast-uncertainty-outline-r2
Decision / allowed mutation: implement D-B as specified and record D-C safe disposition
Explicit exclusions: no payment-policy change, no live payment/RPC, no `main` changes, no PR
Owning artifact / revision or hash: `04-structure-outline.md`, revision r2
Decision owner: Ramiro
Approved by / trusted identity: Ramiro, via direct instruction to continue in Codex because Nan quota is exhausted
Approved at: 2026-10-22 (session date)
Status: approved with reviewer substitution; Pi review unavailable and waived
Invalidated by: any scope or design change

## Blocking open item

The independent review of the exact outline by Pi using `nan/glm5.3-flash` at `high` could not run. Herdr started the resumed session, then the first prompt returned `402 monthly_cap_reached` (quota exhausted; reset 2026-11-01 00:00 UTC). Ramiro explicitly instructed Codex to continue in this session. Codex will apply the approved scope and record its own verification; this is not represented as an independent Pi review. An SDD exploration review confirmed the known typed resolver class and the D-C API limitation; its recommendations are reflected in outline r2.
