# Verify report: sns-alias-recipients

Independent post-apply verification (`sdd-verify`) of change `sns-alias-recipients` against its own
approved spec revision (`openspec/changes/sns-alias-recipients/spec.md` — the delta whose revision was
approved by the human).

| Field | Value |
|---|---|
| Change | `sns-alias-recipients` |
| Working root | `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational` (branch `feat/solana-operational`) |
| HEAD at verification | `6d56e9df6e159742ec30caef804eb768bb4f9ac4` — identical to `origin/feat/solana-operational` |
| Authority | `openspec/changes/sns-alias-recipients/spec.md` (delta; RFC 2119; the revised MUST is the human-approved one) |
| Artifact store | `openspec` (file-backed; verified from disk, not from a summary) |
| `actionContext` | `mode: repo-local`, `workspaceRoot` = the worktree above, `allowedEditRoots` = `[<that same root>]` — one authoritative root, matching the hard constraint |
| Strict TDD (config) | `openspec/config.yaml`: `strict_tdd: false` |
| Strict TDD (harness / apply-progress) | **active** (session prompt) and claimed active in every `apply-progress.md` unit |
| Verdict | **PASS WITH FINDINGS — NOT archive-ready** |
| Defect-level CRITICAL findings | **0** |
| Archive blocker | Task 8.2 remains `- [ ]` (recorded external prerequisite) |

## 1. Summary verdict

The implementation satisfies the approved spec revision. Every one of the eight mandatory
compensations M1–M8 is present **in the code**, not merely in the spec text: server-side resolution
only, the address shown and bound to the confirmed version, freeze + provenance before authorization,
drift surfaced and never auto-followed, "does not exist" separated from "could not be reached",
confirm-time re-verification in the design's S10 order, the paste/scan path retained, and `.sns` only
with no fallback. The alias is a label and the resolved address is the authorization in every path
that stores or authorizes. A request-supplied address can only veto. The freeze holds: nothing on the
payment path re-resolves a name or reads the drift record.

I found **no CRITICAL technical defect** — no spec-claimed condition is unimplemented, and the newest
suites are free of the two false-green classes this change has already been bitten by (a negative
control passing on an empty snapshot; an assertion reading a JavaScript argument array instead of the
SQL statement). I did find one **WARNING-level spec gap** (the self-address refusal is vacuous when no
`user_wallets` row is `state='ready'`, while the spec's refusal is unconditional), one **WARNING-level
over-claim** (task 7.3's structural guard is a strong regression alarm over an enumerated file set and
syntactic shape list, not a proof over the whole payment surface), and four further WARNINGs/
SUGGESTIONs recorded below with exact evidence and remediation.

The change is **not archive-ready**: task 8.2 (live devnet evidence) is still `- [ ]`, with an honest,
verbatim blocker. Nothing implies the live path was proven; the recorded live observations are labelled
as one component of it, never as the path.

## 2. Requirement-by-requirement table

| # | Requirement (delta) | Verdict | Evidence checked (behaviour, not a checkbox) |
|---|---|---|---|
| R1 | `trusted-recipient-policy-sync` **ADDED** — *An alias-resolved destination is re-verified before the address is authorized* | **PASS** | Server-side re-resolution on both paths: `create` resolves before the lease/transaction (`src/wallet/policy/service.ts:957-964`, `resolveAliasForCreate` `:1044-1068`); `expectedAddress` is compared once at `:1064` and never read again — the port receives `resolution.address` (`:970-974`), so the client value can only veto. Card path order verified **by reading the code**: `arbiter.waitAndConsume` (`src/livekit/contact-proposal-publication.ts:495`) → `dependencies.reverifyAlias(...)` (`:517-518`) → `dependencies.consume(...)` (`:570`), with the comment at `:510-516` naming S10; the only transaction is the one `consume` opens. Superposition: `recheck.status === "changed"` clears the window, calls `replaceAddress` (`:534`), and re-publishes before the window re-opens (`republishSupersededCard` `:599`). Veto/refusal: `RecipientAliasDestinationChangedError` (`:1067`). No memoization anywhere in `src/wallet/sns/**` (grep for cache/Map/memo returns only the `isValidSolanaAddress` import). Scenarios: unchanged/moved/unreachable/veto all driven by `tests/unit/policy-alias-arm.test.ts` + `tests/integration/recipient-alias-create.test.ts` (extra run, 14 passing within 45) and `tests/unit/contact-proposal-reverify.test.ts` (19 passing with the card-view suite). Note: the `unavailable` record's *location* diverges from design §4.4 (see §5, deviation 1) — the spec does not pin the location. |
| R2 | `trusted-recipient-policy-sync` **MODIFIED** — *Last-active-alias removal semantics and disclosure* | **PARTIAL** | Add path: duplicate is disclosed **and proceeds** — `findActiveContactByAddress` (`src/wallet/policy/service.ts:990`) with `duplicateOf` always stated on `create` (`:1002`, `:1032`); the user-facing sentence names the address as already trusted and states the ability to pay does not change (`apps/nana-wallet/src/features/wallet/AddTrustedRecipient.tsx:493-495`). Self-address refusal: `RecipientSelfAddressError` on `create` (`service.ts:983-984`) and on the address-replacement arm (`:1284-1286`), checked **before** the duplicate disclosure so it is never reported as a duplicate conflict. The paste path for the same address behaves identically (same create arm; `tests/integration/api-contacts.test.ts` green). Removal/whole-grant-revocation scenarios are pre-existing behaviour carried unchanged by the sibling suite (119 passing). **Why PARTIAL:** the refusal only fires when a `state='ready'` Solana wallet exists (`readReadySolanaWallet`, `src/wallet/policy/repository.ts:1492-1509`); with a non-`ready` row carrying the user's own address the comparison is skipped and the contact is created (see W2). |
| R3 | `trusted-recipient-policy-sync` **MODIFIED** — *Voice permission creation requires a published proposal and a verified address* | **PASS** | `contactCreateInputSchema` carries `snsName` only, `.strict()`, no `address`/`network`/`policyId`/`signerId`/cap (`src/agent/definition.ts:113-129`). Resolution happens after the bound-visual-client guard and **before** `supersedeUnpublished`/`actions.stage`, so an unresolvable name leaves no proposal row and no card (`src/livekit/contact-proposal-publication.ts`, task 6.1/6.4 suites). The alias is never the stored target: the stage binds the resolved address to `contact_action_proposals.address` (`$11::text`) and the contact row stores the resolved address (`service.ts:970-974`). Exactly six fields on the resolve response — `observedOwner`/`nameAccount`/`observedParent`/`slot` stay server-side (`src/api/contacts.ts:322-334`). Refusals are typed and distinct: `SNS_FAILURE_HTTP` (`:65`) maps `not_found` → `404 NOMBRE_NO_ENCONTRADO` and `unreachable`/misconfigured → `503 RESOLVEDOR_NO_DISPONIBLE` with an **unwired deployment also failing closed at 503** rather than emulating or 404-ing (`:300-316`). Paste/scan unchanged and no alias provenance written on that arm (`policy-alias-arm.test.ts` asserts the port input object equality plus `"provenance" in written === false`). Evidence: `EXTRA-2` run (43 passing, incl. `recipient-lifecycle-tools`, `agent-tools-parity`, `contact-proposal-publication`, `contracts-recipient-alias`) and `EXTRA-3` frontend run (76 passing). |
| R4 | `recipient-address-memory` **ADDED** — *RAM-010: frozen at add time with recorded provenance* | **PASS** | Provenance written from the RESOLVED value only (`aliasProvenance(resolution)`, `service.ts:861`, wired at `:974`) and read back through `RECIPIENT_COLUMNS` → `ContactRecord` → `contactSchema.alias` (`.strict().nullable()`) → mirrored `ContactAlias` → the list rendering; `tests/integration/contacts-provenance.test.ts`, `tests/unit/contacts-repository-provenance.test.ts`, `tests/integration/api-contacts-alias-field.test.ts` (extras run) green. Address edit clears a stale claim atomically with the address change (`addressChanged ? (input.provenance ?? {}) : …`, task 2.2; mutation-proved M2 in `apply-progress`). Drift is a guarded `jsonb_set` that touches only `{drift}` and never `address`/`version`/status (`src/memory/contacts-repository.ts`, `writeAliasDrift`), so a name that later resolves elsewhere never updates the stored address; a concurrent address/provenance edit makes the write a no-op reported `unavailable`/`contact_changed`. The composed allowlist is built from `recipients.address` (`composer.ts:252-277`) and carries only the **membership** map (`ComposedProvenance`), never the contact provenance — so the drift state refuses nothing (see §7 for the structural caveat). Evidence: `tests/integration/recipient-drift.test.ts` + `tests/integration/api-contact-check-alias.test.ts` (10 passing) and the behavioural claim that a drifted contact is still selected by the same address predicate. |
| R5 | `unified-agent-tools` **MODIFIED** — *Version-bound recipient lifecycle tools in both agents* | **PASS** | One shared definition, both surfaces compared (`tests/unit/agent-tools-parity.test.ts` green in EXTRA-2); the strict schema refuses an `address`, a resolved address, a model-inferred address, a network, a policy id, a signer and a cap by `unrecognized_keys` while accepting `snsName`; a failed resolution produces a typed refusal with **no** proposal and **no** `publishData`; the name is never accepted on the confirm schema (`contactConfirmInputSchema`, `definition.ts`). Stale version fails closed (`matchesCurrent` + consume predicate; `contact-proposal-reverify` cases). Mutations route through the recipient management service — `createVoiceContactActions` has exactly one production call site feeding both surfaces (`src/livekit/worker.ts:185`), asserted by the parity suite and by the eval harness. **Not re-run by me:** the ambiguous-reference ("ask which contact") scenario lives in the untouched pre-existing `recipient-resolution` surface; it is unchanged by this delta and its clause was not edited, so I did not re-run it (recorded here rather than implied). |

Verdict counts at requirement granularity: **4 PASS, 1 PARTIAL, 0 FAIL, 0 UNPROVEN** (plus the standalone
UNPROVEN items in §6, which are evidence gaps rather than requirement verdicts).

## 3. Findings

### CRITICAL — completeness (archive blocker), **not** a defect

**C1. Task 8.2 remains unchecked, so the change is not archive-ready.**
Exact line, `openspec/changes/sns-alias-recipients/tasks.md:158`:

```text
- [ ] **8.2 Attempt the live devnet alias evidence and record the exact blocker if it cannot run.** With a **dedicated/keyed `SNS_RPC_URL`** (design §10.2 N1 — a prerequisite, not an assumption: the keyless default returns `Connection rate limits exceeded` on every call in a burst), add `sophie.sns` through the real screen and through the agent, verify the card shows the resolved `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2`, observe the three-state reverse line, run one explicit `check-alias`, and assert from the database that `recipients.address` and `applied_rules_hash` are unchanged by the drift report. Booleans, addresses and names only: **no** secret, key, seed, token or signature value in any output or evidence file. **Stop condition:** if no dedicated endpoint is available, the task stays `[ ]` and the blocker is recorded verbatim instead of being narrated as a pass; nothing live is implied. **Verify:** the recorded evidence, or the recorded blocker. <!-- sdd-owner: implementation -->
```

I checked the blocker is **honest**: `SNS_RPC_URL` and `SOLANA_DEVNET_RPC_URL` are both unset, so
`readSnsTransportConfig()` resolves to the keyless public endpoint; the recorded live attempt is
labelled as the resolution half only ("It is not presented as live proof of 8.2"), with no screen/agent
added, no card published, no `check-alias` run and no readback taken. **No implied pass exists anywhere
I looked.** This is a recording-correct pending state, and it still blocks archive: archive is not ready
until 8.2 runs or the maintainer explicitly accepts a partial archive.

### WARNING

**W1. Task 7.3's structural guard proves the property over an enumerated file set and a syntactic shape
list — it is not a proof over the whole payment surface.**
Evidence: `tests/unit/sns-no-payment-path.test.ts`.
- `PAYMENT_PATH_FILES` walks only `src/conversations/**` and `src/wallet/grants/**`; everything else is
  hand-listed (`composer.ts`, `apply.ts`, `readback.ts`, `contact-actions.ts`, `api/conversations.ts`,
  `agent/*`). `src/wallet/solana-devnet-provider.ts` — the module that actually signs/sends — plus
  `src/wallet/provider.ts`, `src/wallet/user-wallet.ts` and `src/livekit/worker.ts` are **not covered**.
  A `resolve` added there is invisible to the import/`.resolve(` assertions.
- `RESOLVER_IMPORT` (`/from\s+["'][^"']*(?:wallet\/sns|\/sns\/|\.\.\/sns\/)/`) misses `await import(...)`
  and any re-export indirection (`export * from "./sns/resolver.js"` re-imported elsewhere).
- The "exhaustion" pin keys on the **receiver name** (`RESOLVER_CALL` = `resolver|aliases . resolve|reverseLookup`),
  so a differently-named holder escapes it.
- `DRIFT_KEY_READ` misses `provenance?.drift`, `const { drift } = provenance`, computed keys and spaced
  SQL (`provenance ->> 'drift'`).
What it *does* prove, and it is worth keeping: the detectors fire on the exact violating shapes and not
on the benign ones (positive control first), the walked trees cannot be outgrown by adding a file, and
the composition path is pinned to stored addresses. See §7 for the honest assessment requested.
**Remediation:** assert over `src/**` minus an explicit allowlist (or walk `src/wallet/**` and
`src/agent/**` too) and detect the import through the TypeScript AST rather than a regex; add
`src/wallet/solana-devnet-provider.ts` and `src/livekit/worker.ts` to the covered set today.

**W2. The self-address refusal is vacuous without a `state='ready'` Solana wallet, while the spec's
refusal is unconditional.**
Spec: "Independent of any duplicate, an address that is the user's own wallet address MUST be refused
with a typed error, on every surface that creates or replaces a trusted recipient", with no state
qualifier. Code: `readReadySolanaWallet` selects `… AND state = 'ready'` (`src/wallet/policy/repository.ts:1492-1509`)
and the guard is `if (wallet && sameAddress(contactInput.address, wallet.address))`
(`src/wallet/policy/service.ts:983`); with `wallet === null` the code proceeds to create the contact
(`:997-1010`). Consequence: a user whose Solana wallet row exists with another state (e.g.
`provisioning`) and an address can add **their own address** as a trusted recipient, with no typed
refusal. The change pins this weaker behaviour deliberately (`tests/integration/recipient-self-address.test.ts`,
"with no ready Solana wallet the comparison is vacuous and the contact is written as saved-not-enabled")
and design §2.5 declares it as an honest boundary — so it is a recorded gap, not a silent one.
**Remediation (either):** compare against the user's own address from any `user_wallets` row for the
chain regardless of `state`, or add the `state='ready'` qualifier to the spec sentence so the
boundary is stated where the requirement lives.

**W3. A security-relevant comment is stronger than the SQL behind it.**
`src/api/contact-actions.ts` comments that an unstamped (unpublished) version is "therefore
unconsumable", but `consumeInTransaction`'s predicate is `id AND version AND status='open' AND
consumed_at IS NULL AND expires_at > now()` with **no `published_at` clause** (found and recorded by the
executor in task 6.2, re-verified here by reading the predicate). The spec's clause ("the window
re-opens only for version *n+1* after it is re-published") still **holds**, because the handle a
confirmation surface and the worker use comes from `readOpen()`, which requires
`published_at IS NOT NULL`, and `republishSupersededCard` opens the arbiter window only after delivery
succeeds (mutation M4 covers it). Pre-existing, not introduced here.
**Remediation:** add `AND published_at IS NOT NULL` to the consume predicate, or correct the comment to
name `readOpen()` as the gate.

**W4. Strict TDD: four cycles obtained RED by reversion rather than RED-first, and two have no RED phase
at all.** Not CRITICAL, because every cycle carries a full `TDD Cycle Evidence` table, the honest
method is disclosed in place, and no failing attribution was claimed without evidence.
- RED-first (strong): U1, U2-slice-1, U3, U4, 5.1, 5.2, 5.3, 6.1, 6.2, 6.3, 7.2.
- Reversion-RED (weaker, disclosed): U2-slice-2, 5.4, 6.4, 7.1.
- No RED (disclosed, mutation substituted): 6.5 (additive eval harness over landed behaviour), 7.3
  (a new structural test cannot be its own RED).
**Remediation:** none required for this change's record; for the next change, hold RED-first on the
confirm-path and drift units, where the reversion-RED units are the two highest-risk ones.

**W5. `keep` on the drift notice is ephemeral local state, so a drift notice is re-shown on every
render/check and a dismissal is never persisted.** This is deliberate and consistent with design §5.4
("the check is user-initiated and drift is re-reported on each explicit check") and with M4 ("never
auto-follows"), so it is not a spec violation; it is recorded as a WARNING because it is load-bearing
judgement about user-visible state that the spec never settles in words.
**Remediation:** state the ephemerality in the spec's drift scenario, or persist a dismissal that
cannot be read as an update of the stored address.

### SUGGESTION

**S1.** The `reverify` outcome (`'verified' | 'unavailable'`) is persisted on the **consumed proposal
row** and has **no read surface** — no endpoint returns it. It is a durable SQL-readable record, which
satisfies "MUST record the re-verification as unavailable", but nothing in the product can show it.
**Remediation:** surface it on the proposal/contact read, or record it where it is readable.

**S2.** `recipient_versions` still snapshots address/name/description/network and **not** provenance
(task 2.6, declined, residual recorded against design §3.1). Nothing else in the change claims the
history preserves provenance, and the pre-existing pin is left unchanged so the decision is visible as
a test. Consistent with the spec (RAM-010 pins the live row); a divergence from design §3.1 that is
recorded rather than hidden. **Remediation:** none required; keep the residual visible at archive.

**S3.** On the drift check, every non-`not_found` resolver failure (`malformed`, `unsupported`,
`ambiguous`, misconfigured) is reported as `unavailable`; only `unreachable` is exercised. The
distinction is preserved where the spec demands it — the *resolve* path returns its own typed code for
each (`SNS_FAILURE_HTTP`) — so M5 holds, but the drift surface's own reported vocabulary is coarser and
partially untested. **Remediation:** add one drift case per non-`not_found` kind, or document the
collapse.

**S4.** The "consumed but not stored" edge remains: if the pre-consume check is `unreachable` and the
later contact-add arm is also unreachable, the affirmative is spent with no contact created (design
§4.4, declared). Nothing is authorized for an unseen address and recovery is a fresh proposal.
**Remediation:** accept explicitly in the spec, or refuse before the affirmative is consumed when the
pre-check is unavailable *and* the add will re-resolve.

**S5.** "Never truncated" is asserted through `className`/exact-text proxies, not geometry (5.4 M6,
6.3 M-C). jsdom cannot measure clipping. **Remediation:** one browser-level visual case, or state the
limit where the requirement is written.

**S6.** The alias arm re-resolves **before** the replay lookup, so a same-key retry after the name moved
is refused `409 SNS_DESTINO_CAMBIADO` instead of replaying the stored intent (5.2, recorded as
deliberate: the retry cannot write the new address under the old key). Consistent with the spec's
fail-closed re-verification; a divergence from design §6's ordering that is recorded. **Remediation:**
none required.

**S7.** Task 8.3 is `[x]` while its own sentence ("this change does not push") is contradicted by the
recorded state — HEAD is in sync with `origin/feat/solana-operational`, and the executor recorded that
discrepancy honestly rather than restating the claim. **Remediation:** reword 8.3 to "the unit commits
only; the parent publishes the branch", so the checked claim matches reality.

**S8.** The final `examples`-style pin for the "unwired deployment" arm is proven twice (unit 5.1 and
the resolve/route suite) but the resolve route's `resolveUserId` authentication is not asserted to be
**non-writing** — the suite proves no *alias* write occurs by table counts, which is the right proof for
the requirement ("performs no database write and creates no proposal"). No action.

## 4. M1–M8 assessment

Each row is a condition claimed in the approved spec revision and bounded by
`.agent-workflow/tasks/sns-alias-recipients/02-design-discussion.md` §1.5. "Code" is where I verified
the behaviour, not where it is described.

| # | Condition (verbatim intent) | Implemented? | Where I verified it |
|---|---|---|---|
| **M1** | Server-side resolution, never a client or model address; the alias is the only input | **YES — full** | `src/api/contacts.ts:281-345` (route resolves; no address accepted), `src/wallet/policy/service.ts:1044-1068` (service resolves), `src/agent/definition.ts:113-129` (`snsName` only, `.strict()`, no address key). The address reaching the port is `resolution.address` (`service.ts:970-974`). |
| **M2** | The resolved address is always shown, verbatim, bound to the immutable version the user confirms | **YES — full** | Card renders `proposal.address` from the persisted row (`ContactActionProposalCard.tsx:213-215` + the three additive alias lines; `tests/unit/contact-action-proposal-alias-view.test.ts` 19 passing). Version binding: `matchesCurrent` rejects any non-current handle (`contact-proposal-publication.ts`, refuse-with-the-open-handle branch) and `consumeInTransaction` matches `id AND version`. Screen renders the address `break-all`, never truncated, with the duplicate disclosure outside the form. |
| **M3** | Freeze + provenance written before the address is authorized; `{source:'sns', name, resolvedAt, resolver}` on the row | **YES — full** | `aliasProvenance()` (`service.ts:861`) written only on the alias arm (`:974`), read back through `RECIPIENT_COLUMNS` → `ContactRecord` → `contactSchema.alias`; the eleven-key object is asserted field-by-field in `tests/unit/policy-service-provenance.test.ts` + `tests/integration/contacts-provenance.test.ts`. The address is validated as canonical base58 by the same path as any recipient (5.2 suite). |
| **M4** | Drift is surfaced and never auto-followed; no re-resolution at send time, ever | **YES — full** | Surfaced: `checkAliasDrift` + the guarded `jsonb_set(provenance,'{drift}')` (`contacts-repository.ts`, `writeAliasDrift`) and the drift notice on the contact row (`ContactAliasDrift.tsx`, `contact-alias-drift.ts`). Never followed: the `SET` clause has no `address`, no revision bump, no recomposition, no grant write — mutation-proved per predicate in 7.1. No re-resolution on the payment path: the drift key has exactly one reader in `src/` (the guarded write) and no payment file matches any resolver call (7.3, with W1's caveat). |
| **M5** | Typed, distinguishable refusals: "does not exist" ≠ "could not be reached" | **YES — full** | `SnsResolveFailure` keeps `not_found` and `unreachable` as separate union members (`src/wallet/sns/resolver.ts:33-39`), `classifySnsReadFailure` never returns `not_found` (`:184-197`), and the route maps them to different statuses/codes (`src/api/contacts.ts:65-101`: `404 NOMBRE_NO_ENCONTRADO` vs `503 RESOLVEDOR_NO_DISPONIBLE`). Mutation M4 in `apply-progress` U1 and the route's mutation each fail **by name** when they are collapsed. The drift surface reports `unavailable` for non-`not_found` failures (S3). |
| **M6** | Confirm-time re-verification; a difference fails closed and supersedes, never silently adopts | **YES — full** | Order verified in code (`waitAndConsume` → `reverifyAlias` → `consume`), fail-closed supersede to *n+1* with `supersedes_id`, `published_at` NULL until re-published, window moved only after delivery, old version never consumed, and the model handed the **new** row's id (`contact-proposal-publication.ts:495-590`). `unreachable` proceeds with the displayed address and records `unavailable`; `not_found`/`ambiguous`/`malformed`/`unsupported` fail closed with a typed code (`unresolvable`) rather than being reported as a change of destination. |
| **M7** | The paste/scan path is retained, unchanged, on every surface | **YES — full** | `tests/integration/api-contacts.test.ts` (3 passing, own run), `tests/unit/policy-alias-arm.test.ts` asserts the paste port input byte-identical plus `"provenance" in written === false`, the repository default `{origin:'user'}` unchanged, `AddTrustedRecipient.tsx` keeps the labelled client-side pre-check and performs no resolution on a base58 value. |
| **M8** | `.sns` only; other suffixes are a typed refusal, never a silent fallback | **YES — full** | `normalizeSnsName` returns `unsupported_tld` with the suffix echoed and no fallback attempt (`resolver.ts:160-176`); `SNS_NETWORKS` is closed with **no mainnet entry** (`:62-68`); unknown network fails closed as `resolver_misconfigured` (mutation M6 in U1). The eval scorer `unsupported_suffix_refused_without_fallback` asserts no address is invented. |

**No condition claimed in the spec is absent from the code.** The only structural weakness found is in
the *proof* of M4's "no payment path resolves" (W1), not in the behaviour itself, which I verified
independently over `composer.ts` / `apply.ts` / `readback.ts` / `api/conversations.ts` (all build or
check only addresses and the membership map) plus the single-reader drift pin.

## 5. Declared-deviation assessment

Every deviation below is recorded in `apply-progress.md`. "Consistent" means consistent with the
authority (`spec.md`); design divergence is called out separately, because the spec is the authority.

| Deviation | Consistent with the spec? | Consistent with the design? | Assessment |
|---|---|---|---|
| **6.4 #1 — the `reverify:'unavailable'` record lives on the consumed proposal version, not (only) on the contact** | **Yes.** The spec says the operation "MUST record the re-verification as unavailable" and does not pin the location; RAM-010's four named keys do not include `reverify`. | **Diverges** from §4.4's stated location. The reason given is sound and checkable: the contact-add arm fails closed with `503` when its own resolution is unreachable, so no contact row exists to carry the record. | **Recorded divergence from design, spec-satisfying.** Residual: the record has no read surface (S1). Not a finding against the spec. |
| **7.1 — drift `unavailable` semantics** (non-`not_found` failures all report `unavailable`; `not_found` reports `changed` + `name_no_longer_exists`) | **Yes.** M5 requires the "does not exist" / "could not be reached" distinction, and the drift surface keeps them distinguishable: `not_found` → `changed` with its own reason, `unreachable` → `unavailable`. Reporting a name that no longer exists as drift is design §5.2, not contradicted by RAM-010. | Consistent. | Consistent; coarseness and partial untested coverage noted as S3. |
| **2.6 — `recipient_versions` does not snapshot provenance (declined)** | **Yes.** No spec requirement puts provenance on the history table; RAM-010 pins the live row and the freeze. | **Diverges** from §3.1's expectation, with the residual explicitly recorded and the pre-existing test left unchanged. | Consistent with the spec; design residual recorded (S2). Nothing in the change claims the history preserves provenance — I checked the claims. |
| **7.2 — `keep` is ephemeral local state** | **Yes.** Design §5.4 governs ("silences nothing permanently"), and M4 forbids auto-following; the spec's drift scenario ends with "the user deciding whether to keep or replace", which an ephemeral choice satisfies. | Consistent. | Consistent (W5 records the unstated state). |
| **2.3/2.5/2.4 — `DIRECCION_PROPIA` and `IDEMPOTENCIA_CUERPO_DISTINTO` added to the seam vocabulary ahead of task 4.1; the contract mirror then mirrored rather than invented them** | **Yes.** Both codes reach the spec's typed refusals through `RECIPIENT_POLICY_ERROR_CODES` (6 → 14) and the route's `409` mapper. | Consistent (ordered differently from the task list). | Consistent; verified in `src/contracts/http.ts` + `tests/unit/contracts-recipient-alias.test.ts`. |
| **5.2 — the alias arm re-resolves before the replay lookup** | **Yes** (fail-closed re-verification). | Diverges from §6's ordering. | Recorded (S6). |
| **2.1 — `request_hash` lands in `017` instead of with the idempotency unit** | **Yes.** Task 2.1 assigns it there; D-C is updated in place. The column is inert but additive and nullable. | Consistent with the updated §15 D-C. | Consistent. Verified: the column is present, nullable, default-less, and written by every keyed intent insert, with the tolerant `NULL` fallback guarded by mutation B. |
| **U1 #1/#2 — the 1.6 dedicated-endpoint prerequisite was not met; the classifier is pinned to the live `"The favourite account does not exist"` string** | **Yes.** Task 1.6's own stop condition governs 1.6 (and was satisfied as recorded); 1.4's stop condition says the classifier keeps `unknown` as its default with no `none` assertion added — honoured, because the recorded shape is now the live one and the design-quoted string maps to `unknown` **and is asserted to**. | Consistent with §1.6's instruction ("only the exact recorded shape maps to `none`"). | Consistent. |
| **2.6 `request_hash` inert / 6.2's `reverify` not carried by either supersede arm** | **Yes.** The widening risk (a half alias claim) is closed by an added refusal, and the freshness refresh is now done by 6.4's seam. | Consistent. | Consistent. |

No declared deviation contradicts the spec. Two diverge from the design and are recorded as such
(§4.4's record location, §3.1's snapshot expectation), each with the residual stated and nothing else in
the change depending on the weaker reading.

## 6. UNPROVEN list with prerequisites

| Item | Prerequisite to prove it | Declaration status |
|---|---|---|
| Live end-to-end alias add through the screen and the agent, card shows the resolved address, three-state reverse line observed, one live `check-alias`, DB readback that `address`/`applied_rules_hash` are unchanged (task 8.2) | A **dedicated/keyed `SNS_RPC_URL`** (a variable change; no code change) | Recorded, verbatim, and `[ ]` — nothing live implied |
| A live `present` reverse state on any network (design N2 / §11 Q1) | A devnet name with a primary domain, keyed endpoint | Unproven; classifier default is `unknown`, no `none` assertion from a real transport |
| The synthetic third 32-byte `class` segment of the header (N4 / §11 Q6) | Real observed bytes; the resolver must never interpret `class` (it does not — it only requires ≥96 bytes) | Unproven; labelled synthetic in the fixture |
| `recipient_versions` provenance | The 2.6 decision reverses | Declined, residual recorded |
| Live screen/agent/card/`check-alias`/readback path | Same as 8.2 | Unproven |
| The no-ready-wallet idempotency branch (§11 Q8) | Pre-existing, out of scope | Unproven, not fixed |
| SDK in-container install cost (N5) and the `--legacy-peer-deps` peer pruning of `@livekit/rtc-node` prebuilds | A later slice that needs the LiveKit rtc path must re-materialise them | Unproven, flagged as a risk in `apply-progress`; `tests/unit/livekit/` green and `node_modules/@livekit/rtc-node` present in this tree |
| `ambiguous` beyond the three derivable conditions (N3 / §11 Q2) | An on-chain shape that is ambiguous for another reason | Unproven; `ambiguous` stays narrow at three, no unexercised branch ships |
| Keyless-endpoint behaviour under burst | Keyed endpoint | Observed not to throttle for 1–2 paced calls only; the burst assumption is untested |

## 7. Regression judgement

**Not a regression** (verified or recorded as pristine): `conversation-preview-claim-race`, the
`wallets-sync` PEW-013 case, `realtime-agent-session`, `realtime-tool-binding`'s `send_token` case,
`realtime-tools`, and the 46-failure combined-invocation contention family (37 timeouts in the
alias/drift/resolve API suites that serialize on one demo wallet's lease, 9 `expected 409 to be …` in
pre-existing contact suites, one `recipients_user_id_users_fk` cleanup race, one
`notifications-reconciliation` assertion) — every one clears when its file is re-run alone, per task
8.1's recorded evidence and consistent with my own separated runs.

**Verified by me in this verification (separated invocations, no combined full-suite run):** see §10.
In particular the two additivity claims were spot-checked rather than accepted: the sibling feature's
suite as the separated nine-file set is **119 passing** — the same count recorded in slices U1–U4 — and
the paste/scan suites pass unchanged.

**`api-voice-auth`:** the one baseline failure that did not reproduce in task 8.1. Fewer failures than
the baseline is not a regression; it was not re-run in isolation to force a verdict and I did not
re-run it either. Recorded as not reproduced, not as fixed.

## 8. Task completion state

| Metric | Value |
|---|---|
| Implementation tasks `[x]` | **28** |
| Implementation tasks `[ ]` | **1** — task 8.2 (`tasks.md:158`), reproduced in full under C1 |
| Parent-owned rows `[ ]` | **2** (`tasks.md:204`, `tasks.md:205`) — byte-for-byte unchanged, not this phase's to tick |
| Archive readiness | **Not ready** — C1 |

Checked directly with `grep -n '^\-\s*\[ \]' openspec/changes/sns-alias-recipients/tasks.md`; no other
unchecked implementation line exists.

## 9. Strict TDD compliance and assertion quality

Strict TDD is **active** for this change (session directive + every `apply-progress.md` unit), while
`openspec/config.yaml` still carries the stale `strict_tdd: false`. Compliance: **PARTIAL**, disclosed
rather than inferred.

1. **`TDD Cycle Evidence` table present** for every unit (U1–U8, 5.1–5.4, 6.1–6.5, 7.1–7.3) — present.
2. **Reported test files exist in the codebase** — every suite named in `apply-progress.md` exists and
   runs green (see §10); no phantom file was claimed.
3. **GREEN still true** — confirmed by running the relevant suites (§10), all passing.
4. **RED discipline** — see W4: four units obtained RED by reversion (disclosed in place), two have no
   RED phase (disclosed, mutation substituted). No unit claims RED evidence it does not have.
5. **Assertion-quality audit** (the "newest suites" class of defect was searched for specifically):
   - No assertion in this change's suites reads a JavaScript argument array — `grep -rn
     '\.values\[[0-9]\|\.args\[[0-9]\|mock\.calls\[[0-9]*\['` over the alias/drift/reverify/provenance
     suites returns **nothing**. The one such defect this change hit (6.1's M-B, where removing an SQL
     binding left the assertion green) was found by mutation and re-anchored to the statement's
     placeholder.
   - The empty-snapshot negative-control class (7.1) was fixed: the suite now provisions a real
     `delegated_grants` row and asserts non-vacuity (`toHaveLength(1)`, `toBeGreaterThan(0)`) before the
     "nothing else moved" claims.
   - Positive controls exist and are placed first in the structural guard, the resolve route, the drift
     route, the idempotency suite and the frontend drift suite.
   - Remaining proxy-only assertions: truncation via `className`/exact text (5.4 M6, 6.3 M-C), and
     `withoutComments` regex guards in 7.3 (W1).
   - No tautologies, ghost loops, type-only assertions or smoke-only tests were found in the change's
     suites.

## 10. Spot-checks run (commands and results)

Every command below ran in the working root, as its own `vitest` invocation (the required four), plus
three clearly-labelled extras. No `npm test` full run was made (task 8.1 established it is
contention noise). All runs: **0 failures**.

| # | Command | Result |
|---|---|---|
| 1 (required) | `npx vitest run tests/unit/sns-*.test.ts tests/unit/sns-no-payment-path.test.ts` (7 files) | **7 files / 62 tests passed** (267 ms) |
| 2 (required) | `npx vitest run tests/unit/contact-action-proposal-alias-view.test.ts tests/unit/contact-proposal-reverify.test.ts` | **2 files / 19 tests passed** |
| 3 (required) | `npx vitest run tests/integration/recipient-drift.test.ts tests/integration/api-contact-check-alias.test.ts` | **2 files / 10 tests passed** (14.35 s, real DB) |
| 4 (required) | `npx vitest run tests/integration/recipient-policy-*.test.ts` (9 files) | **9 files / 119 tests passed** — sibling feature unchanged |
| EXTRA-1 | `npx vitest run --no-file-parallelism tests/unit/policy-alias-arm.test.ts tests/integration/recipient-alias-create.test.ts tests/integration/recipient-self-address.test.ts tests/integration/recipient-duplicate-disclosure.test.ts tests/integration/recipient-idempotency-body.test.ts tests/integration/api-contacts.test.ts tests/integration/api-contacts-alias-field.test.ts tests/integration/livekit-contact-alias-reverify.e2e.test.ts tests/integration/api-recipient-aliases-resolve.test.ts` | **9 files / 45 tests passed** (15.6 s; `--no-file-parallelism` used to avoid the recorded lease contention) |
| EXTRA-2 | `npx vitest run tests/unit/recipient-lifecycle-tools.test.ts tests/unit/agent-tools-parity.test.ts tests/unit/contact-proposal-publication.test.ts tests/unit/contracts-recipient-alias.test.ts` | **4 files / 43 tests passed** |
| EXTRA-3 | `(cd apps/nana-wallet && npx vitest run src/features/wallet/AddTrustedRecipient.test.tsx src/features/wallet/ContactAliasDrift.test.tsx src/features/wallet/ContactActionProposalCard.test.tsx src/lib/api-alias.test.ts)` | **4 files / 76 tests passed** |

**Skipped:** the full `npm test` / `npm run eval` / `npm run lint` / `npm run typecheck` gates (task
8.1's evidence stands and the full run is recorded contention noise); the frontend's whole suite
(grepped, not run in full: 220 passing recorded by 7.2); `tests/unit/recipient-resolution.test.ts` (R5's
ambiguous-reference scenario, unchanged by this delta). The database was **not** started or migrated —
it was already up on `127.0.0.1:55470`.

## 11. Finding I was asked to assess honestly: does task 7.3's structural guard prove what it claims?

**No — it proves a narrower statement, and it says so less loudly than it should.**

What it genuinely proves, and this is real value:
- Over the enumerated file set, no resolver import and no `.resolve(`/`.reverseLookup(` call exist on
  the transfer/preview/compose path — including the two **walked** trees (`src/conversations/**`,
  `src/wallet/grants/**`), which cannot be outgrown by adding a file. This is meaningfully stronger than
  a hardcoded list of paths.
- The drift key is read as a persisted row in **exactly one** module in `src/` and
  `apps/nana-wallet/src/` (the guarded write). That pin is a genuine alarm against a new reader.
- The composer is pinned to stored addresses and to the *membership* `ComposedProvenance`, distinct from
  `recipients.provenance`.
- The detectors are exercised on the violating shapes and the benign look-alikes (`Promise.resolve`,
  `source.resolve`, `require.resolve`, the composer's `provenance[address]`) **before** the negative
  assertions, so a typo cannot silently turn the suite into a no-op. The 7.3 mutation run reintroduced
  each forbidden shape into the real `composer.ts` and each intended assertion failed by name — that is
  the strongest evidence in this unit and it is honest.

Where it does **not** prove the claim:
- The property is universal ("no payment path"), but the file set is partly **hand-listed**, and the
  hand-list omits the module that actually moves money (`src/wallet/solana-devnet-provider.ts`) as well
  as `src/wallet/provider.ts`, `src/wallet/user-wallet.ts` and `src/livekit/worker.ts`. A resolver call
  reintroduced there passes.
- Detection is **textual**, so `await import(...)` and re-export indirection escape the import
  assertion, and the global "exhaustion" pin keys on the receiver's *name*, so a renamed holder escapes
  it.
- The drift-read pattern misses optional chaining, destructuring, computed keys and spaced SQL arrows.

So: a strong, well-designed **regression alarm**, not a soundness proof. It would be defeated by exactly
the change it exists to prevent if that change landed in an uncovered file or behind a renamed seam. The
behaviour it is meant to protect **is** independently satisfied today (verified in §4/M4), which is why
this is a WARNING about the proof's reach rather than a FAIL of the requirement. Remediation in W1.

## 12. Review workload / PR boundary

| Item | Forecast (`tasks.md`) | Observed |
|---|---|---|
| Estimated changed lines | ~4,900–7,200 | Not re-measured in this phase; no unit claims to have shrunk a diff |
| Chained PRs recommended | Yes | Eight work units U1–U8, one commit per bounded slice |
| Chain strategy | `size-exception` | Recorded at the top of `tasks.md` and restated in every `apply-progress` unit; no Gentle-owned `size:exception` PR policy was invoked, because this worktree's standing instruction is no PR |
| Decision needed before apply | Yes | Resolved by the parent before each apply launch (`size-exception`), as recorded in each unit's "Structured status consumed" |

I verified the boundary held rather than trusting it: `git log` shows the recipient work landing as
discrete, outcome-first conventional commits (`7e825eb`, `7f9fceb`, `74ace4e`, `fae5d4d`, `74832d1`,
`fb1fd26`, `0b805ad`, … `6d56e9d`) rather than one accumulated diff. **No scope creep beyond the
assigned tasks was found**: every `src/` module touched maps to a numbered task, and the one declared
mid-unit divergence (6.2's payload half landing in 6.1's commit) is recorded in place with its reason.
`tasks.md`'s four guard lines are present and were resolvable before apply, so the Review Workload Guard
was satisfied rather than bypassed.

## 13. Structured status and `actionContext` findings

- `gentle-ai sdd-status sns-alias-recipients --cwd . --json` reports `artifactStore: openspec`,
  `applyState: blocked`, `nextRecommended: "spec"`, `dependencies.specs: "blocked"`, and
  **`blockedReasons: []`**.
- Cause, verified: `artifactPaths.specs` is `[]` because the dispatcher looks for a `specs/`
  sub-directory while this change keeps its approved delta at the change root as `spec.md` (364 lines) —
  the layout every slice of this change was applied under. Every other artifact resolves
  (`proposal`, `design`, `tasks`, `applyProgress`, `verifyReport`).
- Consequence for this phase: the derived block is a **layout artefact, not a real blocker**. Both
  required inputs (`spec.md`, `tasks.md`) and `apply-progress.md` exist, were read directly from the
  authoritative root, and `blockedReasons` is empty, so verification proceeded. **Recorded as a finding
  for the parent** (`nextRecommended: "spec"` is wrong for an approved, applied change) rather than
  absorbed: the dispatcher's authoritative status for this change is misleading until the change is
  archived into `openspec/specs/`.
- `actionContext`: `mode: repo-local`, one `allowedEditRoots` entry equal to the working root — no
  workspace-planning mode, no ambiguity, and every write of this phase stayed inside it. The untracked,
  user-owned `compose.privy-local.ports.yaml` was neither read, modified nor staged.
- This phase wrote exactly two files: `openspec/changes/sns-alias-recipients/verify-report.md` (this
  report) and an appended pointer in `apply-progress.md`. No production code, no test, no assertion, no
  migration and no contract was changed. No `git stash`/`checkout`/`reset`/`restore`/`clean` was used, and
  nothing was pushed.

## 14. Delivery / hand-off state

| Item | State |
|---|---|
| Branch / HEAD | `feat/solana-operational` @ `6d56e9d` (identical to `origin/feat/solana-operational`) |
| Working tree | clean except the untracked user-owned `compose.privy-local.ports.yaml` and this report before its commit |
| Commits | 20 conventional commits carry the change (`80fdbf6` … `6d56e9d`), one per work unit, plus this report |
| PR | none (by the worktree's standing no-PR instruction) |
| Archive | **not started, and not ready**: C1 (task 8.2) is an open blocker |
| Parent-owned gates | both still `[ ]` and untouched: the bounded native review over each frozen work-unit commit, and the archive step |
| Sequencing dependency | **satisfied and verified**: `trusted-recipient-policy-sync`'s commits (`b3c6a98`, `ce4ea06`, `5c84465`, …) predate every `recipients` commit (`79ba4d0` → `6d56e9d`), so this delta was applied after that block, not ahead of it |
| Host-capability correction | **satisfied and verified**: the revised requirement sits in `trusted-recipient-policy-sync`'s capability block (`openspec/changes/trusted-recipient-policy-sync/spec.md:469`), and the change's artifacts touch nothing in `voice-transfer-confirmation` (grep: only prose that says so) |
| Next recommended | run or formally waive task 8.2, then hand to `sdd-archive` |

**Recommended next step:** obtain a keyed `SNS_RPC_URL` and complete 8.2 (it is a variable change, not a
code change), then archive. If the maintainer prefers to archive with 8.2 open, that is a partial
archive with an externally-blocked live-evidence task and must be recorded as such — this report does
not present the change as fully verified while that line stays `[ ]`.
