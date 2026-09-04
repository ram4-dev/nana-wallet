# RPI task packet

Create these files under `.agent-workflow/tasks/<slug>/`:

1. `00-intake.md`: outcome, acceptance evidence, granted authority, read scope, write scope, non-goals, selected route, and active gate.
2. `01-research-questions.md`: current-state questions, why each matters, evidence to inspect, and scope exclusions.
3. `02-research.md`: answers, source paths or commands, observed behavior, contradictions, and remaining gaps.
4. `03-design-discussion.md`: current state, desired state, options, tradeoffs, recommendation, open questions, explicit decisions, and approval record.
5. `03a-open-questions.md`: complete inventory of controlling questions, one-at-a-time answers, rationale, dependency and status. Create and show it before drafting the outline.
6. `04-structure-outline.md`: vertical slices with outcome, files, automated checks, E2E or real-route check, manual checks, and stop condition.
7. `05-independent-review.md`: exact outline revision reviewed by Pi/GLM 5.3 Flash at `high`, findings, dispositions, session receipt, cleanup proof, and review verdict. Create it before requesting outline approval.
8. `90-verification.md`: unit, integration, static, build, E2E, manual results, not-run blockers, deviations, and next owner.

Use this approval record at every pre-mutation gate:

```markdown
Gate ID:
Decision / allowed mutation:
Explicit exclusions:
Owning artifact / revision or hash:
Decision owner:
Approved by / trusted identity:
Approved at:
Status: proposed | approved | superseded
Invalidated by:
```
