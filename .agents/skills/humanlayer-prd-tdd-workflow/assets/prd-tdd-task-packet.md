# PRD and TDD task packet

Create these files under `.agent-workflow/tasks/<slug>/`:

1. `00-intake.md`: outcome, acceptance evidence, granted authority, read scope, write scope, non-goals, selected route, and active gate.
2. `01-research-questions.md`: current-state questions and evidence scope.
3. `02-research.md`: sourced answers, behavior, contradictions, and exact gaps.
4. `03-prd.md`: user, problem, desired behavior, success evidence, boundaries, non-goals, open questions, and PRD approval.
5. `04-tdd.md`: System Design questions, decisions, and approval; then Program Design questions, decisions, and separate approval. Include interfaces, state, failures, security, migration, and verification.
6. `05-structure-outline.md`: vertical slices with observable outcome, files, automated checks, E2E or real-route check, manual checks, and stop condition.
7. `90-verification.md`: unit, integration, static, build, E2E, manual results, not-run blockers, deviations, and next owner.

Use this approval record for PRD, System Design, Program Design, and any later pre-mutation gate:

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
