# HANDOFF v2 — Nana Wallet, voice confirmation flow

**Date**: 2026-10-10
**Branch**: `feat/solana-operational` (35 commits ahead of `origin/main`, none pushed)
**Worktree**: `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`
**Author of this handoff**: el Gentleman (Pi session)

---

## 0. Read this first

**The confirmation flow is MID-REFACTOR.** Do not assume it works. The last
change removed a broken mechanism and the tests for the new one are not written
yet. Two tests fail on purpose because they assert the old behaviour (see §6).

**There is uncommitted work in the working tree.** The last commit is `445fbc1`;
everything after it is unsaved:

```
 M src/agent/definition.ts
 M src/livekit/create-agent-session.ts
 M src/livekit/realtime-tools/create-realtime-tools.ts
 D src/livekit/speak-text.ts
 M src/livekit/voice-decision-gate.ts
 M src/livekit/worker.ts
 M tests/integration/livekit-voice-confirmation-fake.e2e.test.ts
 M tests/unit/agent-tools-parity.test.ts
 D tests/unit/livekit/speak-text.test.ts
 M tests/unit/livekit/voice-decision-gate.test.ts
 M tests/unit/livekit/voice-decision-transcripts.test.ts
 M tests/unit/realtime-tool-binding.test.ts
 M tests/unit/realtime-tools.test.ts
?? HANDOFF_v2.md
```

`src/` compiles clean (`npx tsc --noEmit -p tsconfig.json`), and the full test
typecheck is clean. The gate rewrite is complete and verified by direct
execution; the two failing tests are the loose ends. **Commit this before
starting anything else**, or the next session starts from a dirty tree it did not
create.

**Money is safe.** The wallet holds 5.0 SOL on devnet and the only on-chain
transaction is the inbound funding transfer. Verified, not assumed:

```
tx 4HaKwXhgyui9F45fZXqtj8KwTx1kYXJc6t1YPJe3nfZakBBGhhZCFAn6bC1coqj8JABt9fzyZwgKpMtqgtTcqQ3c
  account iB1mdEmZ… 10.174349160 -> 5.174269226 SOL   (-5.000080)
  account AfHaCDtR…  0.000000000 -> 5.000000000 SOL   (+5.000000)   <- our wallet
  err: none, finalized
```

---

## 1. What this codebase is

Nana Wallet (Aleph Hackathon 2026, WDK Track): an Argentine agentic wallet for
older adults. The user speaks or types a money request, reviews a preview
(amount, network, recipient, fee), and explicitly confirms before funds move.

Monorepo with two strictly separated halves:

| Part | Path | Stack |
|---|---|---|
| Backend | repo root (`src/`) | Node 22, Fastify, LiveKit Agents, Privy, Supabase/Postgres, Vitest |
| Frontend | `apps/nana-wallet/` | React 19, TanStack, Tailwind 4, Capacitor 8, livekit-client |

**Hard rule**: the halves never import each other. The HTTP contract is
duplicated on purpose (`src/contracts/http.ts` and
`apps/nana-wallet/src/lib/api-types.ts`). If you change the contract, change both.

Read `AGENTS.md` at the repo root before writing code. It has the mandatory
validation commands and the two-stage workflow.

---

## 2. The single configuration

This branch converted the deployment to **Solana devnet only**. There is exactly
one configuration and no fallbacks:

```
WDK_NETWORK=solana-devnet
WDK_TOKEN=SOL
```

Deleting the EVM/Arc path was the whole point of this branch. If you find
yourself adding a chain switch, a network default, or an "if EVM then…" branch,
you are undoing the refactor. `walletChainFamilyForNetwork` **throws** for
anything that is not `solana-devnet`; that is deliberate.

Removed and must stay removed: `WDK_TOOLS_SOURCE`, `IDENTITY_PROVIDER`,
`DEMO_USER_ID`, `WDK_ALLOWED_RECIPIENTS`, `WDK_MAX_TRANSFER_AMOUNT`, the local
transfer-policy gate, `CircleArcProvider`, the `live` WDK signing path, Nan,
ElevenLabs.

---

## 3. How to run it

### Docker (Colima, not Docker Desktop)

```sh
colima start
cd /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational
docker compose -p nana-privy-impl \
  -f compose.privy-local.yaml \
  -f compose.privy-local.ports.yaml up -d
```

Services: backend `127.0.0.1:32800`, frontend `127.0.0.1:32802`,
LiveKit `127.0.0.1:17881`, db `127.0.0.1:5432`.

`compose.privy-local.ports.yaml` is a **local, untracked override** that pins
those two host ports. The base compose file deliberately publishes them as
random (`127.0.0.1::3000`, `127.0.0.1::80`), so treat the pinned numbers as this
machine's convention, not the repo's. It is **not** in `.gitignore` — it is simply
never committed. Recreate it if it is missing:

```yaml
services:
  backend:
    ports: ["127.0.0.1:32800:3000"]
  frontend:
    ports: ["127.0.0.1:32802:80"]
```

Everything else about LiveKit comes from the base compose file; this override
pins ports and nothing more.

### Two frontends, mutually exclusive

`LIVEKIT_BROWSER_URL` is a single value, so web and emulator cannot both work at
once. Choose one:

**Web** (default, currently active):
```
LIVEKIT_URL          ws://livekit:7880                     (backend + worker)
LIVEKIT_BROWSER_URL  wss://nana-privy.localhost/livekit    (returned to browser)
```
Open `https://nana-privy.localhost` (portless proxy on 443, CA already trusted).
An https page cannot open a `ws://` socket — mixed content — so `wss://` is
required here.

**Android emulator**: override the backend to
`LIVEKIT_BROWSER_URL: ws://127.0.0.1:32802/livekit`, then
```sh
adb reverse tcp:32802 tcp:32802   # page + signaling
adb reverse tcp:17881 tcp:17881   # media, ICE-TCP
```
The installed APK bakes `server.url=http://127.0.0.1:32802`, so **no APK rebuild
is needed** when only the served web bundle changes.

### The worker compiles its own `dist`

```
command: ["npm run build && exec node dist/livekit/worker.js dev"]
```

**Restarting the backend does NOT update the worker.** After changing anything
under `src/livekit/` or `src/agent/`:

```sh
docker restart nana-privy-impl-voice-worker-1
# wait for the compile, then VERIFY inside the container:
docker exec nana-privy-impl-voice-worker-1 \
  grep -c "<some-string-from-your-change>" /app/dist/<built-file>.js
```

A fix that is not deployed where the code runs is not a fix. This already cost
one debugging round in this session.

---

## 4. What was fixed in this session

Six defects, each found by reproducing, not by reading. All committed.

| Commit | Defect |
|---|---|
| `49d55ac` | Balance reader defaulted to the **fixture** source with an empty map → `503` on every balance read, for every user. The screen showed a leftover demo string. |
| `913b961` | `getFeeForTransferMessage` compiled a message with **no `recentBlockhash`** → `compileMessage()` threw on every call → **no transfer could ever be previewed**, in text or voice. |
| `2c2c7e2` | `search_recipients` asked "is this the contact?" for a single candidate while `confirm_transfer` fired on a user "yes" → the model read the contact answer as the transfer confirmation and skipped `send_token`. |
| `0c70380` | Confirmation was a **closed list of exact sentences**: "dale", "listo", "ok", "de una", "confirmá" all refused, and a bare "no" cancelled nothing. |
| `0c70380` | An **interrupted read-back was a dead end**: no phrase could ever work and the prompt forbade re-reading. |
| `0c70380` | The assistant narrated the machinery: internal error codes in the prompt, "the server" in copy, English meta refusals on Spanish sessions. |
| `445fbc1` | The read-back called `session.say()`, which **throws on a realtime session** (no TTS model) → every preview marked interrupted → **every confirmation refused forever**. |

### The pattern worth carrying over

Three of those six share one shape: **the test double answered a question the
real implementation could not ask.**

1. Fee quote: the double returned `5000n`; the real adapter threw.
2. Balance: the default was a fixture, so no test noticed devnet was never read.
3. Read-back: the double's `say()` works; the real one throws.

A mock that *answers* cannot discover that production *cannot ask*. When you fix
something, prefer a test that drives the real adapter, even against a fake
transport.

---

## 5. Current state of the confirmation flow

### What the gate is now

`src/livekit/voice-decision-gate.ts` was rewritten. The invariant is:

> An affirmative the user spoke AFTER the preview existed, from an authenticated
> speaker, counted once.

`prepare(previewId, createdAt)` opens the window. `recordTranscript` accepts a
final transcript only when `createdAt > previewCreatedAt`. `consume` returns the
evidence once. That is the whole contract.

**The read-back requirement was removed, deliberately.** It required a nested
`generateReply` to produce an exact sentence, which a speech-to-speech model
does not reliably do. It was also redundant: the preview is persisted and
narrated in the assistant's own turn. The ordering rule is what keeps a "sí"
that answered some *other* question — or a model-invented confirmation with no
user speech — from authorizing a transfer.

Verified in the running container:

```
user says "dale" after the preview      -> confirmed
user said "si" BEFORE the preview       -> refused   (the instruction is not the decision)
model confirms, user never spoke        -> refused   (no user authorization)
"listo" "ok" "de una" "perfecto"        -> confirmed
"no" "dejalo" "cancelá"                 -> cancelled
consumed twice                          -> second refused
```

### Where narration comes from now

The **model narrates the preview in its own turn**, from the tool result. The
worker no longer calls `say()`/`generateReply` for it. `send_token` returns the
three fields the user must hear, plus an instruction to say exactly those:

```
message: "Decile esto al usuario, breve y cálido, y después quedate esperando:
          el monto, la comisión estimada y el nombre del contacto. Preguntale si
          confirma o cancela. No menciones herramientas, redes ni estados internos…"
amount, recipientName, estimatedFee, network
```

This follows the pattern the repo already uses for `get_balance`
(`balanceSpoken`): the tool returns data, the model speaks it.

### Honest status

| Piece | State |
|---|---|
| Preview creation (amount/fee/contact) | Works. Verified against real devnet. |
| Balance read | Works. Real 5.0 SOL. |
| Decision gate | Works. Verified by direct execution. |
| Model narrating the preview | **UNVALIDATED in a live call.** |
| End-to-end voice confirm | **UNVALIDATED.** Not tested since the last change. |
| Tests for the new gate | Gate unit tests rewritten and passing (19). Two other files still fail — §6. |

**The next single step is one live voice call.** Everything else is downstream.

---

## 6. The two failing tests (expected, mid-refactor)

Baseline before this session's last change: **19 failed / 983 passed / 13
skipped (1015)**. The 19 are pre-existing DB-state failures, unrelated to voice.

Current: **21 failed / 997 passed / 13 skipped (1031)** — the same 19 plus these
two, which assert behaviour that was intentionally removed:

**1. `tests/unit/realtime-agent-session.test.ts`**
`allows one re-read when a confirmation is refused for an incomplete read-back`
asserts the instruction string
`"except when a confirmation is refused because the transfer was not read out in
full, in which case call send_token again to read it"`. That instruction is gone
because the re-read mechanism is gone. Delete the test, or repoint it at the new
contract: the model narrates the preview from the tool result.

**2. `tests/unit/realtime-tools.test.ts`**
`send_token delegates the preview to the service and strips the recipient address`
still passes `speakPreview` into `createRealtimeTools`. That dependency was
deleted from `RealtimeToolsDependencies`; the file was patched with `grep -v`
and a stray `speakPreview` reference survived. Check lines ~320–340.

**Also check**: `tests/unit/livekit/voice-decision-transcripts.test.ts` and
`tests/unit/realtime-tools.test.ts` were edited by line-deletion, so verify their
formatting and that no assertion was silently lost.

### The 19 pre-existing failures

All DB-state related, all present before this session. Do not chase them without
confirming they still fail on a clean checkout. Known flake:
`notifications-reconciliation` "starts immediately, runs a pass…" — passes 10/10
in isolation.

```
api-contacts x3, api-conversation-resolution (file), api-conversation-service,
api-conversations, contacts-cross-user, conversation-live-leases,
conversation-preview-claim-race, grant-claim-release 8.4b,
notifications-outbox-dispatcher x2, notifications-outbox x5,
users-db x2, voice-touch-decision-race, wallets-sync x2
```

Test DB:
```
DATABASE_URL='postgresql://postgres@127.0.0.1:55460/wdk_agent?options=-csearch_path%3Dpublic,extensions'
```

---

## 7. Open problem: `broadcast_uncertain`

**Investigate this before trusting any confirmed transfer.**

A live session produced:

```
04:13:02  confirm_transfer -> {"code":"confirmation_required"}   (gate refused)
04:13:15  confirm_transfer -> {"code":"broadcast_uncertain"}     (broadcast attempted, outcome undetermined)
```

and this row was left in the database:

```
conversation ce29f84b-379d-4c44-a6d4-366b64f2ddba
  561beba8… | uncertain | revision 3 | created 04:12:42 | updated 04:13:16
```

The amount was **1 SOL**, and the Privy policy caps a single transfer at
**0.01 SOL**. Money did not move (verified on-chain), but:

**Hypothesis to test**: a Privy policy refusal is being classified as
`broadcast_uncertain` instead of `policy_rejected`. This is the same class of bug
as `b58e668e`/`b4a95b3` from earlier in the branch — a permanent refusal wearing
the costume of an ambiguous outcome, which tells the user to "check your history
before trying again" instead of "this will never work".

The relevant classification lives in `asDispatchFailure` and the
`NotDispatchedCause` mapping. Privy answers a Solana policy denial with **HTTP
400 and a body code `policy_violation`** — an earlier fix taught the mapper to
recognise that; verify it still holds on the broadcast path and not only on the
preview path.

Also unresolved: **a permanent `uncertain` row is a dead end.** Decide what the
user is told and how the state is cleared. Leaving it stuck means the
conversation can never proceed.

Reproduce with: ask for **1 SOL** to any contact (over cap), confirm, then read
`docker logs nana-privy-impl-voice-worker-1` and the
`conversation_transfer_attempts` table.

---

## 8. Known pending items

**Security — user-owned, still open.** Rotate `LIVE_VOICE_BINDING_PRIVATE_KEY`
and the `LIVEKIT_*` keys. Key material was printed to a chat transcript twice in
this session by accident. The user said they would handle it and has not yet.

**`g4-policy-rejected` eval is unsatisfiable in fixture mode.** It expects
`policy_rejected` for an over-cap 5000, but nothing enforces policy in fixture.
Needs `EVAL_REAL=1` and a real wallet. Currently recorded as FAIL in
`evals/voice/realtime/baseline.json`. Decide: retarget, document as real-mode
only, or drop.

**`service.ts:1060` swallows every resolver error.** A `catch {}` with no binding
flattens `wallet_not_ready`, `wallet_config_error` and a genuine outage into
`wallet_unavailable` → "try again in a while". A user whose wallet is not
configured is told to retry something that cannot work. Same class as the
`broadcast_uncertain` problem above.

**Duplicate "La voz no está disponible" on screen.** `start()` runs twice.

**LiveKit Cloud quota exhausted.** The shared project `test-nanna-48u0wazg` hit
`429 connection minutes limit exceeded`, which is why voice now points at the
self-hosted container. If you switch back to Cloud, expect that until the
billing is sorted.

---

## 9. Traps that already cost time here

**The CDP `Log.enable` replay.** Enabling `Log` in DevTools re-emits buffered
entries. It made a stale Cloud error look like a fresh one for several minutes.
To tell "is this new?", read `Network.*` events (no replay) or count requests in
the backend log. The backend log is the judge: zero new requests means the app
did not retry.

**Two caches, not one.** Rebuilding the frontend image is not enough — the
WebView caches the JS. Clear both:
```js
Network.setCacheDisabled({cacheDisabled:true}); Network.clearBrowserCache();
Page.reload({ignoreCache:true});
```

**Absence of a request is evidence.** A tool that failed without any HTTP call
never reached the API, so the fault was local. That single observation is what
located the fee-quote bug after the resolver, the RPC and the emulator were all
ruled out.

**RLS is FORCED** on `conversations`, `conversation_state`,
`conversation_messages`, `conversation_transfer_attempts`. `psql` returns empty
rows without it:
```sql
SET row_security=off;
```

**Audio transcripts are redacted** in logs as `lk.pii.*`, and voice
conversations do not persist `conversation_messages`. You cannot recover what the
user said. Ask them; it is the one input you cannot reconstruct.

**`socket` of the WebView changes on reconnect.** Re-do `adb forward` to
`webview_devtools_remote_<pid>` and all `adb reverse` entries.

**Compare the full suite against a captured baseline, name for name.** Every
regression in this branch was caught that way, never by reading a diff. Changing
the phrase classifier broke `"confirm the transfer"` and `"I confirm"` — four
tests caught it immediately. A `git stash push` is the clean A/B to separate
"my regression" from "pre-existing failure".

---

## 10. Verification commands

```sh
# backend
npm run lint && npm run typecheck && npm test && npm run eval

# frontend
cd apps/nana-wallet && npm run lint && npm run typecheck && npm test
```

Real-mode voice eval (needs a real wallet and `EVAL_REAL=1`):
```sh
EVAL_REAL=1 npm run eval
```

LiveKit smoke against a real deployment (drops test env isolation):
```sh
VI_TEST_AMBIENT_PROVIDER_ENV=1 npx vitest run tests/e2e/livekit-smoke.e2e.test.ts
```

---

## 11. Suggested next order

1. **One live voice call.** Confirm the model narrates amount + fee + contact,
   and that an ordinary "dale" closes it. Nothing else matters until this is seen.
2. Fix the two failing tests (§6) so the suite reports only pre-existing noise.
3. Reproduce and fix `broadcast_uncertain` (§7). Confirm an over-cap request
   reports `policy_rejected`, and decide how a stuck `uncertain` clears.
4. `service.ts:1060` — stop flattening distinct resolver errors (§8).
5. Rotate the exposed keys (§8).

**Do not push.** 35 local commits, branch protection bypassed once already on
`main` in this project. Pushing is the user's decision.
