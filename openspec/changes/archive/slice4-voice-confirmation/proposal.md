# Proposal: Explicit voice confirmation for uncovered Solana transfers

## Problem

The assistant can prepare an address-free voice transfer preview, but the model's `confirm_transfer` callback currently trusts its own tool choice. The server does not require evidence that the user spoke an explicit confirmation after hearing the current preview. Also, contacts and live-transfer policy only accept EVM addresses, blocking the Slice 2 Solana devnet provider from the outside-grant voice flow.

## Outcome

For a Solana devnet transfer outside an active delegated grant, the assistant resolves a versioned saved contact, reads back amount, contact name and estimated fee, and broadcasts only after a final explicit spoken confirmation tied to that current preview. Spoken cancellation and stale-preview handling remain observable. No voice tool accepts a free-form destination.

## Scope

- Bind a one-use confirmation/cancellation decision to a final user transcript arriving after the current preview.
- Extend versioned contact storage/API/UI compatibly for Solana devnet recipients while retaining EVM behavior.
- Apply chain-aware validation and the configured live transfer maximum to the uncovered Solana voice path, converting exactly to lamports without an oracle. The separate 0.01 SOL hard cap remains specific to delegated grants in Slice 2.
- Narrate amount, token, saved contact name and estimated fee; never expose the raw recipient address to the model.
- Prove preview, confirmation, cancellation, stale preview, race, broadcast and finality with deterministic tests and a fake LiveKit worker.

## Out of scope

Grant creation or policy changes, changes to Slice 3 covered-grant execution, multi-wallet, swaps, notifications, EVM behavior changes, arbitrary-address voice sending, production devnet signatures, and product-wide copy redesign.

## Acceptance

1. A `confirm_transfer` model tool call without a matching final user transcript after the active preview never broadcasts.
2. A final exact confirmation after the preview authorizes at most that preview once; replay, earlier confirmation, non-final transcript, or mismatched/stale preview fails closed.
3. Exact spoken cancellation cancels the active preview and never broadcasts.
4. Solana recipients are versioned saved contacts explicitly scoped to `solana-devnet`; invalid, changed, EVM, or ambiguous recipients cannot reach broadcast.
5. Every Solana preview obeys configured live policy and exact lamport precision; UI and voice render SOL, amount, recipient name and estimated fee.
6. Voice schemas remain strict and address-free, and existing EVM flow tests stay green.
