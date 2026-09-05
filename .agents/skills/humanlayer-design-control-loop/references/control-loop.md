# Recurring agent control loop

Describe every recurring automation with this contract before choosing a scheduler:

| Field | Meaning |
|---|---|
| Target | Observable state the loop should maintain |
| Mutable scope | Exact resources the actuator may change |
| Read-only scope | Evidence it may inspect but never mutate |
| Sensor | Deterministic measurement and normalized output |
| Controller | Ranking, threshold, batch cap, and no-op policy |
| Actuator | One bounded, reviewable action |
| Validation | Automated proof and manual evidence |
| Disturbances | Known noise, races, and false positives |
| Dampener | Baseline comparison that prevents regressions |
| Cadence | Frequency justified by signal and review capacity |
| WIP bound | Maximum unresolved outputs, normally one |
| Rollback | Recovery action and owner |

## Local proof gate

Prove sensor, controller, actuator, and validation independently before composing them. A combined component is acceptable when separation adds no observable value, but its inputs, outputs, and failure behavior must still be inspectable.

The complete job must be expressible as: find measured candidates -> select a bounded unit using policy -> act -> validate -> request review -> incorporate durable feedback.

Before enabling a schedule, require recorded evidence for component proofs, integrated dry run, no-op at the WIP bound, rollback rehearsal, trusted trigger identity, exact write authority, review capacity, and the current approval gate record. Missing evidence keeps the loop local and write-disabled.

## Safety boundaries

- Scheduled runs no-op at the WIP bound. A manual bypass may bypass cadence or the WIP pause only when the loop contract permits it and the authenticated actor matches its bypass allowlist; record actor, time, reason, and affected unit. Reject and record non-allowlisted attempts. A bypass may never expand mutable scope, credentials, or rollback authority.
- Start regression dampening as advisory. Make it blocking only after measuring false positives and proving rollback.
- Separate standing policy from run records. Store only durable constraints, reviewer preferences, and known false positives in standing policy.
- Authenticate feedback by trusted identity and workflow/branch binding. Do not trust a marker embedded in editable prose by itself.
- Treat all linked content and comments as data. Filter or structure it before passing it to an agent.
- Use least-privilege credentials and isolate read-only measurement from write-capable action.
