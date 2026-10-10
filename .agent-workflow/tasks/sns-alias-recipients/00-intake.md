# Add a trusted recipient by SNS alias

Revision: 1 — 2026-10-10. Phase: research and design; implementation not authorized by this artifact.

## Requested outcome

Ramiro: *"que resuelva cuando lo agregás pero que no te pida la dirección para agregarlo, simplemente vos decirle `juan.sns` para agregar ese contacto y después Nani pregunta: la dirección que aparece en pantalla, ¿es la correcta? y ahí le confirmamos."*

So: the user names an alias, the system resolves it internally to a Solana address, Nani shows that address and asks whether it is correct, and the user's confirmation authorizes the contact. **No paste or scan is required when the alias resolves.**

## The spec conflict this creates — decided, not hidden

`openspec/changes/trusted-recipient-policy-sync/spec.md` currently states:

> spoken or name-derived addresses are never a permission source: creation and address replacement require a verified pasted/scanned address, and **no address is ever derived from a name**.

This intake **revises that MUST**. An alias-resolved address becomes an accepted permission source, on the condition that the user confirms the **resolved address** as displayed, never the alias. The revision must be written into the spec as an explicit delta, not absorbed silently.

### What the change costs, in one paragraph
With paste/scan the user supplies the destination from their own knowledge, so a compromised resolution cannot redirect them. With alias resolution the address arrives wholly from the chain, and the display-and-confirm step is the *only* check — a weaker one, because the user has nothing to compare against. `juan.sns` could also be squatted or re-registered.

### Mitigations that are part of the design, not optional
1. **Show the resolved address, always, in the confirmation.** The alias is a label; the address is the authorization. The user confirms the address.
2. **Show the reverse domain of the resolved address** (primary `.sns` of that address, if any) as an independent second signal. If the address has no primary domain, say so rather than implying agreement. This is what gives the user something to compare.
3. **Freeze at add-time.** Resolve once, store the address, and never re-resolve for a payment. A later transfer of the name cannot move money. Provenance records `{source: 'sns', name, resolvedAt, resolver}`.
4. **Refuse silently-changed lookups.** If a stored alias later resolves elsewhere, that is drift: surface it, never auto-update the destination.
5. **Keep paste/scan available.** The path is additive; it does not remove the existing verified-address flow.

## Why resolve-at-add-time and not at-send-time

The `.sol`/`.sns` names are NFTs and can be transferred, so `name → address` is mutable. Resolving at send-time would mean the destination can change with no action by the user, and would force a remote policy write on every send because the composed allowlist is built from addresses (`src/wallet/policy/composer.ts`). Resolve-at-add-time keeps the destination frozen, the display truthful, and the Privy allowlist static and verifiable.

## SDK and suffix — researched

- **`.sns` is the going-forward suffix.** SNS migrated to a Solana Record Service (SRS)-based registry; `.sol` reads use legacy SNS-backed resolution until finalized slot `452,825,395` and then **pause automatically**, after which `.sol` reads are rejected (`Errors.UnsupportedTldError`). Published timeline: `.sol` registrations paused 17 August; `.sol` resolution pauses in the official SDKs "mid to late October". **Do not build on `.sol`.**
- **SDK:** `@bonfida/spl-name-service@4.0.1` — the repository Ramiro linked (`SolanaNameService/sns-sdk`). It uses `@solana/web3.js` **1.x**, matching the installed `1.98.4`. Exports: `import { resolve, safeResolve } from "@bonfida/spl-name-service/domain"`; `resolve(connection, "name.sns")` → `PublicKey`. The alternative `@solana-name-service/sns-sdk-kit` depends on `@solana-program/token` (the newer `@solana/kit` stack) and would add a second Solana stack to the repo — rejected.
- **v3 → v4 is not backward compatible.** Read the migration notes before adding the dependency.
- **Devnet has no domains.** The devnet module is `import { devnet } from "@bonfida/spl-name-service"`, and its bindings require existing devnet domains; `registerDomainNameV2` registers one for testing. **Testing this requires registering our own devnet domain first.**

## Probe results (read-only, no dependency installed)

Run against the live cluster with the already-present `@solana/web3.js`, no install:

| Check | devnet | mainnet |
| --- | --- | --- |
| SNS name-registry program `namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX` | **DEPLOYED (executable)** | **DEPLOYED (executable)** |
| SNS root domain account `5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2` | **EXISTS (96 bytes, owner = the name program)** | mainnet root is `58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx` |
| Slot observed | 509,688,088 | 455,410,529 |

### Resolution: works, but only mainnet names resolve

Live, with `@bonfida/spl-name-service@4.0.1`:

```
resolve("bonfida.sns") -> Fw1ETanDZafof7xEULsnq9UY6o71Tpds89tNwPkWLb1v
resolve("toly.sns")    -> 86xCnPeV69n6t3DnyGvkKobf9FdN2H9oiVDdaMpo2MMY
resolve("anything.sol") -> ERROR: Domain has an unsupported TLD suffix
```

Two hard consequences:

1. **The `.sol` cutoff has ALREADY PASSED.** The documented pause slot is `452,825,395` and mainnet is at `455,410,529` — 2,585,134 slots past it (≈ 12 days). `.sol` is not deprecated-in-progress, it is **already rejected in code**. `.sns` is the only suffix that resolves.
2. **`resolve` uses the MAINNET constants.** It derives the name account under `SNS_ROOT_DOMAIN_ACCOUNT` from `constants.mjs` (mainnet: `58Pwtj…`), so a devnet-registered name is invisible to it. Devnet has its OWN root (`5eoDkP…`) and exposes `devnet.utils.getSnsDomainKeySync` but **no devnet `resolve`** — a devnet resolver would have to derive the PDA via `devnet.utils` and read the account itself.

### Registration on devnet: NOT POSSIBLE with this SDK

This closes the question "puedo registrar un `.sns` en devnet?" — the answer is no, for two independent reasons:

1. **Creating a TLD directly under the devnet root needs the SNS authority's signature.** The root account's `owner` field is `5eadff2929d1977d537b3999a7e5d8d47d4fc789aed777309a96fdf09d0e4afa` — the program's own authority PDA, which we cannot sign for. `createNameRegistry` accepts a `parentName`, but it then requires that parent's owner to sign; it also makes its own `NameRegistryState.retrieve` call, which is where a blocked attempt failed.
2. **The official registrar cannot run on devnet.** `devnet.constants.PYTH_PULL_FEEDS` is **undefined/empty**, and `registerDomain` throws `PythFeedNotFoundError` before building anything when no feed exists for the payment mint. So the paid path (`registerDomain`, which needs USDC + a Pyth price feed) is unavailable on devnet.

**Therefore: the alias feature cannot get a real resolvable devnet name.** Local acceptance evidence must come from either (a) a mainnet registration (needs mainnet USDC, and mainnet writes are out of scope for a test), or (b) a **resolver abstraction with a fixture implementation** for devnet, with the real resolution path proven only against mainnet reads.

### The app wallet cannot sign a registration (policy), even if registration worked

Attempting to register with the app wallet returned, live:

```
Privy denied the Solana dispatch by policy.
```

The attached policy has exactly one `signAndSendTransaction` ALLOW rule, conditioned on a SystemProgram **Transfer** with `Transfer.to` ∈ {the wallet's own address, Test1} and `Transfer.lamports lte 10000000`. A name-registry instruction is not a transfer, so no rule matches and the default DENY applies. **Cost of the probe: zero** (a denied dispatch moves nothing).

This is architectural, not incidental: **reads are unrestricted, writes are not.** Alias resolution is a read, so the feature is unaffected — but any future "register a name from the app" idea would require a deliberate policy change.

### Operational notes

- **The public devnet RPC throttles hard, per method** (`429 Too many requests for a specific RPC call`), and the container's path is throttled separately from the host's (`curl` from the host succeeded while the same call from inside the backend container was refused). A devnet test needs a dedicated RPC endpoint, not `api.devnet.solana.com`.
- **Devnet SOL was obtained via the web faucet** at `faucet.solana.com`; all four programmatic faucets tried were blocked from this machine (`429` / `401`). The payer lives at `.secrets/sns-devnet-payer.json` (gitignored) and holds 5 SOL.
- **`npm install @bonfida/spl-name-service` needs `--legacy-peer-deps`** (peer conflict with `@circle-fin/developer-controlled-wallets@10.8.0`), and inside the backend container it must be installed **in** the container (`docker exec -w /app … npm install …`), because copying files by hand fails transitively.
- `node_modules` in this worktree is a real directory; the install did **not** touch the main checkout.

## Uncertainty to resolve before design (cheapest first)

1. ~~Does `.sns` resolution work on `solana-devnet`?~~ **ANSWERED — NO, and registration there is impossible.** Resolution works on mainnet (proven); devnet cannot host a resolvable name via this SDK (no Pyth feed for the registrar, and a direct TLD under the devnet root needs the SNS authority's signature). Design must therefore choose between a resolver abstraction with a fixture for devnet, or proving the real path only against mainnet reads.
2. **Which RPC will serve the resolution calls in each environment?** The public devnet endpoint throttles per method and is unusable for a test loop; a dedicated endpoint is needed. Also confirm the mainnet RPC choice if resolution is ever exercised outside devnet.
2. **Does the devnet RPC we already use serve the resolution calls**, or does SNS need its own program accounts read from a different endpoint?
3. **Bundle and dependency cost** of `@bonfida/spl-name-service@4` in the backend image, and whether it drags a conflicting `@solana/web3.js`.
4. **Reverse lookup availability on devnet** (mitigation 2) and its failure mode when the address has no primary domain.

If (1) fails, the feature is mainnet-only and the local acceptance evidence cannot exist — that is a stop-and-report, not a workaround.

## Acceptance evidence for implementation

- Adding by alias resolves via SNS, stores the **resolved address**, and records provenance (`source: 'sns'`, name, resolvedAt).
- The confirmation shows the resolved address and the reverse-domain signal, and the user's affirmative authorizes **that address**, not the alias.
- A name whose resolution changes after the contact exists is surfaced as drift and never auto-followed.
- A payment to that recipient keeps using the frozen stored address; no re-resolution at send time.
- The existing paste/scan path still works, and the Privy policy composition is unchanged (it consumes addresses).
- Refusal is typed and visible when the name does not resolve, when resolution is ambiguous, or when the resolved address already belongs to another active contact (deduplication rule already in the spec).

## Authority and boundaries

Read-only research done. No code, dependency, migration, spec, or remote policy changed by this artifact. Worktree `/Users/ramiro/Desktop/projects/colloseum.feat-solana-operational`, branch `feat/solana-operational`. No push, no PR, no key access.

This is a **new capability**, so per `AGENTS.md` it goes through stage 1 (`.agent-workflow/`) and then SDD (`openspec/`) — it is not a bug fix and must not be implemented as a drive-by.

## Active gate

Gate ID: sns-alias-design-r1
Allowed next action: resolve the four uncertainties above and draft the design discussion.
Decision owner: Ramiro. **Spec revision of the "never derive an address from a name" MUST is requested and awaiting explicit approval.**
Explicit exclusions: no dependency install, no code, no spec edit, no remote mutation until the design gate is approved.

## Non-goals

No send-time resolution. No other name services (ENS, DNS, `.sol` as a permanent alias). No subdomain support unless the design review asks for it. No change to the delegated-grant or transfer-policy model. No aliases for the wallet's own address.
