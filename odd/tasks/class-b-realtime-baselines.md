# Feature: Class-B test baselines on CI (realtime send_token + preview-race)

- Branch: `fix/class-b-realtime-baselines` (worktree `colloseum.fix-class-b-realtime-baselines`)
- Base: `main @ 76473ea`
- Context: CI run `38337428633` (main, 2026-10-13) failed 12 files; the 8 provisioning ones are fixed on `test/self-provisioning-suites`. This feature owns the remaining **class B** failures — and only these:

## Scope (authoritative)

IN:
1. `tests/unit/realtime-tools.test.ts` — `createRealtimeTools > send_token delegates the preview to the service and strips the recipient address`: `AssertionError: expected "vi.fn()" to be called with arguments [StringContaining{}] — Number of calls: 0` at `:402` (`speakPreview`).
2. `tests/unit/realtime-tool-binding.test.ts` — `send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy`.
3. `tests/integration/conversation-preview-claim-race.test.ts` — `two simultaneous confirms broadcast exactly once (V8.5)`: `expected "broadcastTransfer" to be called once, but got 0 times` at `:106`. Documented as a load flake (passes 3/3 isolated) — determine whether CI's failure is timing (drain/too-short wait) or a real regression; do NOT mask a real race by just enlarging timeouts without evidence.

OUT (parked by Ramiro, 2026-10-21 — do NOT investigate, fix, or "clean up"): `tests/unit/realtime-agent-session.test.ts > allows one re-read when a confirmation is refused for an incomplete read-back`. It may stay red; record it as parked in receipts.

## Key forensic fact

CI on old main passed fully on 2026-10-08 (run 37782979335, `be4dbca`). These files fail at `76473ea`. Something between `a8fad42`/`be4dbca` and `76473ea` changed either the tests or the code under them. Bounded archaeology: `git log --oneline be4dbca..76473ea -- <the test files>` and the matching `src/` paths; then `git show`/`git diff` the candidates. Classify each failure as (a) real production regression, (b) test asserting behavior deliberately changed (update the test with the commit evidence), or (c) test-environment/timing.

## Tasks

- [x] T1 Diagnose each of the 3 files with evidence — **verdicts (all class b: tests asserting pre-refactor contracts):**
  1. `realtime-tools` `:402` — asserted `speakPreview` with Spanish copy `"Comisión estimada…"` and a pre-`bafc63d` preview flow (the decision window was re-anchored to the preview by `bafc63d`; the copy moved to English in `90711e8`/`1288b2e`; last test edit `765e367`).
  2. `realtime-tool-binding` — same `send_token` contract drift, last touched by `765e367`.
  3. `conversation-preview-claim-race` — **NOT the assumed load flake: fails 3/3 isolated locally.** `isClaimedRecipientValid` (`src/conversations/service.ts:1998-2019`) requires `current.network === expectedNetwork`, and under the Solana-only config (`9d0c0af`) `previewTransfer` stamps `transfer.network = config.network = "solana-devnet"` while the fixture recipient had `network: undefined` + an EVM `0x…` address → guaranteed mismatch at the S10-style pre-dispatch revalidation (`service.ts:1261`, `recipient_revalidation_required`). Production contacts store `network='solana-devnet'`, so production is consistent; the fixture had drifted.
- [x] T2 Fix per diagnosis: `922e0d0` aligned the two unit tests to the post-`bafc63d` contract; preview-race fixture moved to the Solana-only contract (base58 recipient `DFYT4RD…AWWM`, mock `network: "solana-devnet"`). The PROBE scaffolding used during diagnosis was removed before committing. The final `lastTransactionHash` `/^0x[0-9a-f]{64}$/` assertion still holds: `FixtureWalletProvider` keeps `HASH_PREFIX = '0x'`.
- [x] T3 Verify: preview-race **3/3 isolated** green (inline warm-DB `DATABASE_URL`); unit pair `realtime-tools` + `realtime-tool-binding` **24/24** green; `npm run typecheck` (`tsconfig.test.json`) clean; `npm run lint` clean.
- [x] T4 Receipts — **Commits:** `922e0d0` test(realtime): align send_token preview tests with the post-bafc63d contract; `a75b0f8` test(conversations): move the preview-race fixture to the Solana-only contract; docs commit with these verdicts. Diagnosis log: PROBE output captured `recipient_revalidation_required` on both confirms (`turn-completed`), pointing at `isClaimedRecipientValid`. **Parked test untouched:** `realtime-agent-session > allows one re-read…` stays red by decision (Ramiro, 2026-10-21). Note for follow-up: a production contact row WITHOUT a `network` value would preview and then fail pre-dispatch revalidation (fail-closed, AD-10/S10 by design) — recorded, not changed.

## Environment / rules

- `node_modules` → symlink to `colloseum.feat-solana-operational/node_modules` (complete, same lockfile); `.cache` and `.env` copied from main (`.env` has NO DATABASE_URL; NEVER read it).
- Never: git stash/checkout/reset/restore/clean, npm install, `--legacy-peer-deps`, secrets, pushing (orchestrator pushes).
- Subagent budget ~20 min: commit as soon as each unit is verified, even if not at the last file.

## Receipts

- **CI local reproduction (2026-10-22):** lint PASS, typecheck PASS, full suite fresh DB @`--maxWorkers=2` = **8 failed files / 21 failed tests / 1828 passed** — ALL cross-scope: the 7 class-A files (fixed only on sibling `test/self-provisioning-suites`) + `realtime-agent-session` (parked test). **The three files THIS branch fixes pass in full-suite context** (`realtime-tools`, `realtime-tool-binding`, `conversation-preview-claim-race` absent from the failing list). Zero new failures.
- Commits: (to be recorded)
- Diagnosis per file: (to be recorded)
- Checks: (to be recorded)
