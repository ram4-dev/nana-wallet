# Verification receipt

2026-10-10: mapping and implementation outline only. No application code, database migration, remote policy, signer credential, or transaction changed.

- Source mapping: completed at 9eccee1; documentation mapping commit 14c6e82.
- Design approval: Ramiro, "si apruebo"; removal revokes affected automatic-payment grants when no active address alias remains.
- Execution override: Ramiro, "Hacelo todo inline o con subagentes nativos". Native independent revision 1 review found four controlling issues; revision 2 resolved them and was judged ready for outline approval; Pi/Herdr review superseded, not silently substituted.
- Worktree: user-designated /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational; feat/solana-operational. Untracked compose.privy-local.ports.yaml preserved.
- git diff --check: passed after outline creation.
- Tests/lint/typecheck/build/E2E: not run for documentation-only phase; required before implementation closure. No application implementation yet.
- Manual/live policy operations: not performed in this phase.
- Outline approval: pending after independent review.
- Next authorized action: request approval of independently reviewed outline revision 2, then SDD. No push/PR.

---

# 2026-10-10 — Closing evidence set and RPI verification receipt (tasks 5.3–5.9)

Read scope: everything below was executed against the tree at commit **`5eed078`** plus the
closing documentation-only edit of this run. Nothing under `src/` or `apps/` was edited by this run.
Working root (the only writable tree):
`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch `feat/solana-operational`.
The main checkout was never entered or modified.

**Later-commit facts outrank earlier snapshots.** `apply-progress.md` and this file carry two earlier
PENDING records (task 2.14's live probe, task 5.1/5.2's deployment state) that remain true but are
**superseded where they differ** by the sections below: 2.14's "probe PENDING" became "collected,
negative per process" at 5.2; 5.1/5.2's container markers stay ABSENT and their blockers are unchanged.

## 5.3 Automated suites with a captured pre-existing-failure baseline

| Command (worktree root) | Exit | Result |
|---|---|---|
| `npm run lint` | 0 | `eslint src tests --max-warnings=0`, clean |
| `npm run typecheck` | 0 | `tsc -p tsconfig.test.json --noEmit`, clean |
| `npx vitest run` | 1 | `Test Files 10 failed \| 186 passed \| 4 skipped (200)` / `Tests 12 failed \| 1457 passed \| 10 skipped (1479)` / 76.27 s |
| `npm run build` | 0 | `tsc -p tsconfig.json`, clean |
| `npm run eval` | 0 | 9 eval files / 27 evals / score 98 % vs threshold 0 % → PASS |
| `(cd apps/nana-wallet && npm run lint)` | 0 | `eslint .`, clean |
| `(cd apps/nana-wallet && npm run typecheck)` | 0 | `tsc --noEmit`, clean |
| `(cd apps/nana-wallet && npx vitest run)` | 0 | `Test Files 24 passed (24)` / `Tests 156 passed (156)`, 0 failed, 0 skipped |

Not run: `npm run db:migrate` — it fails locally on the pre-existing
`relation "conversations" already exists`; the worktree DB already reflects the Supabase chain
(`extensions` schema + `supabase/roles.sql` + `supabase/migrations/*.sql`), which is the CI shape.

### Baseline comparison by test name

Baseline = `.agent-workflow/tasks/trusted-recipient-policy-sync/91-test-baseline.md` **attempt 2**
(CI-shaped database, commit `a121b2c`): `6 failed | 1028 passed | 10 skipped (1044)`.
This run: `12 failed | 1457 passed | 10 skipped (1479)`.

| # | Baseline test (file > describe > test) | Baseline first message | This run | Verdict |
|---|---|---|---|---|
| B1 | `tests/integration/api-voice-auth.test.ts` > /v1/voice/room-token authorization (PMU-020, privy mode) > returns the same 404 for a foreign conversation as for a missing one | `Error: Test timed out in 15000ms.` | **did not fail** | baseline-family (timing); not reproduced |
| B2 | `tests/integration/conversation-preview-claim-race.test.ts` > previewTransfer real claim semantics > two simultaneous confirms broadcast exactly once (V8.5) | `expected "broadcastTransfer" to be called once, but got 0 times` | FAILED, **identical message** | pristine, reproduced |
| B3 | `tests/integration/wallets-sync.test.ts` > PEW-013: explicit activation with read-back; empty allowlist rejected (422) | `expected 422 to be 200` | FAILED, **identical message** | pristine, reproduced |
| B4 | `tests/unit/realtime-agent-session.test.ts` > allows one re-read when a confirmation is refused for an incomplete read-back | persona-prompt regex mismatch | FAILED, **identical message** | pristine, reproduced |
| B5 | `tests/unit/realtime-tool-binding.test.ts` > send_token previews (no broadcast) and confirm_transfer broadcasts through the fixture spy | `expected [] to have a length of 1 but got +0` | FAILED, **identical message** | pristine, reproduced |
| B6 | `tests/unit/realtime-tools.test.ts` > send_token delegates the preview to the service and strips the recipient address | `expected "vi.fn()" to be called with arguments: [ StringContaining{…} ]` | FAILED, **identical message** | pristine, reproduced |
| N1 | `tests/integration/api-auth-logout.test.ts` > POST /v1/auth/logout and the session floor (privy mode) > keeps the existing verification guarantees unchanged | — | `Error: Test timed out in 15000ms.` | **outside both lists** → load-flaky family (15 s). Isolation: **5 passed (5)** |
| N2 | `tests/integration/api-contacts-policy.test.ts` > /v1/contacts + /v1/recipient-policy routes (task 3.2) > creates a contact whose permission is honest and never claims an unverified apply | — | `expected 409 to be 201` | **outside both lists** → not a timeout; contention-shaped. Isolation: **9 passed (9)** |
| N3 | `tests/integration/contact-action-address.test.ts` > task 4.7 > renders the persisted row after a reload and refuses an unknown or foreign proposal | — | `Error: Test timed out in 5000ms.` | outside both lists → load-flaky family (5 s). Isolation: **7 passed (7)** |
| N4 | `tests/integration/contact-action-address.test.ts` > task 4.7 > re-validates the canonical base58 form and creates exactly one new version | — | `Error: Test timed out in 5000ms.` | same, isolation-clean |
| N5 | `tests/integration/contact-action-address.test.ts` > task 4.7 > rejects a stale expectedProposalVersion with PROPUESTA_OBSOLETA and mutates nothing | — | `Error: Test timed out in 5000ms.` | same, isolation-clean |
| N6 | `tests/integration/livekit-trusted-recipient.e2e.test.ts` > task 4.8 > never derives an address from a spoken name, and a paste creates the new version | — | `Error: Test timed out in 5000ms.` | outside both lists → load-flaky family (5 s). Isolation: **13 passed (13)** |
| N7 | `tests/integration/notifications-reconciliation.test.ts` > reconciliation worker (forward catch-up, lease, lifecycle) > starts immediately, runs a pass, and stops cleanly awaiting in-flight work | — | `expected 0 to be greater than or equal to 1` | **outside both lists** → not a timeout; contention-shaped. Isolation: **10 passed (10)** |

**Verdict: 0 regressions.** All five reproducible pristine failures kept their exact baseline message.
The baseline entry that did not reproduce here (B1) is inside the documented timing/load family. Every
one of the seven non-baseline failures was re-run **in isolation and passed**; none is a change-owned
assertion failure that survives alone. The 5 s / 15 s timeouts are the parallel-run contention family;
N2 and N7 are the same contention expressed as an assertion (a 409 where the sequencing expected 201
under a competing connection; a lease/pass counter that had not advanced when observed), and both are
clean alone. Recorded as observed, not hidden: **the parallel run is redder than the baseline, and its
redness is contention, not behaviour.**

### Isolation re-runs (both results reported)

| File re-run alone | Result |
|---|---|
| `tests/integration/api-contacts-policy.test.ts` | 1 file passed, **9 passed (9)** |
| `tests/integration/notifications-reconciliation.test.ts` | 1 file passed, **10 passed (10)** |
| `tests/integration/contact-action-address.test.ts` | 1 file passed, **7 passed (7)** |
| `tests/integration/livekit-trusted-recipient.e2e.test.ts` | 1 file passed, **13 passed (13)** |
| `tests/integration/api-auth-logout.test.ts` | 1 file passed, **5 passed (5)** |
| `tests/integration/api-voice-auth.test.ts` | 1 file passed, **4 passed (4)** |

No readback assertion was removed or weakened to reach this state; nothing in this run edited `src/`.

## 5.4 Browser E2E on the final tree

`npm run test:e2e:trusted-recipient-browser` → **exit 0**.

```text
SCENARIOS: 25  PASS: 20  FAIL: 0  BLOCKED: 5
RESULT: PASS (no failed scenario) with 5 BLOCKED (not executed) — exit 0
```

Executed and PASSING (20), including the driver layer: real backend + real database + fixture identity
seam, `GET /v1/me` positive control; create (persisted with an honest permission snapshot, payload
carries no key material); reload observes the same `permission.state`; retry answers honestly and never
fabricates `applied`; retry stays `retryable_failure` instead of claiming success; duplicate alias
accepted as a distinct alias and the pre-flight read reports the surviving alias; edit replaces the
address with an honest permission and the disclosure-carrying replacement is accepted (409 as
contracted); edit disclosure pre-flight carries the affected grants; remove returns
`{contact, revocation}` and never announces an unverified revocation as applied; a second DELETE is
`404 CONTACTO_NO_ENCONTRADO`; no chain picker (explicit chain → `422 DATOS_INVALIDOS`); no ready
permission → saved-and-not-enabled with 0 applied-policy rows; durable intent recorded instead of a
policy write; MSW fixtures serve every readiness state and every new error code; playwright chromium
launch; frontend dev server ready.

BLOCKED (5, implemented but NOT executed — exact blocker, verbatim from the harness):

1. `browser layer: an authenticated session is required`
2. `browser: the recipient row renders the readback-backed state and never "habilitado"`
3. `browser: the address edit shows the revocation disclosure before submitting anything`
4. `browser: the recipient form exposes no chain picker`
5. `browser: removing the recipient shows the disclosure dialog before deleting`

**Blocker (all five):** *"no authenticated browser session: the frontend attaches only
`usePrivy().getAccessToken()` (`apps/nana-wallet/src/routes/__root.tsx`) and this environment has no
Privy credentials, so the real API answers 401 and the recipient surface never renders."* This is a
real, unrelated blocker, **not a pass**. The deployed-stack half of 5.4 is additionally blocked by the
5.1 state (nothing was rebuilt or restarted), so this harness ran against the worktree stack with the
fake policy transport.

## 5.5 LiveKit session E2E and the fake-transport worker run

| Command | Exit | Result |
|---|---|---|
| `npx vitest run tests/integration/livekit-trusted-recipient.e2e.test.ts` | 0 | 1 file passed, **13 passed (13)**, **0 skipped** |
| `npm run test:e2e:livekit-fake` (`tests/integration/livekit-worker-fake.e2e.test.ts`) | 0 | 1 file passed, **3 passed (3)**, **0 skipped** |

**Skipped cases: none — there are zero skipped tests in either run, so there is no skipped case to name
by name.** All 13 session cases executed: authenticated final affirmative succeeds; foreign speaker
fails closed while the bound one succeeds; no-speech fails closed then completes when speech arrives;
pre-proposal affirmative dropped and the next accepted; expired affirmative refused as
`evidence_expired`; delayed final transcript inside the inherited 2 s bound completes the same call;
replay refused after consumption; a consumed action id is never re-armed; contact↔transfer window
collisions refused in both orders; permission creation refused with no bound participant able to
receive the card; the window stays closed when the card could not be published; a spoken name never
becomes an address and a paste creates the new version. Fake worker: binds before accepting a
transcript and commits one turn once; fails closed for a malformed binding; fails closed for an expired
binding. Transport is the fake one by design (§12.2) — it is not live-provider proof.

## 5.6 Agent evals on the final candidate

`npm run eval` → **exit 0**. `Score 98%`, `Threshold 0% (passed)`, `Eval Files 9`, `Evals 27`.

| Eval file (case/suite names from `evalite(...)` in source) | Cases | Score |
|---|---|---|
| `evals/smoke.eval.ts` — "Smoke: harness wiring" | 2 | 100 % |
| `evals/voice/realtime/realtime.eval.ts` — "Realtime: harness offline (WAV extraction + message shape)" | 1 | 100 % |
| `evals/voice/stt/stt.eval.ts` | 0 | — (0 evals) |
| `evals/voice/tts/tts.eval.ts` — "TTS: harness offline (samples + round-trip machinery)" | 1 | 100 % |
| `evals/agent/conversational-quality.eval.ts` — "Conversational quality: judge harness (offline)" (+ the real-agent suite gated by `EVAL_REAL`) | 1 | 100 % |
| `evals/agent/wallet-agent.eval.ts` — "Agent: tool selection + parameters", "Agent: guards", "Agent: preview → confirm flow", "Agent: recipient resolution", "Agent: unified surface coverage" | 18 | **98 %** |
| `evals/agent/tools-parity.eval.ts` — "Tools parity: text vs voice surface" | 1 | 100 % |
| `evals/agent/recipient-lifecycle.eval.ts` — "Agent: recipient lifecycle (text and voice)" | 2 | 100 % |
| `evals/voice/realtime/tools-matrix.eval.ts` — "Realtime Tools: scenario definitions valid (offline)" | 1 | 100 % |

The change-added suites (`recipient-lifecycle`, `tools-parity`, and the realtime tools matrix) passed at
100 %. **Not executed (real-mode gates, `EVAL_REAL` unset) — recorded, not hidden:** the real realtime
eval, the real STT round-trip (0 evals collected), the real TTS round-trip, and the real realtime tools
matrix; each printed `SKIP: real mode off (set EVAL_REAL=1)`. `evalite` prints per-file rows but not
per-case names, so per-case outcomes could not be named individually; the 98 % figure on
`wallet-agent.eval.ts` means at least one of its 18 cases scored below 1.0 in this offline model-free
configuration. That is **not** a blocker for this change (threshold 0 %, exit 0) and **not** a
change-owned regression, but it is recorded rather than smoothed to a round 100 %.

## 5.7 Manual/live devnet verification — PENDING (checkbox stays `[ ]`)

Not executed. Two independent prerequisites, both unmet:

1. **User selection** — the task requires the change owner to explicitly choose the exact devnet
   recipient. No recipient has been named, and this run must not invent one.
2. **Signer capability** — the live path needs a deployment whose `canSignAuthorizations()` is true.
   The deployed processes report `{"capable":false,"code":"signer_unavailable"}` for both the backend
   and the worker sidecar (task 5.2), so no signed remote GET is obtainable.

Not performed, deliberately: no live trusted recipient was created, `Test1` was not removed, no policy
was written, and **no money moved** (no transfer of any size, including the permitted ≤ 0.01 SOL path).

Exact steps it would take once both prerequisites are met: (1) the user names the exact devnet
recipient address; (2) perform the screen operation (add / edit / remove that recipient) through the
real API against the deployed stack; (3) perform the matching agent operation in the text and voice
contexts with the versioned proposal card; (4) issue a **signed remote GET** of the policy and prove the
address is included (add/edit) or absent (remove) while the ordinary cap, the delegated limits, the
canonical signer attachment, and the unrelated signer are byte-identical before and after; (5) record
every still-unexecuted live step with its blocker. The `Test1` drift case converges rather than blocking
per design §5.1 and is part of the same readback evidence.

## 5.9 Work-unit commits, no push, no PR

Each completed work unit is closed by **exactly one** conventional commit (English, outcome-first,
tests with their behaviour, docs with their change, no AI attribution). The slice-1/2/3/4 unit commits
and their exact SHAs are recorded in `apply-progress.md`; `git log --oneline` at the time of writing
(newest first):

```text
(this commit)   docs(sdd): record the closing evidence set and the verification receipt
5eed078 docs(deploy): record the blocked rebuild and the live capability probe result
7f53919 test(evals): prove the recipient lifecycle surface in both agent contexts
0f39529 test(voice): prove the trusted-recipient session window end to end
1f79e79 feat(policy): review a persisted contact proposal and version its address from the screen
0177f3d feat(policy): publish the contact proposal card reliably and gate the voice window
```

`git status --porcelain -uall` at freeze, before the closing commit:

```text
?? compose.privy-local.ports.yaml
```

The single untracked entry is the pre-existing, deliberately preserved local port override; it is
**not** committed. No tracked file was modified before the closing documentation edit.

| Fact | Evidence |
|---|---|
| **No push happened** | `git rev-list --left-right --count origin/feat/solana-operational...HEAD` → `0  6` (0 behind, **6 ahead**): the branch is local-only, exactly as the no-push rule requires. The parent publishes once at the end. `git push` was never invoked in this run. |
| **No new remote branch** | `git branch -r` lists only pre-existing remotes: `origin/HEAD`, `origin/backup/pre-colloseum-main`, `origin/chore/remove-provider-caveats`, `origin/feat/openai-realtime-poc`, `origin/feat/solana-operational`, `origin/feat/voice-e2e-harness`, `origin/main`, `origin/review-architecture-review-and-livekit-integration-strategy`. No branch from this change (no `trusted-recipient*`, no slice/PR branch) exists on any remote. |
| **No PR** | No PR was opened; no `gh pr` invocation was made. |

## Deviations and state mutations disclosed

1. **The worktree DB container had to be restored before the suites could run.** `docker compose up -d db`
   (as literally written in the task) **recreated** `colloseumfeat-solana-operational-db-1` onto host
   port **5432** and failed to start: `Bind for 127.0.0.1:5432 failed: port is already allocated`,
   leaving the container in `Created` (stopped). Root cause: `DB_HOST_PORT` is set in **neither** `.env`
   (`grep -c '^DB_HOST_PORT='` → 0) nor the shell, so the `${DB_HOST_PORT:-5432}` default applied. Every
   documented invocation assumes port 55470, which is where `.env`'s `DATABASE_URL` points. Restored with
   `DB_HOST_PORT=55470 docker compose up -d db` → `Up (healthy)`, `127.0.0.1:55470->5432/tcp`. The named
   volume was preserved, no data was lost, and every suite above ran against the same schema shape as
   the baseline. **Any future `docker compose up -d db` in this worktree must carry `DB_HOST_PORT=55470`.**
2. `npm run db:migrate` was not run (pre-existing `relation "conversations" already exists`), as stated
   by the brief.
3. The browser harness ran against the worktree stack with the fake policy transport, not a rebuilt
   deployment — the deployment half is blocked by 5.1 and is reported as such, not as a pass.

## Secret safety

No `.env` value was read or printed. `.env` was inspected by **key name / presence count only**
(`grep -c '^DB_HOST_PORT='`). No token, key, payload, signature, or provider credential value appears
in any command argument, in this file, in `apply-progress.md`, or in the commit. Commands printed
booleans, HTTP status codes, scenario names and counts. The proxy log lines observed during the browser
harness carry request ids, hostnames and status codes only.

## RPI verification receipt

| Field | Value |
|---|---|
| Change | `trusted-recipient-policy-sync` |
| Frozen candidate | `5eed078` + this run's documentation-only closing edit (no `src/` change in this run) |
| Branch / worktree | `feat/solana-operational` @ `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational` |
| Normalizers run before any check | `npm run lint` (exit 0, convergent), `(cd apps/nana-wallet && npm run lint)` (exit 0) |
| Check-only commands | `npm run typecheck` 0 · `npx vitest run` 1 (12 failed, all baseline or isolation-clean) · `npm run build` 0 · `npm run eval` 0 · `(cd apps/nana-wallet && npm run typecheck && npx vitest run)` 0/0 |
| Baseline comparison | `91-test-baseline.md` attempt 2 (commit `a121b2c`): **0 regressions**, 5 of 6 pristine reproduced verbatim, 7 non-baseline failures all isolation-clean |
| E2E | browser 25 scenarios (20 PASS / 0 FAIL / 5 BLOCKED, no Privy session); LiveKit 13/13 PASS 0 skipped; fake worker 3/3 PASS 0 skipped |
| Evals | 9 files / 27 evals, 98 % vs threshold 0 %, exit 0; 4 real-mode suites skipped by design |
| Live probe outcomes | `{"capable":false,"code":"signer_unavailable"}` for the backend and for the worker sidecar (task 5.2); U1–U4 unproven |
| Live-step status | 5.1 BLOCKED (nothing rebuilt/restarted), 5.2 partially collected (U1–U4 uncollectable), 5.7 PENDING (user selection + signer capability), 5.3–5.6/5.8/5.9 executable and executed |
| Delivery | Local only — **no push, no PR**; `0 6` ahead of `origin/feat/solana-operational` |
| Hand-off | Ready for `sdd-verify` / archive on the recorded state; live tasks remain pending with their exact prerequisites |
