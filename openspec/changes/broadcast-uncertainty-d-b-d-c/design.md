# Design: Truthful broadcast outcomes for D-B and D-C

## Technical Approach

Keep the dispatch boundary explicit. Convert only failures from provider validation/preparation or lazy wallet resolution, which occur before the signer call. Preserve the current typed classification inside the dispatch call; generic errors there stay `uncertain`. D-C remains unresolved without an authoritative lookup-by-reference contract.

## Architecture Decisions

| Decision | Choice | Alternative | Rationale |
|---|---|---|---|
| Provider preparation | Guard request validation and runtime preparation before dispatch; map typed causes | Catch around the entire method | A wide catch could hide an error after submission |
| Lazy wallet binding | Map only existing `PrivyWalletRuntimeError` values thrown during resolution | Classify all thrown resolver/provider errors as unavailable | Known resolver failures are typed and happen before the provider call; generic DB/runtime/provider errors must stay uncertain |
| D-C absence | Keep unresolved results uncertain | Infer absence from partial history or unsupported SDK fields | Current Privy API lacks correlation evidence; partial history is not exhaustive |

## Data Flow

    Conversation service → lazy wallet resolution → provider validation/preparation
                                               → signAndSend → submitted / uncertain
                            resolver failure → not_dispatched(provider_unavailable)
    Reconcile by reference → authoritative hit → submitted
                           → unavailable / null / incomplete → uncertain

## File Changes

| File | Action | Description |
|---|---|---|
| `src/wallet/solana-devnet-provider.ts` | Modify | Catch only pre-dispatch validation/preparation failures |
| `src/conversations/service.ts` | Modify | Map only typed resolver failure to `not_dispatched` |
| Unit test files for provider and conversation service | Modify | Prove pre- and post-dispatch behavior |
| `odd/tasks/broadcast-uncertain-defects.md` | Modify | Record D-C as open with evidence |

## Interfaces and Contracts

No HTTP contract changes. `PrivyWalletRuntimeError` already marks expected resolver failures. The service may map only that known type from the lazy resolver; untyped errors stay `uncertain`.

## Testing Strategy

| Layer | What to test | Approach |
|---|---|---|
| Unit | Validation, binding, blockhash failure before signer | Inject provider dependencies and assert signer not called |
| Unit | Resolver failure versus generic provider throw | Test typed resolver failure maps to provider unavailable; generic throw remains uncertain |
| Unit | Reconciliation absence | Keep null/missing lookup and incomplete scans unresolved; no second dispatch |
| E2E | Existing wallet confirmation route | Run the applicable non-live suite after implementation; no live payment or RPC |

## Threat Matrix

N/A: no routing, shell, subprocess, VCS/PR automation, executable-file classification, or process-integration boundary changes.

## Migration and Rollout

No migration or API contract change. Revert the isolated D-B commit to restore prior behavior.

## Open Questions

- Independent Pi review and explicit human approval of the outline remain pending.
- D-C cannot move to `not_dispatched` on current evidence; revisit only if Privy adds an authoritative reference lookup.
