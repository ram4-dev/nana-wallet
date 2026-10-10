# Proposal: Trusted recipient by SNS alias

## Intent and Outcome

A trusted recipient can only be created today from an address the user **pastes or scans** into the
review surface. `AddTrustedRecipient.tsx` requires an address field, the strict create schema
(`src/agent/definition.ts:113-116`) carries a display name and an optional description and nothing
else, and `contact-actions.ts`'s `payloadSchema.addressSource` admits only
`["review_required", "pasted", "scanned"]`. So a user who knows a person's **name** and not their
address cannot add them — which is exactly the situation the product is built for: an older user who
has been told "mandale a `juan.sns`" and has no way to turn that into a destination.

And the mechanism that would fix it is currently forbidden by the published spec. In
`openspec/changes/trusted-recipient-policy-sync/spec.md`, capability `trusted-recipient-policy-sync`,
requirement *Voice permission creation requires a published proposal and a verified address*:

> Creating a permission or replacing an address MUST require a verified pasted or scanned address;
> a spoken-only, inferred, or **name-derived** address MUST NEVER be a permission source.

with the scenario *Name-derived address is never accepted*. That MUST is the only thing standing
between the request and a working feature, so this change revises it explicitly instead of absorbing
the exception silently.

**Outcome.** The user names an alias; the **server** resolves it to a Solana address; the app shows
**that exact address** and asks whether it is the right one; the user confirms the address; the
contact is stored with the **frozen address** plus provenance recording where it came from. The alias
is a label and the address is the authorization — never the reverse. The paste and scan paths stay
exactly as they are, and the Privy policy machinery is untouched because it consumes addresses and
knows nothing about names.

This is a **new capability**, not a bug fix, and it is not implemented as a drive-by: it goes
`proposal → spec (this delta) → design → tasks → apply → verify` under the stage-2 rules of
`AGENTS.md`.

## Scope

### In Scope

1. **The spec revision (the artifact the human approves first).** One deliberate revision of the
   existing MUST, drafted as `openspec/changes/sns-alias-recipients/spec.md` from §1.3 of
   `.agent-workflow/tasks/sns-alias-recipients/02-design-discussion.md`: **model inference** of an
   address stays forbidden without exception, and **server-side resolution of an explicit `.sns`
   name the user supplied** becomes a second verified source, admitted only under the eight
   mandatory compensations M1–M8. Three requirements are added (confirm-time re-verification,
   freeze + provenance, the model's alias surface) and one aliasing requirement is extended so
   "disclose and proceed" is specified rather than unstated.
2. **The resolver seam.** New `src/wallet/sns/resolver.ts` (pure orchestration, closed
   network→root map) and `src/wallet/sns/transport.ts` (the only module importing the SDK),
   with a total failure taxonomy where `not_found`, `unsupported_tld`, `ambiguous`, `unreachable`,
   and `resolver_misconfigured` are distinct typed outcomes, and `resolve` never throws.
   `SNS_RPC_URL` (already present in `.env.example`, defaulting to the keyless public devnet
   endpoint) follows the `BALANCE_RPC_URL` precedent in `src/wallet/balances.ts:252`.
3. **Freeze and provenance.** `recipients.provenance` (existing `JSONB`, migration `001`) records
   `{source:'sns', name, resolvedAt, resolver}` plus the resolution evidence; the alias lives in
   provenance and never in `recipients.name`; `RecipientContactWriteInput` gains one optional
   `provenance` field passed through to the existing `RecipientInput.provenance` parameter;
   `payloadSchema.addressSource` widens by one additive enum value, `"sns"`.
4. **The confirmation on both surfaces.** Screen: the address field accepts a name, resolve shows the
   address verbatim plus the reverse-domain line, and "Guardar" posts
   `{source:'sns', name, expectedAddress, description, network}` where `expectedAddress` can only
   veto. Voice/text: `contactCreateInputSchema` gains an optional `snsName` (`.strict()` retained, no
   address field), the name is resolved **before** the proposal is persisted, the card carries the
   resolved address, and publication still gates the window — so the user is looking at the address
   when they say yes. The spoken sentence asks about the screen, as the product asks it.
5. **Confirm-time re-verification.** A resolution that moved between display and confirmation
   supersedes the proposal into a new immutable version and asks again; an unreachable resolver at
   confirmation proceeds with the displayed address and records `reverify:'unavailable'`.
6. **Drift reporting, bounded.** An explicit `POST /v1/contacts/:id/check-alias` read, a
   `provenance.drift` record plus an `alias_destination_changed` audit event, and a user-facing
   notice offering keep / replace / remove. Drift never changes the stored address, never
   re-composes, and **never blocks a payment**.
7. **Dedup semantics made explicit.** A resolved address that already belongs to another active
   contact is **disclosed and the add proceeds** (D13); a resolved address that is the user's own
   wallet address is refused with a typed error on every surface.
8. **Idempotency correctness.** A replay carrying the same `Idempotency-Key` with a different
   mutation body must be refused with a typed conflict instead of returning the stored result of a
   different alias.
9. **Both contract sides in one work unit.** `src/contracts/http.ts` and
   `apps/nana-wallet/src/lib/api-types.ts`, with MSW fixtures, per `AGENTS.md`.

### Out of Scope / Non-goals

- **No resolution at send time**, ever. Resolve once, freeze, and never consult the name again for a
  payment, preview, or composition.
- **No `.sol`.** It is not deprecated-in-progress; it is already rejected in code
  (`Domain has an unsupported TLD suffix`, mainnet ~2,585,134 slots past the documented pause slot).
  `.sns` only, and an unsupported suffix is a typed refusal with **no fallback attempt**.
- **No subdomains** and **no other name services** (ENS, DNS, or any non-SNS registry).
- **No name registration and no primary-domain writes.** The feature performs reads only; the app
  wallet cannot sign a name instruction anyway (`Privy denied the Solana dispatch by policy`, since
  the single ALLOW rule covers a SystemProgram `Transfer`).
- **No change to the delegated-grant model**, to the transfer-policy model, to the 10,000,000-lamport
  ordinary ceiling, or to the one-use typed confirmation arbiter.
- **No alias for the wallet's own address** (refused), no mainnet entry in the resolver's network map,
  no process-wide resolver cache, and no new table or column for provenance.

## Business Rules and Constraints

The following invariants MUST survive this change; they are asserted by the spec delta and are the
reason the change is expressible as an additive slice at all:

- **The composer still consumes addresses, and is not touched.** `composePolicy`'s contact input is
  `Array<{id, version, address}>`; an alias-created contact contributes its resolved address exactly
  like a pasted one, so the allowlist, the grant rules, `applied_rules_hash`, the readback comparator,
  and `applied_recipients` see zero difference. This is the strongest single argument for
  freeze-at-add-time, and it is why no code path exists in which a **name** (rather than an address)
  reaches a rule.
- **The ordinary ceiling stays 10,000,000 lamports (0.01 SOL)**, and separately approved delegated
  limits and expiries are not silently changed. Adding an alias contact creates no grant.
- **The one-use typed arbiter is unchanged.** An alias-origin proposal is not special: `confirm` still
  runs `currentOpenProposal` → version match → `waitAndConsume({kind:'contact', actionId, userId,
  version})` → the persisted one-use UPDATE inside the mutation transaction.
- **The address validator remains the last gate.** The resolved address must satisfy
  `isValidRecipientAddress`/`isValidSolanaAddress` (`src/memory/address.ts`), and the resolver
  additionally requires `address === observedOwner` — the value it *read* — so a resolver bug cannot
  write a malformed key.
- **Remote I/O stays outside the contact transaction** (existing rule, both at stage time and at
  re-verification time).
- **An unreachable resolver is never reported as a non-existent name**, per the repo's own rule in
  `AGENTS.md` that a definite rejection and an ambiguous network failure are different things.
- **The reverse-domain signal is never made mandatory.** It is reported in three distinct states
  (`present` / `none` / `unknown`), `unknown` is never rendered as `none`, and its absence (the
  expected devnet case) is a fact about the chain, not a failure and not agreement.
- **Front/back separation holds.** The frontend performs no resolution: a client-produced address is a
  client-supplied address. Its `solanaAddressPattern` stays an explicitly labelled pre-check.
- **Testnet-only, no secrets.** `WDK_TOOLS_SOURCE=fixture` remains the default; no live credential,
  key, or secret access; the devnet keypairs under `.secrets/` are never read.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `trusted-recipient-policy-sync`: one revised MUST (the two-verified-sources wording replacing the
  unconditional name-derived prohibition), one added requirement for confirm-time re-verification of
  an alias-resolved destination, and an extension of the aliasing requirement so the duplicate-address
  add is specified as "disclose and proceed" plus the unconditional self-address refusal.
- `recipient-address-memory`: **RAM-010** — an alias-resolved address is validated, frozen at add
  time, recorded with `{source, name, resolvedAt, resolver}` provenance, never re-resolved, and
  reported as drift rather than followed if the name later moves.
- `unified-agent-tools`: the create tool may accept one explicit `.sns` name while the prohibition on
  a model-supplied (**including model-inferred**) address is preserved verbatim; a scenario asserts
  both halves.

The `voice-transfer-confirmation` capability is **not** modified. The revised requirement lives in the
`trusted-recipient-policy-sync` capability block of the published spec, not in
`voice-transfer-confirmation`; the design discussion's §1.1 misattributes it, and the spec delta
records the correct host capability in its baseline references.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/wallet/sns/resolver.ts`, `src/wallet/sns/transport.ts` | New | The resolver seam: pure orchestration plus the single SDK-importing transport; closed network→root map keyed off `CONFIGURED_RECIPIENT_NETWORK` |
| `package.json` + lockfile | Modified | `@bonfida/spl-name-service@3.0.23` pinned, installed with `--legacy-peer-deps` (peer conflict with `@circle-fin/developer-controlled-wallets@10.8.0`) and, in the container, installed **in** the container |
| `.env.example` / `SNS_RPC_URL` | Modified (documentation) | Already present and documented; defaults to the keyless public devnet endpoint, which is sufficient for real use and explicitly not sufficient for a CI loop |
| `src/wallet/policy/service.ts` | Modified | `RecipientContactWriteInput` gains one optional `provenance`; the alias arm is the only new caller; strict schemas and the `solana-devnet` scope are unchanged |
| `src/wallet/policy/contact-actions.ts` | Modified | `payloadSchema.addressSource` widens with `"sns"`; `replaceAddress`/`supersede` reused unchanged for the confirm-time supersede |
| `src/db/migrations/` | Modified (small, additive) | Widening `recipient_policy_audit.event` with `alias_destination_changed` if the design's recommendation is kept; **no** new table and **no** new column |
| `src/agent/definition.ts` | Modified | `contactCreateInputSchema` gains optional `snsName` (`.strict()` retained); resolve-before-persist in the stage path |
| `src/api/contacts.ts`, `src/contracts/http.ts` + `apps/nana-wallet/src/lib/api-types.ts` | Modified | One resolve endpoint, one alias-add arm, one drift-check endpoint; both contract sides in the same work unit with MSW fixtures |
| `apps/nana-wallet/src/features/wallet/AddTrustedRecipient.tsx`, `ContactActionProposalCard.tsx`, `ContactActionProposalReview.tsx` | Modified | Alias form, `expectedAddress` posting, the address never truncated, the three-state reverse-domain line, the alias and drift lines on the card |
| `src/memory/address.ts`, `src/memory/repository.ts` | Unchanged / read path | The validator stays the last gate; `recipients.provenance` is already read with the row |
| `src/wallet/policy/composer.ts` | **Unchanged** | Explicitly not touched: it consumes addresses, and an alias contributes only its resolved address |

## Risks

| Risk | Likelihood | Mitigation |
|---|---|---|
| **The user is asked to approve an address they by definition cannot verify.** With paste/scan the user chose the destination from their own knowledge; with an alias the address arrives wholly from the chain and display-and-confirm is the only check — a strictly weaker one, because the reason to type `juan.sns` is not knowing the address | **Inherent to the feature** | M1–M8 are mandatory, not optional: server-side resolution only; the resolved address always shown verbatim and bound to the immutable version confirmed; freeze + provenance written before authorisation; drift surfaced and never auto-followed; typed `does not exist ≠ could not be reached`; confirm-time re-verification; the paste/scan path retained on every surface; `.sns` only with no suffix fallback |
| A **squatted or mis-told name** resolves authoritatively to the wrong address | Medium, and **irreducible by this feature** | The compensating controls above bound it but cannot detect it. The product must not imply that an alias-sourced contact is verified identity, and the reverse-domain line is offered as a corroborating signal only. This residual is stated, not papered over |
| A **name transferred between resolution and confirmation** | Low/Medium | Confirm-time re-verification with fail-closed supersede; the residual window between re-verify and commit is bounded and cannot redirect, because the stored value is the address the user saw |
| **RPC throttling** (the public devnet endpoint throttles per method and path-dependently) | High for any tight loop | `unreachable` is a distinct typed outcome → `503`, never "not found"; nothing is staged; the last resolution stays visible labelled with its age; the paste path remains. A dedicated `SNS_RPC_URL` is a prerequisite for live evidence, not an assumption |
| **Reverse lookup is unavailable or unset on devnet** | High (expected) | Classified as `none`, never as failure and never as agreement; never promoted into a gate. `unknown` is never degraded to `none`, because `none` reads as "nothing to see here" |
| SDK **v3 is the legacy line** and the bundle/peer cost is unmeasured | Medium | Pinned to `3.0.23`, version-tagged in every provenance record (`sns/<network>/v3`), confined to `src/wallet/sns/transport.ts` with a structural assertion that exactly one module imports it. A mainnet move re-opens the decision visibly, in the data |
| **Idempotency replay with a different body** silently returns another alias's result | Medium | Typed conflict on a body mismatch; the alias path makes this user-visible, so it is fixed here rather than inherited |
| **Drift turned into a denial-of-service lever** | Low/Medium | Drift never blocks a payment and never touches a grant: a stranger who transfers a name must not be able to disable the user's trusted recipient |
| **`ambiguous` is under-specified** — no fixture exists that produces it | Low | It exists as a named, typed refusal rather than an exception path, and the missing fixture stays an open question; a resolution whose parent is not the configured root is refused rather than interpreted |
| **Confusable names** (`Juan.SNS`, non-ASCII lookalikes, trailing whitespace) | Medium | Normalize to lowercase, enforce charset and length, refuse non-ASCII as `malformed_name`, render the alias with its suffix. The decisive guard is structural: the alias is never the authorization, so a confusable name can mislead a label but cannot confer authority |
| **Front/back contract drift** | Medium | Both sides plus MSW fixtures in one work unit; the alias flow is refused when the resolve endpoint is absent, never emulated client-side |
| **Baseline sequencing** — the revised requirement is published by an unarchived change | Medium | Recorded in the spec delta's baseline references; the delta must not be applied ahead of `trusted-recipient-policy-sync`'s block |

## Rollback Plan

The feature is additive in code and read-only on-chain, so rollback is local and must never be
achieved by widening or repairing authority. In order:

1. **Disable the surfaces, not the stored data.** Remove the alias arm of `POST /v1/contacts`, the
   `snsName` field from the create schema, and `POST /v1/recipient-aliases/resolve`; revert the
   `addressSource` enum widening and the MSW fixtures. The frontend then falls back to the
   paste/scan form it already has.
2. **Never roll back the spec while alias-origin contacts exist.** Contacts already stored keep a
   plain canonical address in `recipients.address` and a `provenance.source = 'sns'` record. Reverting
   the spec text to the unconditional prohibition while that data exists would make the spec describe
   state it forbids; if the spec is reverted at all, it is reverted together with an explicit,
   user-visible decision about those contacts.
3. **Do not rewrite or delete the contacts to force conformance.** Every stored address was
   individually confirmed by the user and is in the composed allowlist. Removing one would revoke a
   destination the user approved and would touch grants; deleting provenance rows would destroy
   evidence.
4. **Do not remove alias-created addresses from the allowlist.** Rollback of the feature is not a
   reason to recompose a policy: no rollback step issues a PATCH, creates a grant, revokes a grant,
   changes a signer, or alters the 0.01 SOL ceiling.
5. **Leave the drift machinery inert.** Disable `POST /v1/contacts/:id/check-alias` and stop reading
   `provenance.drift`; never "resolve" an observed drift by writing the newly observed address.
6. **Keep the audit trail.** `alias_destination_changed` rows are append-only evidence; do not delete
   them, and do not re-use `drift_repaired` to describe them.
7. **Dependency removal is a one-module change.** Uninstall `@bonfida/spl-name-service` together with
   `src/wallet/sns/transport.ts` and the lockfile entry. Because exactly one module imports it
   (asserted structurally), nothing else can break; note that the install needed
   `--legacy-peer-deps` and, in the container, an in-container install, so the dependency and its lock
   entry are removed together rather than partially.
8. **Restore the persisted state honestly.** Follow the existing "freeze the writer, not the policy"
   discipline: if a contact was left `saved, not enabled`, it stays saved and not enabled, reported as
   such — never narrated as enabled.
9. **Reduce the blast radius.** A revert must not touch the transfer preview/confirmation flow, the
   typed arbiter, the composer, the delegated-grant engine, or any `recipients.address` value.
10. **Verify the reverted tree.** Backend `npm run lint`, `npm run typecheck`, `npm test`, `npm run
    eval`; frontend `npm run lint`, `npm run typecheck`, `npm test`. The paste/scan suites must pass
    **unchanged** — that is the proof that the alias path was additive and that rollback returned the
    system to its previous behaviour rather than to a third state.
11. **Revert per work unit.** Conventional commits per unit make steps 1–7 revertable independently;
    the additive audit-event widening is the only migration, and it needs no down-migration (a wider
    CHECK accepts every value it accepted before).

## Delivery

Worktree `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch
`feat/solana-operational`. This change's artifacts live in `openspec/changes/sns-alias-recipients/`.
Note the ordering dependency: the requirement this delta revises is published by
`openspec/changes/trusted-recipient-policy-sync/`, which is **not yet archived** — the two changes are
delivered in sequence, not in parallel. Conventional commits per work unit; **no push and no PR**. No
live credential, key, or secret access; `WDK_TOOLS_SOURCE=fixture` stays the default and the resolver
is exercised over an injected transport. Validation: backend `npm run lint`, `npm run typecheck`,
`npm test`, `npm run eval`; frontend `npm run lint`, `npm run typecheck`, `npm test`. The live
end-to-end alias add additionally requires a dedicated `SNS_RPC_URL`; that is a prerequisite to record
honestly, not an assumption to bury.

## Success Criteria

- [ ] `openspec/changes/sns-alias-recipients/spec.md` is approved by the human before any code exists,
      and the one revised MUST is visible as a `(Previously: …)` delta rather than an absorbed
      exception.
- [ ] Adding by alias resolves via SNS, stores the **resolved address**, and records
      `{source:'sns', name, resolvedAt, resolver}` in `recipients.provenance`.
- [ ] The confirmation shows the resolved address (untruncated) and the three-state reverse-domain
      line, and the user's affirmative authorizes **that address**, not the alias.
- [ ] A resolution that moved before confirmation supersedes the proposal into a new immutable
      version and asks again; an unreachable resolver proceeds with the displayed address and records
      `reverify:'unavailable'`.
- [ ] A name whose resolution changes after the contact exists is reported as drift and never
      auto-followed; the stored address and the composition are unchanged, no grant moves, and the
      drift alone blocks no payment.
- [ ] A payment to that recipient uses the frozen stored address with no re-resolution anywhere on the
      transfer, preview, or compose path (asserted structurally).
- [ ] Refusals are typed and distinguishable for: name that does not exist, unsupported suffix,
      unreachable resolver, ambiguous resolution, duplicate-address disclosure, and the user's own
      address.
- [ ] The paste/scan path and the Privy policy composition are unchanged; `composer.ts` is not
      modified; the existing suites pass.
- [ ] The model still cannot supply an address in any form, including an inferred one, while an
      explicit `.sns` name is accepted; `@bonfida/spl-name-service` is imported by exactly one module.
- [ ] A replay with the same idempotency key and a different body is refused with a typed conflict.

## Proposal question round

Product questions, each with the assumption the approved design already implies. These refine the
product surface and the wording the user sees; they do not reopen D1, D11, D13, or the resolved RPC
decision.

1. **How prominent is "add by name" on the screen?** Given §1.4's finding that the alias path cannot
   make confirmation stronger than the paste path, should the alias form be the primary entry on the
   add-recipient screen, a peer option beside pasting, or a secondary affordance reachable from the
   paste form? *Assumption: a peer option — the address field accepts either form with an explicit
   "Buscar" action, so a user who has the address is never steered into the weaker source.*
2. **How is the weaker source communicated, if at all?** Should an alias-origin contact be labelled as
   such in the UI (for example "agregado por `juan.sns`") so the user can tell a name-added
   destination from an address-added one, or is that only an internal provenance record?
   *Assumption: labelled — the design recommends exposing it on the contact surface; the cost is an
   additive contract field on `GET /v1/contacts` plus a mirrored frontend type.*
3. **What does the duplicate-address disclosure say?** When the resolved address already belongs to an
   active contact, does the notice name that contact ("Esta dirección ya está en tu lista como Mamá")
   or stay generic ("Esta dirección ya está en tu lista")? *Assumption: name it — D13 chose disclosure
   as the control, and naming is what makes it informative; it does mean the notice reveals one contact
   to a user who is already that user.*
4. **Is a drift notice dismissible forever?** When a name is found to point elsewhere, does "keep my
   current recipient" silence future notices for that contact, or is drift re-reported on each explicit
   check? *Assumption: re-reported on each explicit check, with no persistent silence — the check is
   user-initiated, and a permanent silence would turn a one-time answer into a standing claim the user
   never made.*
5. **Does the reverse-domain line appear at all when it is `none`?** On devnet the expected state is
   "no primary name registered", which is honest but adds a line of noise to every alias confirmation.
   *Assumption: show it — the design's position is that silence would let the user read the absence of
   any signal as agreement; the alternative is to show the line only when it is `present` or
   `unknown`.*
