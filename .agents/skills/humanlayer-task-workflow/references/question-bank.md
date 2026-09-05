# Evidence-first question bank

Do not conduct an intake questionnaire. First inspect what the repository, issue, logs, tests, and prior artifacts already answer. Ask one remaining consequential question at a time. Include a recommended default and explain what changes if the user chooses differently.

## Route selection

- What observable result proves the task is done?
- Which systems or people may be affected?
- Is the change easy to reverse without data loss or external coordination?
- Is this a single delivery or a recurring autonomous action?
- Do product intent and technical design have different approvers?

## Scope and authority

- What may be read?
- What may be written or triggered externally?
- Which targets are explicitly out of scope?
- What action requires fresh approval even after the workflow begins?

## Decision gate

- Which unresolved choice changes the architecture, user behavior, cost, or risk?
- What evidence supports each viable option?
- What default do we recommend, and what is its concrete downside?
- Who owns the decision?

## Verification

- Which automated command proves each delivery slice?
- Which user-visible behavior requires manual observation?
- What baseline detects regression?
- What must cause an immediate stop or rollback?

## Recurring work

- What measurable target should remain true?
- What signal is stable, repeatable, and affordable enough to observe it?
- How does the controller rank and cap candidate work?
- What is the maximum concurrent work in progress? Default to one reviewable unit.
- Which disturbances or false positives are expected?
- What durable feedback should tune future selections?
- What cadence matches review capacity rather than compute availability?

## Stop conditions

Stop instead of guessing when authority, destructive scope, external recipients, acceptance criteria, or an irreversible design choice remains ambiguous. Record the answer in the artifact that owns it before continuing.

