# SNS devnet resources — DO NOT LOSE

Everything below is verified live on `solana-devnet`. Written 2026-10-10.

This file exists because these values were expensive to obtain (several dead
ends, one wrong conclusion I had to retract) and because a container rebuild or
a lost keypair would mean paying and registering them again.

---

## 1. Registered names

| Name | Resolves to | Name account (PDA) |
| --- | --- | --- |
| **`sophie.sns`** | `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2` | `ELMUa8M5cqHMzF12WgbyGQu28Kdm39fD2fSkNxBGvCew` |
| `nanatest.sns` | `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` | `6Kcihb6KARkTtrnps8TbPp7H3b69jFxEe5i4hUrxkBps` |

Both have `parentName` equal to the devnet SNS root
(`5eoDkP6vCQBXqDV9YN2NdUs3nmML3dMRNmEYpiyVNBm2`, see section 4) — so they are
genuine TLD children, not stray accounts.

### Transactions

| Name | Signature |
| --- | --- |
| `sophie.sns` | `3pwsxGLusetLSfdQ7LakbKJyAKnwLuWsK6XVU16VBqqyYtdWFWruToVYSQWKHP9Y133eQronVKMWVXa3CcbTE3jD` |
| `nanatest.sns` | `4gZ9rJcY2Lj64rVqzEM9wXYrwznkJ1DXbhQo1GNKvHtnhswCpgBxoa7zrP2NrZYSo7TDuCMHKpizH2T3oz2oiBGH` |

Explorer: `https://explorer.solana.com/tx/<signature>?cluster=devnet`

### Why `sophie.sns` points at Sophie

In the paid registrar the **buyer becomes the name owner**. So the name's target
address is decided by *who pays*. Sophie's own keypair bought the name (funded
from the payer), which is why it resolves to Sophie and not to us. That is the
semantically correct arrangement for a demo: a third party's name pointing at
that third party's address.

---

## 2. Local keypairs (gitignored, under `.secrets/`)

| File | Address | Holds |
| --- | --- | --- |
| `.secrets/sns-devnet-payer.json` | `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` | ~4.9 devnet SOL (registers new names) |
| `.secrets/sophie-devnet.json` | `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2` | Sophie's identity; owns `sophie.sns` |

Both are covered by `.gitignore` (`.secrets/`). **Back these up** — losing
`sophie-devnet.json` means `sophie.sns` can never be transferred or sold, though
it still resolves.

Devnet SOL came from the web faucet `https://faucet.solana.com`. All four
programmatic faucets were blocked from this machine (`429` / `401`).

---

## 3. The registration recipe (works; SDK v4 does NOT)

Use **`@bonfida/spl-name-service@3.0.23`**, not v4. v4's `PYTH_PULL_FEEDS` is
empty on devnet and it throws `PythFeedNotFoundError`. v3's `devnet` export
carries the legacy payment configuration.

```ts
const [signers, ixs] = await devnet.bindings.registerDomainName(
  connection,
  label,                 // bare name, no ".sns"
  1000,                  // space
  buyerKeypair.publicKey,
  buyerWrappedSolAta,    // buyer's wSOL ATA
  WSOL_MINT,             // So11111111111111111111111111111111111111112
  devnet.constants.REFERRERS[0],   // REQUIRED — see gotchas
);
```

Wrap ~0.05 SOL into the buyer's wSOL ATA first (`createAssociatedTokenAccountInstruction`
+ `SystemProgram.transfer` + `createSyncNativeInstruction`), or the registrar
cannot take payment.

### Facts that make it work

- Registrar program (devnet): `snshBoEQ9jx4QoHBpZDQPYdNCtw7RMxJvYrKFEhwaPJ` —
  deployed and **executable**, upgradeable BPF loader. It is the authority of the
  devnet root, which is why a direct `createNameRegistry` under the root cannot
  work but the registrar's own instruction can.
- Devnet Pyth accounts **exist on-chain** (owner `gSbePebfvPy7tRqimPoVecS2…`, the
  legacy Pyth program): mapping `BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2`;
  for wrapped SOL product `3Mnn2fX6rQyUsyELYms1sBJyChWofzSNRoqYzvgMVz5E` / price
  `J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix`.
- Vault wSOL ATA (already exists): `CK4GgmwCq1Bcz8dgGSLz5bueJbPdBwNfHPRfWQezgXTU`.
- Devnet pricing is **1000× cheaper** than mainnet: the program's
  `get_special_discount_and_fee` returns `multiplier * 1_000` under the `devnet`
  feature instead of `multiplier * 1_000_000`.

### Gotchas that cost real time

1. **The referrer is mandatory.** Passing none leaves the 17th account
   `undefined`; the instruction is built but fails at compile. Pass
   `devnet.constants.REFERRERS[0]` = `3ogYncmMM5CmytsGCqKHydmXmKUZ6sGWvizkzqwT7zb1`.
2. **`SystemProgram.transfer` takes `{ fromPubkey, toPubkey, lamports }`** — NOT
   `{ from, to, lamports }`. With the wrong names the instruction is created with
   `pubkey: undefined` and the error surfaces far away as
   `TypeError: Cannot read properties of undefined (reading 'toString')` inside
   web3.js `compileMessage`'s dedupe step. If you see that, inspect `ix.keys` of
   every instruction: the one with `undefined` pubkeys is the culprit.
3. **The app wallet cannot sign any of this.** `Privy denied the Solana dispatch
   by policy` — its single ALLOW rule covers only a SystemProgram **Transfer** to
   the allowlisted recipients. Name registration must be signed by a separate
   local keypair. Reads are unrestricted.
4. `@bonfida/spl-name-service` needs `--legacy-peer-deps` (peer conflict with
   `@circle-fin/developer-controlled-wallets`), and inside the backend container
   it must be installed **in** the container (hand-copying files fails
   transitively through `@bonfida/sns-records`, then `@solana/spl-token`).

---

## 4. Constants (verbatim — copy from here, never retype)

```
MAINNET ROOT DOMAIN ACCOUNT : 58PwtjSDuFHuUkYjH9BYnnQKHfwo9reZhC2zMJv9JPkx
NAME PROGRAM ID             : namesLPneVptA9Z5rqUDD9tMTWEJwofgaYwp8cawRkX
DEVNET REGISTER PROGRAM     : snshBoEQ9jx4QoHBpZDQPYdNCtw7RMxJvYrKFEhwaPJ
MAINNET REGISTER PROGRAM    : jCebN34bUfdeUYJT13J1yG16XWQpt5PDx6Mse9GUqhR
CENTRAL STATE (reverse)     : 7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H
DEVNET REFERRER             : 3ogYncmMM5CmytsGCqKHydmXmKUZ6sGWvizkzqwT7zb1
DEVNET USDC MINT            : 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
WRAPPED SOL MINT            : So11111111111111111111111111111111111111112
DEVNET VAULT OWNER          : SNSaTJbEv2iT3CUrCQYa9zpGjbBVWhFCPaSJHkaJX34
DEVNET VAULT wSOL ATA       : CK4GgmwCq1Bcz8dgGSLz5bueJbPdBwNfHPRfWQezgXTU
DEVNET PYTH MAPPING         : BmA9Z6FjioHJPpjT39QazZyhDRUdZy2ezwx4GiDdE2u2
PYTH PRODUCT (wSOL)         : 3Mnn2fX6rQyUsyELYms1sBJyChWofzSNRoqYzvgMVz5E
PYTH PRICE   (wSOL)         : J83w4HKfqxwcq3BEMMkPFSppX3gqekLyLJBexebFVkix
```

**All thirteen values above were re-verified against `devnet.constants` from
SDK v3.0.23 after this file was written** — they are copied from the SDK, not
transcribed from memory.

Two notes so these are not misread as broken:

- **`CENTRAL STATE (reverse)` = `7NbD1vprif6apthEZAqhRfYuhrqnuderB8qpnfXGCc8H`
  has no account on devnet**, and that is expected: it is a *derivation class*
  seed used as the parent when computing a reverse-lookup PDA
  (`getNameAccountKeySync(hash, REVERSE_LOOKUP_CLASS)`), not a live account. Do
  not treat a failed `getAccountInfo` on it as a problem.
- **`MAINNET REGISTER PROGRAM` returns non-null on devnet only because the
  address has lamports.** `getAccountInfo` cannot distinguish "a deployed
  program" from "a funded system account"; check `executable` for that.

---

## 5. Resolution — the SDK's `resolve()` CANNOT be used for devnet

`resolve()` derives the name account under `SNS_ROOT_DOMAIN_ACCOUNT` from
`constants.mjs`, which is the **mainnet** root. It will never find a devnet name.

A devnet-aware resolver is:

```ts
const { pubkey } = devnet.utils.getDomainKeySync(label);   // v3 name
const { registry } = await NameRegistryState.retrieve(connection, pubkey);
const address = registry.owner.toBase58();
```

(v4 renamed the helper to `getSnsDomainKeySync` and exports no devnet resolver.)

### Verified results

```
sophie.sns   -> 3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2
nanatest.sns -> BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv
```

### Reading a name account without the SDK

96-byte header: `parentName` = bytes 0–32, `owner` = bytes 32–64, `class` =
bytes 64–96. Base58 needs no library — a small Python function is enough, which
is how these were verified when the SDK hit RPC throttling.

---

## 6. On suffix choice: `.sol` is DEAD

`.sol` is not "deprecated in progress" — it is **already rejected in code**:
`resolve(conn, "anything.sol")` → `Domain has an unsupported TLD suffix`. The
documented pause slot is `452,825,395` and mainnet was already at `455,410,529`
(≈ 2,585,134 slots, ~12 days past the cutoff). **Only `.sns` resolves.**

---

## 7. RPC caveat

The public devnet endpoint throttles **per method**:
`429 Too many requests for a specific RPC call`. It is unusable for a tight test
loop, and the throttle is **path-dependent** — `curl` from the host succeeded
while the identical call inside the backend container was refused. For anything
resembling a test loop, configure a dedicated RPC endpoint.
