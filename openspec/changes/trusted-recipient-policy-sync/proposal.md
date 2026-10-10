# Proposal: Trusted Recipient Policy Synchronization

## Intent and Outcome

Trusted recipient add / edit / remove does not synchronize the solana-devnet Privy policy that authorizes transfers. Today a contact change writes only local persistence (`src/api/contacts.ts`, `src/memory/contacts-repository.ts`) while the attached policy is written by other full-rule writers, so three defects reinforce each other:

- **Missing synchronization.** The policy attached to the wallet keeps whatever recipients it had. Observed evidence: the manual policy update was required before Test1 could receive funds, and `signer_grants.allowlisted_recipients` / `policy_hash` now disagree with the remote policy (`02-research.md`).
- **Competing full-rule writers and lifecycles.** The enrollment builder (`src/wallet/grants/solana-enrollment-rules.ts`) and the delegated policy provisioner (`src/wallet/grants/solana-policy-provisioner.ts`) both replace the complete rule set, and delegated claim / revoke / expiry recomputes can erase each other's contributions. A third contact-only writer would simply be one more loser in that race, and HTTP backend plus voice worker are separate processes, so an in-memory mutex is not enough.
- **Conflated states in UI and agent.** "Contact saved" is presented as permission "enabled", the recipient draft/write path still rejects Solana addresses via `isValidEvmAddress`, and the voice path has no action-bound evidence for a contact change at all.

**Outcome.** One user-scoped recipient management service becomes the single writer of recipient intent; one serialized policy composer per wallet builds the complete attached policy from enrollment plus delegated grants. Desired and applied policy revisions are durable, remote application is serialized across processes, and no screen or agent reply reports "enabled" before a signed remote readback verifies the exact rules and the canonical signer attachment. Screen, text and voice produce the same result through the same service, with one-use confirmation evidence bound to the exact contact action.

## Scope

### In Scope

Implements the five slices of `.agent-workflow/tasks/trusted-recipient-policy-sync/04-structure-outline.md` revision 2 (approved).

1. **Durable recipient intent and one composition owner.** A new additive migration plus a scoped recipient-management/sync repository and service; contact mutation and desired policy revision persist in one transaction, remote I/O stays outside it. Every policy writer — contacts, enrollment, delegated grant create/revoke/expiry, retry — routes through one composer that reuses `src/wallet/grants/solana-policy-provisioner.ts` composition semantics, plus cross-process wallet serialization with revision verification and a documented lock order across the existing claim/revoke locks. Removal of the last active alias for an address revokes its affected whole delegated grants in the same transaction, with audits, and is disclosed in the proposal shown to the user.
2. **Apply and reconcile signed remote policy.** Immediate bounded attempt after save, durable retry from persisted intent, verified readback updates applied revision, `allowlisted_recipients` and `policy_hash` consistently. Delegated coverage/claim requires the wallet's verified applied revision/hash, not `provider_policy_id` alone; ambiguous PATCH, mismatched readback or unknown remote rule/owner/attachment blocks affected automatic executions until verified reconciliation. Backend obtains its own reachable signed-authorization capability through the existing opaque injection mechanism — never a private key in the frontend or general application containers.
3. **Screen/API vertical flow.** `src/api/contacts.ts`, `src/contracts/http.ts`, the mirrored `apps/nana-wallet/src/lib/api-types.ts` + `api.ts` + MSW handlers, and the trusted recipients UI: create/edit/delete through the common service, showing actual permission readiness after refresh, version-aware mutations, explicit disclosure when a removal also revokes automatic-payment grants, and no chain picker (Solana validation only).
4. **Text and voice agent vertical flow.** The same service and evidence rules for `src/agent/*` and `src/memory/*` recipient tools: Solana validation replaces EVM validation, one per-session typed confirmation arbiter keyed by action kind/ID/user/proposal version owns the only active authorization window, a contact affirmative can never authorize a transfer (or the reverse), and voice permission creation requires a server-owned immutable proposal card published to the bound authenticated UI with a verified pasted/scanned address.
5. **Deploy, verify and close.** Rebuild/restart the affected backend, frontend and voice worker; verify built markers and signer connectivity after namespace restart; run automated suites with a baseline comparison; observe a user-selected devnet recipient change through screen and agent with signed GET evidence. Conventional commits per work unit; no push or PR.

### Out of Scope / Non-goals

From intake revision 1: no new chain switch, no local transfer-policy gate, no rolling-limit provider claim, no key rotation, no pending-broadcast recovery, and no unrelated refactor. Also out of scope here: provider signing, submission or finality changes, swaps or mainnet, grant lifecycle endpoints beyond what slice 1 revokes, and migration of grants to a replacement address.

## Business Rules and Constraints

The following invariants MUST survive into the spec:

- The ordinary trusted-contact transfer ceiling stays **0.01 SOL (10,000,000 lamports)**; separately approved delegated limits and expiries are not silently changed.
- Preserved through every composition and rollback: policy ID, canonical signer attachment, unrelated signers, policy ownership, and already approved delegated limits/expirations.
- Adding a contact **never** creates an automatic-payment grant.
- A remote GET is **observed/applied state and never a consent source**. Unknown remote rules, owner drift or attachment drift **block mutation** instead of being deleted or copied into desired state. The retained baseline allowlist comes from the active `signer_grants` enrollment consent snapshot; Test1's drift comes from its active confirmed contact ID/version and is resolved by the same reconciler, not a one-off DB patch.
- Deleting the **last active alias** for an address revokes that address's affected whole delegated grants (Ramiro-approved semantics, `03-design-discussion.md` Q1). A grant containing several addresses is revoked whole rather than narrowed by invention; unrelated grants are preserved; grants are never migrated to a replacement address. This consequence MUST be disclosed to the user in the screen and agent proposal, and revocation may not be advertised as verified until remote readback confirms it.
- Removing one alias does not revoke another active alias for the same address.
- Editing name/description does not broaden remote permission; an address edit invalidates stale selections/previews and recomposes old and new addresses.
- Composition is never detached to unrestricted authority. If composition becomes empty, supported deny behaviour MUST be proven first; otherwise the restrictive policy is retained and the operation stops visibly.
- No success state before verified readback: a timeout means outcome unverified, and save/remove replies report the actual state (saved-but-not-enabled, pending, syncing, applied, retryable failure, blocked conflict/configuration). Contacts on a wallet without a ready permission stay saved and not enabled.
- One-use confirmation evidence belongs to the exact contact action (kind/action ID/user/proposal version), is authenticated, occurs after the proposal exists, expires, and cannot consume or authorize a pending transfer — and vice versa. Fail closed on ambiguity, replay, foreign session/speaker, or delayed final transcript.
- Spoken/inferred addresses are never a permission source: creation and address replacement require a verified pasted/scanned address, and no address is ever derived from a name.
- Front/backend separation and the duplicated HTTP contract are respected: backend defines `src/contracts/http.ts`, frontend mirrors `apps/nana-wallet/src/lib/api-types.ts`, updated together.
- `WDK_TOOLS_SOURCE=fixture` remains the default; no live credential, secret or key access, no remote policy mutation during development.

## Capabilities

### New Capabilities

- `trusted-recipient-policy-sync`: user-scoped recipient management service, single policy composer, durable desired/applied revisions with cross-process serialization, verified remote readback, action-bound confirmation evidence, and the shared screen/text/voice flow.

### Modified Capabilities

- `recipient-address-memory`: Solana address validation replaces EVM validation on recipient draft/write and selected-address lookup; recipient writes route through the common service while fact memory keeps its separate, non-permission-expanding path.
- `delegated-grant-core`: last-active-alias removal revokes affected whole grants atomically with the contact change; delegated readiness is bound to the wallet's verified applied revision/hash.
- `unified-agent-tools`: recipient create/edit/remove tools reachable from both text and voice with version-bound proposals.
- `voice-transfer-confirmation`: the one-use confirmation arbiter becomes typed per action kind, so a contact affirmation and a transfer affirmation can never cross-authorize.

Exact requirement deltas are confirmed in the spec phase.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/db/migrations/` | New | Additive recipient intent / sync revision and lock state; no destructive change |
| `src/memory/contacts-repository.ts`, new scoped service/repository | New/Modified | Contact persistence adapter plus the single recipient management service |
| `src/wallet/grants/*`, `src/wallet/embedded.ts` | Modified | One composer, cross-process serialization, verified readback, consent provenance |
| `src/api/contacts.ts`, `src/contracts/http.ts` | Modified | Permission readiness/revision and conflict errors in the `/v1` contract |
| `apps/nana-wallet/src/` | Modified | Trusted recipients UI, api client, mirrored types, MSW fixtures |
| `src/agent/*`, `src/memory/tools.ts\|service.ts`, `src/conversations/session-state.ts`, LiveKit evidence binding | Modified | Solana validation, action-bound one-use consent, typed arbiter |
| `src/server.ts`, `src/livekit/worker.ts` | Modified | Shared injected service and policy capability in both processes |
| `tests/`, `evals/`, `apps/nana-wallet/**` tests | Modified | Unit, DB integration, adapter-over-fake-transport, screen and LiveKit E2E, evals |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| Composed-policy race still erases a legitimate rule | Medium | Single composer, DB-backed wallet serialization with revision checks, documented lock order, no second full-rule writer left reachable |
| Ambiguous PATCH leaves grants executable on stale policy | Medium | Wallet-level applied revision/hash required for delegated claim, sibling executions blocked until verified, GET before retry |
| Removal without revocation, or a silent revocation the user never approved | Medium | Atomic contact + grant revocation + audit + intent transaction; explicit disclosure in proposal before mutation; revocation not reported as verified before readback |
| Provider semantics unknown for empty composition, signer binding or ownership conflict | Medium | Treat as stop/verification condition in SDD; never detach to unrestricted authority; block visibly if unproven |
| Consumed confirmation from the wrong action or speaker | Low/Medium | One typed arbiter per session, immutable proposal version, one-use consume by the matching tool, collision/replay/foreign-session tests |
| Voice address inferred or unverifiable | Medium | Server-owned proposal card plus verified pasted/scanned address; refuse creation when absent |
| Backend cannot reach a signed-authorization capability | Medium | Dedicated signer wiring via the existing opaque secret injection; verify auth without exposing secret values |
| Front/back contract drift | Medium | Contract mirrored in the same change with MSW fixtures and status/conflict coverage |

## Rollback Plan

A defect in policy writing must never be fixed by widening authority.

1. **Freeze the writer, not the policy.** Disable the reconciler and the remote-apply path (config/feature switch), so no new composed PATCH is issued; contact mutations continue to persist as saved-but-not-enabled intent. Prior effective policy stays attached and intact.
2. **Disclose, never fabricate.** Screen and agent report the frozen state (`saved, not enabled` / `pending`) instead of "enabled". No success message or spoken "habilitado" while the writer is frozen.
3. **Restore from recorded evidence, not guesswork.** Recompose from the last verified applied revision plus the consent baseline; never rebuild the allowlist from arbitrary remote rules and never delete unknown remote rules to force convergence.
4. **Preserve signers and keys.** No rollback step rotates keys, changes the signer, detaches the policy, or opens the allowlist. If composition cannot be built safely, keep the restrictive policy and stop visibly.
5. **Revocations already verified are not silently undone.** Grants revoked by an approved last-alias removal stay revoked; re-granting requires a fresh explicit user approval, never a rollback side effect.
6. **Code and data rollback.** Revert the change's commits per work unit (contact writes and reads keep working against the pre-change contract only if the additive migration and HTTP additions are reverted together); tables and the durable intent remain additive and unconsumed, so no destructive down-migration is needed. Rows for unverified intent are left for review, not mass-deleted.
7. **Blast radius.** Reverting this change must not touch the existing transfer preview/confirmation flow, the delegated grant engine, or the 0.01 SOL ceiling.

## Delivery

Worktree `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch `feat/solana-operational`, reused; the local untracked ports override is preserved. Conventional commits per work unit. **No push and no PR.** No live credential or secret access; `WDK_TOOLS_SOURCE=fixture` is the default and the real adapter is exercised over a fake transport. Validation: backend `npm run lint`, `npm run typecheck`, `npm test`, `npm run eval`, build; frontend `npm run lint`, `npm run typecheck`, `npm test`; relevant browser and LiveKit E2E; failures compared against a captured baseline with pre-existing errors reported, not hidden. Any live money movement requires a separate user preview and confirmation and stays ≤0.01 SOL.

## Success Criteria

- [ ] Screen and agent converge on one user-scoped recipient management service; a second full-rule writer is unreachable.
- [ ] Adding an exact confirmed Solana address updates the correct attached Privy policy and verifies readback before anything reports enabled.
- [ ] Updates and removals remove obsolete authorization, including duplicate-address aliases and delegated-grant cases under the approved revocation semantics.
- [ ] The 0.01 SOL ceiling, signer identity, unrelated signers, delegated limits/expiries and devnet configuration are unchanged after every flow.
- [ ] Persisted intent survives remote timeout, process restart and concurrent backend/worker writes; no fabricated success is ever reported.
- [ ] A spoken authorization is bound to the exact contact action, authenticated, after its proposal, used once, and cannot authorize a transfer (or vice versa).
- [ ] E2E evidence proves screen and agent entry points, remote rule readback, and the resulting transfer-permission behavior.
- [ ] Rollback by freezing the writer leaves the previous restrictive policy attached and reports the honest state.

## Proposal question round

Product questions for Ramiro. Each carries the assumption already implied by the approved design and outline; answering is optional and only corrects an assumption, it does not reopen the approved design.

1. **Regrant after revocation.** When a removal revokes an affected automatic-payment grant, may the user immediately re-create the same grant through the normal flow, or must re-granting be a distinct, separately worded approval? *Assumption: normal flow only, with its own fresh confirmation — nothing re-grants silently.*
2. **Saved-but-not-enabled visibility.** Should the screen expose "saved, not enabled" as a first-class state with a retry action, or refuse to save a contact when the remote policy cannot be verified? *Assumption: saved-but-not-enabled, disclosed, with retry — never reported as enabled.*
3. **Voice without a visual client.** If no bound visual client is available for the proposal card, should permission creation be refused while the contact may still be saved, or should both be refused? *Assumption: permission creation refused; the contact may be saved as not enabled.*
4. **Empty composition fallback.** If the provider turns out not to support an empty composed policy, is the desired behaviour "block the last-recipient removal with an explicit message and keep the recipient", or something else? *Assumption: block with an explicit message; never detach the policy.*
5. **Drift repair reporting.** Should the reconciler's correction of the existing local/remote drift be silent in the product surface and only recorded as evidence, or should the user see a repaired-inconsistency notice? *Assumption: silent automatic repair through the reconciler, recorded as evidence, no user-facing alarm and no one-off DB patch.*
