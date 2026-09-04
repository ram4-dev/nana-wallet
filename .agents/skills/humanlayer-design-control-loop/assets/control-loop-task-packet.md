# Control-loop task packet

Create these files under `.agent-workflow/tasks/<slug>/`:

1. `00-intake.md`: outcome, acceptance evidence, granted authority, read scope, write scope, non-goals, selected route, and active gate.
2. `10-loop-contract.md`: set point, mutable and read-only scope, sensor I/O, controller policy, actuator action, validation, disturbances, dampener, cadence, WIP, rollback, permissions, and approval.
3. `20-local-proof.md`: commands, fixtures, and observed results for each component, integrated dry run, WIP no-op, and rollback rehearsal.
4. `30-rollout.md`: read-only and advisory stages, write-enable criteria, trigger and bypass allowlists, concurrency, alert thresholds, review capacity, and approval.
5. `80-standing-policy.md`: durable constraints, reviewer preferences, known false positives, and selection-policy adjustments. Do not store transcripts or one-shot instructions.
6. `90-verification.md`: automated, E2E or real-route, manual, rollback, and not-run evidence.

Use this approval record at design, rollout, write-enablement, and bypass gates:

```markdown
Gate ID:
Decision / exact authority:
Explicit exclusions:
Owning artifact / revision or hash:
Decision owner:
Approved by / trusted identity:
Approved at:
Status: proposed | approved | superseded
Invalidated by:
```
