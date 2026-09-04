---
name: humanlayer-rpi-workflow
description: "Trigger: RPI, research design implement, design discussion. Run a finite task through research, design approval, outline, implementation, and verification."
license: Apache-2.0
metadata:
  author: "ramiro"
  version: "1.1"
---

## Activation Contract

Load this skill when a finite task needs current-state research and one integrated design discussion before implementation.

## Hard Rules

- Inspect the repository before asking questions.
- Keep research questions about current state; do not smuggle solution choices into research.
- Ground research in code, tests, commands, and primary sources.
- Ask one consequential design question at a time by default. Offer a recommendation and tradeoff.
- Before drafting an outline, create an explicit open-question inventory and show the user all remaining controlling questions. Record each answer in that artifact; do not silently infer a decision from implementation detail.
- Present the user-facing inventory in plain language with two or three concrete options, mark a recommendation and explain the practical tradeoff; keep protocol names and command details in the artifact.
- Do not create the structure outline until controlling design questions are resolved and the current design artifact is approved.
- After all controlling questions are answered and the complete outline is drafted, run an independent Pi review with `nan/glm5.3-flash` and reasoning `high` before requesting outline approval.
- Persist Pi's review in `05-independent-review.md`. Critical or controlling findings require an outline revision and another independent review; Pi never grants human approval.
- Outline feedback updates the outline only. It never authorizes implementation.
- Implement in vertical slices with unit, integration, static, build, E2E, and manual evidence as applicable.
- Before implementation or any code mutation, load `worktree-first-development` and create a fresh Worktrunk worktree. The implementation gate is not active until the worktree path and branch are recorded.

## Decision Gates

| Phase | Gate |
|---|---|
| Research questions | Scope covers the unknown current state |
| Research | Evidence answers the questions or names exact gaps |
| Design discussion | Explicit decisions and approval bound to current revision |
| Open-question inventory | All controlling questions are listed, answered or explicitly deferred |
| Structure outline | Each slice has an observable result and checks; Pi review is pending |
| Independent review | Pi reviewed the exact outline revision; controlling findings are resolved |
| Implementation | Previous slice verified; manual checks remain pending until confirmed |

## Execution Steps

1. Create the artifacts in `assets/rpi-task-packet.md` under `.agent-workflow/tasks/<slug>/`.
2. Complete research questions, then research.
3. Write current state, desired state, options, tradeoffs, and open questions in the design discussion.
4. Create `03a-open-questions.md`, list every controlling question, present the inventory to the user, and resolve one consequential question at a time. Record approvals, rationale, and unresolved dependencies.
5. Stop for design approval or scope correction. Supersede approval if the design revision or scope changes.
6. Write the complete structure outline only after the inventory has no unanswered controlling question.
7. Use `herdr-development-orchestration` to run an independent Pi review on `nan/glm5.3-flash`, reasoning `high`; record scope, exact reviewed revision, findings, dispositions, session reference, and cleanup in `05-independent-review.md`.
8. Revise and re-review until no critical or controlling finding remains, then stop for explicit human outline approval.
9. Create the approved slice's fresh Worktrunk worktree, then implement and verify it. Record the worktree identity and any deviations in the controlling artifact.

## Output Contract

Return the phase, active gate, artifact changed, evidence gathered, Pi review state and exact reviewed revision, approval state, checks run, manual checks pending, and next authorized action.

## References

- `assets/rpi-task-packet.md`
- `assets/independent-outline-review.md`
