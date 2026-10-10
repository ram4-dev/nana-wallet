# Live observation: `getPrimaryDomain` on the two devnet names (task 1.6)

Date: 2026-10-10 (same day as `.agent-workflow/tasks/sns-alias-recipients/01-sns-devnet-resources.md`).
Endpoint: `readSnsTransportConfig()`'s value in this worktree — `.env` `SNS_RPC_URL`, whose host is the
**keyless public default** `api.devnet.solana.com` (`endpoint_is_keyless_default=true`). No key,
token, seed or URL value is recorded here.

Calls: **one `getPrimaryDomain` per name**, sequential, through the pinned SDK
(`@bonfida/spl-name-service@3.0.23`) — not a burst loop.

| Name | Address asked about | Raw outcome |
|---|---|---|
| `sophie.sns` | `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2` | rejection, message `"The favourite account does not exist"` (579 ms) |
| `nanatest.sns` | `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` | rejection, message `"The favourite account does not exist"` (207 ms) |

Neither call was throttled, timed out or reported an RPC error.

## Why this genuinely means "no primary domain" (the load-bearing check)

`devnet.utils.getPrimaryDomain` looks up the *favourite domain* PDA
(`["favourite_domain", owner]` under `NAME_OFFERS_ID`). The same message would appear if that program
were simply absent on devnet, which would make `none` a false all-clear. Two further reads settle it:

| Observation | Result |
|---|---|
| `NAME_OFFERS_ID` = `zugu92jR3kqgFiNEJywq7gbbc9NbaLmHLiQhsZRwd6J` on devnet | present, `executable=true`, owner `BPFLoaderUpgradeab1e11111111111111111111111` |
| favourite-domain PDA for `3aHrqufW6h2hgmANwhXv6WnijdNiqjU7VbAWyLzGCUb2` | does not exist |
| favourite-domain PDA for `BsNFJHm85Yk2hcugJG16KFm4bfdB5DwnTqfoSW4BuLFv` | does not exist |

So the program is deployed and the accounts are absent: the observed shape means "this owner has no
primary domain", which is exactly the expected devnet state (design §1.6: the reverse-lookup parent is
the `REVERSE_LOOKUP_CLASS` seed, which has no account on devnet by design).

## What was pinned, and what was NOT

- Pinned: **only** the exact string `"The favourite account does not exist"` classifies as `none`
  (`SNS_NO_PRIMARY_DOMAIN_MESSAGE`). Every other shape — including the design-quoted
  `"The primary account does not exist"` — classifies as `unknown`.
- NOT claimed: that a *present* primary domain was ever observed. No name in this worktree has one, so
  the `present` branch is exercised only by the offline fixture in `tests/unit/sns-reverse-lookup.test.ts`.
- NOT claimed: that the keyless endpoint can serve a test loop. It cannot (resources §7); only a
  one-shot observation was attempted and it succeeded.
- No secret, key, seed, token, signature or endpoint value appears in this file or in any commit.
