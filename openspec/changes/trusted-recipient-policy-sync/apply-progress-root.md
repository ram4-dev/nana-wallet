# Root integration evidence

## Test environment signing capability isolation

Regression: ambient PRIVY_SIGNER_URL/TOKEN were not cleared by the provider-isolation setup. A fixture could construct a live sidecar signer despite provider credentials being removed.

| RED | GREEN | Static checks | Runtime boundary / rollback |
| --- | --- | --- | --- |
| npx vitest run tests/unit/provider-env-isolation.test.ts: 1 failed / 1 passed; createWorkerPayloadSigner still constructed a capability | same command: 2 passed | npm run lint && npm run typecheck: exit 0 | Actual environment-to-signer constructor used; no signing request sent. Revert setup key list and this test together. |

Real-mode opt-in preserves the capability; DATABASE_URL stays unchanged so integration tests are not silently skipped.
