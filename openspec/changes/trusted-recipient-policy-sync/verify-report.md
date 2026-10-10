# Verify Report: trusted-recipient-policy-sync

**Verifier:** `sdd-verify`, independent post-apply verification (read-only; no production code or test was edited).
**Frozen candidate:** `3fa9de8` — branch `feat/solana-operational`, in sync with origin, worktree
`/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`.
**Authority:** `openspec/changes/trusted-recipient-policy-sync/spec.md`.
**Inputs judged:** `design.md`, `tasks.md`, `apply-progress.md`, `.agent-workflow/.../90-verification.md`,
`.agent-workflow/.../91-test-baseline.md`.

## Summary verdict

**PARTIAL PASS — code and fake-transport behaviour verify; the live provider half is UNPROVEN, and the
change is NOT ready for archive.**

- **44 of 44 checked `[x]` implementation task rows are supported by artifacts that exist**, with two
  checkbox-integrity exceptions recorded below (2.14, 5.4).
- **Every reasonably testable requirement verifies** on code inspection, the pure-guard suites, the
  removal transaction suite, and the session-window suite that I ran myself in this pass.
- **4 unchecked implementation-owned task rows remain** (5.1, 5.2, 5.7, "Freeze the candidate"):
  archive is **blocked**, by contract, until those are either completed or explicitly reconciled as
  non-critical remaining scope.
- **No live-provider proof exists and none could exist in this environment** (`{"capable":false,
  code:"signer_unavailable"}` for both deployed processes). The live provider semantics U1–U4, the live
  `{capable, code}` record, and 5.7's manual devnet verification are **UNPROVEN**, never upgraded.
- **0 regressions.** Baseline comparison at 5.3 is accepted as recorded; the spot-checks I ran
  independently reproduce green.
- **3 CRITICAL, 4 WARNING, 5 SUGGESTION findings.**

Verdict counts: **PASS 18 · PARTIAL 6 · FAIL 0 · UNPROVEN 1** (per-requirement table below).

---

## Requirement verification table

I ran three suites myself (`SPOT-1/2/3`, below); everything else is judged from the code and the
recorded evidence, cited by `path:line` or test name. **No checkbox and no commit message is treated as
evidence.**

Italics in the Evidence column mark what I verified by running or reading myself vs. what I judged from
`90-verification.md`.

| # | Requirement (capability) | Verdict | Concrete evidence |
|---|---|---|---|
| 1 | Single recipient management service and single policy composer (`trusted-recipient-policy-sync`) | **PASS** | `src/wallet/policy/service.ts` is the only mutator; `tests/unit/policy-writer-structural.test.ts` (9 cases) asserts by exact set equality that no file outside `src/wallet/policy/**` + `src/wallet/signer/**` calls `createPolicy`/`patchPolicy`/`addPolicyToSigner`, and that `composeGrantRules` is imported only by `src/wallet/policy/composer.ts`. Screen/text/voice all reach it: `src/api/contacts.ts` (HTTP) and `src/agent/definition.ts:537-555` → same service. Typed refusal for a non-routable path: `PolicyComposerRequiredError` (`src/wallet/policy/composer.ts:42`). Server-owned identity: strict `.strict()` seam asserted by `tests/unit/policy-service-contract.test.ts`. |
| 2 | Invariants preserved through every composition — **10,000,000-lamport ordinary ceiling** and all identity/delegated invariants | **PASS** | `_src/wallet/embedded.ts:30_` `SOLANA_MAX_PER_TRANSFER_LAMPORTS = "10000000"`; composer derives it and *validates rather than trusts* it — `_src/wallet/policy/composer.ts:217-220_` refuses any other cap with `supported: SOLANA_MAX_PER_TRANSFER_LAMPORTS`; `_composer.ts:296_` emits `maxLamports` from the constant. Ordinary rule byte-identical to `buildSolanaEnrollmentRules` and "ordinary cap exactly 10000000" are asserted by `tests/unit/policy-composer.test.ts`. Policy id / canonical signer / unrelated signer / ownership preservation is classified in `src/wallet/policy/readback.ts:352-417` (`blocked_configuration` on attachment or ownership loss) and asserted by `tests/unit/policy-readback.test.ts`. |
| 2a | Adding a contact creates **no** automatic-payment grant | **PASS** | `src/wallet/policy/composer.ts` composes grant rules only from `input.grants` (ledger-derived); the create path never writes the grants ledger. Asserted by `tests/unit/policy-composer.test.ts` ("grant recipients never entering the ordinary allowlist") and by task 2.10's gate (`src/conversations/grant-gate.ts:121-122` forces `not_covered` / `policy_unverified` when state is unverified, so no grant can auto-execute off a bare contact). |
| 2b | Approved delegated limits and expiries not silently changed | **PASS** | Each active grant becomes one rule carrying the ledger's own `max_per_transfer` and stored `expires_at` inside `composer.ts`; `tests/integration/recipient-policy-removal.test.ts` asserts unrelated grants are preserved **byte-for-byte** (`SPOT-2`, 20/20 green). |
| 3 | Consent provenance for the retained baseline (never a remote GET) | **PASS (positive path) / UNPROVEN (live drift repair)** | `_src/wallet/policy/service.ts:24-26_`: `consent_baseline` / `consent_provenance` are captured ONCE from the newest active `signer_grants` enrollment row and never re-derived; a remote read is observed state only. Unknown remote rule → `blocked_conflict` (`src/wallet/policy/readback.ts:266-327`), owner/attachment drift → `blocked_configuration` (`:352-417`). `Test1` provenance converges rather than blocks (`tests/unit/policy-readback.test.ts`, 33 cases). **The live repair of the existing local/remote drift has no live evidence — see UNPROVEN-3.** |
| 4 | Atomic recipient mutation with desired revision and granted-scope revocation | **PASS** | `SPOT-2` `tests/integration/recipient-policy-removal.test.ts` → **20 passed (20), 0 failed, 0 skipped**: injected post-contact-write failure rolls back contact + desired revision + revocations + audits together; last-alias removal revokes the whole grant with its `revoked` audit in the same transaction; a second alias prevents revocation and appends no audit; a multi-address grant is revoked whole, never narrowed; unrelated grants byte-for-byte unchanged; no grant migrated to a replacement address. Provider I/O outside the transaction: task 2.8 requires "No transaction may be open across steps 4–9" (`tasks.md`, task 2.8). Lock order documented once in `docs/architecture.md` §"Wallet policy lock order" (task 1.9) and asserted by `tests/unit/lock-order-vector.test.ts` + `tests/integration/lock-order-concurrency.test.ts` (no `40P01` under two connections). |
| 5 | Cross-process wallet serialization with revision verification | **PASS** | Lease functions in `src/db/migrations/015_recipient_policy_sync.sql:440-470` + `src/wallet/policy/lease.ts` (`acquirePolicyLease`/`renewPolicyLease`/`releasePolicyLease`, bounded wait, token-guarded renew/release, TTL). `desired_revision_at_acquire` is recorded at acquire (`_015_...sql:214_, :457, :468_`) and asserted by `tests/integration/recipient-policy-lease.test.ts:159,175,190`. Stale writer abandoned: apply CAS `UPDATE … WHERE wallet_id = $7 AND desired_revision = $2 RETURNING wallet_id`, zero rows ⇒ intent `superseded` (`tasks.md` 2.8) — asserted by `tests/integration/recipient-policy-apply.test.ts`. `applied_revision` cannot exceed `desired_revision` at the schema level: `_015_...sql:79_ CHECK (applied_revision <= desired_revision)` plus `:82` applied-completeness. Restart recovery from persisted intent: `tests/integration/recipient-policy-reconciler.test.ts` (reclaim after TTL, resume from stored `composed_rules`). |
| 6 | Applied-revision binding for automatic executions (incl. sibling blocking) | **PASS (degradation) / UNPROVEN (live restore)** | `_src/conversations/grant-gate.ts:63-64, 121-122_` force `{mode:"not_covered", reason:"policy_unverified"}` unless the six §4.1 predicates hold — read **after** wallet resolution and **before** `listGrants`; `grant-gate.ts:199` comment: "including siblings bound for other recipients". Claim-side gate: `_src/wallet/grants/consumption.ts:477-493_` opens `… FOR SHARE OF state` on the pre-existing `W0` read and fails the claim on any missing predicate. Asserted by `tests/unit/grant-gate-revision.test.ts` and `tests/integration/grant-consumption-revision.test.ts`. **"A bound policy ID alone is insufficient"** is exactly the same predicate. **The live "verified match restores automatic execution" scenario has no live evidence — UNPROVEN-2.** |
| 7 | Effective status vocabulary and no premature success | **PASS (contract + API) / PARTIAL (browser render)** | The vocabulary is a closed enum: `_src/contracts/http.ts:270-279_` `policyReadinessSchema` (`saved\|not_configured\|pending\|syncing\|applied\|retryable_failure\|blocked_conflict\|blocked_configuration`); the six new error codes are at `_src/contracts/http.ts:287-292_` (`CONFLICTO_POLITICA`, `COMPOSICION_VACIA_NO_SOPORTADA`, `PROPUESTA_OBSOLETA`, …). `applied` is only returned when `verified_at IS NOT NULL AND applied_revision = desired_revision` (`tasks.md` 3.2), asserted by `tests/integration/api-contacts-policy.test.ts` ("never claims an unverified apply"). A pending removal is never announced as verified: `src/wallet/policy/service.ts:589-613` reports `retryable_failure` for a removal, and the browser harness's remove scenario returns `{contact, revocation}` without an `applied` claim. **The *rendering* half is partially unexecuted — see WARNING-2.** |
| 8 | Last-active-alias removal semantics and disclosure | **PASS** | Same suite as #4 (`SPOT-2`, 20/20). Disclosure before mutation: `projectRevocationDisclosure` in `src/wallet/policy/service.ts` + the `revocation_disclosed` audit recorded *before* Phase B; the route returns `revocation.grantIds.length` so the screen can disclose before submitting (`tasks.md` 3.2/3.3; browser harness scenario "edit disclosure pre-flight carries the affected grants" PASS). |
| 9 | Metadata edits never broaden permission; address edits invalidate stale state | **PARTIAL** | Denial is a validation failure, not a merge: `_src/wallet/policy/service.ts:985_` and `:1079_` return `failureClass: "blocked_conflict"` for the metadata/master-rule change and `revocation_set_widened`; asserted by the metadata case in `tests/unit/policy-service-contract.test.ts`. Address-edit invalidation exists in code — `_src/agent/wallet-agent.ts:246_`, `_src/conversations/service.ts:1186_`, `_src/agent/definition.ts:1074_` all re-validate the resolved recipient's address+network and refuse when it changed — but **I did not run the suites that cover the "stale selection/preview invalidated" scenario end to end** (I chose the three briefed suites). Recorded as PARTIAL rather than upgraded. |
| 10 | Empty composition never broadens authority | **PASS** | `_src/wallet/policy/composer.ts:269-270_`: `if (input.emptyComposition !== "proven_deny") throw new PolicyEmptyCompositionUnprovenError(...)`. The stop code is `_src/contracts/http.ts:291_` `409 COMPOSICION_VACIA_NO_SOPORTADA`. Asserted by `tests/unit/policy-empty-composition.test.ts` and `tests/unit/policy-probe-u4.test.ts`. `empty_composition` is a constrained column (`015_...sql:62 CHECK IN ('unproven','proven_deny','unsupported')`), and the representable `unsupported` value is refused exactly like `unproven`. |
| 11 | Unproven provider semantics are explicit stop conditions | **PASS (stop behaviour)** | `src/wallet/policy/probe.ts` implements U1–U4 with typed outcomes; each blocking condition stops as `blocked_configuration` with a named reason (`rule_composition_semantics_unproven`, `signer_attachment_unproven`, `ownership_drift`, `empty_composition_unproven`) and issues no PATCH. The stop is persisted via `recordStop` (typed `failureClass` + `reason`, never message-matched — `apply-progress.md` deviation 2 on the removal unit). Asserted by `tests/unit/policy-probe-u1..u4.test.ts` + `policy-composer-unproven-refusal.test.ts`. **The positive (proven) branches of U1–U4 are live-only and UNPROVEN.** |
| 12 | Immutable action-bound proposal and one-use authorization | **PASS** | `src/conversations/confirmation-arbiter.ts` — pure, I/O-free, typed `ArbiterRefusalCode` set, keyed `{kind: transfer\|contact, actionId, userId, createdAt}` + immutable version (`_confirmation-arbiter.ts:6-19,34_`). `SPOT-1` ran `tests/unit/confirmation-arbiter.test.ts` inside **54 passed (54)**: one window at a time with a typed conflict in **both** opening orders; only the matching key consumes, exactly once, never re-armed; out-of-bound / interim / replaced-proposal / foreign-session / unauthenticated evidence refused; model-supplied ids and turn counters not accepted; contact↔transfer never cross-authorize in either direction. Persisted one-use consume: `tests/integration/contact-action-proposals.test.ts` (exactly-once under two concurrent consumers, expired row not consumable, strict monotonic turn ordinal). |
| 13 | Voice permission creation requires a published proposal and a verified address | **PASS** | `src/livekit/contact-proposal-publication.ts:14-19,49,76,99,124`: persist → await delivery → `UPDATE … published_at = now()` → **only then** `arbiter.open({kind:'contact'})`. `SPOT-3` `tests/integration/livekit-trusted-recipient.e2e.test.ts` → **13 passed (13), 0 skipped**, including "permission creation refused with no bound participant able to receive the card", "window stays closed when the card could not be published", "a spoken name never becomes an address and a paste creates the new version". Verified address source: `POST /v1/contact-actions/:proposalId/address` re-validates canonical base58 and versions the proposal (`src/api/contact-actions.ts`, `tests/integration/contact-action-address.test.ts`). The card targets one participant identity, never the room at large (`destination_identities: [participant.identity]`, `tasks.md` 4.6). |
| 14 | Versioned `/v1` contract with mirrored frontend types | **PASS** | `_src/contracts/http.ts:270-302_` (`policyReadinessSchema`, `state: policyReadinessSchema`, the six codes) mirrored in `_apps/nana-wallet/src/lib/api-types.ts:39_` (`PROPUESTA_OBSOLETA`), `:124,:180` (`permission: ContactPermission`). Asserted by `tests/unit/contracts-recipient-policy.test.ts` (`.strict()` rejects `policyId`/`signerId`/cap/unknown `network`; serialized read payload has no key matching `secret\|key\|signature\|token\|appSecret`; no chain selector) and the frontend `api.test.ts`/`handlers.test.ts`. Both sides typecheck independently (5.3: backend `typecheck` 0, frontend `typecheck` 0). |
| 15 | Two-process capability with contained secrets | **PARTIAL (structural PASS, live UNPROVEN)** | Worker defect fixed: `authorizationSigner` is now passed into the worker's `PrivyServerClient` (`src/runtime/dependencies.ts:213-219`), asserted by `tests/unit/worker-dependencies.test.ts` (positive control first). Secret containment asserted structurally by `tests/unit/policy-signer-compose-structural.test.ts` (no key variable on `frontend`/`backend`/`voice-worker`; no signer service declares `ports:`; both declare `network_mode: service:`) and by `src/wallet/policy/probe.ts`'s boolean/code-only return (`tests/unit/policy-signer-probe.test.ts`). **The live "both processes receive their own signed capability" half is UNPROVEN — see UNPROVEN-1.** |
| 16 | RAM-009 Solana recipient validation on draft, write, and selected-address lookup | **PASS** | `_src/memory/address.ts:43-47_`: `isValidRecipientAddress(value, network)` routes `solana-devnet` to `isValidSolanaAddress` (`_address.ts:11-19_`: `new PublicKey(...)` + `toBytes().length === 32` + `toBase58() === trimmed`, i.e. canonical base58). `_address.ts:26-38_` `resolveRecipientNetwork` resolves an **absent** network to the configured chain so it can never fall through to the EVM regex. Callers switched: draft `_src/memory/service.ts:193_`, write `_src/memory/tools.ts:14`/`:56`, selected-address lookup `_src/agent/definition.ts:366_`, `_src/agent/wallet-agent.ts:246_`, `src/memory/contacts-repository.ts:114,205`. Covered by `tests/unit/recipient-address-solana-validation.test.ts`. Fact memory keeps its separate path and contributes no recipient record. |
| 17 | RAM-005 Confirmed Durable Writes (MODIFIED) | **PASS (recorded evidence)** | Trusted-recipient writes route through `RecipientPolicyService` (`src/wallet/policy/service.ts` `create`/`edit`) and record `desired_revision` — asserted by `tests/integration/recipient-policy-service.test.ts`; the no-local-write guard is part of `tests/unit/policy-writer-structural.test.ts` (no `ContactsRepository` mutation import outside `src/wallet/policy/**` + `src/api/contacts.ts`). Solana canonical-base58 validation is `address.ts` (#16). Judged from `90-verification.md` + code; not re-run by me. |
| 18 | RAM-007 Exact Address Handoff and Compatibility (MODIFIED) | **PASS (recorded evidence)** | Handoff refuses an unversioned or stale selection: `_src/agent/definition.ts:366_` requires `recipient.id === input.recipientId && recipient.version === input.recipientVersion && isValidRecipientAddress(...)`; revalidation before preview/confirm at `src/agent/wallet-agent.ts:246` and `src/conversations/service.ts:1186`. Covered by `tests/unit/recipient-address-handoff.test.ts`. Existing WDK MCP / explicit-address / Sepolia USD₮ / dry-run behaviour unchanged per the structural freeze in `tests/unit/policy-writer-structural.test.ts`. |
| 19 | Delegated execution requires the wallet's verified applied policy revision (`delegated-grant-core`) | **PARTIAL** | Degradation, sibling degradation, and "policy identifier alone is not authority" all verified (#6). The **positive** scenario — "verified match allows covered execution within approved bounds" — depends on a live verified readback and has **no live evidence** (UNPROVEN-2). |
| 20 | Atomic revocation of affected grants on last-alias removal (ADDED) | **PASS** | Same evidence as #4 and #8: `SPOT-2` 20/20 — whole-grant revoke + `revoked` audit in the contact transaction, multi-address grant revoked whole not narrowed, second alias prevents revocation with no audit, unrelated grants byte-for-byte unchanged, no migration to a replacement address. |
| 21 | Privy Solana policy sync driven by the grants ledger (MODIFIED) | **PASS (recorded evidence)** | Composer-only sync: `tests/unit/policy-provisioner-delegation.test.ts` + the exact-set freeze in `tests/unit/policy-writer-structural.test.ts` (only the composer imports `composeGrantRules`). `policy_synced` / `policy_sync_failed` / fail-closed `policyReady: false` scenarios are covered by `tests/integration/privy-policy-sync.test.ts` and `tests/unit/privy-policy-sync.test.ts`. Unverified sync → degrade-closed is #6. |
| 22 | Version-bound recipient lifecycle tools in both agents (`unified-agent-tools`) | **PASS** | `_src/agent/definition.ts:537-555_` declares `stage_trusted_recipient`, `stage_trusted_recipient_edit`, `stage_trusted_recipient_removal`, `confirm_trusted_recipient_action` in the **single** shared definition. `SPOT-1` ran `tests/unit/recipient-lifecycle-tools.test.ts` inside **54 passed (54)**: schema exposes only `proposalId`/`contactId`/`expectedVersion`, rejects a model-supplied address/network/policyId/signer/cap/`confirmationId`/timestamp/turn count, stale version fails closed, ambiguous name asks first. |
| 23 | Single shared tool definition for text and voice agents (MODIFIED) | **PASS** | `_src/agent/definition.ts:82_` `VOICE_ONLY_TOOLS = ['confirm_transfer','cancel_transfer']` is the only permitted divergence. The voice surface is built **from** the definition, not re-declared: `_src/livekit/realtime-tools/create-realtime-tools.ts:92-113_` calls `createWalletAgentDefinition()` and hands it to `toLivekitRealtimeTools(...)`; the module contains no hand-written tool bodies (it only maps deps into `WalletAgentContext`). Asserted by `tests/unit/agent-tool-parity.test.ts` and `evals/agent/tools-parity.eval.ts` (100 %). |
| 24 | Typed per-session confirmation arbiter (`voice-transfer-confirmation`) | **PASS** | `src/conversations/confirmation-arbiter.ts` is per-session, pure, one window, inherited `boundedWaitMs` 2000; `SPOT-1` **54 passed** includes the both-orders collision, one-use consume, no-re-arm, and late-inside-bound cases. |
| 25 | Explicit confirmation is authorized by final user speech (MODIFIED) | **PARTIAL** | The gate now delegates to the arbiter and inherits the final-authenticated-transcript rule; the existing `voice-decision-gate` suite passes unchanged plus the adapter equivalence suite (`tasks.md` 4.4). `SPOT-3` **13 passed (13)** covers authenticated affirmative, foreign speaker, no speech, pre-proposal, expired, delayed-inside-2 s, replay, no re-arm, both collision orders. **The live provider broadcast scenario has no live evidence — UNPROVEN-2.** |
| 26 | Live provider semantics U1–U4, the live `{capable, code}` record, and 5.7's manual devnet verification | **UNPROVEN** | See the UNPROVEN section. Never upgraded: fake-transport output is not live provider proof. |

### The two specific claims I was asked to check myself

| Claim | Verdict | Evidence |
|---|---|---|
| Task 4.1's gate is **genuinely** the chain-aware validator, not a message string | **CONFIRMED** | `_src/memory/address.ts:43-47_` branches on the chain and calls `isValidSolanaAddress`, which constructs a real `PublicKey` and requires a canonical base58 round-trip (`_address.ts:11-19_`). It is the acceptance gate at all three named points: draft `_src/memory/service.ts:193_`, write `_src/memory/tools.ts:14` + `:56`, selected-address lookup `_src/agent/definition.ts:366_`. The EVM regex is reachable only for an explicitly-EVM network; an absent network resolves to `solana-devnet` (`_address.ts:36-38_`). No string comparison is involved. |
| The voice lifecycle tools now reach a **working context** rather than failing closed | **CONFIRMED for wiring; fail-closed is the absent-port default** | `_src/livekit/worker.ts:185_` constructs `createVoiceContactActions({...})` and `_:255_` passes it into `createRealtimeTools(...)`; `_src/livekit/realtime-tools/create-realtime-tools.ts:104-106_` spreads `contactActions` into the `WalletAgentContext` the shared definition executes against. So the voice path holds a real `ContactActionPort`, and the lifecycle tools are reachable. The port is *typed optional* and its absence is documented as fail-closed (`create-realtime-tools.ts:47`: "Absent ⇒ the lifecycle tools fail closed") — a deliberate seam, not the current state. |

---

## Findings

### CRITICAL

**C1 — Four implementation-owned task rows remain unchecked; archive is blocked.**
Exact unchecked lines (`openspec/changes/trusted-recipient-policy-sync/tasks.md`):

```text
- [ ] **5.1 Rebuild and restart the affected services and verify the built markers.** … (line 135)
- [ ] **5.2 Run the signer capability probe against the deployed stack.** … (line 142)
- [ ] **5.7 Perform the manual/live devnet verification the user selected, and report what was not executed.** … (line 156)
- [ ] **Freeze the candidate with normalization complete.** … (line 186)
```

By the verification contract, 5.1/5.2/5.7 and the freeze row are CRITICAL completeness issues and archive
blockers. 5.1 and 5.2 carry honest, well-evidenced closure notes (BLOCKED / partially collected) and 5.7
is deliberately pending; that does not make a clean PASS, and I am **not** returning one.
*Remediation:* complete them once the two prerequisites exist (below), or obtain an explicit
partial-archive decision that names these rows as remaining scope. Do not convert them into `[x]`
without new evidence.

**C2 — The live provider half has no evidence and cannot be produced in this environment.** Both
deployed processes report `{"capable":false,"code":"signer_unavailable"}` — the backend declares no
`PRIVY_SIGNER_URL`/`PRIVY_SIGNER_TOKEN`, and the voice worker's sidecar is reachable but the worker
declares no `PRIVY_AUTHORIZATION_PUBLIC_KEY`. U1–U4 are unproven in all 45 `recipient_policy_state`
rows. Therefore requirements #3 (live drift repair), #6/#19 (verified-match restores auto-execution),
#11 (positive proven branches), #15 (live two-process capability) and #25 (live provider broadcast)
have **no live proof**. This is an acceptance-blocking *evidence gap*, not a code defect: the fail-closed
behaviour is correct and proven, and an unproven deployment refuses rather than assumes.
*Remediation:* supply `PRIVY_SIGNER_TOKEN` and a key file at `PRIVY_SIGNER_KEY_DIR`, rebuild, apply
`015` to the stack DB, re-run 5.1/5.2, then collect U1–U4.

**C3 — The deployed stack does not match the declared compose services, so 5.1 cannot be satisfied by a
rebuild.** The running signer is `nana-privy-impl-authorization-signer-1`, a service that appears **nowhere**
in `compose.privy-local.yaml`'s git history (`git log -S'authorization-signer' -- compose.privy-local.yaml`
is empty); it was created from an out-of-tree override ~1.5 h before `f4aa2ae` introduced
`backend-signer`/`voice-worker-signer`. The declared services do not exist as containers, and the stack's
DB (`nana-privy-impl-db-1`) has no `recipient_policy_state`, `contact_action_proposals` or
`recipient_policy_leases` (`to_regclass` → NULL). A code-only restart would run pre-`015` schema against
new code and would destroy the only working signer (namespace-coupled to `voice-worker`). The task's
decision not to restart was correct.
*Remediation:* reconcile the compose declaration with the running stack (either declare the
authorization-signer service in-tree or recreate the declared sidecars), then re-run 5.1.

### WARNING

**W1 — Task 2.14 is checked `[x]` on evidence that does not support half of it.** Its own closure note
says the suite half passed but "**the live capability probe is PENDING, not collected**" and defers it to
5.2, which is still `[ ]`. The task text requires the probe "executed against the live local stack and its
`{ capable, code }` recorded". The checkbox overstates the evidence; the note is honest, the `[x]` is not.
*Remediation:* either split 2.14's checkbox so the probe half is visibly pending, or annotate the `[x]`
with "suite half only — probe collected at 5.2".

**W2 — 5 of 25 browser E2E scenarios were never executed, and 5.4's deployed-stack half did not run.**
`SCENARIOS: 25 PASS: 20 FAIL: 0 BLOCKED: 5`; all five blocked ones are the authenticated browser flow
(the frontend attaches only `usePrivy().getAccessToken()` and no Privy credentials exist → the API answers
401 and the recipient surface never renders). So the "no premature *rendering* of `habilitado`", "the
address edit shows the disclosure before submitting", and "no chain picker in the form" assertions are
implemented but unobserved. 5.4's `[x]` is defensible because the task text permits recording unexecuted
steps with their blocker — but the deployed half is blocked by 5.1 and this is not a pass.
*Remediation:* run the five scenarios with a real Privy session against a rebuilt stack.

**W3 — The parallel full-suite run is materially redder than its baseline, and two failures are not
timeouts.** `12 failed` vs the baseline's `6 failed`. Five reproducible pristine failures kept identical
messages (good), and every one of the seven non-baseline failures passed in isolation — but N2
(`api-contacts-policy` expected 409 to be 201) and N7 (`notifications-reconciliation` 0 >= 1) are
assertion failures explained as "contention", not by a timeout. That explanation is plausible and
isolation-clean (9/9, 10/10), yet it is inference rather than proof: nothing isolates the specific
competing resource for N2/N7 the way the 5 s/15 s family is isolated. The 5.3 verdict of "0 regressions"
is therefore **accepted with this caveat**, not endorsed unconditionally.
*Remediation:* record what competes for N2 and N7 (which connection/serialization the suite shares) or
re-run the parallel suite with the change's policy suites excluded and show the count drops to baseline.

**W4 — W1-and-provider-I/O is correct here, but the spec sentence it sits under is stronger than the
implementation's own wording.** The spec forbids "no database lock … held open across the remote call".
The lease is *not* held as a database lock: acquisition is a single upsert that commits and releases its
row lock immediately (`src/db/migrations/015_recipient_policy_sync.sql:440-470`, called at
`src/wallet/policy/lease.ts:129` as a plain `SELECT lease_token FROM acquire_recipient_policy_lease(...)`),
so holding the *lease token* across provider I/O is a lease, not a held lock, and the composer/apply
sequence keeps no transaction open across steps 4–9. That resolves the deviation in the spec's favour.
The residual risk is documentation, not behaviour: a reader of `apply-progress.md` sees "the removal holds
`W1` outside the transaction" and can misread it as a held lock.
*Remediation:* state in `docs/architecture.md` §"Wallet policy lock order" that `W1` is a token/TTL lease
whose row lock is released at acquisition, explicitly distinguished from `L1..L5`, which are never held
across provider I/O.

### SUGGESTION

**S1 — `status_detail` merge semantics accumulate keys.** `setPolicyStatus` now merges
(`COALESCE(status_detail,'{}') || $5`) instead of replacing (`apply-progress.md`, task 2.9 unit). This is
the right call and consistent with design §11 naming `status_detail` as the recording site, but a
transition that wants to *clear* a key must now pass that key explicitly as `null` (the record itself says
so). *Remediation:* keep that note next to `mergePolicyStatusDetail` in `src/wallet/policy/repository.ts`.

**S2 — `RECIPIENT_POLICY_WRITER=frozen` reuses the `unavailable` port arm.** `src/wallet/policy/service.ts:431`
documents that `frozen` returns the `unavailable` arm of `PolicyApplyPort`. It does not contradict the
spec's vocabulary (2.13 requires every surface to report the frozen state), but `unavailable` already means
"no provider capability", and an operator conflating the two could misdiagnose a deliberate freeze as an
outage. *Remediation:* carry the frozen state as its own `reason` on the returned arm so the surface can
distinguish intent from failure.

**S3 — Publication exists at two sites by design.** The voice worker publishes in-process
(`createVoiceContactActions`, `src/livekit/worker.ts:185`) and the HTTP route publishes through the server
SDK (`createOptionalContactCardPublisher`, `src/api/contact-actions.ts:15`), both to the same
`contact_action_proposal` topic with a bound identity. Consistent with §8.1/§8.3 (the route must
re-publish the corrected version), and both paths are covered by tests. *Remediation:* none now — the
record already names this pair as the thing to unify should a third caller appear; keep it that way.

**S4 — The edit path refuses where removal aborts-and-retries.** Removal runs a 3-attempt abort-and-restart
guard on a widened revocation set and then reports `blocked_conflict` with `revocation_set_widened`;
`edit` refuses immediately. Neither contradicts the spec (the spec requires a metadata edit whose
recomposition changes the rules to be a `blocked_conflict` validation failure, and requires the removal's
disclosed set to be the set it affects). The asymmetry is a design-level choice worth recording.
*Remediation:* add one line to `docs/architecture.md` stating that the retry budget belongs to the
revocation set only.

**S5 — Eval coverage is reported at file granularity, and one file is not at 100 %.** `wallet-agent.eval.ts`
scored **98 % of 18**, so at least one case is below 1.0 and `evalite` does not name it. Not a blocker
(threshold 0 %, exit 0, `evals/agent/recipient-lifecycle.eval.ts` and `tools-parity.eval.ts` both 100 %),
but the change's own new text assertions are partly weaker than the voice half (the text refusal wording
is asserted through the fail-closed definition path rather than a real port, recorded as deviation 1 of
task 4.9). *Remediation:* report per-case outcomes for `wallet-agent.eval.ts`, or wire an eval-visible text
port so the text wording assertion is not tautological.

**S6 — `tasks.md` still prescribes `docker compose up -d db`, which is broken in this worktree.** `DB_HOST_PORT`
is in neither `.env` nor the shell, so the literal command recreates the DB onto port 5432 and fails
(`Bind for 127.0.0.1:5432 failed`, container left `Created`). It was correctly restored with
`DB_HOST_PORT=55470 docker compose up -d db` and the named volume survived. *Remediation:* change the
command in `tasks.md`/`AGENTS.md` to `DB_HOST_PORT=55470 docker compose up -d db`, or set `DB_HOST_PORT` in
`.env`.

**S7 — A stale intermediate record survives in `apply-progress.md`.** Task 4.9's block says "**NOT
STARTED (budget cap reached)**", while the checkbox is `[x]`, the eval file exists
(`evals/agent/recipient-lifecycle.eval.ts`) and the work unit is committed at `7f53919`
(`test(evals): prove the recipient lifecycle surface in both agent contexts`). The later record and the
commit govern; the earlier block is a leftover. *Remediation:* add a one-line forward pointer to the 4.9
record so a reader does not stop on the stale "NOT STARTED".

---

## Declared deviations assessment

| # | Declared deviation | Consistent with the authority? | Evidence / reason |
|---|---|---|---|
| D1 | **`W1` held across provider I/O** | **CONSISTENT** (with a documentation caveat — W4) | `W1` is acquired outside the transaction (`apply-progress.md`, task 1.7: "the chain, exactly as §1.3 specifies for removal. `W1` is acquired OUTSIDE the …"); no transaction is open across §3.5 steps 4–9 (`tasks.md` 2.8). The lease is a token/TTL row, not a held database lock — acquisition is one upsert that commits (`015_recipient_policy_sync.sql:440-470`), consumed as a plain function call at `lease.ts:129`. Spec forbids holding a **lock** across the remote call; that is not what happens. Deviation is a naming/documentation risk, not a semantic contradiction. |
| D2 | **`status_detail` merge replaces replacement semantics** | **CONSISTENT** | Design §11 names `status_detail` as the probe-recording site; replacement semantics would let an intervening status write destroy a U1 probe result (`apply-progress.md`, task 1.7: "`setPolicyStatus` REPLACES `status_detail` … a U1 probe result … is destroyed"). Merging *is* what the requirement needs; the slice-1 assertion that pinned replacement was updated deliberately with a cross-user denial as its positive control (`apply-progress.md`, task 2.9 unit, `tests/integration/recipient-policy-repository.test.ts`). Residual caveat S1. |
| D3 | **Address-replacement retirement** | **CONSISTENT** | Spec: "No grant is migrated to a replacement address… grants for A are retired under the approved semantics." The removal transaction retires A's grants under last-alias semantics and never rewrites them to B — proven by the byte-for-byte comparison in `SPOT-2`/`tests/integration/recipient-policy-removal.test.ts`. |
| D4 | **Frozen writer reported as `unavailable`** | **CONSISTENT — but flagged (S2)** | `src/wallet/policy/service.ts:431` (`frozen` returns the `unavailable` arm) plus 2.13's requirement that every surface report the frozen state. No spec requirement names a distinct frozen state, so this does not contradict the authority; it risks operator confusion between intent and outage. |
| D5 | **Edit path refuses where removal aborts-and-retries** | **CONSISTENT — but flagged (S4)** | The spec requires a metadata edit that would change the rules to be a `blocked_conflict` validation failure (service.ts:985) and requires removal to abort when the affected set widens under lock (service.ts:1027, `revocation_set_widened`). Both behaviours match; only the asymmetry in retry policy is a design choice. |
| D6 | **Two publication sites** | **CONSISTENT** | Spec §8 governs "the proposal card is published to the bound authenticated conversation UI" and 4.7 requires the corrected version to be re-published. The two sites (worker in-process, HTTP route via server SDK) both target the one topic and both resolve a bound identity, and both are covered by tests. Note the record names this pair for future unification if a third caller appears. |

No declared deviation contradicts the spec or the design. Two of them (D2, D5) were paired with a
recorded, deliberate update to an older assertion; in both cases the *new* assertion is the stricter one.

---

## UNPROVEN (recorded, never upgraded)

The following cannot be proven in this environment. **Fake-transport output is not live provider proof**
and is not counted as such anywhere in this report.

| ID | Unproven | Exact prerequisite to prove it |
|---|---|---|
| UNPROVEN-1 | The live two-process capability: both `backend` and `voice-worker` obtaining their own signed-authorization capability, and the recorded `{capable, code}`. Recorded state: `{"capable":false,"code":"signer_unavailable"}` for **both** processes (5.2). | `PRIVY_SIGNER_TOKEN` with a value, a key file at `PRIVY_SIGNER_KEY_DIR`, `PRIVY_AUTHORIZATION_PUBLIC_KEY` declared on `voice-worker`, the declared `backend-signer`/`voice-worker-signer` sidecars created and up, then re-run 5.1 → 5.2. |
| UNPROVEN-2 | Live provider semantics **U1–U4**: (U1) several ALLOW rules coexist as a union; (U2) the canonical signer attachment asserted by a signed readback; (U3) the provider's behaviour on an ownership conflict; (U4) empty/deny composition observed as a signed denial. Consequence: requirements #3 (live drift repair), #6/#19 (verified match restoring auto-execution), #11 (positive proven branches), #25 (live provider broadcast) have no live proof. | A deployment whose `canSignAuthorizations()` is `true`, plus devnet budget and a signed-send capability bound to the probe policy. U4's step (iii) additionally needs a user-authorized wallet action. |
| UNPROVEN-3 | Repair of the existing local/remote drift (the `Test1` case) through the reconciler against the real remote policy. | Same as UNPROVEN-2, plus a wallet whose persisted allowlist/`policy_hash` actually disagree with the remote policy. |
| UNPROVEN-4 | Task 5.7's manual devnet verification: screen and agent add/edit/remove with a signed remote GET proving inclusion/removal while the ordinary cap, delegated limits, canonical signer attachment and unrelated signer stay byte-identical. | (a) The change owner names the exact devnet recipient (none was named; the task forbids inventing one); (b) a deployment whose `canSignAuthorizations()` is `true`. **No live step was attempted: no live recipient was created, `Test1` was not removed, no policy was written, and no money moved — including the permitted ≤ 0.01 SOL path.** |

---

## Verification commands run in this pass

| Run | Command (worktree root) | Result |
|---|---|---|
| **SPOT-1** | `npx vitest run tests/unit/recipient-lifecycle-tools.test.ts tests/unit/confirmation-arbiter.test.ts tests/unit/policy-readback.test.ts` | **exit 0** — `Test Files 3 passed (3)`, **`Tests 54 passed (54)`**, 657 ms |
| **SPOT-2** | `npx vitest run tests/integration/recipient-policy-removal.test.ts` | **exit 0** — `Test Files 1 passed (1)`, **`Tests 20 passed (20)`**, 1.12 s |
| **SPOT-3** | `npx vitest run tests/integration/livekit-trusted-recipient.e2e.test.ts` | **exit 0** — `Test Files 1 passed (1)`, **`Tests 13 passed (13)`**, 1.71 s |

Run as **three separate invocations**, sequentially, as instructed (the policy suites serialize on one
demo wallet's `W1` lease). `SPOT-3` emitted a pre-existing non-fatal maverick
`objc[44408]: Class GNotificationCenterDelegate is implemented in both …/libvips-cpp.8.18.3.dylib and
…/libvips-cpp.8.17.3.dylib` from `@livekit/agents`' bundled `sharp` — workflow noise, unrelated to this
change, and the suite still passed 13/13.

**Database:** the worktree DB was already `Up (healthy)` at `127.0.0.1:55470->5432/tcp`
(`colloseumfeat-solana-operational-db-1`). I did **not** run `docker compose up -d db` and did not need
the documented `DB_HOST_PORT=55470` workaround. No container was created, recreated, restarted or
removed by this pass; no migration was applied.

### Spot-checks NOT run (why)

| Skipped | Reason |
|---|---|
| `tests/unit/policy-composer.test.ts`, `policy-composer-hash.test.ts`, `policy-empty-composition.test.ts` | Directly affected by #2/#10 but outside the briefed three-suite list; their claims are judged from the code (`composer.ts:217-220,269-296`) and from the 5.3 recorded run. |
| `tests/unit/policy-service-contract.test.ts`, `policy-writer-structural.test.ts`, `policy-provisioner-delegation.test.ts` | Same: judged from the code and the recorded run. This is why requirement #9 is PARTIAL, not PASS. |
| `tests/integration/recipient-policy-lease.test.ts`, `-repository.test.ts`, `-apply.test.ts`, `-reconciler.test.ts`, `-invalidation.test.ts` | DB integration suites outside the briefed list; judged from `90-verification.md` plus direct reading of `015_recipient_policy_sync.sql` and `lease.ts`. |
| `tests/integration/contact-action-address.test.ts`, `contact-action-proposals.test.ts` | Outside the briefed list; judged from code + the 5.5 isolation re-runs (7/7). |
| The full `npm test` / `npm run eval` / browser E2E / frontend suites | **Deliberately not re-run** — task 5.3 already recorded the full baseline comparison by test name and 5.4/5.5/5.6 recorded E2E and eval results. Re-running them would inflate the budget without adding independent information. |

---

## Review workload / PR boundary

`tasks.md`'s Review Workload Forecast: estimated **~12,000–16,000** changed lines, 400-line budget risk
**High**, chained PRs recommended **Yes**, **Chain strategy `pending`**, "Decision needed before apply:
Yes". Observed against the tree: the change is delivered as **seven explicit PR slices** with per-slice
task ranges and rollback boundaries (`tasks.md`, "PR 1 … PR 7"), and every closed work unit is **one
conventional commit** (5.9; SHAs recorded in `apply-progress.md`). No `size:exception` was requested or
applied and none should be (the forecast explicitly forbids it without maintainer authorization).
The honest overage note ("six of seven slices cannot come under 400 changed lines without breaking a work
unit") is recorded, not hidden.

- **Scope creep: none found.** Every checked task's changes land inside its declared slice boundary, and
  the structural guards (`policy-writer-structural`, `policy-signer-compose-structural`) are themselves
  scope fences.
- **Chain strategy is still `pending`.** Because the delivery is chained, the parent-owned archive step
  cannot fix PR boundaries yet; this is a genuine open decision (finding under CRITICAL-adjacent
  bookkeeping, recorded here rather than as a separate finding).
- **No push, no PR, no remote branch:** `git rev-list --left-right --count
  origin/feat/solana-operational...HEAD` → `0 6` at 5.9; `git status --porcelain -uall` shows the single
  pre-existing untracked `compose.privy-local.ports.yaml`, which this pass also left untouched.

---

## Regression judgement

**0 regressions — accepted, with the W3 caveat.**

- The 5.3 comparison is by **test name**, not by count: 5 of the 6 pristine baseline failures reproduced
  with **byte-identical messages** (`conversation-preview-claim-race` V8.5, `wallets-sync` PEW-013,
  `realtime-agent-session`, `realtime-tool-binding`'s `send_token` case, `realtime-tools`). The one that
  did not reproduce (`api-voice-auth`, 15 s) is inside the documented timing family.
- The 15 s / 5 s timeouts and the two assertion-shaped failures (N2, N7) all passed when re-run alone
  (5/5, 9/9, 7/7, 13/13, 10/10, 4/4). Per the brief, the pristine baseline failures and the 15–16 s
  load-flaky family are **not** regressions.
- **My three spot-checks reproduce green on this tree**, including the two suites that carry the
  change's highest-risk assertions (removal transaction 20/20; session window 13/13) — independent
  confirmation that those behaviours are not baseline noise.
- **Caveat W3 stands:** the parallel run is redder than its baseline and N2/N7 are explained by inference.
  I do not treat that as a regression, and I do not treat the explanation as proof.

---

## Delivery / hand-off state

| Field | State |
|---|---|
| Candidate | `3fa9de8` (branch `feat/solana-operational`), plus this report + an appended `apply-progress.md` pointer |
| Verdict | **PARTIAL PASS** — code/fake-transport verified; live half UNPROVEN; **not archive-ready** |
| Review gate | The two parent-owned rows (`Start or reuse the bounded native review…`, `Run the independent post-apply SDD verification…`) are unchecked and parent-owned. The freeze row is unchecked. No native review receipt exists for this candidate; archive requires `reviewGate.result: allow` only if a review was actually started for this candidate. |
| Blocking prerequisites | (1) `PRIVY_SIGNER_TOKEN` value + a key file at `PRIVY_SIGNER_KEY_DIR`; (2) reconcile the deployed stack with `compose.privy-local.yaml` (declare or recreate the signer services); (3) apply `015` to the stack DB; (4) a real Privy browser session for the 5 blocked E2E scenarios; (5) the change owner names the devnet recipient for 5.7; (6) choose the `pending` chain strategy. |
| Archive readiness | **NOT ready.** 4 unchecked implementation rows (C1) and an unverifiable live half (C2/C3). |
| Next recommended | `sdd-continue` on the blocked prerequisites, or an explicit partial-archive decision by the parent that names 5.1/5.2/5.7 and the freeze row as remaining scope. |
| Secret safety | No `.env` value was read or printed. No token, key, payload, signature or provider credential value appears in any command I ran, in this file, or in the commit. Commands emitted exit codes, counts and test names only. |

---

## Verification contract notes

- **Strict TDD:** explicitly **inactive** — `openspec/config.yaml:12` declares `strict_tdd: false`
  (and `:49` `tdd: false`). I therefore did **not** activate the strict-TDD verification path, and the
  TDD-compliance and assertion-quality checks below are informational only. For the record,
  the units I inspected do carry `#### TDD Cycle Evidence` sections (e.g. task 1.7's honest module-level
  RED, restored and re-run), and task 1.7's report documents six mutations each restored and re-run green
  — the discipline is present even though it was not contractually required of me to certify.
- **Assertion quality (informal, not a strict-TDD audit):** the suites I ran contain no tautologies I
  could see — `policy-readback.test.ts` includes a frozen-input purity case and an A/B on the `Test1`
  drift; `confirmation-arbiter.test.ts` asserts both collision orders and the no-re-arm path;
  `recipient-lifecycle-tools.test.ts` asserts the strict schema rejects model-supplied identifiers.
  `worker-dependencies.test.ts` (inspected in `apply-progress.md`) deliberately observes
  `PrivyServerClient.prototype.canSignAuthorizations` rather than a constructor argument list, with the
  positive control first — that is the right shape.
- **Nothing in this pass mutated production code, tests, migrations, or containers.** The only writes are
  this report and the appended pointer in `apply-progress.md`.
