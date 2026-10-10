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
