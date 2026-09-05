# Workflow model

The router optimizes for the fewest handoffs that still protect consequential decisions. A gate exists only when proceeding would spend authority, harden an expensive choice, create difficult-to-reverse state, or hide uncertainty from the accountable human.

## Oneshot

Use when the target is concrete, the affected area is known, and rollback is cheap.

Flow: inspect -> implement -> automated verification -> manual review if material.

Artifacts: `00-intake.md`, `90-verification.md`.

Escalate to RPI if evidence contradicts the task, scope spreads, or a meaningful choice appears.

Oneshot requires an unambiguous write scope in intake. External writes, destructive or irreversible actions, and recipient selection require a pre-mutation gate even when the implementation is small.

## RPI

Use when the current state must be researched and product/technical choices can be resolved in one integrated design discussion.

Flow: research questions -> current-state research -> design discussion -> structure outline -> implementation -> verification.

Artifacts: `00-intake.md`, `01-research-questions.md`, `02-research.md`, `03-design-discussion.md`, `04-structure-outline.md`, `90-verification.md`.

Gate: the design discussion records current state, desired state, options, tradeoffs, and explicit choices. Unresolved controlling questions stop the outline and implementation. If product intent and system design need independent approval, switch to PRD-oriented.

## PRD-oriented

Use when what should be built and how it should work need separate review points, even when the same person owns both decisions.

Flow: research questions -> current-state research -> PRD -> TDD -> structure outline -> implementation -> verification.

Artifacts: `00-intake.md`, `01-research-questions.md`, `02-research.md`, `03-prd.md`, `04-tdd.md`, `05-structure-outline.md`, `90-verification.md`.

Gates:

1. PRD approval covers user/problem, desired behavior, boundaries, success evidence, and non-goals.
2. TDD has two separate approvals: system design first, then program design. Together they cover interfaces, state, failure modes, migration, security, and verification.

Do not let TDD silently redefine the approved PRD. Reopen and reapprove the PRD instead.

## Control loop

Use for scheduled, event-driven, or repeatedly invoked autonomous work. Load `$humanlayer-design-control-loop`.

Artifacts: `00-intake.md`, `10-loop-contract.md`, `20-local-proof.md`, `30-rollout.md`, `80-standing-policy.md`, `90-verification.md`.

Gate: scheduling is forbidden until the local proof demonstrates every active component and the human approves scope, WIP, rollback, and write authority.

## Freeform

Use for discovery without a stable mutation target. Create `exploration.md` with a bounded question, source boundary, effort/time bound, and exit condition. Put prototypes under `.agent-workflow/scratch/<task-slug>/`, keep them out of deliverable paths, and do not mutate production state. End by selecting Oneshot, RPI, PRD-oriented, Control loop, or Stop.

## Ownership and precedence

- Intake owns intent, authority, and starting constraints.
- Research owns current-state facts; live code and current external state outrank stale notes.
- PRD owns what and why.
- Design discussion or TDD owns chosen behavior and tradeoffs.
- Outline owns delivery slices, not design.
- Standing policy owns durable reviewer preferences, not run history.
- Verification owns observed results and unresolved manual work.

When facts conflict, update the owning artifact. A downstream file must not quietly override it.
