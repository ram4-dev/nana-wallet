---
name: humanlayer-prd-tdd-workflow
description: "Trigger: PRD, TDD, product requirements, technical design. Run separate product, system design, and program design approval gates before implementation."
license: Apache-2.0
metadata:
  author: "ramiro"
  version: "1.0"
---

## Activation Contract

Load this skill when product intent and technical design need separate review points for a finite task.

## Hard Rules

- Inspect current behavior before proposing product or technical changes.
- Ask one product question at a time by default. Approve the complete PRD, not isolated answers.
- TDD has two gates: System Design approval, followed by Program Design approval.
- TDD must not redefine an approved PRD. Reopen and reapprove the PRD when product behavior changes.
- Do not write the structure outline while any controlling PRD or TDD decision is open.
- Outline feedback never authorizes implementation.
- Implement in vertical slices and record all applicable unit, integration, static, build, E2E, and manual evidence.

## Decision Gates

| Artifact | Approval scope |
|---|---|
| PRD | User, problem, behavior, success evidence, boundaries, non-goals |
| TDD System Design | Architecture, components, data flow, security, failure boundaries |
| TDD Program Design | Interfaces, state, file-level changes, migration, testing |
| Structure outline | Reviewable vertical slices and checks |

## Execution Steps

1. Create the artifacts in `assets/prd-tdd-task-packet.md` under `.agent-workflow/tasks/<slug>/`.
2. Complete current-state questions and research.
3. Draft the PRD, resolve its questions, and stop for full approval.
4. Draft System Design, resolve one consequential question at a time, and stop for approval.
5. Draft Program Design and stop for its separate approval.
6. Write the structure outline, then implement and verify each slice.
7. Supersede any gate whose artifact revision, scope, or authority changes.

## Output Contract

Return the phase, active gate, artifact revision, unresolved questions, approval state, checks run, manual checks pending, and next authorized action.

## References

- `assets/prd-tdd-task-packet.md`

