# Design: Solana Devnet Provider (Slice 2)

## Technical approach

Add a devnet-only `WalletProvider` using read-only Solana RPC and Privy
`signAndSendTransaction`. Resolve the exact user wallet and delegated signer
from PostgreSQL, verify both against Privy, and fail closed on ambiguity.
The ledger remains authoritative for grant consumption.

## Architecture decisions

| ADR | Decision | Rationale |
| --- | --- | --- |
| 1 — client | Pin `@solana/web3.js@1.98.4`; no local keypair. | Compatible with installed peers and TS6. |
| 2 — policy | One composed override policy per wallet signer; one conditioned ALLOW rule per active grant. | Per-grant recipient, lamport ceiling and expiry stay isolated; cumulative limits stay in the ledger. |
| 3 — wallet | Require exactly one ready Solana row; match provider wallet id and address independently. | Global senders and guessed/stale bindings violate user isolation. |
| 4 — signer | Store only the exact, readback-verified remote `additional_signers[].signer_id`. | A key-quorum id, list position, or another grant's state is not signer identity. |
| 5 — routing | Every financial caller passes chain intent from the requested network. | Missing or unknown intent must not default to EVM. |

## Components and data flow

- HTTP, conversation and LiveKit resolve through `WalletForUser(userId, chain)`;
  deferred methods derive chain from their network argument.
- Authenticated `/v1/wallets/sync` keeps its default Ethereum behavior and adds
  an explicit Solana arm. Exactly one valid Solana wallet creates a ready row;
  zero, multiple or failed discovery creates none. Sync never writes signer id.
- `createSolanaWalletForUser` requires the ready row and exact Privy wallet id
  and address match before binding the devnet provider.
- Solana RPC reads balances, statuses, history and proof; it cannot send.
  Privy is the only signing/broadcast path and receives one unsigned serialized
  transaction with a stable `reference_id`.
- `PolicyTargetResolver` maps local wallet UUID to exact provider wallet and
  signer ids; mutations preserve siblings and require exact readback.

## Solana consent enrollment

Prepare validates the authenticated user's ready Solana row, creates the
devnet policy, records a pending grant and persists current remote signer ids
in nullable `signer_grants.signer_enrollment_snapshot` JSONB.
The existing React component requests consent using the installed
`@privy-io/react-auth@3.40.0` `useHeadlessDelegatedActions().delegateWallet`
with the wallet address and `chainType: 'solana'`. Privy's method returns
`void`; the UI never supplies signer identity or policy ids. This API is
documented at [Privy signer provisioning](https://docs.privy.io/wallets/using-wallets/signers/delegate-wallet)
and its 3.40.0 declaration was verified 2026-10-04.

Complete authenticates the same user and reads back their wallet. If a
canonical signer id is already stored, it must match exactly once remotely.
Otherwise, compare signer ids with the prepare snapshot and require exactly
one new id; zero stays pending and multiple means conflict. Attach the stored
policy to that exact signer through the signed server mutation, read it back,
then persist the remote signer id on `user_wallets`. Prepare retries preserve
the pending grant and snapshot; complete retries reuse the verified id when
present. Any owner, address, chain, signer or policy mismatch writes no
binding. Never infer signer identity from a quorum id or array position.

## Policy lifecycle and migration

Ledger chain `solana` selects `solana-devnet`. Under a wallet lock, compose
rules from active ledger grants, patch and read back exactly. Mutations require
one stored signer; drift, ambiguity, or provider uncertainty leaves grants
`policy_not_ready`; uncertain revoke remains retryable.

The Privy policy uses `chain_type: 'solana'`,
`signAndSendTransaction`, and `solana_system_program_instruction` fields
`Transfer.to` and `Transfer.lamports`; expiry uses system time with `lt`.
Every instruction must match an ALLOW rule. Reject ALT transactions because
Privy cannot resolve their recipient addresses. The exact DSL and limitation
are verified in [Privy's Solana examples](https://docs.privy.io/controls/policies/example-policies/solana),
2026-10-04.

Migration 010 adds the canonical signer and durable snapshot; 011 adds nullable
`signer_grants.per_transfer_lamports`, leaving EVM `per_transfer_atomic6`
unchanged. Solana enrollment stores 10,000,000 lamports; API/UI show
`perTransferSol: '0.01'` / `0.01 SOL`, never USDC. DGC `chain='solana'` amounts
are lamports; per-transfer grants may be lower but cannot exceed 10,000,000,
and UI divides by 1,000,000,000. No oracle. Backfill only one distinct
readback-derived signer id; enrollment persists it after verification.
Enable the selector after migration; rollback disables it.

## Safety and verification

No global sender or secret logging. Devnet/SOL only; reject invalid, zero, or
self recipients, fees above 50,000 lamports, and ALT transactions. Never resend
an ambiguous broadcast; reconcile finality first. Transactions stay unsigned;
there is no local keypair.

Strict TDD covers provider outcomes, no-send/no-keypair, wallet isolation,
chain-aware sync and unchanged Ethereum behavior, exact signer identity,
enrollment consent/snapshot/retry/conflict, sibling preservation, migration
backfill, policy readback and advisory-lock races. Run lint, typecheck, tests
with Postgres, build and local E2E. Live devnet smoke stays opt-in and performs
no transfer without verified signer and policy readback.

D-4 satisfies 2.9; execution still requires verified signer and policy readback.
