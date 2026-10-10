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

### Registration on devnet: POSSIBLE — earlier conclusion was WRONG

**CORRECTION.** An earlier revision of this intake recorded "no se puede registrar en devnet". That was wrong, and the error was mine: I had only tested `@bonfida/spl-name-service@4` (the SRS-era SDK), whose `PYTH_PULL_FEEDS` is empty on devnet. The **legacy** path works, and it is what the registrar program uses.

Verified end to end on `solana-devnet`: **`nanatest.sns` is registered and live.**

| | |
| --- | --- |
| Transaction | `4gZ9rJcY2Lj64rVqzEM9wXYrwznkJ1DXbhQo1GNKvHtnhswCpgBxoa7zrP2NrZYSo7TDuCMHKpizH2T3oz2oiBGH` |
| Name account (PDA) | `6Kcihb6KARkTtrnps8TbPp7H3b69jFxEe5i4hUrxkBps` |
| Decoded `parentName` | `5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2` = the **devnet SNS root** (a real TLD child, not a stray account) |
| Decoded `owner` | `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` (our local payer) |

**How it works, which is what the implementation must copy:**

1. **Program.** The registrar program `snshBoEQ9jx4QoHBpZDQPYdNCtw7RMxJvYrKFEhwaPJ` is deployed and **executable** on devnet (owner `BPFLoaderUpgradeab1e…`, so it is upgradeable and live). It is the authority of the devnet root — which is why a direct `createNameRegistry` under the root cannot work, but the registrar's own instruction can.
2. **SDK.** Use `@bonfida/spl-name-service@3.0.23` — **not v4**. v3's `devnet` export carries the payment configuration that v4 dropped: `devnet.constants.PYTH_FEEDS` maps the mint to a legacy Pyth product/price pair, and `PYTH_MAPPING_ACC` is present. **All of these accounts exist on devnet** (owner `gSbePebfvPy7tRqimPoVecS2…`, the legacy Pyth program): mapping `BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2`, and for wrapped SOL product `3Mnn2fX6rQyUsyELYms1sBJyChWofzSNRoqYzvgMVz5E` / price `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix` (USDC and the other listed mints have feeds too).
3. **Payment.** Pay in **wrapped SOL** (`So11111111111111111111111111111111111111112`) by passing that mint to `devnet.bindings.registerDomainName(connection, label, space, payer, buyerTokenAccount, mint, referrer)`. The vault ATA `CK4GgmwCq1Bcz8dgGSLz5bueJbPdBwNfHPRfWQezgXTU` already exists, so the vault-side transfer is satisfiable. A **referrer is required** — passing none leaves the 17th account `undefined` and the instruction fails to compile; the devnet referrer is `3ogYncmMM5CmytsGCqKHydmXmKUZ6sGWvizkzqwT7zb1`.
4. **Devnet is 1000× cheaper.** The registrar's `get_special_discount_and_fee` returns `multiplier * 1_000` under the `devnet` feature instead of `multiplier * 1_000_000`. Wrapping 0.05 SOL was more than enough.
5. **Resolution must be devnet-aware.** The SDK's `resolve()` derives under the **mainnet** root from `constants.mjs`, so it cannot find a devnet name. A devnet resolver is `devnet.utils.getDomainKeySync(label)` → PDA → `NameRegistryState.retrieve(...)` → `registry.owner` (v3 calls it `getDomainKeySync`; v4 renamed it `getSnsDomainKeySync` and does not export a devnet resolver).

**The app wallet still cannot sign it** — `Privy denied the Solana dispatch by policy`, because the single ALLOW rule only covers a SystemProgram **Transfer**. So registration must be signed by a **separate local keypair** (`.secrets/sns-devnet-payer.json`, gitignored). That is fine: the name owner is arbitrary, so the payer and the address a name points at are independent.

**What this changes for the plan:** a real, resolvable devnet alias now exists, so the feature CAN be exercised end to end locally. The resolver still needs the abstraction (network-aware root selection) but no longer needs a fake fixture to be honest.

### The app wallet cannot sign a registration (policy) — independent of the above

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

1. ~~Does `.sns` resolution work on `solana-devnet`?~~ **ANSWERED — YES.** A real devnet name exists (`nanatest.sns`, see above), registered through the legacy registrar with SDK **v3**. The resolver must select the root by network and read the account itself, because the SDK's `resolve()` is mainnet-bound.
2. **Which RPC will serve the resolution calls in each environment?** The public devnet endpoint throttles **per method** (`429 Too many requests for a specific RPC call`) and is unusable for a test loop; a dedicated endpoint is needed. Note the throttle is path-dependent: `curl` from the host succeeded while the same call inside the backend container was refused.
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
