# Structure outline: broadcast uncertainty defects

Revision: r2. Status: approved by Ramiro for bounded implementation; Pi independent review unavailable and explicitly waived.

## Slice 1: D-B, prove known pre-dispatch failures

- Outcome: validly classify only operations proven to occur before `signAndSend`; preserve `uncertain` for generic dispatch exceptions.
- Files: `src/wallet/solana-devnet-provider.ts`, `src/conversations/service.ts`.
- Tests: `tests/unit/solana-devnet-provider.test.ts`, `tests/unit/conversation-service.test.ts`.
- Automated checks: focused Vitest files, `npm run typecheck`, `npm run lint`.
- Runtime/E2E: existing test harness only; no live wallet/RPC. Run applicable project E2E suite after implementation if available.
- Manual check: trace every new `not_dispatched` branch to show it precedes the sole dispatch call; only known `PrivyWalletRuntimeError` values from lazy resolution may be mapped, while generic resolver/provider errors and generic timeouts remain `broadcast_uncertain`.
- Stop condition: if a provider exception cannot be proven to happen before dispatch, leave it `uncertain`.

## Slice 2: D-C, record bounded safe disposition

- Outcome: document that absence is unprovable through current production lookup and keep unresolved references `uncertain`.
- Files: `odd/tasks/broadcast-uncertain-defects.md`, OpenSpec task receipt.
- Checks: inspect production SDK surface and preserve tests that show missing reference lookup does not dispatch or settle.
- Manual check: verify no code path treats a capped or indexed history page as exhaustive.
- Stop condition: do not implement `not_dispatched` without an authoritative correlation and explicit absence signal.

Estimated code and tests: under 200 changed lines. 400-line risk: low. Delivery strategy: one work branch; no PR requested. D-C may remain open.
