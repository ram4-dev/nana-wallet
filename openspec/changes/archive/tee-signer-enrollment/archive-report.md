# Archive report — tee-signer-enrollment

## Summary

Consentimiento de firmante compatible con wallets TEE de Privy.

## Delivered

- `PrivySignerEnrollment` now uses `useSigners().addSigners({address, signers:[{signerId: quorumId, policyIds:[policyId]}]})`, the TEE path, instead of the on-device `delegateWallet` action.
- The backend `complete` read-back remains the only thing that can activate the permission.

## Evidence

- Merged as PR #14 (`25d2fe0`).
- Reason: live Privy error "useDelegatedActions is only supported for on-device execution and this app uses TEE execution".

## Open items and deferrals

None.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
