# Proposal: Managed Profile Onboarding and Responsible Access

## Intent

Nana has one Privy path scoped to the authenticated wallet. Add responsible onboarding while preserving identity separation, ownership, confirmation, and auditability.

## Scope

### In Scope

- Separate Privy identities, invitations, notifications, relationships, and revocation.
- Actor/subject authorization for data and policies; no responsible transfer or signing.
- Owner-approved `capped`/`unlimited` limits through the policy service, with durable state, readback, and notifications.
- Invitation narration, one-use decision, and responsible tools without money movement.
- Capability probes and full-stack checks.

### Out of Scope

- Assisted representation for a beneficiary unable to authenticate.
- EVM/mainnet, secrets, transfer changes, grants, signer administration, wallet reassignment, or unreviewed live mutation.

## Capabilities

### New Capabilities

- `managed-profile-onboarding`: roles, invitations, consent, switching, revocation.
- `managed-profile-access`: actor/subject authorization and policy-only access.
- `managed-policy-authority`: consent, mutation, reconciliation, readback.
- `managed-voice-agent`: narration and transfer-isolated tools.

### Modified Capabilities

- None. No main specs exist; owner wallet and transfer contracts remain unchanged.

## Approach

Use additive migrations and a narrow managed-access service. Keep actor separate from subject, RLS owner-scoped, and reuse policy reconciliation. Sequence: probes, relationships, reads, voice, policy authority, agent closure.

## Affected Areas

| Area | Impact |
|---|---|
| `src/db/migrations/`, `supabase/migrations/` | Relationships, consent, audit |
| `src/guardians/`, `src/api/`, HTTP contracts | Authorization and endpoints |
| `src/wallet/policy/`, `apps/nana-wallet/src/` | Policy and onboarding UI |
| `src/livekit/`, `src/agent/`, tests/evals | Voice, tools, regression coverage |

## Risks

| Risk | Mitigation |
|---|---|
| Privy lacks provider proof of guardian authority | Bind DID, scope, revocation, and audit locally; reopen design before writes |
| LiveKit lacks TTS or VAD interrupts consent | Add TTS/audio for `@livekit/agents` 1.7.1; require `waitForPlayout` |
| Subject leakage or responsible transfer access | Transactional checks, RLS, cache keys, denial tests |

## Rollback Plan

Freeze managed writes and reconciliation while retaining the restrictive policy. Revert work-unit commits with migrations preserved; report pending states and revoke relationships. Never detach policies, rotate signers, or alter funds.

## Dependencies

- Privy linked-email, consent, and allowlist evidence with controlled transport.
- TTS/audio and playout evidence for realtime LiveKit.
- PostgreSQL/RLS, mirrored contracts, and Solana devnet fixtures.

## Unresolved Product Decisions

None remain in the approved PRD, TDD, or outline. Probe failures may reopen a gate before policy writes.

## Success Criteria

- [ ] Beneficiary accepts a narrated invitation; responsible switches only to authorized subjects.
- [ ] Managed reads and contact/limit changes are attributed, notified, and verified without enabling transfers.
- [ ] `unlimited` preserves allowlists, signers, grants, and unrelated restrictions; failures never appear applied.
- [ ] Browser/voice E2E proves invitation separation, tool isolation, revocation, and owner transfer regression.
