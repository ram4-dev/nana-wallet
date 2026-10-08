# Archive report — privy-policy-api-alignment

## Summary

La política de enrollment se alineó con la API vigente de Privy, habilitando la activación del permiso de pagos.

## Delivered

- Current rule shape `{name (≤50 chars), method, action, conditions[]}` with the guard conditions inside the rule.
- `chain_id` sent as a string; recipient allowlist via the `in` operator (`in_condition_set` requires a separate condition-set resource id); the removed `gas` field dropped.
- Policy names shortened to fit the 50-character cap.
- Enrollment wallet chain selected by the recipient type, fixing `Invalid recipient address` for EVM recipients on multi-wallet accounts.

## Evidence

- Merged as PR #13 (`8227607`).
- Verified live: policy creation returns 200 and `preparePermission` succeeds for the real user (policy `u94to62itemodu5kon7ubwmy`).

## Open items and deferrals

Recorded, not hidden: the gas ceiling is no longer expressed as a provider policy condition (the field left the API enum); the bound stays enforced through the signed transaction envelope's fee constraints.

## Archive metadata

- Archived: 2026-10-08
- Archive authority: owner request ("hagamos un archive de todas las features que metimos hasta ahora")
- Repository state at archive: `main` = 4cd8092 (PR #15 merged)
- Delivery evidence: merged PRs on `ram4-dev/nana-wallet` + green CI (backend lint/typecheck/tests/evals, frontend lint/typecheck/tests)
