# Research findings

Date: 2026-10-22. Sources inspected: `odd/tasks/broadcast-uncertain-defects.md`, wallet provider/service code, and focused unit-test fixtures. CodeGraph has no index for this worktree; source was inspected directly.

## D-B: dispatch boundary

- `src/wallet/solana-devnet-provider.ts:387-416` validates network, preview ID, recipient, amount, bound identity, recent blockhash, and serializes the transaction before entering the `try` around `signAndSend.signAndSend` at line 418. Throws from those earlier steps currently escape.
- The call to `signAndSend` is the only operation in the dispatch `try`. Its existing catch maps typed definitive signer/policy failures to `not_dispatched`; generic failures stay `uncertain`.
- `src/conversations/service.ts:1334-1342` catches every error from `walletForUser(...).broadcastTransfer(...)` and maps it to `uncertain`. This is safe for an unknown provider exception, but loses proof when lazy wallet resolution fails before a provider exists.
- `src/wallet/user-wallet.ts:32-52, 88-92` returns a lazy wallet binding. Its resolver is awaited before the selected provider's `broadcastTransfer` is invoked. Expected resolver failures are `PrivyWalletRuntimeError` values from `src/wallet/solana-user-wallet.ts`; unexpected database/runtime exceptions can also occur. The current single catch around resolution and provider broadcast does not preserve that distinction.
- Existing tests cover malformed preview IDs, a generic post-boundary timeout, and `not_dispatched` conversation cause mapping. New coverage should pin failures at preparation/resolution, as well as the existing generic-error ambiguity.

## D-C: authoritative absence

- `src/wallet/solana-devnet-provider.ts:472-505` returns `submitted` only for a non-empty hash returned by `findByReference`; missing method, `null`, or empty hash stays `uncertain`.
- The production `createPrivySignAndSendClient` at lines 830-840 deliberately has no `findByReference`. Wallet history cannot search by `reference_id`; individual transaction records can contain the reference, but looking them up requires a transaction ID unavailable after an ambiguous dispatch.
- `resolveByHistoryPaging` at lines 558-600 has a hard page cap and treats an incomplete scan as unresolved. A single bounded page cannot prove absence. Existing specs and comments explicitly reject using a bounded page to settle an unknown transaction.
- Finding no matching transaction in the current production API cannot prove `not_dispatched`. No safe D-C implementation is supported by current evidence.

## Recommendation and remaining gap

For D-B, make the provider convert only its known pre-dispatch preparation failures into typed `not_dispatched` outcomes; at the conversation boundary convert only `PrivyWalletRuntimeError` from lazy resolution. Keep generic resolver/provider failures `uncertain` because their origin is not proven by type.

For D-C, record a proposal and leave behavior unchanged unless the SDK gains an authoritative reference lookup with explicit `found`, `absent`, and `unknown` semantics. This is the bounded safe result; it avoids inventing evidence.

Independent confirmation is pending: the resumed Pi/GLM 5.3 Flash session hit a provider `402 monthly_cap_reached`, reset 2026-11-01 UTC. No code or tests have been changed in this resumed turn.
