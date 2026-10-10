# Apply progress — voice-live-call-recovery

## Completed tasks

- [x] 1.1 Reproduced the lost terminal result and retained the financial task's result in `resolveDecision`.
- [x] 1.2 Added coverage for policy refusal, successful submission, and uncertain dispatch without changing authorization or retry behavior.
- [x] 1.3 Ran focused service coverage and the existing fake voice confirmation E2E.

## Work Unit Evidence

| Evidence | Result |
| --- | --- |
| Focused test command and exact result | `npx vitest run tests/unit/conversation-service.test.ts` — initial RED: 55 passed, 1 failed (`policy_rejected` projected as `transaction_receipt_invalid`); after implementation: 56 passed, 0 failed. |
| Runtime harness command/scenario and exact result | `npx vitest run tests/integration/livekit-voice-confirmation-fake.e2e.test.ts` — 8 passed, 0 failed. The harness covers preview narration fields, a normal spoken agreement, policy refusal, and one-use authorization. |
| Rollback boundary | Revert the terminal-result closure in `src/conversations/service.ts` and the three regression tests in `tests/unit/conversation-service.test.ts`; no authorization, retry, registry, or provider behavior is changed. |

## Remaining tasks

- [ ] 2.1 Add metadata-only gate diagnostics and observe a live call before any timing change.
- [ ] 2.2 Run lint, typecheck, build and applicable evals; restart worker and verify deployed strings.
- [ ] 2.3 Observe live ordinary-agreement transfer and balance change; later tasks remain deferred.
