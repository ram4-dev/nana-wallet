# Voice live call recovery

Outcome: one authenticated live Solana devnet voice transfer, preview narrated and ordinary agreement accepted once, with observable on-chain balance change.
Authority: user requested continuation in the existing worktree and correction of the observed failure. No push or PR; no changes to policy, keys, wallet modes, or confirmation invariant.
Route: Oneshot for localized restoration of the existing approved contract; verified runtime result is the gate. No new product or architecture decision.
Worktree: /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational; branch feat/solana-operational; source bafc63d plus handoff commit 808bbbc. Explicit user resumption overrides creation of another worktree.
Evidence: 04:38:14 confirmation_required, 04:38:25 transaction_receipt_invalid; DB progress failed with policy-rejection copy, attempt still previewed and no hash. Chain balance 5 SOL, only funding signature. User requested 0.01 and said affirmative confirmation.
Approved scope revision 1: preserve exact financial-task result; add metadata-only confirmation diagnostics to reproduce first-turn refusal. No speculative timing fix before observing ordering.
Acceptance: focused regression tests, lint/typecheck/build, fixture E2E and live-call proof. Existing mid-refactor tests and DB noise remain deferred until the successful live call.
Rollback: only files changed by this work unit; runtime signer overlay is local and separately reversible.
