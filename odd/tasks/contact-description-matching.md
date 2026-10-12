# Feature: contact-description-matching

Status: in progress
Branch: feat/solana-operational
Owner: Ramiro
Follows: `odd/tasks/contact-search-returns-evidence.md` (closed)

## Problem (observed, live)

The user said a contact described as **"my nephew"**. The agent found it and still did not
deliver the contact. Measured on the deployed stack, in the real session log:

```
"name": "search_recipients", "args": "{\"query\":\"my nephew\"}"
lk.pii.output: "{\"query\":\"my nephew\",\"count\":2,\"ambiguous\":true,\"status\":\"clarification_required\",
                 \"contacts\":[{\"name\":\"Sophie\",\"description\":\"My nephew\",...
```

So the tool WAS called with the user's own words and it DID rank the right contact first. Two
defects remain, and neither is "the tool is not called".

### Defect 1 — a description query can never score above the threshold

The retrieval compares the query against ONE stored vector built from

```ts
recipientEmbeddingText(name, description) === `name: ${name}\ndescription: ${description}`
```

so the vector is a blend of the name and the description, and the name dilutes a
description-only query. Measured in the deployed container:

| query        | vs stored `name: sophie\ndescription: my nephew` | vs `description: my nephew` alone | vs `my nephew` bare |
| ------------ | ------------------------------------------------ | --------------------------------- | ------------------- |
| `my nephew`  | **0.5722**                                       | **0.8671**                        | **1.0000**          |
| `mi sobrino` | 0.6045                                           | 0.8626                            | 0.9791              |
| `nephew`     | 0.5622                                           | 0.8477                            | 0.9126              |

The threshold is **0.78**. A description query therefore lands at 0.57 — above the 0.55 floor,
below the threshold — and is **structurally incapable of ever resolving**. The same query
against a description-only vector scores 0.8671, i.e. the information is there and the
composition hides it. The model was verified aligned first: re-embedding the stored text gives
`cos = 1.0000`, so this is not a stale-model problem.

Field-aware querying does not rescue it either: embedding the query as `description: my nephew`
against the stored blend reaches only **0.7088**, still below the threshold.
(`name: sophie` against the same blend reaches 0.8161, which is why NAMES work — and today they
work through the deterministic name rules, not through the score.)

**Consequence:** "my nephew" always asks a question instead of producing the contact, no matter
how literally the description matches.

### Defect 2 — the question offers rows that do not match

The clarification carries the whole ranked list with no relevance bound, so `Test1`
(description empty, score **0.1593**) is offered as a candidate alongside Sophie. The user hears
"Sophie... and Test1" for a query that identifies exactly one contact.

This is the opposite failure of the one just closed: `no_match` had to stop destroying evidence,
but a QUESTION is not an evidence list. Rows far below the floor are noise for *identity*, while
remaining legitimate *evidence* of what the store holds.

## Root cause

`classifyRecipientCandidates` has deterministic rules for the NAME (exact, name+qualifier,
bounded prefix) and nothing for the DESCRIPTION, so a description-only request is left entirely
to a score it cannot reach.

## Scope

In scope:

- A deterministic, bounded **description rule** alongside the existing name rules.
- The clarification QUESTION carries only rows at or above the floor.
- `no_match` keeps carrying every retrieved row (the behaviour just closed — not re-broken).

Out of scope (deliberately):

- **No threshold, floor, or margin change.** The numbers are not the defect; the missing rule is.
- **No change to the stored embedding format and no migration.** Changing
  `recipientEmbeddingText` would invalidate every stored vector until a backfill re-embedded it,
  which is a larger change than the defect requires.
- Cross-language description matching stays on the score path (`mi sobrino` → 0.6045 →
  clarification with evidence). The deterministic rule is exact by design.

## Tasks

- [ ] T6. Deterministic unique exact-description rule + red-first tests.
- [ ] T7. The clarification question carries only plausible rows; `no_match` keeps the evidence.
- [ ] T8. Verification: unit, integration, live proof against the deployed stack.

## Evidence ledger

| Task | Commit | Evidence |
| ---- | ------ | -------- |
|      |        |          |
