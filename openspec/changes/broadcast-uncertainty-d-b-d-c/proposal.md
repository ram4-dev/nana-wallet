# Proposal: Truthful broadcast outcomes for D-B and D-C

## Intent

Avoid telling a user that a transfer outcome is unknown when the code can prove the request never reached dispatch. Preserve uncertainty whenever dispatch may have happened.

## Scope

### In Scope
- Convert known provider preparation and lazy wallet-resolution failures into truthful pre-dispatch outcomes.
- Keep generic errors from the dispatch call as `uncertain`.
- Record the safe D-C disposition: current Privy lookup cannot prove absence, so unresolved attempts remain uncertain.

### Out of Scope
- Payment-policy changes, retries, re-signing, live RPC, frontend/API contract changes, and D-C absence inference from bounded history.

## Capabilities

### New Capabilities
- `wallet-broadcast-outcomes`: distinguish provable pre-dispatch failures from unresolved dispatches.

### Modified Capabilities
- None. No existing `openspec/specs/` directory or source capability spec exists in this worktree.

## Approach

Guard preparation steps separately from the sole `signAndSend` boundary. Isolate wallet resolution so only its pre-provider failure can be classified as non-dispatch. Preserve the existing uncertain result for generic dispatch errors. Do not change D-C behavior without an authoritative reference lookup.

## Affected Areas

| Area | Impact | Description |
|---|---|---|
| `src/wallet/solana-devnet-provider.ts` | Modified | Classify pre-dispatch preparation failures |
| `src/conversations/service.ts` | Modified | Map only typed resolution failure to `not_dispatched` |
| `tests/unit/solana-devnet-provider.test.ts` | Modified | Pin preparation and dispatch boundary cases |
| `tests/unit/conversation-service.test.ts` | Modified | Pin resolution failure and generic error behavior |

## Risks and rollback

| Risk | Mitigation |
|---|---|
| Misclassify a failure after submission | Only classify failures from code structurally before `signAndSend`; generic dispatch failures stay uncertain |
| Provider resolution error is mistaken for dispatch error | Use a typed error only around lazy resolution |

Rollback: revert the isolated D-B commit; this restores existing conservative handling. D-C has no behavior change to roll back.

## Success Criteria

- [ ] Tests prove known pre-dispatch failures yield `not_dispatched` without calling the signer.
- [ ] Generic dispatch errors remain `uncertain`.
- [ ] D-C stays uncertain unless an authoritative lookup proves absence.
- [ ] Focused tests, typecheck, lint, and applicable E2E validation pass.
