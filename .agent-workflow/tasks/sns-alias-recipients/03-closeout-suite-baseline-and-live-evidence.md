# 03 — Closeout evidence: suite baseline comparison and the live attempt (tasks 8.1, 8.2, 8.3)

Working root `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`
(branch `feat/solana-operational`), measured at HEAD `916b195` (== `origin/feat/solana-operational`).
Read-only measurement: no source file, assertion or suite was changed by this task. Booleans, addresses
and names only — no secret, key, seed, token or signature value appears anywhere in this file.

## 8.1 — Command results

| # | Command | Result |
|---|---|---|
| 1 | `npm run lint` | exit 0 (`eslint src tests --max-warnings=0`), no output |
| 2 | `npm run typecheck` | exit 0 (`tsc -p tsconfig.test.json --noEmit`), no diagnostics |
| 3 | `npm test` (full backend, combined) | exit 1 — `Test Files 21 failed \| 204 passed \| 4 skipped (229)`, `Tests 51 failed \| 1631 passed \| 10 skipped (1692)`, `Duration 85.93s` |
| 4 | `npm run eval` | exit 0 — `Eval Files 10`, `Evals 29`, `Score 98%` (threshold 0%, passed). Includes `evals/agent/recipient-alias.eval.ts` (2 evals, 100%) |
| 5 | `(cd apps/nana-wallet && npm run lint && npm run typecheck && npm test)` | exit 0 — lint and typecheck clean; `Test Files 29 passed (29)`, `Tests 220 passed (220)` |

Database: `colloseumfeat-solana-operational-db-1` on host port 55470, started for this run with
`DB_HOST_PORT=55470 docker compose up -d db`. **`DB_HOST_PORT` is unset in the environment**, so a bare
`docker compose up -d db` tries `127.0.0.1:5432`, which is already taken by `nana-privy-impl-db-1`, and
the container fails with `Bind for 127.0.0.1:5432 failed: port is already allocated`. Recorded because it
is a reproducible trap for the next run, not a change made by this task.

`npm run db:migrate` was **not** run: it fails in this worktree with `relation "conversations" already
exists`, because this database was built the CI way from the `supabase/` chain rather than from
`src/db/migrations`. That failure is **pre-existing** and was not chased. The suites ran against the
existing database, as instructed.

## 8.1 — Baseline comparison by failure name

Pristine baseline: `.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md`,
"attempt 2", commit `a121b2c`, `6 failed | 1028 passed | 10 skipped (1044)` over 158 files.

The file count is not comparable (229 now vs 158 then): the seven applied slices added suites. The
comparison is by **failure name**, which is what matters.

### The baseline's six failures, in this run

| # | Baseline failure name | Baseline message | This run | Verdict |
|---|---|---|---|---|
| 1 | `tests/integration/api-voice-auth.test.ts` > returns the same 404 for a foreign conversation as for a missing one | `Error: Test timed out in 15000ms.` | **did not fail** | not reproduced; baseline classified it environment/timing-shaped and undiagnosed. Fewer failures than baseline is not a regression. |
| 2 | `tests/integration/conversation-preview-claim-race.test.ts` > two simultaneous confirms broadcast exactly once (V8.5) | `expected "broadcastTransfer" to be called once, but got 0 times` | **failed, message byte-identical** | pre-existing |
| 3 | `tests/integration/wallets-sync.test.ts` > PEW-013: explicit activation with read-back; empty allowlist rejected (422) | `expected 422 to be 200` | **failed, message byte-identical** | pre-existing |
| 4 | `tests/unit/realtime-agent-session.test.ts` > allows one re-read when a confirmation is refused for an incomplete read-back | `expected 'You are Nani, …' to match /except when a confirmation is refus…/iu` | **failed, message byte-identical** | pre-existing |
| 5 | `tests/unit/realtime-tool-binding.test.ts` > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy | `expected [] to have a length of 1 but got +0` | **failed, message byte-identical** | pre-existing |
| 6 | `tests/unit/realtime-tools.test.ts` > send_token delegates the preview to the service and strips the recipient address | `expected "vi.fn()" to be called with arguments: [ StringContaining{…} ]` | **failed, message byte-identical** | pre-existing |

**5 of 6 reproduced with byte-identical first messages; 1 (the timing-shaped one) did not reproduce.**
No baseline failure changed shape and none is attributable to this change.

### The 46 non-baseline failures: the combined-invocation family, all cleared in isolation

The combined invocation produced 46 further failing tests across 18 files. They are **not** regressions:
every one clears when its file is re-run alone, at the **default 5000 ms** timeout, with no assertion
relaxed and no suite edited. Two signatures, both load-shaped:

- **`Error: Test timed out in 5000ms.` (37 tests)** — the alias, drift and resolve API suites each
  acquire the one demo wallet's lease over a real Fastify server; in a 200+-file parallel run they
  overrun the 5000 ms per-test budget.
- **`expected 409 to be 201/200/404` (9 tests, all in `api-contacts.test.ts` /
  `api-contacts-policy.test.ts`)** — the demo-wallet lease is held elsewhere, so the route mapper's
  conflict path answers `409` where the uncontended run answers the success/validation status. This is
  the documented contention family: the policy suites **serialize on one demo wallet's lease**, and a
  combined invocation produces contention failures that clear.

Two further messages in the combined run are the same contention seen from the database side and also
clear alone: `Error: update or delete on table "users" violates foreign key constraint
"recipients_user_id_users_fk" on table "recipients"` (one suite's cleanup racing another's inserts), and
`AssertionError: expected 0 to be greater than or equal to 1` in
`notifications-reconciliation.test.ts`.

Isolation re-runs (each file alone, default timeout):

| File re-run alone | Tests |
|---|---|
| `tests/integration/api-contact-check-alias.test.ts` | 8 passed |
| `tests/integration/api-contacts-alias-field.test.ts` | 2 passed |
| `tests/integration/api-recipient-aliases-resolve.test.ts` | 7 passed |
| `tests/integration/recipient-alias-create.test.ts` | 6 passed |
| `tests/integration/recipient-drift.test.ts` | 2 passed |
| `tests/integration/recipient-alias-migration.test.ts` | 11 passed |
| `tests/integration/api-contacts-policy.test.ts` | 9 passed |
| `tests/integration/api-contacts.test.ts` | 3 passed |
| `tests/integration/contact-action-address.test.ts` | 7 passed |
| `tests/integration/recipient-duplicate-disclosure.test.ts` | 3 passed |
| `tests/integration/recipient-idempotency-body.test.ts` | 5 passed |
| `notifications-reconciliation / -webhook / -webhook-deep` (one separated set) | 18 passed |

For one representative case the slower confirmation was also taken:
`api-recipient-aliases-resolve.test.ts` alone with `--testTimeout=30000` → 7 passed; the same file in a
six-file set at the default 5000 ms → 3 of 7 timed out. The slowest individual test is 1720 ms, well
inside the budget alone and outside it under contention. That is the whole story of the family.

**Result: zero failures outside the baseline six and the load-contention family. No regression.**

## 8.1 — The load-bearing claim, verified explicitly, not assumed

| Claim | Verification | Result |
|---|---|---|
| The existing **paste/scan** suites pass **unchanged** | `tests/integration/api-contacts.test.ts` — the fixture-identity paste/scan CRUD (creates a confirmed contact, lists, versions, archives, reveals; explicit Solana devnet contacts; not-found + 422 shapes) — re-run alone | **3 passed** |
| The **whole `trusted-recipient-policy-sync` suite** passes **unchanged**, as a **separated set** | the nine files matching `tests/integration/recipient-policy-*.test.ts` in one invocation, separated from every other set | `Test Files 9 passed (9)`, `Tests 119 passed (119)` — the same 119 the change recorded for this set in slices U1–U3 |

No paste/scan or policy assertion was weakened, skipped or edited: `git status --porcelain -uall` shows
only the untracked `compose.privy-local.ports.yaml` and this evidence file, and no tracked test file
appears in the diff of the closeout commit.

## 8.2 — The live devnet attempt: what was observed, and why the checkbox stays `[ ]`

**The prerequisite is not met.** Measured as booleans only:

```json
{"SNS_RPC_URL set": false, "SOLANA_DEVNET_RPC_URL set": false,
 "readSnsTransportConfig(): endpointIsKeylessPublicDevnet": true}
```

So the configured endpoint is the **keyless public devnet default**, not the dedicated/keyed
`SNS_RPC_URL` that design §10.2 N1 names as a prerequisite. Per 8.2's stop condition the task stays
`[ ]`, and the blocker is recorded verbatim below rather than narrated as a pass.

### What was nonetheless attempted, live, through the real transport

One honest paced attempt — `readSnsTransportConfig()` → `createSnsTransport()` →
`createSnsResolver({ network: "solana-devnet" })` — against the live devnet endpoint, one resolution per
user action with a 1200 ms pace, no fixture, no injected transport, no stub:

| Name | Latency | Outcome |
|---|---|---|
| `sophie.sns` | 753 ms | resolved `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2`, nameAccount `ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew`, `observedParent` = the devnet root, slot 509778908, `reverseDomainState: "none"` |
| `nanatest.sns` | 397 ms | resolved `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv`, nameAccount `6Kcihb6KARkTtrnps8TbPp7H3b69jFxEe5i4hUrxkBps`, `observedParent` = the devnet root, slot 509778915, `reverseDomainState: "none"` |

No `Connection rate limits exceeded` was observed: 2 of 2 paced resolutions succeeded, p95 ≈ 753 ms. This
is consistent with the behaviour already recorded in `.agent-workflow/tasks/sns-alias-recipients/02-live-primary-domain-observation.md`
and with design §10.2 N1's own measurement (one paced resolution per user action → 10/10; a 30-request
burst → throttled on every call). It reproduces the **resolution** half live, and re-confirms `none` as
the reverse state for both names.

**What this is not.** It is not the live evidence 8.2 asks for, and it is not presented as such. 8.2
requires `sophie.sns` added **through the real screen path** and **through the agent**, the card showing
the resolved address, an explicit `check-alias`, and a **database readback** that `recipients.address`
and `applied_rules_hash` are unchanged by the drift report. None of that was exercised live: no live
contact was created, no proposal or card was published, no `check-alias` was run, and no database
readback of `recipients.address` / `applied_rules_hash` was taken. A resolution through the resolver
module is **one component** of that path, not the path.

### The blocker, verbatim, and what would clear it

> With a **dedicated/keyed `SNS_RPC_URL`** (design §10.2 N1 — a prerequisite, not an assumption: the keyless default returns `Connection rate limits exceeded` on every call in a burst)

The prerequisite is absent in this worktree: neither `SNS_RPC_URL` nor `SOLANA_DEVNET_RPC_URL` is set, so
`readSnsTransportConfig()` resolves to the keyless public devnet endpoint. Clearing it is a **variable
change with no code change** — one keyed `SNS_RPC_URL` — followed by the screen-path and agent-path run
with its database readback. **Awaiting a keyed endpoint; 8.2 stays `[ ]`.**

## 8.3 — The commit and push state, recorded as it actually is

```text
$ git status --porcelain -uall
?? compose.privy-local.ports.yaml

$ git rev-parse HEAD origin/feat/solana-operational
916b1954222ae68d784d67729406c966c44d81c8
916b1954222ae68d784d67729406c966c44d81c8

$ git rev-list --left-right --count HEAD...origin/feat/solana-operational
0	0
```

- **Every completed task closed with exactly one conventional commit.** Twenty conventional commits carry
  this change, from `80fdbf6 feat(sns): resolve .sns aliases through a pure resolver with a total failure
  taxonomy` through `916b195 feat(recipients): report alias drift on the contact surface and never follow
  it`. Each is outcome-first, English, with its tests (or its docs) in the same commit; none carries an
  AI attribution trailer.
- **The no-push rule has changed in practice, and the record says so rather than restating the original
  wording.** The task text says the change "does not push" and that "the parent publishes the branch once
  at the end". The observed state is the opposite: `HEAD` is **in sync with
  `origin/feat/solana-operational`** (`0 0`), so the parent **has been pushing this branch between
  slices**, under the standing instruction to push to `feat/solana-operational` only. This task did not
  push; it also did not find an unpushed state, and it does not claim one.
- **No PR** exists for this branch.
- **The user-owned untracked `compose.privy-local.ports.yaml` is preserved and was never committed** — it
  is the sole untracked entry, it is absent from every commit, and this task did not read, modify or
  stage it. Its `DB_HOST_PORT` effect was worked around by passing the variable to `docker compose` on
  the command line instead of editing the file.

## What remains unproven after this closeout

1. **The live end-to-end alias add and every live drift check (8.2, design §10.2 N1).** Blocked on the
   keyed `SNS_RPC_URL`. Not implied anywhere. Only one paced live resolution per name through the
   resolver module was observed.
2. **The live screen path, the live agent path, the live card render, the live `check-alias`, and the
   `recipients.address` / `applied_rules_hash` readback that 8.2 asks for.** Not run.
3. **`reverseDomainState: "none"` is observed live for both names, but no `present` state was ever
   observed on any network** (design §10.2 N2, §11 Q1) — `none` is not evidence that `present` renders.
4. **The synthetic `class` half of the 96-byte header** (N4, §11 Q6) — still synthetic, still labelled as
   such in the fixture suite, still never interpreted.
5. **`recipient_versions` does not snapshot provenance** (task 2.6, declined) — the residual recorded
   against design §3.1 stands; nothing in this change claims the history preserves provenance.
6. **No ready wallet ⇒ no idempotency key honoured** on the create path (design §11 Q8) — pre-existing,
   not fixed.
7. **Bundle/peer-dependency cost of the SDK in the backend container (N5)** — the install was never
   measured in the container.
8. **`ambiguous` beyond the three derivable conditions (N3, §11 Q2)** — narrowed deliberately; no third
   branch ships.
