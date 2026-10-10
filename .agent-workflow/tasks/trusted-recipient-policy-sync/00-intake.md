# Trusted recipients and Privy policy synchronization

Revision: 1 — 2026-10-10. Phase: research and design; implementation not authorized by this artifact.

## Requested outcome
Adding a trusted recipient enables its exact Solana address in Privy automatically. Editing and removing recipients keeps authorization consistent. The authenticated user can request the same actions through the text or voice agent.

## Authority and boundaries
User authorized the complete mapping. Documentation and read-only source inspection are allowed. No remote policy mutation, transaction, credential access, application-code change, push, or PR in this phase. Worktree: /Users/ramiro/Desktop/projects/colloseum.feat-solana-operational; branch feat/solana-operational. Preserve local untracked ports override and all existing work.

Route: HumanLayer RPI; contact persistence, external authorization, agent confirmation, and delegated grants need an integrated design. A localized CRUD patch would leave incompatible writers and failure semantics unresolved. Implement approved design through SDD later.

## Acceptance evidence for implementation
- Screen and agent converge on one user-scoped application service.
- Adding an exact confirmed Solana address updates the correct attached Privy policy and verifies readback before reporting enabled.
- Updates/removals remove obsolete authorization, including duplicate-address and delegated-grant cases under the approved removal semantics.
- Existing 0.01 SOL ceiling, signer identity, unrelated signers, and devnet configuration remain unchanged.
- Persisted intent survives remote timeout, process restart, and concurrent backend/worker writes; no fabricated success.
- Spoken authorization belongs to the exact contact action, is authenticated, occurs after its proposal, and is used once. It cannot authorize a transfer.
- E2E proves both entry points, remote rule readback, and the resulting transfer permission behavior.

## Active gate
Gate ID: trusted-recipient-design-r1
Allowed next action: complete evidence-backed mapping and design discussion.
Owner: 03-design-discussion.md revision 1.
Decision owner: Ramiro. Mapping authorized by user request; implementation design approval pending.

## Non-goals
No new chain switch, local transfer-policy gate, rolling-limit provider claim, key rotation, pending broadcast recovery, or unrelated refactor. Previous voice follow-up items remain open separately.
