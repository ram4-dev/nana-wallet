# Feature: contact-search-returns-evidence

Status: done
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

- [x] T1. Classification keeps the retrieved rows on `no_match` (floor arm) + red-first tests.
- [x] T2. Voice projection stops discarding candidates on `no_match` + red-first test.
- [x] T3. Text path narrates the candidates on `no_match` instead of a flat denial + test.
- [x] T4. Instructions and tool descriptions: narrate name+description, never assert
      non-existence, search the user's own words + tests.
- [x] T5. Verification: unit, integration, full suite; live proof against the deployed stack.

## Evidence ledger

| Task | Commit | Evidence |
| ---- | ------ | -------- |
| T1 | `db80ea2` | Unit RED first (4 failures on the intentional contract change), then GREEN. `tests/integration/recipient-name-matching.test.ts` proves the real service returns `Nadie` → `no_match` **with** `["Sofía", "Test1"]` and their descriptions. |
| T2 | `4083724` | `tests/unit/realtime-tools.test.ts` RED first (`expected +0 to be 1`), then GREEN. |
| T3 | `d907162` | `tests/unit/wallet-agent-deterministic.test.ts` RED first (message contained no `Sophie`), then GREEN. |
| T4 | `d7608e4` | `tests/unit/contact-search-guidance.test.ts`; every asserted clause verified absent from `HEAD` (`git show HEAD:<file> \| grep -ci`), which is the RED proof. |
| T5 | this commit | See below. |

### T5 — verification

**Unit suite:** 159 files — **1316 passed**, 3 failed. All three are the documented baseline
failures: `realtime-agent-session` ("allows one re-read when a confirmation is refused for an
incomplete read-back"), `realtime-tools` ("send_token delegates the preview … strips the
recipient address") and `realtime-tool-binding` ("send_token previews … fixture spy"). None
belong to this change: the first two assert Spanish preview copy that the English translation
work replaced.

**Integration / e2e / simulation:** at 4 workers, 22 failures, every one of them a 5 s or 15 s
**timeout**, not an assertion. Each failing file was then re-run in isolation:

- 9 of 11 pass in full (`api-contact-check-alias` 8/8, `api-contacts-alias-field` 2/2,
  `api-contacts-policy` 9/9, `api-contacts` 3/3, `api-recipient-aliases-resolve` 7/7,
  `contact-action-address` 7/7, `recipient-alias-create` 6/6, `recipient-drift` 2/2,
  `notifications-reconciliation` **3/3 three times in a row**).
- The remaining two are documented baselines: `wallets-sync` PEW-013 and
  `conversation-preview-claim-race`.

Structural control: **none** of the failing files imports any of the five changed modules
(`grep -cE 'memory/service|agent/definition|agent/wallet-agent|agent/instructions|create-agent-session'` → `0`
for each), so the change is not on their code path at all.

DB health during the runs: 1 active connection, `max_connections=100`, largest table 2572 rows,
1.6 % CPU, 76 MiB. The parallel-run failures are worker saturation on this machine (many cores →
many workers → each file's own pg pool exceeds the server limit), which is why CI (fewer cores)
does not see them.

**Live proof on the deployed stack.** `nana-privy-impl-voice-worker-1` was restarted so `dist`
was rebuilt from the new `src`, then the REAL `search_recipients` tool was built through
`createRealtimeTools` with the real recipient-memory service and called for the incident's own
inputs:

```
query="MinaFi"     status=no_match  count=3  ambiguous=true
    Sophie  | desc: "My nephew"        <- the row that was destroyed before
    Test1   | desc: ""
    Sophie  | desc: "Confirmen la creación de la destinataria confiable Sophie …"

query="my nephew"  status=clarification_required  count=3  ambiguous=true
    Sophie  | desc: "My nephew"
```

Before this change the same call returned `{"status":"no_match","count":0,"contacts":[]}` —
the evidence the model needed to say "I found Sophie, saved as my nephew" was already destroyed
by the time it arrived.

## Consequence worth knowing

The retrieval has `LIMIT 5` and no similarity cutoff, so a `no_match` now carries the top rows
for **any** query, including a completely unrelated one (`"Zzzqqqxyz"` → `count=3`). That is
what makes the denial impossible, and it is also the trade-off: a query that identifies nobody
reads the contact list back. The fields exposed are the ones `list_contacts` already exposes to
the same authenticated user (names and descriptions, never addresses), so no new boundary is
crossed — but the disclosure is now reachable through `search_recipients` too. A lower
disclosure-only floor would narrow it, at the cost of losing exactly the mangled-name evidence
this change exists to keep.

