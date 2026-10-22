# Feature: Broadcast `uncertain` defects D-A…D-E (money-safety error classification)

- Branch: `fix/broadcast-uncertain-defects` (worktree `colloseum.fix-broadcast-uncertain-defects`)
- Base: `main @ 76473ea`
- Origin: diagnosed 2026-10-12 when a live transfer reported `uncertain` while on-chain evidence PROVED the money never moved (sidecar signer orphaned in another network namespace; conversation `159eb260` stuck `uncertain`). The operational fix landed then; these are the code defects underneath, diagnosed but deliberately not yet fixed.

## The defects (scope, authoritative)

- **D-A** — `PayloadSignerError` (`src/wallet/signer/port.ts:33`) carries `code` but never sets `definitive`. `SolanaDevnetProvider.broadcastTransfer` branches on `error.definitive === true`; its own doc says `signer_rejected` is "a definitive 4xx rejection" — yet even a definitive rejection reports `uncertain`.
- **D-B** — `src/conversations/service.ts` wraps `broadcastTransfer` in try/catch and converts ANY throw into `uncertain`, including provably pre-dispatch failures. Also `bound()` and `requireRecentBlockhash()` live OUTSIDE the provider's try, so their errors surface raw and get the same blanket treatment upstream.
- **D-C** — `SolanaDevnetProvider.reconcileBroadcast` returns `uncertain` when `findByReference` finds nothing: no path from `uncertain` → `not_dispatched` exists even when the chain proves absence (irony: `waitForFinality` pages history exhaustively because "a single bounded page never proves absence"). Biggest design surface — treat as needs-design: propose the minimal safe transition rule with tests; if it exceeds a bounded change, record the proposal in Receipts and stop rather than forcing it.
- **D-D** — nothing validates the sidecar signer's capability (neither at boot nor before dispatch), so a namespace orphan is invisible until a dispatch fails mid-flight.
- **D-E** — `src/wallet/wdk-provider.ts:146` validates the tx hash with `/^0x[0-9a-f]{64}$/iu` (EVM) and `explorerUrl` points at sepolia.etherscan.io. Latent: the Privy stack uses `SolanaDevnetProvider` (base58-correct), but any Solana hash through this path reports `uncertain`. Align validation/explorer with the chain this provider actually serves (read the code to decide — do not assume).

## Order (by safety/value): D-A → D-D → D-E → D-B → D-C

D-C last and may legitimately remain open with a recorded proposal.

## Non-negotiables (money safety)

- NEVER loosen fail-closed behavior: ambiguity must keep reporting `uncertain`. The goal is the opposite — stop calling provable pre-dispatch failures "uncertain", and only when the evidence class is provable (signature step failed before submission; capability probe failed before signing; validation rejected the hash before any network call).
- A broadcast error AFTER submission stays `uncertain` unless a definitive 4xx-class rejection is documented in code. Prove the dispatch boundary by reading the actual call order in `src/wallet/solana-devnet-provider.ts` before classifying anything.
- Tests: strict TDD where deterministic (RED first). No test may perform a real payment or hit a live RPC — fixture/fake transport only. Existing suites: `tests/unit/wallet-*.test.ts`, `tests/integration/*`; run targeted files.
- The `beforeCommit` seam (`src/wallet/policy/service.ts`) and the policy reconciler are OUT of scope — do not touch.

## Tasks

- [x] T1 D-A — **DONE, commit `df7e88c`.** Dispatch boundary proven by reading the code: `broadcastTransfer` (`solana-devnet-provider.ts:386`) enters the try at `:416` and the ONLY network call inside is `this.signAndSend.signAndSend(...)` → one `POST /v1/wallets/{wallet_id}/rpc` (`signAndSendTransaction`); the client (`privySignAndSendFromEnvironment:724`) has no retry/loop (grep: zero retry/attempt/while/for), signing happens inside the SDK request construction via `signerAuthorizationContext(payloadSigner)` BEFORE the POST, and `asDispatchFailure` (`:895`) passes every non-policy error through unchanged — so a `PayloadSignerError` can only escape before any send: provably pre-dispatch. **Fix:** the error class now carries `readonly definitive = true` (port.ts, doc comment states the one-request/no-retry premise) and the provider catch derives a truthful `cause` (`signer_rejected`→`invalid_request`, other signer codes→`provider_unavailable`, policy→`policy_rejected`) instead of the previously hardcoded `policy_rejected`. **TDD evidence:** RED observed first (`expected {kind:'uncertain'} to match {kind:'not_dispatched'}`), then GREEN 44/44 (`solana-devnet-provider` + `signer-client`), `npm run typecheck` clean, `npm run lint` clean. The ambiguous-signer-stays-uncertain side is pinned by the existing `keeps a policy denial definitive and every transport failure ambiguous` test (plain `Error` remains `uncertain`).
- [ ] T2 D-D: capability validation (boot + pre-dispatch probe) with a test proving an unreachable sidecar fails fast with its own error instead of a mid-dispatch `uncertain`.
- [ ] T3 D-E: hash validation + explorer URL aligned to the provider's actual chain, with a test (Solana hash accepted, EVM hash rejected on the Solana path — or whatever the code's real contract is).
- [ ] T4 D-B: classify provable pre-dispatch throws (move `bound()`/`requireRecentBlockhash()` inside the guarded region or map them explicitly) with tests for both sides of the boundary.
- [ ] T5 D-C: bounded proposal or minimal implementation with tests; stopping with a recorded proposal is an acceptable outcome.
- [ ] T6 Verify: targeted suites green, `npm run lint`, `npm run typecheck` (`tsconfig.test.json`); Receipts with per-defect evidence; work-unit commits (English, conventional, no AI attribution).

## Environment / rules

- `node_modules` → symlink to `colloseum.feat-solana-operational/node_modules`; `.cache`/`.env` copied from main (`.env` has NO DATABASE_URL; NEVER read any `.env`). DB-dependent tests get it inline: `DATABASE_URL='postgres://postgres@127.0.0.1:5432/wdk_agent?options=-csearch_path%3Dpublic,extensions'` (warm stack DB) or the fresh-DB recipe (pgvector image + `CREATE SCHEMA extensions` prelude + `supabase/roles.sql` + migrations, ephemeral container).
- Never: git stash/checkout/reset/restore/clean, npm install, `--legacy-peer-deps`, secrets, pushing (orchestrator pushes).
- Subagent budget ~20 min: COMMIT as soon as each defect's unit is green, even if you have not reached the last defect.

## Receipts

- **CI local reproduction (2026-10-22):** lint PASS, typecheck PASS, full suite fresh DB @`--maxWorkers=2` = **11 failed files / 24 failed tests / 1826 passed** — exactly the pre-existing CI baseline (7 class-A + 4 class-B files, minus `api-contact-check-alias` whose shared-user provisioning happens to be satisfied by ordering). **D-A introduced zero new failures** (24 tests < CI's original 26; every failing test is accounted for by the two unfixed sibling scopes).
- Commits: (to be recorded)
- Per-defect evidence: (to be recorded)
- Checks: (to be recorded)
