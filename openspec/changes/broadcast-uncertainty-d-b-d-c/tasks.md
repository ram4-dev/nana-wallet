# Tasks: Truthful broadcast outcomes for D-B and D-C

## Review Workload Forecast

Estimated changed lines: 100-200. 400-line budget risk: Low. Chained PRs recommended: No. Delivery strategy: ask-on-risk. Chain strategy: pending. No PR is requested.

Decision needed before apply: Resolved by Ramiro's direct instruction to continue in Codex; Pi review unavailable and waived, no independent-review claim.
Chained PRs recommended: No
Chain strategy: pending
400-line budget risk: Low

### Suggested Work Units

| Unit | Goal | Likely PR | Focused test command | Runtime harness | Rollback boundary |
|---|---|---|---|---|---|
| D-B | Classify only proven pre-dispatch failures | Existing branch; no PR yet | `npx vitest run tests/unit/solana-devnet-provider.test.ts tests/unit/conversation-service.test.ts` | Existing fake provider and resolver fixtures; no live RPC | D-B source, tests, and receipt commit |
| D-C | Record safe open disposition | Same branch | Existing reconciliation test file | N/A: no behavior change until authoritative API exists | Documentation-only commit |

## Phase 1: Review and approval

- [x] 1.1 Record Pi/GLM review unavailable (`402 monthly_cap_reached`) and explicit user waiver in `05-independent-review.md`; this is not a Pi review.
- [x] 1.2 Record Ramiro's explicit authorization to proceed in Codex in `03-design-discussion.md`.

## Phase 2: D-B tests and implementation

- [x] 2.1 Add tests for pre-dispatch provider preparation and typed `PrivyWalletRuntimeError` resolution failures; assert signer is not called for provider prep failures.
- [x] 2.2 Pin generic `signAndSend` exceptions as `uncertain` with no retry.
- [x] 2.3 Implement stage-specific provider outcomes and map only `PrivyWalletRuntimeError`; keep generic resolver/provider exceptions uncertain.
- [x] 2.4 Run focused unit tests, typecheck, lint, build, and applicable E2E validation; record full-suite and DB blockers in `90-verification.md`.

## Phase 3: D-C disposition

- [x] 3.1 Record that missing/null lookup and incomplete history do not prove absence; keep `uncertain` and no retry.
- [x] 3.2 Leave D-C open until the production adapter can provide authoritative reference correlation and absence.
