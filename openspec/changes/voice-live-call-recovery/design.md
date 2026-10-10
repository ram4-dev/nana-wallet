# Design
Keep runFinancialTransfer's return value in the waiting resolveDecision closure and return it after FinancialTaskRegistry.wait. Preserve the existing projection fallback only when no result is available. Do not change financial task registry architecture or introduce persistent fields.
Add metadata-only observation at the gate/transcript boundary to diagnose why a transcript is rejected or absent. No authorization change in this work unit.
Worktree explicitly designated by user: /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational, feat/solana-operational. Tests precede production changes. Rollback is scoped to this unit's files.
