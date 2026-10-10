# Design: Trusted Recipient by SNS Alias

Implementation design for change `sns-alias-recipients`. Requirements are fixed by
`openspec/changes/sns-alias-recipients/spec.md` (approved); the approved design intent is
`.agent-workflow/tasks/sns-alias-recipients/02-design-discussion.md` (revision 1). This document turns
§2–§6 of that discussion into the mechanical resolution the code actually needs, adds §9's danger
analysis and §12's decision summary, and records every place the discussion left something open
instead of filling it in.

Worktree: `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch
`feat/solana-operational`. No push, no PR, no credential access, `WDK_TOOLS_SOURCE=fixture` by
default. The devnet keypairs under `.secrets/` are never read; only the public addresses and PDAs
recorded in `.agent-workflow/tasks/sns-alias-recipients/01-sns-devnet-resources.md` are used.

---

## 0. Baseline, sequencing and code-grounding corrections

### 0.1 Baseline and sequencing (carried forward, not reopened)

- **Host-capability correction.** The discussion's §1.1 locates the revised clause in capability
  `voice-transfer-confirmation`. That is a misattribution. In
  `openspec/changes/trusted-recipient-policy-sync/spec.md` the requirement *Voice permission
  creation requires a published proposal and a verified address* sits inside the capability block
  `trusted-recipient-policy-sync`; `voice-transfer-confirmation` holds the arbiter requirements only.
  This change therefore revises the requirement under its real host capability and modifies nothing
  in `voice-transfer-confirmation`. Recorded in the spec delta's baseline references; repeated here
  so no implementation task edits the wrong capability block.
- **Sequencing dependency.** The revised requirement lives in an **unarchived** change
  (`openspec/changes/trusted-recipient-policy-sync/` has no `archive-report.md` and no `state.yaml`,
  and `openspec/specs/` does not exist in this worktree). This change MUST NOT be applied ahead of
  that change's block: applying it against the pre-`trusted-recipient-policy-sync` text would
  reinstate the unconditional prohibition in a different wording. Everything below assumes the
  `trusted-recipient-policy-sync` code and spec are present, and the whole design is written against
  the interfaces that change introduced (`RecipientPolicyService`, the composer, the arbiter,
  `contact_action_proposals` with the `016` `payload` column).
- **Decisions already made, not reopened here:** D1 (the spec revision, approved), D11 (SDK
  v3.0.23 pinned, `--legacy-peer-deps`, one importing module), D13 (a resolved address belonging to
  another active contact is disclosed and the add proceeds; the wallet's own address is always
  refused), `SNS_RPC_URL` dedicated and already present in `.env`/`.env.example`.

### 0.2 Corrections found by reading the code

Each row is a fact established from source. Where the discussion asserts something the code does not
support, the design follows the code and records the difference.

| # | Discussion / proposal claim | What the code actually does | Design consequence |
| --- | --- | --- | --- |
| C1 | "`RecipientInput.provenance` is already written" (§3.1) | True of `src/memory/repository.ts:117-121`, which is the **memory** repository. The contact write path is `ContactsRepository.create` (`src/memory/contacts-repository.ts:103-145`), which **ignores the caller** and hardcodes `provenance` to `JSON.stringify({ origin: "user" })` (`:132`). `ContactWriteInput` (`:17-22`) has no `provenance` field at all. | §3.2: `ContactWriteInput` gains an optional `provenance`, and the hardcoded literal becomes the default. Without this the alias provenance is written and silently discarded. |
| C2 | An address edit must rewrite or clear the alias provenance atomically (RAM-010, 4th scenario) | `ContactsRepository.update` (`:155-239`) snapshots the prior row into `recipient_versions` (including `network`, `:177-186`) and then `UPDATE recipients SET name, normalized_name, description, address, network, embedding, …` (`:207-219`) — it never writes `provenance`. | §3.3: the patch input and the UPDATE gain one conditional column write, defaulting to **clear** when the address changes. Confirmed, not assumed. |
| C3 | The alias "is already read with the row" (proposal, `src/memory/` row) | `RECIPIENT_COLUMNS` (`contacts-repository.ts:77-78`) is `id, name, description, address, network, version, status, created_at, updated_at` — **no `provenance`**, and `ContactRecord` (`:6-16`) has no field for it. | §3.2/§7: exposing the alias on the contact surface is a real additive contract change (column selection → record → `contactSchema` → mirrored frontend type), not a UI-only change. It stays an explicit task with a stop condition (§11 Q3). |
| C4 | "`recipient_versions` snapshots `name`, `description`, `address` and `network` — not `provenance`" | Exact. `005_recipient_versions.sql` plus the INSERT at `contacts-repository.ts:177-186`. | §3.1 keeps the snapshot gap as an open question with a named stop condition, because extending an `INSERT`-only RLS table is out of this feature's scope. |
| C5 | "a new optional field on one port" | The create body is validated **twice** by two different `.strict()` schemas: `createContactInputSchema` at the route (`src/api/contacts.ts:137`) and `recipientCreateInputSchema` in the service (`src/wallet/policy/service.ts:153-161`, parsed at `:722`). | §2.1/§7: both schemas widen in one work unit, or the alias arm is refused at the route before the service ever sees it. |
| C6 | "`replaceAddress`/`supersede` reused unchanged for the confirm-time supersede" (proposal, affected areas) | `replaceAddress` (`src/wallet/policy/contact-actions.ts:155-168`) is the right shape, but `payloadSchema` (`:10-14`) is `.strict()` with `addressSource: ["review_required","pasted","scanned"]`, and `replaceAddress` sets `addressSource` from a `source?: "pasted" \| "scanned"` parameter (`:163`). | §4.3: reused with a **two-line widening** — `addressSource` gains `"sns"`, `payloadSchema` gains the alias evidence keys, `source` gains `"sns"`. Recorded because two artifacts say "unchanged"; the mechanism is unchanged, the enum is not. |
| C7 | "dual-file convention (see the 008/010 headers)" | The Supabase mirror chain carries `013`, `014` and `015` (`supabase/migrations/20261005000*`), but **`016_contact_action_proposal_payload.sql` has no mirror**. The chains are already divergent. | §6.3/§11 Q5: the new migration ships in `src/db/migrations/` with the mirror decision left as an explicit task with a stop condition, rather than inventing a mirror filename for a chain the last migration did not touch. |
| C8 | "**no** new table and **no** new column" (proposal, affected areas) | True for provenance. It is **not** achievable for the idempotency body binding: `replayIdempotentMutation` (`service.ts:929-948`) matches on `(wallet_id, idempotency_key)` only via `readIntentByIdempotencyKey` (`repository.ts:1648-1663`), and the intent row's only hash is `composed_hash`, which is the composed-policy hash and not a body hash. | §6: one additive column (`request_hash` on `recipient_policy_sync_intent`). Flagged as a **divergence from the proposal's wording** that the human can veto; §11 Q4 carries the alternative that needs no column and the reason it is insufficient. |
| C9 | The confirm-time timing block (§5) places re-verification "before the consume transaction" without saying whether it precedes or follows the affirmative wait | `createVoiceContactActions.confirm` (`src/livekit/contact-proposal-publication.ts`) calls `arbiter.waitAndConsume(...)` and only then `dependencies.consume(...)`, which the worker wires to `ContactActionService.consumeInTransaction` (`src/livekit/worker.ts:213-229`). | §4.2 fixes the placement explicitly (after the affirmative, immediately before the persisted consume) and records the rejected alternative. |
| C10 | The screen sequence returns `expiresAt` from the resolve endpoint (§8a) | No resolution TTL exists anywhere in this codebase. The only TTL is the proposal window (`ttlMs = 5 * 60_000`, `contact-actions.ts:63`). | §7: the resolve response carries `resolvedAt` and the UI renders its age. **Explicit deviation** from the discussion's diagram; inventing an expiry would create a second, unevaluated freshness authority next to the proposal TTL. |

---

## 1. The resolver seam

### 1.1 Modules and interface

Two new modules, no others:

- `src/wallet/sns/resolver.ts` — pure orchestration: name normalization, the closed network→root
  map, the header decode, the failure taxonomy, provenance shaping, the injected clock. Imports no
  SDK and no RPC client.
- `src/wallet/sns/transport.ts` — the **only** module that imports `@bonfida/spl-name-service`. It
  owns the RPC connection, the name-account derivation and the account read.

```ts
/** src/wallet/sns/resolver.ts */
export type SnsResolution = {
  /** Canonical: the lowercased label plus its required `.sns` suffix. */
  name: string;
  /** Canonical base58; equal to `observedOwner`, which is the value that was read. */
  address: string;
  nameAccount: string;
  observedOwner: string;
  /** registry.parentName, decoded from bytes 0..32 of the account. */
  observedParent: string;
  slot: number | null;
  resolvedAt: string;
  /** e.g. "sns/solana-devnet/v3" — the value persisted as `provenance.resolver`. */
  resolver: string;
  reverseDomain: string | null;
  reverseDomainState: "present" | "none" | "unknown";
};

export type SnsReverseLookup = { name: string | null; unknown: boolean };

export type SnsResolveFailure =
  | { kind: "malformed_name"; reason: "empty" | "too_long" | "charset" | "suffix_required" }
  | { kind: "unsupported_tld"; suffix: string }
  | { kind: "not_found" }
  | { kind: "ambiguous"; detail: string }
  | { kind: "unreachable"; retryable: true; cause: "rpc_error" | "rpc_throttled" | "timeout" }
  | { kind: "resolver_misconfigured"; reason: "unknown_network" | "no_root" };

export type SnsResolver = {
  resolve(name: string): Promise<
    { ok: true; value: SnsResolution } | { ok: false; failure: SnsResolveFailure }
  >;
  reverseLookup(address: string): Promise<
    { ok: true; value: SnsReverseLookup } | { ok: false; failure: SnsResolveFailure }
  >;
};

export function createSnsResolver(deps: {
  transport: SnsTransport;
  /** The DEPLOYMENT's network, from `CONFIGURED_RECIPIENT_NETWORK`. Never a request field. */
  network: string;
  now?: () => Date;
}): SnsResolver;
```

Three properties of that type, each load-bearing:

- **`resolve` never throws.** Every outcome is a returned union, so the caller's mapping to HTTP
  status, tool result and spoken sentence is total. An exception path here would be the one place a
  "could not reach the chain" could drift into "not found", which M5 forbids.
- **`address` is not a free string.** The resolver returns
  `isValidSolanaAddress(observedOwner) && address === observedOwner`
  (`src/memory/address.ts:10-18`), so the returned address is the one it **read**. It never decodes,
  trims, normalizes or repairs a value from anywhere else, and the existing
  `derivedAddressSchema` (`src/wallet/policy/service.ts:139-145`) remains the last gate before any
  write.
- **`observedParent` is part of the value, not an internal check.** It is what makes "wrong
  network" a refusal instead of an interpretation, and it is the evidence a UI can show.

### 1.2 Normalization: ASCII, explicit suffix, no folding

Normalization happens **before** any transport call and is pure:

1. `trim()` only. **No** `normalize("NFKC")` — deliberately unlike
   `normalizedContactName` (`src/memory/contacts-repository.ts:60-71`), because NFKC folding would
   turn a homoglyph name into a plausible ASCII one, which is exactly what G7 must refuse.
2. A name carrying no suffix at all (`juan`) is `malformed_name: "suffix_required"`, not an implicit
   `.sns` append. *Rejected alternative:* defaulting the suffix so a bare label resolves. It would
   make the suffix not user-supplied, which the revised requirement's second verified source
   requires to be explicit, and it would silently resolve a name the user never named.
3. A name whose suffix is not `.sns` is `unsupported_tld`, with the suffix echoed — **no** fallback
   attempt (§8 G9).
4. The label is lowercased and must match `^[a-z0-9-]{1,63}$`. Anything else (a Cyrillic `а`, a
   zero-width joiner, a space, an emoji) is `malformed_name: "charset"`.
5. The canonical form (lowercased label + `.sns`) is what is resolved, stored in provenance and
   compared by the drift check, so the card and the drift check can never disagree about the name.

### 1.3 Selecting the devnet root without a second source of truth for "which network are we"

`src/wallet/sns/resolver.ts` owns a **closed** map from network to root and takes the network as an
input from `CONFIGURED_RECIPIENT_NETWORK` (`src/memory/address.ts:26`) obtained through its existing
re-export `SOLANA_POLICY_NETWORK` (`src/wallet/policy/service.ts:117`). It never re-declares the
network and never reads one from a body, a query or a stored row.

```ts
const SNS_NETWORKS: Record<string, { root: string; resolverId: string }> = {
  "solana-devnet": {
    root: "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
    resolverId: "sns/solana-devnet/v3",
  },
};
```

- The module adds **a root for a network**, not a new way to decide which network we are on. There is
  no `SNS_NETWORK` variable, and the strict recipient schemas already refuse any `network` other than
  the derived scope.
- **An unknown network fails closed** as `resolver_misconfigured: "unknown_network"`, instead of the
  SDK's mainnet default. *Rejected alternative:* letting the map fall through to
  `SNS_ROOT_DOMAIN_ACCOUNT`'s mainnet root, which would resolve user-facing names against a cluster
  this deployment cannot sign on.
- **The mainnet root `58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx` is deliberately absent.** Adding
  it is a one-line commit that would enable mainnet resolution for a devnet-only deployment and would
  make the persisted `resolverId` describe a network the wallet does not transact on.
- *Rejected alternative:* deriving the root from the RPC URL string. It couples a security-relevant
  derivation to an arbitrary hostname: a custom endpoint would resolve to no root, and a proxied
  mainnet URL would silently resolve against mainnet.
- *Rejected alternative:* inferring the cluster from which root happens to exist on-chain. There is
  no reliable cluster-identity method on the standard RPC surface, and resolution would then depend
  on a race between two deployments.

### 1.4 `SNS_RPC_URL`

Read exactly like the balance surface reads `BALANCE_RPC_URL`
(`src/wallet/balances.ts:237-254`, the `environment.BALANCE_RPC_URL ?? SOLANA_DEVNET_RPC_URL` line at
`:252`), in `src/wallet/sns/transport.ts`:

```ts
export function readSnsTransportConfig(environment: NodeJS.ProcessEnv = process.env): {
  rpcUrl: string;
} {
  // Dedicated variable so resolution can be pointed at a keyed node without
  // touching the balance or transfer preference. Its absence is not a
  // misconfiguration: the keyless public devnet endpoint is the shipped default.
  return { rpcUrl: environment.SNS_RPC_URL ?? SOLANA_DEVNET_RPC_URL };
}
```

`SNS_RPC_URL` is already documented in `.env.example:135-140`, defaulting to
`https://api.devnet.solana.com`. The values are never printed. Nothing here may be chosen from a
public HTTP surface.

### 1.5 Transport, and how the module stays unit-testable without a live RPC

```ts
/** src/wallet/sns/transport.ts — the ONLY module importing @bonfida/spl-name-service. */
export type SnsTransport = {
  /** Derive the name-account PDA for `label` under this network's root. */
  deriveNameAccount(label: string): { pubkey: string };
  /** Read the raw 96-byte name-registry header, or `null` when the account does not exist. */
  readNameRegistry(nameAccount: string): Promise<
    { data: Uint8Array; owner: string; slot: number | null } | null
  >;
  /** The reverse-lookup path (§1.6). */
  readPrimaryDomain(address: string): Promise<
    | { kind: "present"; name: string }
    | { kind: "none" }
    | { kind: "unknown"; detail: string }
  >;
};

export function createSnsTransport(deps: {
  rpcUrl: string;
  fetchImpl?: typeof fetch;
}): SnsTransport;
```

The split is a hard rule, not a nicety:

- **Derivation uses the SDK; the decode is ours.** `deriveNameAccount` calls
  `devnet.utils.getDomainKeySync(label)` from SDK v3.0.23 (resources §5: v4 renamed it to
  `getSnsDomainKeySync` and exports no devnet resolver, which is why v3 is pinned). The account is
  read with `connection.getAccountInfo(pubkey)` and the 96-byte header is decoded **in the resolver**
  (`parentName` = bytes 0..32, `owner` = bytes 32..64, `class` = bytes 64..96 — the layout resources
  §5 records and the intake used to verify both names). *Rejected alternative:* reading through the
  SDK's `NameRegistryState.retrieve`, which decodes internally and throws on the shapes this design
  must classify as `ambiguous`.
- **The transport is injectable, so the resolver's tests never touch the network.** This is the only
  way the feature is testable at all: the public devnet endpoint throttles **per method** and
  **path-dependently** (resources §7: `429 Too many requests for a specific RPC call`; host `curl`
  succeeded while the identical call inside the backend container was refused). A test loop against
  it does not exist.
- *Rejected alternative:* calling `resolve()` from the SDK directly. `resolve()` derives the name
  account under `SNS_ROOT_DOMAIN_ACCOUNT` from `constants.mjs`, which is the **mainnet** root
  `58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx`, so a devnet name is invisible to it.
- *Rejected alternative:* a process-wide resolver cache. A cache is a second source of truth for
  "what does this name resolve to" and can serve an address different from the one the user was
  shown, which is precisely the divergence M6 exists to catch. Memoization is **request-scoped only**,
  and the design states that as a rule rather than leaving it to implementation taste.

#### The live devnet names are the fixtures (real observed bytes)

`01-sns-devnet-resources.md` records two names verified on-chain. They are decoded in tests from
**their observed bytes**, with no RPC call:

| Name | Resolves to | Name account (PDA) |
| --- | --- | --- |
| `sophie.sns` | `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2` | `ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew` |
| `nanatest.sns` | `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` | `6Kcihb6KARkTtrnps8TbPp7H3b69jFxEe5i4hUrxkBps` |

Both have `parentName` equal to the devnet root `5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2`, so
they are genuine TLD children. The fixture bytes are built in test scope with the already-installed
`@solana/web3.js` (`1.98.4`, no new dependency):
`new PublicKey("<parentName>").toBytes()` (32) ++ `new PublicKey("<owner>").toBytes()` (32) ++ 32
bytes for the `class` half. **Honest limit:** the resources file records no `class` value, so the last
32 bytes are synthetic and marked as such in the test; the resolver must not interpret `class` at any
point — it validates only that the account is at least 96 bytes. Recording one real header (including
its `class` half) is an explicit task stop condition (§11 Q6).

The suite this buys, offline: a known-answer decode for both names; a 95-byte account →
`ambiguous`; a header whose `parentName` is a different root → `ambiguous`; `null` account →
`not_found`; a throttled/timeout rejection → `unreachable` (never `not_found`); an unknown network →
`resolver_misconfigured`. `nanatest.sns` is the counter-example fixture: the paid registrar makes the
buyer the name owner, so it resolves to its own payer, which is the "resolves to the wallet's own
address" fixture the self-address refusal (§2.5) needs.

### 1.6 Reverse lookup as a three-state signal that never blocks

`reverseLookup` is classified separately and **never blocks the alias flow**. `readPrimaryDomain`
wraps the SDK call and maps three outcomes: a name → `present`; the recorded "no primary domain"
shape → `none`; **anything else → `unknown`**. `unknown` is never degraded to `none`, because `none`
reads as "nothing to see here" — the state an attacker wants produced. On devnet `none` is the
expected state, and it is a fact about the chain: the resources file records no primary-domain call
at all, and the reverse-lookup PDA's parent is the `REVERSE_LOOKUP_CLASS` seed
`7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H`, which the resources file warns has no account on
devnet **by design** because it is a derivation class seed, not a live account.

The reported SDK failure `getPrimaryDomain → "The primary account does not exist"` is Ramiro's
observation and was not reproduced (the SDK is not installed in this worktree). Classifying an
unrecognized error shape as `none` would turn a failure into a false all-clear, so until one live
observation is recorded the classifier is pinned the other way: only the exact recorded shape maps to
`none` and every other shape is `unknown`. §11 Q1 carries the observation as a stop condition.

---

## 2. Where the alias enters each surface

### 2.1 Screen: one field, one resolve, one save

The create form is two `Input`s plus `api.createContact({name, description, address, network})`
(`apps/nana-wallet/src/features/wallet/AddTrustedRecipient.tsx:132-137`) with a client-side
`solanaAddressPattern` pre-check (`:19-23`, `:110-111`) that stays explicitly labelled as a
pre-check.

1. The address field accepts either form. A value containing `.` is a **name candidate**; a
   base58-shaped value stays the paste path. An explicit "Buscar" action appears for the name form,
   so a user who has the address is never steered into the weaker source (proposal question 1,
   resolved as a peer option).
2. Resolve calls `POST /v1/recipient-aliases/resolve` (`{name}`, strict). On success the field area
   shows, from the server response and nothing else: the resolved address **verbatim and not
   truncated**; the three-state reverse-domain line (§2.4); and the confirmation question
   *"¿La dirección que aparece acá es la correcta para `juan.sns`?"*
3. "Guardar" is enabled only after a successful resolution and posts the **alias arm** of
   `POST /v1/contacts`: `{source: 'sns', name, snsName, expectedAddress, description, network}`.
4. The server re-resolves and requires equality with `expectedAddress` (§4.1). The contact is
   created with the **server's** resolved address and the provenance record of §3.

#### The create body: one strict schema, two arms

`createContactInputSchema` (`src/contracts/http.ts:324-332`) and `recipientCreateInputSchema`
(`src/wallet/policy/service.ts:153-161`) both widen **in the same work unit** (C5), each staying
`.strict()` and gaining:

```ts
source: z.enum(["pasted", "scanned", "sns"]).optional(),
snsName: z.string().trim().min(1).max(70).optional(),
expectedAddress: z.string().trim().min(1).optional(),
address: z.string().trim().min(1).optional(),   // no longer required on the alias arm
```

plus one `.superRefine` that admits exactly two shapes:

- **paste/scan arm** — `address` present, `snsName` absent; `source` absent or `pasted`/`scanned`;
- **alias arm** — `snsName` and `expectedAddress` present, `address` absent, `source === "sns"`.

Anything else is `422 DATOS_INVALIDOS`. *Rejected alternative:* `z.discriminatedUnion("source", …)`.
It is cleaner to read but requires `source` on every request, which breaks the existing paste client
in `apps/nana-wallet/src/lib/api.ts`, and giving `source` a default makes the union non-discriminating
anyway. The refinement keeps the change additive.

**`expectedAddress` can only ever veto, never choose.** The stored address is the one the server
resolves; `expectedAddress` is compared against it and a mismatch is a typed
`409 SNS_DESTINO_CAMBIADO` with nothing written. The client therefore cannot inject a destination, and
— the part that matters — the server cannot silently write an address the user never saw.
*Rejected alternative:* posting `{snsName}` alone and letting the server write whatever it resolves.
Simpler by one field, and it converts the human confirmation into decoration: between the preview and
the submit, a name transfer would silently change the stored destination.

### 2.2 The new optional field on the contact-write input

`RecipientContactWriteInput` (`src/wallet/policy/service.ts:246-251`) is
`{name, description, address, network}`. It gains exactly one field:

```ts
/** Durable per-contact provenance. Written by the alias arm; `{origin:'user'}` otherwise. */
provenance?: Record<string, unknown>;
```

which the service passes through `RecipientContactMutationPort.create` into
`ContactWriteInput.provenance` (§3.2). That is the whole plumbing: **one optional field on one port**,
plus the repository change C1/C2 requires. No new repository method, no new table.

### 2.3 Voice and text: resolve before the proposal exists

Nothing about the gating changes. The sequence stays exactly what
`trusted-recipient-policy-sync` built:

```
stage → resolve (I/O, no transaction) → persist proposal → publish card to the BOUND participant
      → await delivery → mark published → arbiter.open(contact window) → authenticated affirmative
      → re-verify → consume once
```

- **Model surface.** `contactCreateInputSchema` (`src/agent/definition.ts:113-116`) gains an optional
  `snsName` (`.strict()` retained; still no `address`, `network`, `policyId`, `signerId`, cap,
  confirmation, timestamp or turn count). The model may pass a name it heard —
  *"agregá a juan.sns"* → `{name: 'Juan', snsName: 'juan.sns'}` — and can never pass an address, so
  the forbidden inference has no surface to travel on.
- **Resolve before persisting.** The stage path resolves first, outside any transaction. On failure
  the tool returns the typed refusal and **no proposal is created and no card is published**, so a
  broken name produces a spoken sentence rather than a broken card. On success the proposal is
  persisted **with** the resolved address in `contact_action_proposals.address` and with
  `payload` `{addressSource: "sns", snsName, resolvedAt, resolver, reverseDomain, reverseDomainState}`
  (§2.4).
- **The card carries the address, and the spoken sentence asks about the screen.** The tool result
  message becomes the server-owned sentence the model relays: *"Resolví `juan.sns` a la dirección que
  aparece en la tarjeta. ¿Es la correcta?"* — the alias is spoken, the address is shown, and the raw
  address is never read aloud (the existing narration rule in
  `trusted-recipient-policy-sync`'s design §8.3 is preserved).
- **No bound visual client ⇒ refusal, unchanged.** `createVoiceContactActions.stage` already returns
  `address_review_required` with `REVIEW_CHANNEL_MESSAGE` when `boundParticipantIdentity` is absent
  (`src/livekit/contact-proposal-publication.ts`). That guard carries *more* weight on the alias path:
  it is the only thing preventing a spoken name from becoming a permission with no displayed address
  at all. It must not be relaxed, and the spec keeps its scenario.
  *Rejected alternative:* creating the contact from the alias alone when no bound client exists,
  "because a name is safer than a spoken address". It is not: with no display the user never sees the
  destination, so it removes M2 while keeping the weaker source.

### 2.4 The card

`ContactActionProposalCard.tsx` renders the persisted row and nothing else (its stated invariant), and
already renders `proposal.address` (`:213-215`). Three additive lines, all from the persisted row:

- alias line: *"Este destinatario se agregó por `juan.sns`."* — the alias with its suffix, never
  truncated, in the same font as the address;
- reverse-domain line, three honest states, never collapsed:

| State | Text | Rationale |
| --- | --- | --- |
| `present` | "El nombre principal de esta dirección es `…`." | Corroboration only. |
| `none` | "Esta dirección no tiene un nombre principal registrado." | The expected devnet state. A fact about the chain — not a failure, not disagreement, and not a reason to refuse. |
| `unknown` | "No pude verificar si esta dirección tiene un nombre principal." | An unrecognized error shape. Never rendered as `none`. |

- a freshness line built from `payload.resolvedAt` labelled with its age (O3), which is a transparency
  affordance and never the guard.

The proposal-level plumbing: `payloadSchema` (`src/wallet/policy/contact-actions.ts:10-14`) widens
additively with `addressSource: "sns"` plus optional `snsName`, `resolvedAt`, `resolver`,
`reverseDomain`, `reverseDomainState`, `reverify`. No migration: `contact_action_proposals.payload` is
JSONB with no CHECK on its keys (`016`).

### 2.5 Duplicate disclosure (D13) and the self-address refusal

- **Duplicate address ⇒ disclose and proceed.** Before the alias-arm create writes, the service reads
  the active contacts holding the resolved address. When one exists it is disclosed **by name**
  ("Esta dirección ya está en tu lista como Mamá; `juan.sns` apunta al mismo lugar y no cambia a quién
  le podés pagar") and the add proceeds. No grant is created or revoked: the composed allowlist is a
  set (`composer.ts` `sortedUnique`), so a second label for an address the user already trusts adds no
  authority. The disclosure is carried on the create response as a bounded field
  (`duplicateOf: {contactId, name} | null`) so both surfaces render the same fact rather than each
  guessing. The alias path is deliberately **not** stricter than the paste path for the same address.
- **The wallet's own address ⇒ always refused.** A typed `409 DIRECCION_PROPIA` on every surface that
  creates or replaces a trusted recipient. This needs the wallet's address, and `readReadySolanaWallet`
  (`src/wallet/policy/repository.ts:1492-1509`) currently selects only `id, chain_family` and returns
  `{walletId, chainFamily}`. The SELECT gains `address` and `ReadyPolicyWallet` gains `address`, so the
  comparison is against the server's own record and never against a client-supplied value.
  *Honest boundary:* with no ready Solana wallet there is no own address to compare against, so the
  refusal is vacuous there — and so is the risk, because the same branch writes a contact with no
  policy at all. Stated rather than implied.
- Admitting `source: "sns"` into `payloadSchema.addressSource` is an additive enum widening on a JSONB
  payload with no key CHECK, so **no migration** is needed for it.

---

## 3. Freeze and provenance

### 3.1 The persisted shape

`recipients.provenance` already exists as `JSONB NOT NULL DEFAULT '{}'::jsonb`
(`001_recipient_memory.sql:15`), so **no new table and no new column** is needed for provenance:

```jsonc
// recipients.provenance for a contact added by alias
{
  "source": "sns",
  "name": "juan.sns",                                  // canonical, lowercased, suffix included
  "resolvedAt": "2026-10-10T18:04:11.482Z",
  "resolver": "sns/solana-devnet/v3",
  "reverify": "verified",                              // 'verified' | 'unavailable'
  "nameAccount": "…",                                  // evidence (O2)
  "observedOwner": "…",                                // == recipients.address, recorded as read
  "observedParent": "5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2",
  "slot": 509688088,
  "reverseDomain": null,
  "reverseDomainState": "none"
}
```

The four names the spec's M3 requires are `source`, `name`, `resolvedAt`, `resolver`; the rest is
evidence kept inside the same object so there is one read path and no join. `reverify` is explicit
rather than absent-on-success on purpose: "absence" would be ambiguous between "the re-resolution
agreed" and "no re-verification happened", and this design does not let an ambiguous absence stand in
for a security property.

**The paste/scan path records `{origin:'user', source:'pasted'|'scanned'}` in the same object**, so
"what was this address's source" has one vocabulary instead of "an object for aliases, nothing for
everything else". *Rejected alternative:* leaving the paste path at the current literal and making
`source:'sns'` the only possible value. It would leave the absence of provenance ambiguous between
"pasted" and "written before this feature existed" — the kind of ambiguity that later gets read as a
security property.

### 3.2 The plumbing, with the two corrections the code required

1. `ContactWriteInput` (`src/memory/contacts-repository.ts:17-22`) gains
   `provenance?: Record<string, unknown>`, and `create`'s hardcoded
   `JSON.stringify({ origin: "user" })` (`:132`) becomes
   `JSON.stringify(input.provenance ?? { origin: "user" })`. **Correction C1.**
2. `RECIPIENT_COLUMNS` (`:77-78`) gains `provenance` and `RecipientRow`/`ContactRecord` gain the
   field, so a read can report the alias. **Correction C3** — this is what makes §7's
   `alias | null` on `contactSchema` possible at all.
3. `RecipientContactWriteInput.provenance` (§2.2) is passed straight through the mutation port to
   `ContactWriteInput.provenance`.
4. The alias arm is the **only** caller that sets a non-default provenance.

### 3.3 The address-edit rule

`ContactsRepository.update` currently never writes `provenance` (**C2**), so replacing the address of
an alias-created contact would leave `provenance` claiming `juan.sns → <old address>`, and a later
drift check would compare against an alias for an address the contact no longer has — reporting "no
drift" for a name that has nothing to do with the current destination. The patch therefore gains
`provenance?: Record<string, unknown> | null` and one conditional column write:

```
nextProvenance =
  addressChanged ? (input.provenance ?? {})      // clear by default; a missed caller clears,
  : (input.provenance ?? row.provenance)         // never leaves a stale alias claim
```

*Rejected alternative:* requiring the caller to pass `provenance` whenever it changes the address. A
single missed caller would then leave a stale claim, which is precisely the failure the requirement
exists to prevent; the fail-safe default clears instead of lying.

Consequences, both deliberate: **renaming never invalidates a freeze** — a metadata-only edit produces
an identical composed rule set (held by the existing assertion in
`src/wallet/policy/service.ts`) and leaves `provenance` untouched; and the replacement address is
validated exactly as before, so an alias-origin contact is not a second-class citizen in the edit
path. The composed rules are unchanged either way, because the alias lives in a column the composer
never reads.

### 3.4 Why the composer is not touched

There are three things called provenance in this codebase and confusing them is the easiest mistake
here:

| | What it is | Writer | Reader | Changes here? |
| --- | --- | --- | --- | --- |
| `recipient_policy_state.consent_provenance` | The **enrollment** snapshot, written once and never re-derived | the enrollment capture | carried by the composer without interpretation | **no** |
| `ComposedPolicy.provenance` | `Record<address, 'baseline'\|'contact'\|'grant'>` — **membership** | `composePolicy` | the readback comparator, check (d) | **no** |
| `recipients.provenance` | **Per-contact** durable provenance: where this address came from | the contact write port | the contact read surface and the drift check | **yes — the new one** |

`composePolicy`'s contact input is `Array<{id, version, address}>` (`src/wallet/policy/composer.ts:99-101`).
It never sees a name and after this change still never will, so the allowlist, the 0.01 SOL ceiling,
the grant rules, `applied_rules_hash`, the readback comparator and `applied_recipients` see zero
difference. Nothing about SNS reaches the rule path, and there is no code path in which a **name**
rather than an address could reach a rule — which is the structural reason the alias can never become
a payment target.

---

## 4. Re-verification at confirm time

The spec's ADDED requirement *An alias-resolved destination is re-verified before the address is
authorized* is satisfied in two places, matching its two paths. In both, remote I/O stays outside the
contact transaction, and no memoization may serve an address other than the one obtained for the
request being authorized.

### 4.1 The contact-add path (screen, and the card's paste/use action)

`RecipientPolicyService.create`'s alias arm, before the lease and before the mutation transaction:

```
1  resolve(snsName)                                   ← I/O, no transaction, no lease
2  failure → typed refusal (§1.2 taxonomy), nothing staged, nothing persisted
3  resolution.address !== expectedAddress → 409 SNS_DESTINO_CAMBIADO, nothing written
4  ownership / duplicate / self-address checks (§2.5)
5  withPolicyLease → tx{ contact write + provenance + desired_revision + intent } → apply
```

`expectedAddress` is compared and can only veto. The stored address is the one step 1 read, so the
server cannot write an address the user never saw, and the client cannot inject one.

### 4.2 The review-card path: exact placement against the one-use consume

`createVoiceContactActions.confirm` (`src/livekit/contact-proposal-publication.ts`) calls
`arbiter.waitAndConsume(...)` and only then `dependencies.consume(...)`, which the worker wires to
`ContactActionService.consumeInTransaction` (`src/livekit/worker.ts:213-229`) — the persisted one-use
`UPDATE`. The re-verification is placed **after `waitAndConsume` returns `consumed` and immediately
before `dependencies.consume(...)`**, through one new optional dependency:

```ts
reverifyAlias?: (input: {
  userId: string; proposalId: string; proposalVersion: number;
}) => Promise<
  | { status: "not_alias" }                                  // no alias provenance on this version
  | { status: "unchanged" }
  | { status: "unavailable" }
  | { status: "changed"; supersededProposalVersion: number; observedAddress: string }
>;
```

*Rejected alternative:* re-verifying before `waitAndConsume`. It reads more naturally ("check, then
wait for the yes"), but it leaves the whole bounded affirmative window (up to 2 000 ms) inside the
unchecked interval, so the address compared would be up to two seconds older than the one being
authorized. The spec says "at the moment the address is authorized", so the check goes as close to
that moment as possible.

*Rejected alternative:* making the consumption itself conditional on the re-verification inside one
transaction. Remote I/O inside the contact transaction is forbidden, and a name transfer between the
re-resolve and the commit is not closable without trusting an unverifiable slot or blockhash.

### 4.3 The supersede path

A difference produces a **new immutable version** — the `replaceAddress` shape, not a new shape.
`ContactActionService.replaceAddress` (`src/wallet/policy/contact-actions.ts:155-168`) already
supersedes the old row, inserts `version + 1` with `supersedes_id` and `previous_address`, and leaves
`published_at` NULL on the new row, so the window can only re-open after a successful re-publish
(§2.3's publication-gates-window rule). Drift-at-confirm is the same situation with a chain-derived
new address, so it reuses that path. **Two additive widens are required (correction C6):**
`payloadSchema.addressSource` gains `"sns"`, the payload gains the alias evidence keys, and
`replaceAddress`'s `source` parameter gains `"sns"`. The mechanism is unchanged; the enum is not.

One more detail the spread pattern would get wrong: `replaceAddress` currently builds the new payload
as `{...original.payload, addressSource: input.source}`. On an alias-origin proposal, a **paste**
supersede must **clear** `snsName`/`resolvedAt`/`resolver`/`reverseDomain*`/`reverify`, so the payload
is constructed explicitly per arm rather than by spreading. Otherwise the new version would carry a
stale alias claim for an address the user replaced — the proposal-level form of the same failure
RAM-010's fourth scenario forbids at the contact level.

After a `changed` result the worker **re-publishes** the card for version *n+1*, stamps
`published_at`, opens the arbiter window for *n+1* and clears the window for *n*, then returns the
existing `confirmation_required` status with `currentProposalId`/`currentProposalVersion` set to
*n+1* — so the model asks again and the user confirms the newly displayed address. No new status, no
new arbiter code, and version *n* is never consumed.

### 4.4 The unreachable asymmetry, stated in the code

**Difference ⇒ fail closed; unreachable ⇒ proceed with the frozen address, labelled
`reverify: 'unavailable'`.** The asymmetry is deliberate and is worth a code comment, because
"fail closed on any re-verification failure" is the safer-sounding choice someone will ask for: with
the devnet RPC throttling per method and path-dependently, making the confirmation of an address the
user is already looking at depend on a fresh read would let a throttled endpoint block the user from
adding a contact. The re-verification is a **divergence detector**, not an authority gate: it cannot
widen anything, because nothing is authorized except the address the user was shown.

Recording `reverify: 'unavailable'`: on the card path the consumption proceeds and the record lands
in the **contact** provenance, written by the contact-add arm of §4.1 — which re-resolves too and
records its own outcome (`'verified'` when it agreed, `'unavailable'` when it could not be reached).
One record shape, written where the address is actually stored.

*Stated residual (the "consumed but not stored" edge):* if the pre-consume re-verification is
unreachable and proceeds, and the later contact-add re-resolution then succeeds and finds a
**different** address, the contact-add arm refuses with `409 SNS_DESTINO_CAMBIADO` while the proposal
has already been consumed. Nothing is stored, nothing is authorized for an address the user did not
see, and the recovery is to stage a fresh proposal (the card then shows nothing open). This is the
honest cost of not putting an RPC call inside the transaction.

**Proposal TTL is an affordance and is never the guard.** The existing 5-minute TTL
(`contact-actions.ts:63`) bounds the window; the guard is the re-resolve equality at confirm. A
preview submitted an hour later is still safe, because the server resolves again and compares.

---

## 5. Drift

### 5.1 What it is, and when it is checked

The stored provenance names `juan.sns`; later, `juan.sns` resolves to address B while the stored
address is A. That is drift — a **fact to report**, not a state to converge.

| Trigger | Chosen? | Why |
| --- | --- | --- |
| Confirm time, on the alias being added | **Yes** | Mandatory (M6). One read on a path that already performed one. |
| On demand, user-initiated | **Yes** | `POST /v1/contacts/:id/check-alias`: explicit, bounded, single-contact, and it puts the read where a human is already looking. |
| On `GET /v1/contacts` | **No** | It would put N RPC reads on a read path, make the contact list slow or fail because of a third-party registry, and change a read into a write (the drift evidence) — a `GET` with side effects. |
| At transfer preview or send time | **No** | The spec forbids re-resolution for a payment, and it would re-introduce the mutable destination. This is M4 and it is absolute. |
| A background daemon | **No, in this change** | No periodic job exists in this feature's scope and adding one is new operational surface (§11 Q7). |

### 5.2 The endpoint and the write

```
POST /v1/contacts/:id/check-alias   (authenticated, no body)
  → resolve the contact (RLS-scoped, status='active')
  → no alias provenance                       → 409 CONTACTO_SIN_ALIAS
  → resolve(provenance.name)
     ├─ equal to the stored address           → 200 {state:'unchanged', storedAddress}
     ├─ different / not_found                 → 200 {state:'changed', storedAddress,
     │                                              observedAddress, reason:'destination_moved'
     │                                              | 'name_no_longer_exists'}
     │                                          + provenance.drift + audit('alias_destination_changed')
     └─ unreachable / misconfigured           → 200 {state:'unavailable', storedAddress}
```

The drift write is a **single guarded `UPDATE` on one JSONB column**, inside a plain
`withUserTransaction`, with no policy lease (`W1`), no `desired_revision` advance, no revision bump and
no recomposition:

```sql
UPDATE recipients
   SET provenance = jsonb_set(provenance, '{drift}', $4::jsonb, true)
 WHERE user_id = $1 AND id = $2 AND status = 'active'
   AND address = $3                           -- the address the check compared against
   AND provenance->>'name' = $5               -- the alias the check resolved
RETURNING id
```

The `address` and `name` predicates are the atomicity guard: if a concurrent address edit (or a
provenance rewrite) landed between the read and the write, the statement affects zero rows and the
drift claim is **skipped** rather than attached to a contact it no longer describes. Zero rows is
reported as `state: 'unavailable'` with `reason: 'contact_changed'`, never as `changed`.

`state` is returned with HTTP 200 for all three outcomes on purpose: an unreachable resolver is
*unknown*, not an error the caller must retry, and an unverifiable third-party registry must not turn
the user's own contact list into a failing request. Only `misconfigured` is reported in the audit as a
`blocked_configuration`-class operational stop.

*Stated boundary:* `recipient_policy_audit.wallet_id` is `NOT NULL` with an FK to `user_wallets`
(`015`), so appending the audit row requires a ready Solana wallet. An alias-origin contact can exist
without one (the `create` no-ready-wallet branch writes the contact and reports
`saved_not_configured`). In that case the drift state is still returned and the audit row cannot be
appended; the `provenance.drift` record is still written, so the evidence is not lost, and this is
stated rather than silently omitted.

### 5.3 Where the evidence lives

- `recipients.provenance.drift = {observedAddress, observedAt, resolver}` — the per-contact record.
- one append-only `recipient_policy_audit` row with event **`alias_destination_changed`**.

`alias_destination_changed` widens the closed `recipient_policy_audit_event_ck` CHECK
(`015_recipient_policy_sync.sql:229-234`) by exactly one value, in an additive migration.
*Rejected alternative:* reusing the existing `drift_repaired` event. That event means "the reconciler
converged the policy", which is the opposite of "nothing changed here"; reusing it would make the
audit assert the reverse of what happened. §11 Q5 carries the alternative of writing no audit row at
all and relying on `provenance.drift` only.

### 5.4 The two guarantees, and why they hold

- **Drift never blocks a payment.** Nothing on the transfer, preview or compose path reads
  `provenance.drift`; the composed allowlist is built from `recipients.address`. This is a deliberate
  choice against the tempting "fail closed" reflex: a third party who transfers or re-registers a name
  must not be able to disable the user's trusted recipient. Blocking on drift would hand a stranger a
  denial-of-service lever over the user's own payment ability, and the security property is already
  intact because the destination cannot move. A structural test asserts no file on the
  transfer/preview/compose path reads the drift key or imports the SNS module.
- **Drift never auto-follows.** If a later resolution could update the destination, the destination
  would be mutable by whoever controls the name, and consent would be to *a name* rather than *an
  address*. Auto-following would not merely be unsafe: the composed allowlist would change with no
  user action, `applied_rules_hash` would drift from `desired_rules_hash`, the readback comparator
  would report a rules mismatch, the grant gate's predicates would fail and every sibling grant of
  that wallet would degrade to manual confirmation. That is the deepest reason M3/M4 are mandatory.

The reported notice, with the user's authority intact: *"`juan.sns` ahora apunta a otra dirección. Tu
destinatario de confianza sigue siendo `<stored address>`; no cambié nada."* Options: **keep**,
**replace** (a full address edit with disclosure, recomposition and the atomic provenance rewrite of
§3.3), or **remove**. Per proposal question 4, "keep" silences nothing permanently: the check is
user-initiated and drift is re-reported on each explicit check, because a permanent silence would turn
a one-time answer into a standing claim the user never made.

---

## 6. The idempotency gap

### 6.1 What exists, and what it does on the alias path

`Idempotency-Key` is durable on `recipient_policy_sync_intent.idempotency_key`, unique per wallet
(`015_recipient_policy_sync.sql:144-146`), and a replay returns the stored result without a second
composition, PATCH or audit row (`src/wallet/policy/service.ts:921-948`). The lookup is
`readIntentByIdempotencyKey` (`repository.ts:1648-1663`), matching `(wallet_id, user_id,
idempotency_key)` — **the body is not bound**. `composed_hash` is the composed-**policy** hash, not a
body hash, so it cannot serve this purpose.

For the paste path that is invisible: the body is the address, so a replay of the same key with a
different address still yields one contact and the user's effective intent. For the alias path it is
user-visible and wrong: a client that asked to add `maria.sns` receives a `201` describing the
contact created for `juan.sns`.

### 6.2 The fix

One additive column and one comparison:

- `017` adds `request_hash TEXT` to `recipient_policy_sync_intent` (`ADD COLUMN IF NOT EXISTS`).
- `runMutation`/the intent insert writes `request_hash = sha256(canonicalMutationBody)` computed from
  the **parsed** body (§2.1's schema output, not the raw JSON) with an explicitly declared key order
  and sorted arrays, exactly like the composer's canonical form
  (`src/wallet/policy/design` §3.2 item 5 precedent: a declared key order, never `Object.keys`
  order).
- `replayIdempotentMutation` compares the recomputed hash against `intent.requestHash` and, on a
  mismatch, raises a typed `409 IDEMPOTENCIA_CUERPO_DISTINTO` instead of returning the stored contact.
  A `NULL` `request_hash` (a row written before `017`, or by a path that supplies no key) is treated
  as **not comparable** and falls back to today's behaviour, so the guard is additive and cannot
  break an in-flight replay.

### 6.3 The committed cost, stated rather than buried

This adds a **column** where the proposal's affected-areas table says "no new column". The constraint
that sentence expresses — no new table and no new column **for provenance** — is respected
(`recipients.provenance` is untouched), and the divergence is recorded here so the human can veto it.
§11 Q4 carries the alternative that needs no column, and why it is insufficient.

*Rejected alternative:* deriving the body binding from the stored contact — compare the requested
alias name against `provenance.name` and `expectedAddress` against `recipients.address`. It needs no
schema change and covers the alias-visible case, but it **falsely conflicts after a legitimate
rename** (the stored label is user-owned and mutable, so a replay after a rename would be reported as
a different request), and it cannot detect a differing `description` at all. A request hash is bound to
the request, not to a row the user may edit. Rejected.

*Pre-existing boundary, not fixed here:* the no-ready-wallet branch of `create`
(`service.ts:731-740`) never consults the idempotency key at all, because it writes no intent. A
replay in that branch creates a second contact today. This change does not alter that, must not
narrate it as fixed, and records it in §11 Q8.

---

## 7. HTTP contract delta

`src/contracts/http.ts` and `apps/nana-wallet/src/lib/api-types.ts` change together in the same work
unit (hard repo rule, `AGENTS.md`), with `apps/nana-wallet/src/lib/api.ts` and
`apps/nana-wallet/src/mocks/handlers.ts` mirrored in the same unit.

| Method + path | Body / params | Success | Errors |
| --- | --- | --- | --- |
| `POST /v1/recipient-aliases/resolve` | `{name}` + header `Idempotency-Key?` — read-only, no side effects | `200 {ok:true,data:{name,address,resolvedAt,resolver,reverseDomain,reverseDomainState}}` | `422 DATOS_INVALIDOS` (`malformed_name`), `422 NOMBRE_NO_SOPORTADO`, `404 NOMBRE_NO_ENCONTRADO`, `409 NOMBRE_AMBIGUO`, `503 RESOLVEDOR_NO_DISPONIBLE` |
| `POST /v1/contacts` | widened (§2.1): the alias arm `{source:'sns', name, snsName, expectedAddress, description, network?}`; the paste arm unchanged | `201 {ok:true,data:Contact}` plus the disclosure field (§2.5) | existing codes verbatim, plus `409 SNS_DESTINO_CAMBIADO`, `409 DIRECCION_PROPIA`, `409 IDEMPOTENCIA_CUERPO_DISTINTO`, `422 NOMBRE_NO_SOPORTADO`, `404 NOMBRE_NO_ENCONTRADO`, `409 NOMBRE_AMBIGUO`, `503 RESOLVEDOR_NO_DISPONIBLE` |
| `POST /v1/contacts/:id/check-alias` | — | `200 {ok:true,data:{state:'unchanged'\|'changed'\|'unavailable', storedAddress, observedAddress?, reason?}}` | `404 CONTACTO_NO_ENCONTRADO`, `409 CONTACTO_SIN_ALIAS` |

- **No existing field changes name, type or optionality, and no response gains a wrapper object** —
  the current `{ok:true,data}` envelope is preserved so `api.ts` and the MSW handlers change
  additively. `RECIPIENT_POLICY_ERROR_CODES` (`src/contracts/http.ts:286-293`) and the mirrored
  `ErrCode` (`apps/nana-wallet/src/lib/api-types.ts:15-40`) widen together.
- **The resolve endpoint is a read with no side effects.** It writes nothing: no proposal, no
  contact, no audit, no cache. A resolved address is not yet an authorization.
- **`expiresAt` is deliberately absent** from the resolve response (correction C10) — no resolution
  TTL exists, and the UI renders the age of `resolvedAt` instead of inventing one.
- **Nothing in the resolve response is a secret or key material**, and the closed field set is
  asserted by a test that fails if the serialized payload contains a key matching
  `secret|key|signature|token|appSecret|seed`. `observedOwner` and `nameAccount` are **not** returned
  to the client: they are server-side evidence. The client needs exactly one address to display and
  to echo as `expectedAddress`.
- **`snsName` is never accepted on the voice tool's `confirm` schema**, only on `create` — the model
  supplies a name to *stage*, never to authorize with.

---

## 8. Sequence diagrams

### (a) Add a trusted recipient by alias — screen

```mermaid
sequenceDiagram
  autonumber
  actor U as User (screen /perfil)
  participant FE as Nana frontend
  participant API as Backend /v1
  participant SNS as SNS resolver (src/wallet/sns)
  participant RPC as Solana RPC (SNS_RPC_URL)
  participant SVC as RecipientPolicyService
  participant DB as Postgres
  participant CMP as Policy composer
  participant P as Privy API

  U->>FE: "juan.sns" + Buscar
  FE->>API: POST /v1/recipient-aliases/resolve {name}
  API->>SNS: resolve("juan.sns")
  SNS->>SNS: normalize (lowercase, .sns required, ASCII charset)
  SNS->>RPC: derive name account under the devnet root, read the 96-byte header
  RPC-->>SNS: {parentName, owner, class}, slot
  SNS->>SNS: observedParent == devnet root AND isValidSolanaAddress(owner)
  SNS->>RPC: reverse lookup of owner (primary domain)
  RPC-->>SNS: present / none / unknown
  SNS-->>API: {address, resolvedAt, resolver, reverseDomain, reverseDomainState}
  API-->>FE: 200 (no write anywhere)
  FE-->>U: the ADDRESS verbatim + the three-state reverse line + "¿Es la correcta para juan.sns?"
  U->>FE: Guardar
  FE->>API: POST /v1/contacts {source:'sns', name, snsName, expectedAddress}
  API->>SNS: resolve("juan.sns")   again, now
  alt still resolves to expectedAddress
    API->>SVC: create(userId, {name, address, provenance}, {idempotencyKey})
    SVC->>SVC: isValidRecipientAddress(address, 'solana-devnet') · duplicate disclosure · self-address refusal
    SVC->>DB: W1 lease → tx{ W0(U) → L3 → L5 } → commit
    Note over SVC,DB: contact + provenance + desired_revision + intent (+ request_hash), one transaction
    SVC->>CMP: composeAndApply(walletId, revision)
    CMP->>P: readback → patchPolicy(addresses only) → readback verify
    CMP->>DB: CAS applied revision → signer_grants refresh → audit
    SVC-->>API: {contact, permission}  (never "enabled" before the readback)
    API-->>FE: 201 {ok:true, data:contact} + duplicateOf?
  else the name moved since the preview
    API-->>FE: 409 SNS_DESTINO_CAMBIADO
    Note over API,FE: nothing written, no contact, no policy write; the UI re-resolves and asks again
  else the resolution is the user's own address
    API-->>FE: 409 DIRECCION_PROPIA
  else resolver unreachable
    API-->>FE: 503 RESOLVEDOR_NO_DISPONIBLE
    Note over API,FE: NOT reported as "does not exist"; the paste path stays available
  end
```

### (b) Add a trusted recipient by alias — voice, with the card as the confirmation

```mermaid
sequenceDiagram
  autonumber
  actor U as User (voice, bound client on screen)
  participant LLM as Realtime model (Nani)
  participant WK as Voice worker
  participant SNS as SNS resolver
  participant DB as Postgres
  participant ARB as Confirmation arbiter (per session)
  participant FE as Bound review card (screen)

  U->>LLM: "agregá a juan.sns a mis destinatarios de confianza"
  LLM->>WK: stage_trusted_recipient({name:'Juan', snsName:'juan.sns'})
  Note over LLM,WK: no address field exists on this schema — .strict()
  WK->>SNS: resolve("juan.sns")
  alt resolution ok
    WK->>DB: insert contact_action_proposals (address = resolved, payload addressSource:'sns')
  else not_found / unsupported / ambiguous / unreachable / self-address
    WK-->>LLM: typed refusal (distinguishable)
    LLM-->>U: "No encontré juan.sns" / "No pude consultar la red ahora"
    Note over WK,DB: no proposal, no card, no window — nothing to authorize
  end
  WK->>WK: publish reliable card to the BOUND participant identity
  WK->>FE: contact_action_proposal (address, snsName, reverseDomain…)
  FE-->>U: renders the ADDRESS (untruncated), the reverse-domain line, the freshness line
  WK->>DB: UPDATE … SET published_at = now() WHERE version = n AND status='open'
  Note over WK,ARB: publication success GATES the window
  WK->>ARB: open({kind:'contact', actionId, version:n})
  WK-->>LLM: "Resolví juan.sns a la dirección que aparece en la tarjeta. ¿Es la correcta?"
  LLM-->>U: asks the question (alias spoken, address shown, never read aloud)
  U->>ARB: "sí" (final, authenticated transcript, after the proposal)
  LLM->>WK: confirm_trusted_recipient_action({proposalId, proposalVersion})
  WK->>ARB: waitAndConsume({kind:'contact', actionId, userId, version}) → consumed once
  WK->>SNS: re-verify "juan.sns" still resolves to the displayed address
  alt unchanged
    WK->>DB: consume UPDATE (one-use) inside the contact mutation transaction (L5)
    WK->>SNS: the contact-add arm resolves again and compares against expectedAddress
    WK->>DB: tx{ contact + provenance (+reverify:'verified') + intent } → apply → readback
    WK-->>LLM: consumed; honest resulting status
  else changed
    WK->>DB: replaceAddress → supersede v(n), insert v(n+1) with the NEW address (published_at NULL)
    Note over WK,FE: v(n) is never consumed; the window re-opens ONLY for v(n+1) after re-publication
    WK->>FE: re-published card for v(n+1)
    WK-->>LLM: confirmation_required {currentProposalId, currentProposalVersion = n+1}
    LLM-->>U: "La dirección cambió; mirá la tarjeta nueva y confirmame otra vez."
  else unreachable
    Note over WK,DB: proceed with the displayed address; the contact provenance records reverify:'unavailable'
  end
```

### (c) Drift detection

```mermaid
sequenceDiagram
  autonumber
  actor U as User
  participant FE as Frontend (contacts / card)
  participant API as Backend /v1
  participant SNS as SNS resolver
  participant RPC as Solana RPC (SNS_RPC_URL)
  participant DB as Postgres
  participant CMP as Policy composer
  participant P as Privy API

  U->>FE: "verificar nombre" on the contact created by juan.sns
  FE->>API: POST /v1/contacts/:id/check-alias
  API->>DB: read the contact (address A, provenance {name:'juan.sns', …})
  API->>SNS: resolve("juan.sns")
  alt still resolves to A
    SNS-->>API: A
    API-->>FE: {state:'unchanged', storedAddress:A}
    Note over API,DB: no write, no revision, no composition
  else now resolves to B, or the name no longer exists
    SNS-->>API: B / not_found
    API->>DB: UPDATE recipients SET provenance.drift = {observedAddress:B, observedAt, resolver}
    Note over API,DB: guarded by address = A AND provenance->>'name' = 'juan.sns'; zero rows ⇒ skipped
    API->>DB: audit('alias_destination_changed')
    Note over API,DB: the stored address stays A — no contact write, no revision, no revoked grant
    API-->>FE: {state:'changed', storedAddress:A, observedAddress:B, reason:'destination_moved'}
    FE-->>U: "juan.sns ahora apunta a otra dirección. Tu destinatario sigue siendo A; no cambié nada."
    U->>FE: keep  |  replace with B  |  remove
    alt replace
      FE->>API: PATCH /v1/contacts/:id {address:B, expectedVersion, expectedRevokedGrantIds}
      API->>DB: tx{ address edit + provenance rewrite (alias claim cleared) + last-alias grant revocation }
      API->>CMP: composeAndApply → PATCH rules → readback verify
      CMP->>P: the policy now carries B, not A
    end
  else resolver unreachable or misconfigured
    API-->>FE: {state:'unavailable', storedAddress:A}
    Note over API,FE: reported as unknown — never as "changed" and never as "still fine"
  end
```

---

## 9. What could make this dangerous

Carried forward from the discussion's §9, with the concrete guard for each and an honest statement of
what remains.

| # | Threat | Concrete guard | Residual, stated |
| --- | --- | --- | --- |
| G1 | **A squatted or mis-told name.** The chain answer is authoritative and points at the squatter. | Display the **address** (M2), record the freeze (M3), disclose a duplicate address (D13), refuse the self-address. | **Real and irreducible by this feature.** A user with nothing to compare against cannot detect it. The product must not imply that an alias-sourced contact is verified identity, and the reverse-domain line is offered only as a corroborating signal. |
| G2 | **A name transferred between resolve and confirm.** | M6: re-verify immediately before the persisted consume; a difference **supersedes** instead of adopting; the window re-opens only for the new version. | Milliseconds between the re-verify and the commit (§4.2). Non-redirecting, because the stored value is the address the user saw. |
| G3 | **A name transferred after the contact exists (drift).** | M3 freeze + M4: the stored address never changes; drift is reported and never auto-followed; it **never blocks a payment**. | The user may keep paying A forever if they ignore the notice. Deliberate: the alternative is a stranger-controlled switch on the user's money. |
| G4 | **A throttled or unreachable resolver.** | M5: `unreachable` is a distinct typed outcome → `503 RESOLVEDOR_NO_DISPONIBLE`, never "not found"; nothing is staged; the paste path remains; the last resolution stays visible labelled with its age. | The alias path is simply unavailable while the RPC is, and the keyless default cannot serve a test loop (§10). Recorded as an operational prerequisite. |
| G5 | **The resolved address already belongs to another active contact.** | Disclose it **by name** and proceed (D13). No authority changes: the allowlist is a set. | Confusion only; the disclosure is what makes it informative. |
| G6 | **A resolution on the wrong cluster.** | Three stacked refusals: (i) derive under the **configured** network's root; (ii) require `observedParent === configured root`, else `ambiguous`; (iii) require `isValidSolanaAddress(observedOwner)` and `address === observedOwner`. Plus an unknown network failing closed as `resolver_misconfigured`. | None for the devnet deployment. A base58 value that is 32 bytes *is* a Solana key, so a cross-family value cannot pass (iii); cluster confusion is what (i)+(ii) close. |
| G7 | **Homoglyph / confusable names.** `juan.sns` vs a Cyrillic `а`, a dotless `ı`, a zero-width joiner, trailing whitespace. | Lowercase + ASCII charset + length, refusing non-ASCII as `malformed_name`; **no NFKC folding**; the alias rendered with its suffix, never truncated; and the decisive structural guard: the alias is never the authorization, so a confusable name can mislead a label but cannot confer authority. | A confusable name that is genuinely registered and points elsewhere is G1, handled as G1. |
| G8 | **The display path is subverted** (a lying RPC, or a card rendering something the row does not say). | The card renders the **persisted row**, never a transport payload (`ContactActionProposalCard.tsx`'s stated invariant; its reload path re-reads by id). | A compromised RPC that replaces both the forward answer and a plausible reverse answer is not detectable by this feature. The reverse-domain signal is the only defense against a substituted forward answer, and it is weak and often absent. |
| G9 | **An `.sol` name silently treated as equivalent.** | `unsupported_tld` is a typed refusal with **no fallback attempt**; `.sol` is already rejected in code (resources §6). | None. |
| G10 | **Authority arriving through the alias.** | Structural: the composer takes addresses only; `recipients.address` is the payment target and the alias lives in `provenance`; no rule can carry a name; `applied_rules_hash` is computed over address sets. | None by construction. |
| G11 | **A model talking the user into it** — narrating "es seguro" or reading out an address it "resolved". | The model-supplied address stays forbidden and `.strict()`; the spoken sentence is server-owned and contains no address; the alias is spoken and the address exists only on the screen. `snsName` is accepted on `create` only, never on `confirm`. | Nothing prevents a model from *saying* reassuring words. The authorization remains the address confirmation, not the narration. |
| G12 | **Registration confused with resolution.** | Stated non-goal plus the architectural fact: the app wallet cannot sign a name instruction (`Privy denied the Solana dispatch by policy`); this feature performs **reads only**. A code comment records it. | None. |
| G13 | **A replay with the same key and a different body** silently returning another alias's result. | §6: `request_hash` on the intent row; a mismatch is a typed `409 IDEMPOTENCIA_CUERPO_DISTINTO`. | None for bodies that reach the wallet-scoped path; the no-wallet branch writes no intent and is unchanged (§11 Q8). |
| G14 | **Consumed-but-not-stored** (§4.4): the pre-consume re-verify was unavailable and the later contact-add re-resolution finds a different address. | The contact-add arm refuses, nothing is stored, nothing is authorized for an unseen address, and a fresh proposal is required. | The user's affirmative is spent with no contact created. Bounded, visible, and non-redirecting. |

**The one irreducible residual is G1** — a squatted name pointing at a squatter's address, with the
user having nothing to compare against. Nothing in this design changes that; §1.4 of the discussion
frames it correctly: the alias path is a convenience that hands the destination choice to a
third-party registry, and the compensations bound that rather than pretend it away.

---

## 10. What can and cannot be proven locally

### 10.1 Provable offline, today

The two devnet names are the reason this feature is testable at all.

| Name | Resolves to | Name account (PDA) | parentName |
| --- | --- | --- | --- |
| `sophie.sns` | `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2` | `ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew` | `5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2` |
| `nanatest.sns` | `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` | `6Kcihb6KARkTtrnps8TbPp7H3b69jFxEe5i4hUrxkBps` | `5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2` |

`sophie.sns` is the semantically correct demo case — a third party's name pointing at that third
party's address, because the buyer becomes the name owner in the paid registrar. `nanatest.sns` is the
counter-example the suite carries: a name that resolves to its own payer, which is not a recipient and
is the fixture for the "resolves to the wallet's own address" refusal.

Acceptance criteria, each with its layer:

| # | Criterion | Proven how |
| --- | --- | --- |
| A1 | Adding by alias resolves via SNS, stores the **resolved address**, and records `{source:'sns', name, resolvedAt, resolver}` | resolver unit tests over the real 96-byte fixtures; service integration with an injected transport; a DB assertion on `recipients.provenance` |
| A2 | The confirmation shows the resolved address (untruncated) and the three-state reverse-domain line; the affirmative authorizes **that address** | card component tests over each of the three reverse states; the exposure/arbiter suite; a `GET /v1/contacts` read-back asserting the alias is never the payment target |
| A3 | A name that moved after the contact exists is drift, never an update | integration: store A, make the transport return B, call `check-alias`, assert `state:'changed'` while `recipients.address`, `applied_rules_hash` and every `delegated_grants` row are unchanged |
| A4 | A payment to that recipient uses the frozen stored address; no re-resolution anywhere on the transfer, preview or compose path | structural assertion (pattern `tests/unit/signer-worker-path.test.ts:256-290`) plus a unit test |
| A5 | The paste/scan path and the Privy composition are unchanged; `composer.ts` is not modified | the existing suites pass **unchanged** |
| A6 | Refusals are typed and distinguishable for: name does not exist, unsupported suffix, unreachable resolver, ambiguous resolution, the user's own address, duplicate disclosure | one unit/route test per taxonomy row of §1.2 and §2.5 |
| A7 | A resolution that differs at confirm supersedes the proposal and the window re-opens only for the new version | integration on the card path: resolve A, change to B, confirm → `version + 1`, `supersedes_id`, old row `superseded`, new row unpublished until re-published, old window unconsumable |
| A8 | An unreachable resolver at confirm proceeds with the displayed address and records `reverify:'unavailable'` | unit + integration with a throwing transport |
| A9 | The model still cannot supply an address, in any form, and can supply a name | `.strict()` schema tests extended: `{…, address}` rejected; `{…, snsName}` accepted |
| A10 | `@bonfida/spl-name-service` is imported by exactly one module | structural assertion over `src/**` |
| A11 | A replay with the same key and a different body is refused with a typed conflict | integration: two calls, same key, different `snsName` → `409 IDEMPOTENCIA_CUERPO_DISTINTO`, one contact, one intent |

### 10.2 Not provable locally now, and must not be implied

| # | Unprovable here | Why | What would make it provable |
| --- | --- | --- | --- |
| N1 | **Live end-to-end alias add and every live drift check** | the keyless public devnet endpoint throttles per method and path-dependently; the measured limit is recorded in `.env.example:138-140` (one resolution per user action paced → 10/10, p95 ≈ 181 ms; a 30-request burst → `Connection rate limits exceeded` on every call) | a **dedicated/keyed `SNS_RPC_URL`**. This is a **prerequisite, not an assumption**, and it is a variable change with no code change. |
| N2 | **Reverse-domain behaviour on either network**, including whether the two devnet names have a primary domain | never observed; the SDK is not installed in this worktree and no live call was made | one live `getPrimaryDomain` per name per network, recorded with its raw outcome; a `present` fixture would additionally need `setPrimaryDomain`, itself unproven on devnet (§11 Q1) |
| N3 | **The exact `ambiguous` conditions beyond the two derivable ones** (parent mismatch, undecodable/short header) | no third realistic case could be constructed from the available material, and neither owned name is ambiguous | a concrete fixture that produces it, or a decision to narrow `ambiguous` to the two derivable conditions (§11 Q2) |
| N4 | **The `class` half of the 96-byte header** | the resources file records no class value | one live raw header per name, recorded verbatim (§11 Q6) |
| N5 | **Bundle and peer-dependency cost of the SDK in the backend image**, and whether `--legacy-peer-deps` is still required with the current lockfile | no install was performed | one install measured in the container plus a build-size delta |
| N6 | **v4 behaviour on devnet** | same reason as N1/N5 | only relevant if D11 is revisited |
| N7 | **Mainnet resolution behaviour** | this deployment is devnet-only and cannot sign mainnet transactions; the map deliberately has no mainnet entry | a deployment decision plus a mainnet RPC and a funded mainnet signer |

Live evidence also requires the install to happen **in the backend container**
(`docker exec -w /app … npm install …`), because hand-copying `node_modules` fails transitively
through `@bonfida/sns-records` → `@solana/spl-token`.

---

## 11. Open questions

Each is a real gap. None is filled with a plausible-sounding decision.

1. **`getPrimaryDomain`'s error shape (discussion Q10).** Classifying "no primary domain" versus
   "resolver error" is load-bearing: a misclassification turns a failure into a false all-clear. The
   classifier is therefore pinned to *unknown by default* until one live observation is recorded
   (recorded shape → `none`; everything else → `unknown`). **Stop condition:** with no recorded
   observation, no test may assert a `none` classification from a real transport; the offline fixtures
   declare their state directly.
2. **`ambiguous` beyond the two derivable conditions (discussion Q8 / N3).** It stays a named, typed
   refusal rather than an exception path. **Stop condition:** if no third condition can be produced by
   the end of the resolver unit suite, the union is narrowed to the two derivable conditions and the
   narrowing is recorded, rather than shipping an unexercised branch.
3. **Does the contact list surface the alias? (discussion Q8).** Correction C3 makes this a real
   contract change: `RECIPIENT_COLUMNS` + `RecipientRow` + `ContactRecord` + `contactSchema` +
   `api-types.ts` + the MSW fixture. **Stop condition:** it lands only as one additive, mirrored
   change in a single work unit; if the mirrored type cannot land in this change, the surface is
   dropped rather than partially shipped, and no drift or confirmation behaviour depends on it.
4. **The new `request_hash` column (correction C8).** The proposal's affected-areas table says "no new
   column". The column is not provenance, and the alternative that avoids it — deriving the binding
   from the stored contact — falsely conflicts after a legitimate rename and cannot detect a differing
   description. **Decision needed:** accept the one additive column, or drop the body binding to a
   narrower alias-only comparison and record the residual.
5. **Where drift evidence lives (discussion Q4).** Recommended: one `alias_destination_changed` audit
   event (a small additive migration widening a closed CHECK) **plus** `provenance.drift`. Rejected:
   reusing `drift_repaired`, which means the policy converged and would assert the reverse. A second
   rejected alternative — `provenance.drift` only, no audit row — removes the need for the enum
   widening but loses the append-only trail. **Stop condition:** if the migration is refused, drift is
   recorded in `provenance.drift` only and the absence of an audit row is stated in the change record.
6. **The synthetic `class` bytes (N4).** The offline fixtures build the third 32-byte segment because
   no real value was recorded, and the resolver must not interpret it. **Stop condition:** one live
   raw header per name is recorded before any test asserts a real `class` value.
7. **Should `recipient_versions` snapshot provenance? (discussion Q5).** It does not today, so after an
   address edit the history shows the old address without "where it came from". This is
   directly caused by this feature but changes an `INSERT`-only RLS table. **Stop condition:** out of
   scope unless the human says otherwise; the atomic rewrite of §3.3 bounds the damage to the history
   table in the meantime.
8. **The no-ready-wallet idempotency branch (§6.3).** `create`'s no-wallet branch writes no intent, so
   no idempotency key is honored there, today and after this change. **Not fixed here, and not to be
   narrated as fixed.**
9. **Drift checks: explicit-only, or also periodic? (discussion Q7).** Explicit-only for this change:
   a periodic check needs an operational home and a budget, and it is not obviously worth it while
   drift cannot move money.
10. **Alias normalization and display casing (discussion Q11).** The persisted (canonical, lowercased)
    value is displayed, so the card and the drift check can never disagree about the name. If a
    product decision prefers the user's original casing, it must be display-only and must not become
    the compared value.
11. **The Supabase mirror (correction C7).** `013`–`015` are mirrored; `016` is not, so the chains have
    already diverged. **Stop condition:** the convention is read from the repository at apply time
    (e.g. the headers of the mirrored migrations) and a mirror ships only if that chain is still
    maintained for this series; no mirror filename is invented here.
12. **A rollback/feature switch for the resolver.** Recommended: **none**. The proposal's rollback plan
    is code-level (remove the alias surfaces), and a new `SNS_*` switch would be new operational
    surface nobody asked for. Rejected alternative: an `SNS_RESOLVER=enabled|disabled` switch mirroring
    `RECIPIENT_POLICY_WRITER`. If review asks for a switch, this is the recorded starting point.

---

## 12. Decision summary

| ID | Decision | Rejected alternative(s) |
| --- | --- | --- |
| S1 | Resolver and transport in two modules; the SDK is imported by `src/wallet/sns/transport.ts` alone; the 96-byte decode is ours; the transport is injectable | calling the SDK's `resolve()` (mainnet-bound); `NameRegistryState.retrieve` (decodes and throws on the shapes we must classify); re-implementing the PDA derivation |
| S2 | A closed network→root map keyed off `CONFIGURED_RECIPIENT_NETWORK` via `SOLANA_POLICY_NETWORK`; unknown network fails closed; **no mainnet entry** | deriving the root from the RPC URL string; inferring the cluster from the chain; hardcoding the root as the only source and dropping the constants |
| S3 | A total failure taxonomy where `not_found` ≠ `unreachable`, `ambiguous` is a narrow labelled refusal, and `resolve` never throws | one "resolution failed" outcome; an exception path; a broad ambiguity taxonomy invented up front |
| S4 | Reverse lookup is a three-state, never-blocking signal; `unknown` is never degraded to `none`; the classifier is pinned to `unknown` by default until a live observation exists | making the reverse line mandatory or a gate; treating an unrecognized error shape as absence |
| S5 | ASCII-only normalization, explicit `.sns` suffix required, no NFKC folding | implicit `.sns` append; NFKC folding (which would turn a homoglyph into a plausible name); case-preserving comparison |
| S6 | Freeze at add time with `{source, name, resolvedAt, resolver, reverify, …evidence}` in `recipients.provenance`; the alias never enters `recipients.name`; the composer is untouched | re-resolving at send time; an alias-valued target; a name→address table; a process-wide cache; storing the alias in `name` |
| S7 | The paste path records `source:'pasted'\|'scanned'` in the same object, and `payloadSchema.addressSource` widens by one value | leaving the paste path at its current literal, so absence is ambiguous between "pasted" and "pre-this-feature" |
| S8 | An address edit rewrites or **clears** provenance by default; a metadata-only edit leaves it untouched | requiring the caller to pass provenance on address change (a missed caller leaves a stale claim) |
| S9 | One strict create schema with two arms via `.superRefine`; `expectedAddress` can only veto | `z.discriminatedUnion` on `source` (breaks the existing paste client); posting the name alone and letting the server choose |
| S10 | Re-verification on the card path runs **after** the affirmative and immediately before the persisted consume; a difference supersedes into a new immutable version, re-publishes, and re-opens the window for it only | re-verifying before the affirmative wait (leaves the bounded window unchecked); adopting the new address; failing closed on any re-verification failure (a throttled RPC would block the user) |
| S11 | Unreachable at confirm proceeds with the displayed address and records `reverify:'unavailable'`; `'verified'` is recorded explicitly rather than left absent | absence-on-success (ambiguous between "agreed" and "not attempted") |
| S12 | Drift is reported and never auto-followed, never blocks a payment, checked only at confirm time and on an explicit user request; a guarded `UPDATE` that skips rather than attaches a stale claim | re-resolving for a payment; failing closed on drift (a stranger-controlled DoS lever); a per-list-read check; a background daemon in this change; an unguarded drift write |
| S13 | Drift evidence is `provenance.drift` plus one append-only `alias_destination_changed` audit event; the enum widening is the only migration in this change | reusing `drift_repaired` (asserts the opposite); `provenance.drift` only (loses the append-only trail) |
| S14 | Duplicate-address add is disclosed **by name** and proceeds (D13); the wallet's own address is refused with `409 DIRECCION_PROPIA` on every surface, compared against `user_wallets.address` | refusing on any duplicate (asymmetric with the paste path, and a second spec delta); making the self-address refusal conditional |
| S15 | The idempotency body binding is a persisted `request_hash` on the intent row; a mismatch is `409 IDEMPOTENCIA_CUERPO_DISTINTO`; a `NULL` hash falls back to today's behaviour | deriving the binding from the stored contact (falsely conflicts after a rename); using `composed_hash` (a policy hash, not a body hash) |
| S16 | The resolve endpoint is a side-effect-free read; the response carries `resolvedAt` and no `expiresAt`; `observedOwner`/`nameAccount` are never returned | inventing a resolution TTL (a second freshness authority next to the proposal TTL); returning the raw evidence to the client |
| S17 | No new feature switch; rollback is the code-level removal the proposal describes | an `SNS_RESOLVER=enabled\|disabled` env switch (new operational surface, unrequested) |
| S18 | SDK **v3.0.23**, pinned, version-tagged as `sns/<network>/v3` in every provenance record, confined to one module | v4 (cannot resolve devnet); the `@solana-name-service/sns-sdk-kit` stack (a second Solana stack) |

---

## 13. Residual risks

| Risk | Likelihood | Mitigation in this design | Residual, stated |
| --- | --- | --- | --- |
| **The user approves an address they cannot verify** (the reason to type `juan.sns` is not knowing the address) | Inherent to the feature | M1–M8 are mandatory, and the spec asserts them | Not removable. The product must not imply verification of identity. |
| A squatted or mis-told name (G1) | Medium | Display, freeze, disclose, refuse self | **Irreducible.** The only honest mitigations are product-level. |
| **RPC throttling** on the keyless default | High for any loop | `unreachable` is a distinct outcome → `503`, never "not found"; the paste path remains; the screen keeps the last resolution labelled with its age | Live end-to-end evidence needs a dedicated `SNS_RPC_URL`; recorded as a prerequisite (N1). |
| **Reverse lookup unavailable or unset on devnet** | High (expected) | Classified `none`/`unknown`, never a failure and never agreement; never promoted to mandatory | The devnet demo most likely shows `none`, so this mitigation is effectively mainnet-only (§11 Q1). |
| **The SDK's bundle and peer cost is unmeasured** (v3 is the legacy line) | Medium | Pinned to `3.0.23`, version-tagged in provenance, confined to one module with a structural assertion, install with `--legacy-peer-deps` and in-container | Accepted and unmeasured (N5). A mainnet move re-opens D11 visibly, in the data. |
| **`ambiguous` is under-specified** | Low | A named typed refusal rather than an exception path; a resolution whose parent is not the configured root is refused rather than interpreted | No fixture produces it yet (§11 Q2). |
| **The `class` half of the header is synthetic in fixtures** | Low | The resolver validates only the 96-byte length and never interprets `class` | Until one live header is recorded, the fixture's third segment is labelled synthetic (§11 Q6). |
| **Front/back contract drift** | Medium | Both sides plus `api.ts` and the MSW fixtures in one work unit; the alias flow is refused when the resolve endpoint is absent, never emulated client-side | None beyond the normal mirror discipline. |
| **The "consumed but not stored" edge** (G14) | Low | Nothing is stored, nothing is authorized for an unseen address, and a fresh proposal is required | The user's affirmative is spent with no contact created, and the surface must say so. |
| **Supabase mirror divergence** | Low | The chain is already divergent (`016` unmirrored) | The mirror ships only if that chain is still maintained (§11 Q11). |
| **One additive column beyond the proposal's wording** (`request_hash`) | Low | Recorded as an explicit divergence; a `NULL` hash falls back to today's behaviour | Needs an explicit accept-or-veto (§11 Q4). |
| **Baseline sequencing** — the revised requirement is published by an unarchived change | Medium | Recorded in the spec delta's baseline references and here | This change must not be applied ahead of `trusted-recipient-policy-sync`'s block. |

## 14. Rollback

The feature is additive in code and read-only on-chain. Rollback follows the approved plan in
`proposal.md` and is not repeated here in full; the two design-relevant points are that (a) no rollback
step issues a PATCH, creates or revokes a grant, changes a signer or alters the 0.01 SOL ceiling, and
(b) dependency removal is a one-module change — uninstall `@bonfida/spl-name-service` together with
`src/wallet/sns/transport.ts` and the lockfile entry, which is why the structural assertion that
exactly one module imports it is part of the design rather than a nicety.

---

## 15. Decisions settled before apply

### D-A. The idempotency body binding needs a column — **ACCEPTED**

The proposal's "no new column" wording predates the finding that
`replayIdempotentMutation` (`src/wallet/policy/service.ts`) matches on
`(wallet_id, idempotency_key)` alone. So a replay carrying a **different body**
silently returns the first result. That is invisible on the paste path, where the
body *is* the address, and user-visible on the alias path, where the same key with
a different alias returns the wrong contact.

`request_hash` on `recipient_policy_sync_intent` is **accepted** as an additive
column. The no-column alternative was rejected because it fails in a way that
matters: it falsely conflicts after a legitimate rename (the composed policy hash
changes for a reason unrelated to the request) and it cannot see a differing
`description` at all. A guard that fires on valid operations and misses invalid
ones is worse than the hole it closes.

This is a deliberate, recorded divergence from the proposal's wording, not an
oversight. A mismatch is reported as a typed conflict (`409`), never applied.

### D-B. Review workload — **no PR, therefore no exception to request**

The forecast is honest and large (~4,900–7,200 changed lines; seven of eight units
exceed 400 lines). It does **not** gate anything operationally here: this
worktree's standing instruction is **no PR** — work-unit commits pushed to
`feat/solana-operational` — so `size-exception` describes review size, not a
Gentle-owned PR policy to invoke. The consequence to respect is that each unit
still lands as its **own** commit so a reviewer can read the change in slices, and
no diff is shrunk by dropping tests or comments to reach a number.

### D-C. The resequencing that follows from D-A

`request_hash` is additive to a table this change does not otherwise own, so its
migration lands with the idempotency unit, not with the provenance unit, keeping
the schema delta and the behaviour it enables in the same commit.
