# Solana-only refactor: remove Arc/EVM and the `WDK_TOOLS_SOURCE` switch

Owner request (2026-10-09): "hagamos lo de la voz, pero antes quiero estar totalmente
operativos en Solana. Si hay errores con Arc para lo que sea, saquémoslo totalmente de
la ecuación. Todo lo que sea WDK_TOOLS_SOURCE también saquémoslo."

## Objective

The application keeps exactly one wallet strategy — the Privy-managed Solana path whose
signing goes through the local sidecar — and none of the legacy machinery that selects
between several provider families at runtime.

## Why this is one refactor, not two

`WDK_TOOLS_SOURCE` is the selector for four wallet providers, and `arc` is one of the
families it selects. Removing Arc and removing the switch are the same deletion.

    src/runtime/dependencies.ts:153-199
      === "circle-arc"     -> CircleArcProvider
      === "solana-devnet"  -> SolanaDevnetProvider   <- the survivor (production path)
      === "live"           -> WdkWalletProvider      <- second, forbidden EVM signing path
      else                 -> FixtureWalletProvider

An unknown or typo'd value silently takes the `fixture` arm. That is fail-closed for
money, and it is also why the switch cannot be left half-removed: there is no validation
anywhere, so a partial removal changes behavior by omission rather than by decision.

## Decisions taken

- **D1 — the survivor is the Solana provider.** The product direction is Solana-only and
  the real signing path is the Privy sidecar (`src/wallet/signer/`, selected by
  `PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN`), which does not read this switch at all. The
  provider chain collapses to the Solana arm, not to the fixture arm.
- **D2 — `live` goes with it.** `WdkWalletProvider` plus the bundled
  `@tetherto/wdk-cli` MCP subprocess is a complete second EVM signing path that no Privy
  code depends on, and `AGENTS.md` forbids enabling it. Keeping it would leave a
  forbidden door with no lock: only the Privy-mode guards in `src/config/process.ts` and
  `src/config/privy-server.ts` stop it, and only when `IDENTITY_PROVIDER=privy`.
- **D3 — the test seam is replaced, not deleted.** `fixture` mode is used by ~40 test
  files, most of them for non-money behavior (notifications, contacts, auth, health).
  Deleting it without a replacement breaks tests unrelated to this refactor. The seam
  must become an explicit dependency injection in those tests rather than an environment
  variable read at provider construction.

## Known blast radius (from exploration, `path:line` verified)

| Group | Files | Notable |
| --- | --- | --- |
| Production wiring | 5 | `src/runtime/dependencies.ts:153-199,205-210`, `src/api/health.ts:14-19`, `src/agent/definition.ts:459-462`, `src/agent/wdk-tools.ts:12`, `src/wdk/transaction-receipt.ts:234-236` |
| Config / guards | 4 | `src/config/process.ts:101-109`, `src/config/privy-server.ts:83-97`, `src/wallet/privy-client.ts:313-315` |
| Tests | 40 | 18 unit, 20 integration, 2 e2e |
| Evals | 4 | `evals/agent/helpers.ts:46,77`, `evals/agent/scenarios/guards.ts:12` |
| Scripts | 6 | `scripts/docker-real-wallet.mjs:43`, `scripts/nani-e2e.sh:119-150` |
| Compose / env | 3 | `compose.yaml:61,119`, `compose.privy-local.yaml:9`, `.env.example:14` |
| Docs | 8 | `README.md` x6, `docs/local-live-runbook.md`, `docs/api.md`, ... |
| Frontend | **0** | `apps/nana-wallet/` never reads it; the separation rule holds |

Additional Arc surface (independent of the switch) is mapped separately: ~93 files, with
`DEFAULT_READ_NETWORK = 'arc-testnet'` at `src/agent/definition.ts:153` making Arc the
silent default for any read that omits `network`.

## Work units

- [ ] WU1 — Freeze the reference and capture the baseline: full suite counts with the
  switch set to `solana-devnet`, and with it unset, so every later step has a comparator.
- [ ] WU2 — Introduce the explicit seam that replaces `fixture` for tests (D3), without
  removing anything yet. The suite must stay green while both mechanisms coexist.
- [ ] WU3 — Collapse the provider chain to the Solana arm (D1) and delete
  `CircleArcProvider` plus its config guards and env.
- [ ] WU4 — Delete the `live` path (D2): `WdkWalletProvider`, the WDK MCP client, its
  tool source, and the live-transfer policy gate keyed on the same literal.
- [ ] WU5 — Delete `FixtureWalletProvider` and the switch itself; migrate the 40 test
  files to the seam from WU2.
- [ ] WU6 — Remove Arc as the silent default: `DEFAULT_READ_NETWORK`, the
  `arc-testnet` literals in `apps/nana-wallet/src/lib/api.ts:374,400,457`, the
  `EXPLORER_URLS` entry, and the mirrored HTTP contract on both sides in one change.
- [ ] WU7 — Update compose, `.env.example`, scripts, and docs.

## Verification

- Root: `npm run lint`, `npm run typecheck`, `npm test`, `npm run eval`.
- Frontend: `npm run lint`, `npm run typecheck`, `npm test`.
- Every work unit commits on the feature branch with tests alongside the behavior.
- No test may pass only because an unset variable happened to select a safe provider:
  after WU5, grepping the suite for `WDK_TOOLS_SOURCE` must return zero matches.

## Evidence

- Arc surface: `feat/solana-operational` exploration, 2026-10-09 (93 files, ranked).
- Switch surface: `feat/solana-operational` exploration, 2026-10-09 (69 files, 7 call
  sites, Q1/Q2 answered).
- Neither explorer could use CodeGraph: its index resolves to the primary checkout and
  the tool accepts no path argument, so worktrees fall back to grep/find.

---

## Progress log

### WU3 — DONE: `d5c2d9e refactor(wallet): delete the Circle Arc provider`

Deleted `src/wallet/circle-arc-provider.ts` and its two test files (~1090 lines),
the `circle-arc` arm of `createWalletProvider` with its `WDK_NETWORK`/`WDK_TOKEN`
guards, its clause in `isLiveTransferSource`, and its clause in the health
`MODE()` derivation. The privy-mode health `NETWORK()` default moved
`arc-testnet` -> `solana-devnet`. 17 files, +86/-1237.

Verification (rigorous, `git stash` A/B against the same commit):
- same 21 failing tests before and after, name-for-name; the only diff was the
  per-test timing suffix. Zero regressions.
- `typecheck` and `lint` clean; `grep -rn "circle-arc|CircleArcProvider"` -> 0.
- Full-suite total fell 1082 -> 1048 and passed fell 1048 -> 1014: exactly the
  34 tests that lived in the two deleted files.

One flake observed and dismissed with evidence: `notifications-reconciliation`
appeared in one full-suite run only, passes 10/10 in isolation, and has zero
references to anything deleted.

## BLOCKING DESIGN QUESTION — the Solana transfer gate

`src/agent/definition.ts:459` `isLiveTransferSource()` is currently
`WDK_TOOLS_SOURCE === 'live' || === 'solana-devnet'`. It guards
`validateWalletTransferPolicy`, which is a REAL, LIVE safety control for Solana
transfers today (applied at `src/conversations/service.ts:959` on preview and
`:1154` on broadcast). It enforces: configured wallet/network/token match,
amount is a positive plain decimal, SOL amounts have at most 9 decimals, amount
does not exceed `WDK_MAX_TRANSFER_AMOUNT`, recipient is a valid address for the
network (and not a burn address), and recipient is in `WDK_ALLOWED_RECIPIENTS`.

Removing `WDK_TOOLS_SOURCE` therefore cannot simply delete this predicate: doing
so would silently remove a live safety control for the only chain that remains.

Decision taken (safe default, pending owner confirmation):
**preserve the gate and re-derive it from `IDENTITY_PROVIDER`**, rather than
deleting it. Concretely, the gate stays unconditional for the Solana/privy path
and the `live`/EVM clause disappears with the EVM path.

This is the one place in this refactor where a deletion could WEAKEN a safety
control rather than remove dead code. It is called out here rather than decided
silently.

## Next design decision for the switch removal

`IDENTITY_PROVIDER` already distinguishes the two surviving behaviors
(`demo` is the default; `privy` is production), and
`src/config/process.ts:101-109` already restricts privy mode to `fixture` or
`solana-devnet`. So the switch is redundant with the identity mode:

    IDENTITY_PROVIDER=demo   -> FixtureWalletProvider   (fake wallet)
    IDENTITY_PROVIDER=privy  -> Solana per-user + sidecar signing

Deriving the provider from the identity mode removes `WDK_TOOLS_SOURCE` without
removing either behavior. `WdkWalletProvider` is NOT dead code and cannot simply
be deleted: besides the forbidden `live` arm it also backs the demo-mode read
path via `legacyToolSource()` (`src/runtime/dependencies.ts:184,278`).

### WU4 — DONE: `5f31e88 refactor(wallet): delete the forbidden live EVM signing path`

Deleted the `live` arm of `createWalletProvider`, the dead Sepolia receipt
polling, and the `live` clause in the health `MODE()` derivation.

**The safety control was reworked, not removed.** `isLiveTransferSource()` is now
`WDK_TOOLS_SOURCE === 'solana-devnet' || IDENTITY_PROVIDER === 'privy'`. The
`solana-devnet` clause is deliberately kept so the gate's behaviour is unchanged;
`validateWalletTransferPolicy` still guards Solana transfers. New tests pin it:
under privy identity it still rejects a missing `WDK_MAX_TRANSFER_AMOUNT` and an
over-cap amount, and stays inert in demo mode.

Verification: same 21 failing tests as the baseline, name for name, via a
`git stash` A/B. `tests/unit` fully green (778 passed). typecheck and lint clean.

One regression was introduced and caught by that comparison, not by the worker:
`tests/integration/grant-claim-release.test.ts` "8.4 GREEN" flips
`WDK_TOOLS_SOURCE='live'` MID-FLIGHT, after a successful preview, to force a real
policy rejection from the owned broadcasting state. The new predicate does not
answer to that value, so the gate stayed off. Fixed by flipping
`IDENTITY_PROVIDER='privy'` instead, with hermetic backup/restore. Verified fixed:
the file is back to its single pre-existing failure (8.4b RED).

### Residual `live` references a later stage must handle

- `src/wallet/privy-client.ts:313` — `createPrivyWalletApiClient` still selects
  `LivePrivyWalletApiClient` on `WDK_TOOLS_SOURCE === 'live'`.
- `src/agent/wdk-tools.ts:12` — `isFixtureMode()` is `!== 'live'`, so a stale
  `live` value still opens the real WDK MCP read client (writes fall through to
  `FixtureWalletProvider`, so no signing — but the read client is real).
- `scripts/nani-e2e.sh:120`.
- `waitForSepoliaTransactionReceipt` is now unreferenced by the default waiter but
  still exported and exercised by `tests/unit/transaction-receipt.test.ts`.

### NEW Arc default found (belongs to WU6)

`getWalletAgentConfig()` (`src/agent/instructions.ts`) resolves the privy identity
to `{ wallet: 'privy-user', network: 'arc-testnet', token: 'USDC' }`. So the privy
path STILL advertises Arc as its network. This is the same class of silent default
as `DEFAULT_READ_NETWORK`, and it surfaced because flipping `IDENTITY_PROVIDER`
in a test drifted the fixture config to Arc.

---

## Post-refactor state (2026-10-10)

25 commits on `feat/solana-operational`. Verified at the end of this pass:

    tests/unit      102 files / 751 passed / 1 skipped
    full suite      19 failures = the shared-database baseline, no regression
    typecheck/lint  clean on both sides
    frontend        112 passed
    npm run eval    25 evals, green

### Solana is the only configured path

- chain routing resolves `solana-devnet`; every other value — including the
  retired `arc-testnet` and `sepolia` — throws `wallet_config_error`
- the deployment's `WDK_NETWORK`/`WDK_TOKEN` are Solana, and `/health` reports
  `solana-devnet`
- the EVM per-user provider is deleted; the per-user path is Solana only
- the balances feature reads the native Solana balance over JSON-RPC
  (verified against devnet), and the contract's `chainId` is a CAIP-2 string

### What is left, and why it is separate

**`src/wallet/embedded.ts` — 8 `chainFamily = "arc"` parameter defaults and the
`PINNED` Arc catalog.** I attempted this as a blanket change and it broke 13
enrollment/sync integration tests, so I reverted it rather than force it. The
reason is now known and recorded here so the next attempt does not repeat it:
`syncWallet`'s eligibility filter (`chainFamily === "arc"`) is the **EVM sync's
own filter**, not a stray default. Changing it makes the EVM sync find no
eligible wallet, which is what the fixtures assert. The functions that ARE
Solana-scoped (`getCurrentWallet`, `getPermission`, `revoke`) have their own
defaults, and `wallet-chain-scope.test.ts` pins the current ones as `arc` under
a describe titled "default to arc (compatibility)". Changing those is a
two-file change: the defaults plus that test's expectations, which currently
encode the Arc default as intended behaviour.

Also dead in that file: `PINNED` (referenced nowhere) and the
`ARC_TESTNET_CHAIN_ID` import that only served it.

**`src/wallet/privy-client.ts:16`** still declares `ARC_TESTNET_CHAIN_ID`, and
`src/wallet/enrollment-policy.ts` plus `src/wallet/provider.ts` still carry Arc
constants. They are consumed by `embedded.ts`, so they move with it.

### Verification discipline that paid off

Comparing `npm test` against a captured baseline, name for name, caught two
regressions that green-looking unit runs had hidden: a `grant-claim-release`
case that flipped the transfer gate mid-flight, and the 13 enrollment failures
above. Both were found by the comparison, not by the suites themselves.

---

## Final state (2026-10-10) — 28 commits

    tests/unit      102 files / 751 passed / 1 skipped
    full suite      19 failures = the shared-database baseline, zero new
    typecheck/lint  clean on both sides
    frontend        112 passed
    npm run eval    green
    /health         "network":"solana-devnet"

### Arc is gone

`grep -rIln "arc-testnet|ARC_TESTNET|arcscan|Arc testnet|5042002"` over `src`,
`apps/nana-wallet/src`, `scripts`, the compose files, `.env.example` and
`package.json` returns **nothing**. The remaining mentions are historical
documents under `.agent-workflow/` and `openspec/changes/archive/`, which are
records and stay.

`src/wallet/embedded.ts` was the last island; it is now Solana-only. The tests
that encoded the EVM shape were repointed, and one test was deleted because its
subject — the EVM-vs-Solana arbitration in `preparePermission` — no longer
exists.

### Three real defects the conversion exposed

None of these were visible while the EVM path existed:

1. **Ethereum gated Solana.** `syncWalletLive` returned early when the Ethereum
   wallet listing failed, so the Solana arm never ran. A Solana-only deployment
   was hostage to a chain it does not serve.
2. **A Solana transaction could not be reported.** `normalizeBroadcastResult`
   only accepted a `0x`-shaped hash, so the text agent dropped every Solana
   broadcast result.
3. **The fixture minted an EVM address.** The Privy test double produced
   `0x…` + `chainFamily: "arc"`, so it could never bind in a Solana-only build.
   It now mints a real base58 address through the same codec as the provider.

### Lesson worth keeping

Every one of these was found by comparing the full suite against a captured
baseline **name for name**, not by reading the code and not by a green unit run.
Three separate regressions in this refactor — the mid-flight transfer gate, the
13 enrollment failures, and the Ethereum-gates-Solana return — first appeared as
a count that did not match.

## Fourth defect: the balance surface was never switched on

Found by opening the wallet screen on the emulator, not by reading code.
`906acc3`.

`readBalanceReadConfig` defaulted to `source: "fixture"` with an **empty**
balance map, so `FixtureBalanceReader.readSolAtomic` threw
`BALANCE_NO_DISPONIBLE` for every address.
`GET /v1/wallets/current/balances` answered **503** for every authenticated
caller, and the screen rendered "No pudimos leer tu saldo" over a leftover demo
sentence: "Todavía no tenemos un saldo de demostración para tu billetera."

Why it survived the whole conversion: `compose.privy-local.yaml` deliberately
omitted `BALANCE_READ_SOURCE`/`BALANCE_RPC_URL`, with a comment explaining that
the reader was an Arc `eth_call` path with no Solana implementation yet. True
before `c47c949`, false after it. The comment outlived the code it described, and
nothing failed loudly enough to notice: a 503 on one screen reads as "the wallet
has no funds", which was also true.

The fix defaults the source to `rpc` and the URL to `SOLANA_DEVNET_RPC_URL`, the
constant the signing provider already uses. This deployment serves exactly one
chain, so the node is not a deployment decision and its absence is no longer a
misconfiguration. `BALANCE_READ_SOURCE=fixture` still exists for offline work but
now has to be asked for.

### The stale bundle hid half the bug

After the backend fix the screen still read "Arc testnet · USD Coin · 0 USDC".
The frontend image predated the balance commit by ~10 hours, so the served bundle
carried `arc-testnet` labels and requested
`/v1/wallet/balance?network=arc-testnet&token=USDC`; the source had none of it.
Rebuilding the image removed every `arc-testnet` reference from the bundle.

Two caches had to be cleared before the fix was even visible: the container
image, and the WebView's HTTP cache. A rebuilt image plus `adb reverse` is not
enough; `Network.setCacheDisabled` + `Page.reload({ignoreCache: true})` was.

### Lesson

A deployment can be answering every balance request with 503 and still look
"green". Counts matched the baseline exactly (19 failed / 983 passed / 13
skipped), which proves only that nothing **else** broke. A green suite says
nothing about a surface whose default is silently wrong — someone has to open the
screen.
