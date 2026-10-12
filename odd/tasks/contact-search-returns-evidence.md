# Feature: contact-search-returns-evidence

Status: in progress
Branch: feat/solana-operational
Owner: Ramiro

## Problem (observed, live)

The user asked the voice agent to find a contact described as **"my nephew"**. The agent
answered that the contact **does not exist**. It does exist, and the search was capable of
finding it.

Raw evidence from the deployed stack (`docker logs nana-privy-impl-voice-worker-1`):

```
"name": "search_recipients", "args": "{\"query\":\"MinaFi\"}"
lk.pii.output: "{\"query\":\"MinaFi\",\"count\":0,\"ambiguous\":false,\"status\":\"no_match\",\"contacts\":[]}"
```

The audio model (`gpt-realtime-2.1-mini`) rendered "my nephew" as a phonetic proper name,
`MinaFi`. The tool was then called and returned **zero candidates**, so the model had nothing
to read back and reported non-existence.

Measured against the real stack DB through the real runtime, for each query:

| query       | rows the repository returned                                                                       | what the caller received            |
| ----------- | -------------------------------------------------------------------------------------------------- | ----------------------------------- |
| `my nephew` | Sophie **0.572** (description `"My nephew"`), Test1 0.159, Sophie 0.092                            | `clarification_required`, 3 rows    |
| `MinaFi`    | Sophie **0.263** (description `"My nephew"`), Test1 0.231, Sophie 0.224                            | **`no_match`, `candidates: []`**    |

The repository returned three rows in both cases. `classifyRecipientCandidates` **destroyed
them** at the floor check and shipped an empty list.

## Root cause

`src/memory/service.ts` floor arm:

```ts
if (!first || first.score < config.scoreFloor) return { status: 'no_match', candidates: [] };
```

The floor is the *selection* gate, but it was implemented as a *disclosure* gate: evidence
below 0.55 is discarded instead of being reported.

The consumer contract already said otherwise. `src/agent/recipient-resolution.ts` declares:

```ts
| { status: 'no_match'; candidates: Candidate[] }
```

So the implementation contradicted a type its own caller was written against. A second,
independent discard sits in the voice projection (`src/agent/definition.ts`), which maps
`no_match` to `[]` explicitly.

The failed safety argument is written into the test suite
(`tests/unit/recipient-memory-service.test.ts`):

> "Below the floor the candidate is noise: a real miss, and nothing is shipped to the caller,
> so `status` can never contradict the payload."

Payload consistency was bought by destroying the evidence. A comprehension error upstream
then became a **false assertion about the user's own data**.

## Scope

In scope:

- `no_match` carries the rows the repository returned, ranked, so the surface can narrate
  what the store actually holds.
- Every surface stops discarding those rows.
- Model-facing instructions: read the name **and the stored description** back, and never
  report a contact as non-existent. Search with the user's own words; never invent a proper
  name from a relationship word.

Out of scope (deliberately):

- **Matching semantics.** No threshold, floor, margin, or rule-order change. The floor keeps
  gating selection exactly as today.
- **Auto-selection.** `no_match` never sets `selectedRecipient`, so nothing becomes a
  transfer target. A transfer still requires a resolved, version-bound recipient plus the
  user's spoken confirmation.
- The pre-existing duplicate-contact issue (two `ACTIVE` rows named `Sophie` holding the same
  address) is a separate data/design question.

## Tasks

- [ ] T1. Classification keeps the retrieved rows on `no_match` (floor arm) + red-first tests.
- [ ] T2. Voice projection stops discarding candidates on `no_match` + red-first test.
- [ ] T3. Text path narrates the candidates on `no_match` instead of a flat denial + test.
- [ ] T4. Instructions and tool descriptions: narrate name+description, never assert
      non-existence, search the user's own words + tests.
- [ ] T5. Verification: unit, integration, full suite; live proof against the deployed stack.

## Evidence ledger

| Task | Commit | Evidence |
| ---- | ------ | -------- |
|      |        |          |
