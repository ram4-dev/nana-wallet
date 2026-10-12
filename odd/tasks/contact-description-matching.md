# Feature: contact-description-matching

Status: done
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

- [x] T6. Deterministic unique exact-description rule + red-first tests.
- [x] T7. The clarification question carries only plausible rows; `no_match` keeps the evidence.
- [x] T8. Verification: unit, integration, live proof against the deployed stack.

## Evidence ledger

| Task | Commit | Evidence |
| ---- | ------ | -------- |
| T6 | `3acbdea` | Unit RED first (4 failures on the intentional rule). Integration proves it on a **total retrieval miss**: the stub sends an irrelevant vector, so the score is below the floor for every row and only the description rule can answer. |
| T7 | `b7dc703` | Unit RED first (`['Sophie','Test1']` vs `['Sophie']`). |
| T8 | this commit | See below. |

### T8 — verification

**Unit:** 1330 tests — **1326 passed**, 3 failed, all three documented baselines
(`realtime-agent-session`, `realtime-tools`, `realtime-tool-binding`, all asserting Spanish preview
copy replaced by the English translation).

**Integration:** the six recipient/contact suites pass at 2 workers, 27/27.

**Live, on the deployed stack.** Both containers recompile from the mounted `src`, so the VOICE
path (`nana-privy-impl-voice-worker-1`) and the TEXT path (`nana-privy-impl-backend-1`) were each
restarted and verified to have the new `dist` before probing. **Restarting only the worker leaves
the text path on the old code** — a trap worth remembering.

Real `search_recipients` tool, real recipient-memory service, real database:

| query | before | after |
| ----- | ------ | ----- |
| `my nephew` | `clarification_required` | **`resolved`**, count=1, `Sophie("My nephew")` |
| `mi sobrino` | `clarification_required`, count=**2** (Sophie + Test1) | `clarification_required`, count=**1**, only Sophie |
| `nephew` | count=**2** | count=**1** |
| `Sophie` | `resolved` | `resolved` |
| `MinaFi` | `no_match`, count=2 | `no_match`, count=2 — testimony preserved |
| `my grandson` | `no_match` | `no_match` |

Real text path (`resolveTransferRecipient` with the real memory tools):

```
"send money to my nephew"       -> resolved                selected=8ccc3c14
"Mandale plata a mi sobrino"    -> clarification_required  cands=[Sophie]
"Mandale plata a Sophie"        -> resolved                selected=8ccc3c14
"Mandale plata a Nadiequeexista" -> no_match               cands=[Test1,Sophie]
```

`resolved` selects the recipient through the same seam a name already used, so the flow becomes
preview → spoken confirmation, with no new authority.

## What this does NOT fix

Cross-language and fuzzy descriptions stay on the score path by design: `mi sobrino` against the
English `My nephew` scores 0.6045 and still asks (now about Sophie alone). Making THAT resolve
would need the description to stop being diluted in the stored vector, i.e. a second
`description_embedding` column plus a backfill that re-embeds every existing row. That is a
larger change than the defect requires and is not done here.

