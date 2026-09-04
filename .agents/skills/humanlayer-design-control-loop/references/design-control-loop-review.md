# HumanLayer design-control-loop review

Source inspected: `humanlayer/skills` at commit `3c2629142c5d437428269b1b722b08c0b87f574d`, mainly `plugins/design-control-loop/skills/design-control-loop/` and its references.

## What it is

`design-control-loop` defines a recurring code improvement system. Each run measures a property of the repository, selects one bounded improvement, changes the code, validates it, and opens work for review. Human feedback adjusts later runs.

It does not replace RPI or PRD-oriented work. RPI and PRD-oriented take one task from research to implementation. A control loop chooses and executes a new unit of work on every run. RPI can design the first version of that loop. If the loop encounters a new product decision or technical contract, stop and return to RPI or PRD-oriented. Use PRD and TDD when those decisions need separate approval.

## The loop

```text
set point
   ↓
sensor measures the gap
   ↓
controller ranks candidates and selects a bounded unit
   ↓
actuator changes the code
   ↓
validation and regression check
   ↓
PR and human review
   ↓
durable feedback tunes later selections
```

The terms have concrete jobs:

- The set point is the property to maintain or improve.
- The sensor produces a stable and repeatable measurement.
- The controller applies thresholds, priority rules, and a batch cap. It can decide to do nothing.
- The actuator is the coding agent and its task-specific skill.
- Disturbances are unrelated changes such as dependency upgrades, generated code, concurrent commits, or flaky tests.
- A dampener compares the result with a baseline. It should begin as advisory and become blocking only after its false-positive rate is understood.

Sensor, controller, and actuator may be combined when separation adds no useful observation point. Their inputs, outputs, and failure behavior still need to be inspectable.

## Upstream phases and gates

1. Inspect the repository. Find package commands, CI, validation, existing skills, and possible sensors before asking the user questions.
2. Write the loop design. Define the target, read and write scope, sensor, selection policy, smallest reviewable action, validation, disturbances, cadence, and WIP limit.
3. Build the actuator skill. It contains judgment, completion criteria, and known good patterns for the selected task.
4. Prove each component locally, then prove the integrated loop. CI is blocked until this works.
5. Add the scheduled workflow, PR output, and durable feedback memory.
6. Keep humans on the loop. Reviewers use feedback to change later selection and behavior.
7. Bound work in progress. The upstream default is one open PR per loop; scheduled runs do nothing while that slot is occupied.
8. Start with a dry run and low cadence. Increase cadence or batch size only after the output is consistently reviewable.

The strongest gate is local proof before scheduling. A workflow file is not evidence that the loop works.

## Questions the design must answer

- Which measurable property should move toward what target?
- Which files and systems may be read, and which may be changed?
- Is the sensor stable, repeatable, affordable, and hard to disable accidentally?
- What is the smallest unit a reviewer can accept or reject independently?
- How does the controller rank candidates, cap a batch, and decide to do nothing?
- Which agent, task skill, known good patterns, and validations drive the actuator?
- Which disturbances and false positives should the loop expect?
- Which regression comparison should remain advisory, and what evidence would make it blocking?
- Which reviewer feedback is durable enough to change future runs?
- Can every component and the complete run execute locally?
- Does the cadence match human review capacity?

## Example from HumanLayer

The public example applies React Doctor to a UI directory. The sensor reports React issues. The controller chooses a few high-impact rules and caps the number of issues. The actuator fixes or skips each issue with a reason, then runs type checking and quality checks. A comparison against the merge base warns about regression. The scheduled workflow allows one open PR, and maintainers can request another iteration on that branch.

React Doctor, its thresholds, Bun, CodeLayer, and the example directory are implementation choices. The reusable part is the loop shape and its gates.

## What we should keep

Our local `control-loop.md` keeps the set point, sensor, controller, actuator, disturbances, local proof, WIP bound, advisory dampener, and durable feedback. It adds explicit rollout stages, rollback rehearsal, authenticated trigger identities, approval records tied to artifact revisions, and separate read and write authority.

## What we should not copy

The public workflow and iteration helper have unsafe defaults for a general-purpose implementation:

- The iteration prompt concatenates the PR body and raw comments. A trusted person can trigger the command while an untrusted earlier comment injects instructions.
- Example runners offer broad permission bypasses. The agent should receive only the credentials and filesystem access required by the actuator.
- Some dependencies use mutable versions such as `latest`. Actions, runners, and packages should be pinned.
- Raw runner output may be copied into artifacts or PR content without a redaction boundary.
- WIP routing relies on editable labels and HTML markers. Those are routing hints, not authorization.
- Manual dispatch can bypass the upstream WIP check.
- Validation is described to the agent but is not always enforced before push by the workflow itself.

Our version treats external text as data, verifies trigger and bypass identities against allowlists, binds approvals to the current artifact revision, defaults manual bypass to off, requires exact validation evidence, and keeps the loop write-disabled when any local proof is missing.

## Relationship between the three workflows

| Need | Use |
|---|---|
| Research and resolve one integrated design for a finite task | RPI |
| Approve product requirements, system design, and program design separately | PRD-oriented |
| Repeatedly measure, select, and perform bounded improvements | Control loop |

The control loop must stop and return to RPI or PRD-oriented when a run encounters a new product decision, changes an interface or migration contract, or needs authority outside its approved mutable scope.
