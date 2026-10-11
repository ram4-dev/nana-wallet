# Apply progress: Trusted Recipient by SNS Alias

Work unit: **U1 — the resolver seam, offline-proven** (tasks 1.1–1.6); the commit for this unit is the one that carries this file.
Working root `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`
(branch `feat/solana-operational`); no push, no PR. Strict TDD active.

## Completed tasks

| Task | What landed | Persisted checkbox |
|---|---|---|
| 1.1 | `src/wallet/sns/transport.ts`: `readSnsTransportConfig`, `createSnsTransport`, the injectable `SnsTransport` port; `@bonfida/spl-name-service@3.0.23` pinned in `package.json` | `- [x]` |
| 1.2 | `src/wallet/sns/resolver.ts`: `SNS_NETWORKS` (closed, devnet only), `normalizeSnsName`, `base58Encode`, `decodeNameRegistryHeader`, `classifySnsReadFailure`, `createSnsResolver` | `- [x]` |
| 1.3 | `tests/unit/sns-resolver-fixtures.test.ts`: known-answer decode from the two live devnet names' observed bytes, plus the short-header, foreign-root, all-zero-owner, `not_found` and throttled/timeout cases | `- [x]` |
| 1.4 | `reverseLookup` three-state classifier + `classifyPrimaryDomainFailure` / `mapPrimaryDomainResult` in the transport; `tests/unit/sns-reverse-lookup.test.ts` | `- [x]` |
| 1.5 | `tests/unit/sns-import-structural.test.ts`: one SDK importer, and no payment path can reach the resolver | `- [x]` |
| 1.6 | One live `getPrimaryDomain` per devnet name through `readSnsTransportConfig()`'s endpoint, recorded in `.agent-workflow/tasks/sns-alias-recipients/02-live-primary-domain-observation.md`, and the classifier pinned to the observed shape | `- [x]` |

## Files changed

New: `src/wallet/sns/transport.ts`, `src/wallet/sns/resolver.ts`,
`tests/unit/sns-transport-config.test.ts`, `tests/unit/sns-resolver.test.ts`,
`tests/unit/sns-resolver-taxonomy.test.ts`, `tests/unit/sns-resolver-fixtures.test.ts`,
`tests/unit/sns-reverse-lookup.test.ts`, `tests/unit/sns-import-structural.test.ts`,
`.agent-workflow/tasks/sns-alias-recipients/02-live-primary-domain-observation.md`,
this file, and the checkbox flips in `tasks.md`.
Modified: `package.json` (one pinned dependency), `package-lock.json`.

Nothing under `src/wallet/policy/**`, `src/conversations/**`, `src/api/**`,
`src/agent/**`, `src/livekit/**` or `apps/nana-wallet/**` was touched: no consumer of the resolver
exists yet, and the structural suite (1.5) asserts none can appear on a payment path.

## The taxonomy: exactly what each failure class returns

| Input | `SnsResolveFailure` |
|---|---|
| empty / whitespace / non-string | `malformed_name: "empty"` |
| no suffix at all (`juan`) | `malformed_name: "suffix_required"` |
| label longer than 63 chars | `malformed_name: "too_long"` |
| non-ASCII label (Cyrillic `а`, ZWJ, fullwidth `ｊ`) | `malformed_name: "charset"` |
| suffix is not `.sns` (`juan.sol`, `juan.eth`) | `unsupported_tld` with the suffix echoed, no fallback attempt |
| account absent (`getAccountInfo` → `null`) | `not_found` |
| account shorter than 96 bytes | `ambiguous: "short_header"` |
| `parentName` ≠ this network's root | `ambiguous: "parent_mismatch"` |
| owner segment is 32 zero bytes (base58 = system program id) | `ambiguous: "unassigned_owner"` |
| rejected read: throttle shape (`429`, `Too many requests…`, `rate limit`) | `unreachable: "rpc_throttled"` |
| rejected read: timeout/abort shape | `unreachable: "timeout"` |
| rejected read: anything else | `unreachable: "rpc_error"` |
| deployment network not in `SNS_NETWORKS` | `resolver_misconfigured: "unknown_network"` |
| name-account derivation throws, or returns an empty account | `resolver_misconfigured: "no_root"` |

`not_found` and `unreachable` are different members of the union, and `resolve` returns a union
member on every path — it never throws (proved by the hostile-input case, whose positive control is
the same stub resolving `sophie.sns`).

## TDD cycle evidence

RED was run before `src/wallet/sns/**` existed and is honest: five suites failed at import
(`Cannot find module '../../src/wallet/sns/{resolver,transport}.js'`) and the structural suite failed
its own positive controls (`expected true to be false` for a transport that did not exist yet), so no
suite could pass by absence. Two expectations were then corrected *after* seeing real output rather
than being weakened: a ZWJ placed after the suffix produces `unsupported_tld` (not `charset`), and a
space-padded canonical address is valid by `isValidSolanaAddress`'s own trimming, so it is a positive
control for the port being reached.

| Cycle | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|
| 1.1 transport config | absent `SNS_RPC_URL` → default; empty → refused by `createSnsTransport` | both cases + the recorded PDA derivation | present/absent/blank values, three-port surface | moved the two error patterns above their user |
| 1.2 resolver + taxonomy | every failure class asserted before any code existed | 6 files, 57 tests | casing, digits/hyphens, foreign parent, short header, 6 rejection shapes | extracted `classifyReverse` so `resolve` and `reverseLookup` cannot disagree about the three-state signal |
| 1.3 fixtures | recorded addresses and PDAs asserted first | known-answer decode for both names | 95-byte, foreign root, all-zero owner, `null`, throttle, abort | decode split from the resolver's orchestration |
| 1.4 reverse lookup | `present` / `none` / `unknown` asserted up front | classifier pinned to the recorded shape | rejection, malformed result, stale reverse, misconfigured port | result mapping and failure classification are separate exported functions |
| 1.5 structural | positive controls run before the negative ones | exactly one importer; no payment path reaches `wallet/sns` | detector proved live against a known import | recursive `src/` walk instead of a hardcoded file list |

### Mutation evidence (each guard removed, failure observed **by name**, then restored)

| Mutation | Failing tests it produced |
|---|---|
| M1 drop the all-zero-owner refusal from the resolver | `refuses an unassigned owner as ambiguous instead of authorizing a zero address`; `refuses an account whose owner segment is all zero` |
| M2 add `normalize("NFKC")` before lowercasing | `normalizeSnsName refuses a non-ASCII label instead of folding it` |
| M3 drop the `parentName !== network.root` check | `refuses a header whose parentName is a different root`; `returns ambiguous for a short header and for a foreign parent, and never not_found` |
| M4 turn a rejected read into `not_found` | `reports a throttled or timed-out read as unreachable, never as not_found`; `returns unreachable with a classified cause for a rejected read` |
| M5 make the reverse classifier answer `none` for every shape | `maps every unrecognized shape to 'unknown', never to 'none'` |
| M6 drop the fail-closed unknown-network guard | `fails closed on an unknown network instead of falling through`; `fails closed on an unknown network` |
| M7 let the resolver import the SDK | `is imported by exactly one module, the transport`; `is not mentioned by the resolver, which owns no SDK and no RPC client` |
| M8 degrade the reverse `unknown` state to `none` | `reports a rejection, a misconfigured port and a malformed response as 'unknown'` |

Every mutation failed by name; none was inert.

## Commands run (exact)

```text
npm install --legacy-peer-deps --save-exact @bonfida/spl-name-service@3.0.23   # added 1 dep, see below
npx vitest run tests/unit/sns-*.test.ts                     # RED first (5 module-not-found), then 6 files / 57 tests passed
npm run lint                                                # clean (eslint src tests --max-warnings=0)
npm run typecheck                                           # clean (tsc -p tsconfig.test.json --noEmit)
npx vitest run tests/integration/recipient-policy-*.test.ts  # 119 passed (separated run)
npx vitest run tests/unit/policy-*.test.ts                   # 174 passed (separated run)
```

The two policy runs were executed as **separate** invocations, as instructed: they serialize on one
demo wallet's lease. No policy test regressed.

## `npm install` collateral, stated rather than buried

`package.json` gained exactly one line (`"@bonfida/spl-name-service": "3.0.23"`, no caret). The
lockfile records **no version change to any existing dependency**. Two other effects are real:

- **+37 packages added** — the SDK's declared closure (its own `@bonfida/sns-records`,
  `@solana/spl-token*`, `@solana/codecs*`, `borsh`, `bs58`, `bigint-buffer`, …). The previous tree
  had a *hand-placed* `@bonfida/spl-name-service@4.0.1` in `node_modules` that was never in
  `package.json` or the lockfile (the resources file records the hand-copy attempt), so its closure
  had to be materialised properly.
- **−16 peer-materialised entries pruned**, which is the recorded cost of `--legacy-peer-deps`:
  `@livekit/rtc-node` + its `@livekit/rtc-ffi-bindings-*` prebuilds, `@datastructures-js/deque`,
  `jayson/node_modules/utf-8-validate`. They are `peer: true` entries that a plain `npm install`
  materialises, not declared dependencies; nothing in `src/`, `tests/`, `evals/` or
  `apps/nana-wallet/src` imports them, and `@livekit/agents` keeps them as *optional* peers. Flagged
  as a risk rather than silently accepted, because a later slice that needs the LiveKit plugin's rtc
  path would have to re-materialise them (`npm install` without `--legacy-peer-deps`, or an explicit
  devDependency decision — neither belongs in this slice).

## Deviations from the design

1. **Task 1.6's dedicated-endpoint prerequisite was not met.** `SNS_RPC_URL` in this worktree is the
   keyless public default (`https://api.devnet.solana.com`). The design calls a keyed endpoint a
   prerequisite because the keyless default *cannot serve a burst loop*; the task asks for **one call
   per name**, and both calls returned in 579 ms / 207 ms with no throttling. The observation was
   therefore recorded, and 1.6 is checked — with the deviation visible here. If the maintainer holds
   the prerequisite as blocking, flip 1.6 to `[ ]`; the observation stands as recorded either way.
2. **The classifier is pinned to a different message than the design quotes.** Design §1.6 records
   `getPrimaryDomain → "The primary account does not exist"` (an unreproduced observation). The live
   call returns **`"The favourite account does not exist"`** — the SDK's own `FavouriteDomain` lookup
   (`dist/esm/favorite-domain.js`), on both names. Only that exact string maps to `none`; the
   design-quoted string maps to `unknown`, and the test asserts that, so a stale wording cannot
   produce a false all-clear. §1.6's own instruction ("only the exact recorded shape maps to `none`")
   is followed with the shape that is now actually recorded.
3. **`ambiguous` stays narrow at three derivable details** (`short_header`, `parent_mismatch`,
   `unassigned_owner`) per §11 Q2's stop condition. The `isValidSolanaAddress(observedOwner)` clause of
   the owner guard is a total invariant that the decode path cannot violate by construction (any 32
   bytes are a canonical base58 key); the reachable, mutation-proved arm of that guard is the all-zero
   owner, which base58 renders as the system program id. No unexercised branch ships.
4. **The SDK is imported as a namespace and narrowed to a local `SnsSdk` type.** v3.0.23's
   `dist/esm/index.d.ts:119` re-exports `devnet` through an extension-less relative specifier, which
   the project's `NodeNext` resolution cannot follow (`error TS2305: Module … has no exported member
   'devnet'`). The runtime export exists and the unit suite proves the derivation against the recorded
   devnet name account, so the one importer is preserved and surface drift becomes a failing test.
5. **`stale: true` from `getPrimaryDomain` maps to `unknown`, not `present`.** A stale reverse record
   names a domain whose current owner is no longer the address asked about; reporting it as a
   `present` primary domain would be the false claim §1.6 warns about. Recorded here as a sub-decision
   because §1.6's wording ("`present` when the SDK reports a name") is loosely satisfied either way.

## Workload / PR boundary

U1 is this commit and only this commit: `src/wallet/sns/**` plus its six suites, the pin, the evidence
file and the checkbox flips. Rollback is the deletion of `src/wallet/sns/**` and those test files; no
existing call site changes, so nothing else in the repository can depend on it. The forecast's
`size-exception` stands: this unit is ~1,450 changed lines and no diff was shrunk to reach 400.

## Structured status consumed

This run was launched by the parent with `openspec`-store artifacts and an explicit delivery decision
(`size-exception`, no push/no PR, U1 = tasks 1.1–1.6), and the Review Workload Gate's three guard
lines were resolved in the parent prompt before apply, so the gate did not block. `actionContext`
carried one hard root (`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`); every
write stayed inside it, and the user-owned untracked `compose.privy-local.ports.yaml` was never
touched.

## Remaining work

Slice U2 (tasks 2.1–2.6) onward is untouched: no consumer, no endpoint, no migration, no contract
change, no UI. Both parent-owned rows in `tasks.md` are byte-for-byte unchanged.

---

# Apply progress: work unit U2 (first slice) — tasks 2.1 and 2.2

Work unit: **U2 partial — the `017` schema delta and the contact-repository provenance plumbing**
(tasks 2.1 and 2.2 only; 2.3–2.6 remain untouched and unchecked). One commit, one PR-sized review
unit. Working root `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`
(branch `feat/solana-operational`); no push, no PR.

## Completed tasks

| Task | What landed | Persisted checkbox |
|---|---|---|
| 2.1 | `src/db/migrations/017_recipient_alias_provenance.sql` + its Supabase mirror `supabase/migrations/20261005000600_recipient_alias_provenance.sql`: the widened `recipient_policy_audit_event_ck` (exactly one new value, `alias_destination_changed`; `drift_repaired` not reused) and the nullable, default-less `request_hash TEXT` on `recipient_policy_sync_intent` | `- [x]` |
| 2.2 | `src/memory/contacts-repository.ts`: `ContactWriteInput.provenance` (C1), `ContactPatchInput.provenance` + the single conditional column write in `update` (C2), and `provenance` on `RECIPIENT_COLUMNS` / `RecipientRow` / `ContactRecord` (C3) | `- [x]` |

## The mirror decision (design §11 Q11) — a mirror SHIPS, and why

The design records (correction C7) that `013`–`015` are mirrored while `016` has **none**, and
instructs reading the convention from the repository at apply time. Read at apply time, the
observation is **stale**: `supabase/migrations/20261005000500_contact_action_proposal_payload.sql`
exists, is tracked and was committed in `3d97758` ("feat(agent): stage trusted-recipient actions
behind a typed confirmation arbiter") as the mirror of `016`, and its own header says so
("Mirror of src/db/migrations/016_contact_action_proposal_payload.sql"). The Supabase chain is
therefore **still maintained for this series**, so `017` ships a mirror:
`supabase/migrations/20261005000600_recipient_alias_provenance.sql` — the next free timestamp slot
after `20261005000500`, following the existing naming (`20261005HHMMSS_`), not an invented filename.

A static test pins both halves of that: the mirror must exist and both files must stay
content-equivalent modulo the `public.` qualification the existing pairs already differ by.

## Database reality in this worktree (carried forward, not fixed here)

`npm run db:migrate` fails on this worktree's database (`colloseumfeat-solana-operational-db-1`,
host port 55470) with `relation "conversations" already exists`, because that database was built by
the CI path from `supabase/` rather than from `src/db/migrations`. That failure is **pre-existing and
not this task's to fix**. So the migration was applied the way the database is actually maintained:

```text
docker compose exec -T db psql -U postgres -d wdk_agent -v ON_ERROR_STOP=1 < supabase/migrations/20261005000600_recipient_alias_provenance.sql
```

and the `src/db/migrations` path is proved by the repository's own runner instead — the new suite
runs `runMigrations` on a temporary database, asserts `017` applied, and then runs it a **second**
time and asserts it applies nothing (`[]`). That is the honest equivalent of "a second `db:migrate`
run is a no-op", and it is the stronger proof because the same runner is what the suites that rebuild
a fresh database (`tests/integration/privy-policy-admin-migration.test.ts`, green in this run) use.

## Files changed

New: `src/db/migrations/017_recipient_alias_provenance.sql`,
`supabase/migrations/20261005000600_recipient_alias_provenance.sql`,
`tests/integration/recipient-alias-migration.test.ts`,
`tests/integration/contacts-provenance.test.ts`,
`tests/unit/contacts-repository-provenance.test.ts`, and this append.
Modified: `src/memory/contacts-repository.ts`, the two checkbox lines in `tasks.md`.

## TDD cycle evidence

RED ran before either artifact existed and is honest: **25 failed / 0 passed**. The migration suite
failed at file level (`ENOENT … src/db/migrations/017_recipient_alias_provenance.sql` for the five
static cases) and at database level for the two schema facts (`expected +0 to be 1` for the
`request_hash` column; `audit vocabulary must keep alias_destination_changed` against the real
`CHECK`). The repository suites failed with exactly the two defects being fixed —
`expected { origin: 'user' } to deeply equal { source: 'sns', …(10) }` (the hardcoded literal at
`:132`) and `expected undefined to deeply equal { source: 'sns', …(10) }` (the column missing from
`RECIPIENT_COLUMNS`) — and `no provenance bind parameter in: UPDATE recipients` for the missing
conditional write. No suite could pass by absence.

| Cycle | RED | GREEN | TRIANGULATE | REFACTOR |
|---|---|---|---|---|
| 2.1 migration | five static cases + two DB facts failed before the file existed | 11 tests green after writing both files and applying the mirror | every prior event accepted one by one, unknown event still rejected, NULL round-trip, double re-apply, temp-DB runner with a real no-op second run | `schemaFingerprint` extracted so "nothing changed" compares columns + the CHECK definition |
| 2.2 repository | 14 tests failed: hardcoded provenance, missing column, missing conditional write | 14 tests green (6 integration, 8 unit) | default / explicit / paste provenance; address edit, metadata edit, explicit override, `null`; raw column vs record projection | `provenanceParamOf` locates the bind from the statement text instead of hardcoding a position |

### Mutation evidence (each guard removed, failure observed **by name**, then restored)

| Mutation | Failing tests it produced |
|---|---|
| M1 `create` back to the hardcoded `JSON.stringify({ origin: "user" })` | `persists the alias provenance object and reads the whole object back`; `keeps the paste/scan default and honours an explicit paste provenance`; `stores the caller's provenance object verbatim on create`; `stores the paste/scan provenance unchanged when the caller supplies it` (+2 attributable cascade cases) |
| M2 the conditional write replaced by "always preserve" (`input.provenance ?? row.provenance ?? {}`) | `clears a stale alias claim on an address edit while recipient_versions keeps the old address`; `clears the claim when an address edit re-sends the same address (fail-safe clear)`; `clears a stale alias claim on an address edit that supplies no provenance`; `treats a null provenance as the empty claim on an address edit` |
| M3 `provenance` removed from `RECIPIENT_COLUMNS` | `persists the alias provenance object and reads the whole object back`; `preserves provenance byte-for-byte on a metadata-only edit`; `reads provenance back with the row (C3)` |
| M4 the new event removed from the CHECK (files mutated **and** re-applied to the live database) | `widens the closed audit vocabulary by exactly one value and never reuses drift_repaired`; `carries the widened vocabulary under the original constraint name`; `accepts every prior event and the new one, and still rejects an unknown event`; `re-applies the migration idempotently without changing the schema` |
| M5 `request_hash TEXT` narrowed to `TEXT NOT NULL` | `declares request_hash as a nullable text column with no default`; `stays content-equivalent modulo the public. schema qualification` |

Every mutation failed by name; none was inert. M4 is the reason the *negative* control in the event
case is load-bearing: with the CHECK absent, `not_an_event` was **accepted**, which is exactly the
false green the positive-control-first rule exists to catch. Two `not_an_event` rows were written
into the local test database by that mutation; they were removed again with the append-only trigger
temporarily disabled, the trigger re-enabled, and the widened CHECK re-applied and verified
(`pg_constraint` count 1, 17 values). The database is back to the intended state.

## Commands run (exact)

```text
docker compose exec -T db psql -U postgres -d wdk_agent -v ON_ERROR_STOP=1 < supabase/migrations/20261005000600_recipient_alias_provenance.sql   # exit 0
npx vitest run tests/integration/recipient-alias-migration.test.ts tests/integration/contacts-provenance.test.ts tests/unit/contacts-repository-provenance.test.ts
  # RED: 3 files failed / 25 tests failed. GREEN: 3 files passed / 25 tests passed
npm run lint                                                                          # clean (eslint src tests --max-warnings=0)
npm run typecheck                                                                     # clean (tsc -p tsconfig.test.json --noEmit)
npx vitest run tests/integration/recipient-policy-*.test.ts                           # 9 files / 119 tests passed (separated run)
npx vitest run tests/unit/policy-*.test.ts                                            # 14 files / 174 tests passed (separated run)
npx vitest run tests/unit/livekit/                                                    # 7 files / 50 tests passed
npx vitest run tests/integration/privy-policy-admin-migration.test.ts tests/integration/recipient-policy-migration.test.ts tests/unit/contacts-repository.test.ts tests/unit/recipient-address-solana-validation.test.ts
                                                                                      # 4 files / 34 tests passed (fresh DB from src/db/migrations)
npx vitest run tests/integration/api-contacts.test.ts tests/integration/api-contacts-policy.test.ts tests/integration/api-contacts-policy-cross-user.test.ts tests/integration/contacts-cross-user.test.ts
                                                                                      # 4 files / 14 tests passed
```

No install was run: `package.json` and `package-lock.json` are byte-identical to `ca64265`.
`node_modules/@livekit/rtc-node` and `node_modules/pino` are still present and `tests/unit/livekit/`
is green, so the dependency tree is untouched.

## Deviations from the design

1. **`request_hash` lands in `017`, i.e. here, not with the idempotency unit (design §15 D-C).** D-C
   says the column "lands with the idempotency unit"; task 2.1 says `017` carries it. The task list
   was followed (it is the later, delegated instruction and is explicit), and the divergence is
   recorded here exactly as C8 was. Nothing changes about the guard: the column is inert until task
   3.1 writes and compares it, and `NULL` keeps it additive. If the maintainer prefers D-C, the
   statement moves to a later migration and `017` keeps only the CHECK widening.
2. **The mirror observation in C7/§11 Q11 is stale — a mirror SHIPS.** See the section above:
   `016`'s mirror exists and was committed in `3d97758`.
3. **`addressChanged` is defined as "the patch carries an address".** §3.3 and task 2.2 both leave
   the predicate's exact meaning to the implementation. The patch's own vocabulary decides it —
   `src/wallet/policy/service.ts` calls a patch "metadata-only" exactly when it carries no address —
   so a patch that carries one IS an address edit. Consequence, pinned by a test: an address edit
   that re-sends the **same** value still clears the claim. Clearing loses a claim; keeping a stale
   one states something false, which is the failure the requirement exists to prevent, so the
   fail-safe direction is to clear.
4. **`provenance: null` collapses to "absent"** under the design's own expression
   (`input.provenance ?? …`). On an address edit that is the fail-safe clear; on a metadata-only edit
   it preserves, which is what §3.3 requires ("a metadata-only edit leaves `provenance` untouched").
   The `| null` in the type is therefore equivalent to `undefined` for the update path; documented
   rather than silently reinterpreted.
5. **`recipient_versions` is unchanged.** Per instruction and design §11 Q7, settling whether the
   snapshot keeps provenance is task 2.6, not this slice. The suite pins today's behaviour (the old
   address is snapshotted, no provenance), so the 2.6 decision becomes a visible test change.

## Workload / PR boundary

This slice is the commit that carries this append: the two migration files, one source file, three
suites and the two checkbox flips. Rollback is dropping the `request_hash` column, restoring the
previous CHECK definition and reverting `src/memory/contacts-repository.ts`; no call site changed
shape (every new field is optional and the `update`-arm default preserves today's behaviour for the
existing paste path), so nothing else in the repository can depend on this unit.

## Structured status consumed

Launched by the parent with `openspec`-store artifacts and an explicit delivery decision
(`size-exception`, no push/no PR, U2 = tasks 2.1–2.2 only). The Review Workload Gate's guard lines
(`Decision needed before apply: Yes` / `Chained PRs recommended: Yes` / `400-line budget risk: High`)
were resolved in the parent prompt as `size-exception` before apply, so the gate did not block.
`actionContext` carried one hard root (`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`);
every write stayed inside it, no forbidden git command was used, and the user-owned untracked
`compose.privy-local.ports.yaml` was neither touched nor committed.

## Remaining work

Tasks 2.3, 2.4, 2.5 and 2.6 are untouched and still `- [ ]`:

```text
- [ ] **2.3 Add the one optional field on the contact-write port and write the alias provenance object.**
- [ ] **2.4 Refuse the wallet's own address with a typed error on every surface (D13, unconditional half).**
- [ ] **2.5 Disclose a duplicate address by name and proceed (D13, the disclosed half).**
- [ ] **2.6 Settle whether `recipient_versions` should snapshot provenance (design §3.1, §11 Q7 — open item, decision required).**
```

`request_hash` has no reader or writer yet (task 3.1). Both parent-owned rows in `tasks.md` are
byte-for-byte unchanged.
