# Design: Managed Profile Onboarding and Responsible Access

## Technical Approach

Add an invitation/relationship subsystem beside the existing owner paths. Privy authentication still resolves the actor DID to `users.id`; every managed request names a subject but `ManagedAccessService` authorizes the relationship and exact capability before entering that subject's existing RLS scope. Owner wallet, conversation, voice-token, grant, signing, and transfer routes remain self-only. Policy writes are **disabled** pending approval of `onboarding-roles-consent-boundary-r2`; this design does not treat that amendment as decided.

## Architecture Decisions

| Decision | Choice and rationale | Rejected alternative |
|---|---|---|
| Actor/subject boundary | Dedicated `/v1/managed-people/:subjectId` routes call closed `ManagedAccessService` operations. It locks the relationship as actor, then sets `app.user_id` to the subject in the same transaction. This preserves current owner RLS and serializes revocation. | Optional subject on existing routes broadens transfer/signing authority. |
| Invitation identity | Extend authenticated identity internally with verified `privyDid`; a server Privy adapter reads `linked_accounts` and returns normalized, verified emails. Invitation lookup/decision is an internal system transaction constrained by those emails; responses never expose account existence. | Browser-provided email or access-token claims do not prove ownership. |
| Voice decision | Extend `ActionKind` with `invitation`. Server-authored text is played through a validated TTS path; only successful `waitForPlayout()` opens the window bound to invitation/version, user, conversation, and participant. Persisted CAS is the final authority. | `generateReply` can paraphrase or be interrupted. |
| Policy authority | Until the pending amendment is approved, accepted relationships expose reads only and stay `accepted_pending_policy_authorization`; no `guardian_policy_authorizations`, `contacts.write`, `limits.write`, or Privy PATCH is enabled. | Inferring consent from invitation acceptance or provider readback. |

## Data Flow

```text
Guardian DID -> POST invitation -> opaque pending row
Beneficiary DID -> Privy verified emails -> pending invitation/card
card or TTS playout -> invitation window -> final bound speech/screen decision
                    -> CAS accept -> read-only relationship

Guardian DID -> managed read(subject)
  -> lock relationship + check state/version/capability
  -> set app.user_id=subject -> narrow contacts/history/limits read
Revoke -> lock same relationship -> revoked -> later reads denied
```

## Components and File Changes

| Area | Change |
|---|---|
| `src/db/migrations/017_guardian_relationships.sql`, `supabase/migrations/20261010000100_guardian_relationships.sql` | Add mirrored `guardian_invitations` and `guardian_relationships`, CAS/version constraints, expiry/idempotency indexes, forced RLS, and invitation/relationship notification values. |
| `src/guardians/{privy-email,repository,invitation-service,access-service}.ts` | Trusted email resolution, lifecycle transitions, capability checks, subject-scoped closed reads, and revoke locking. |
| `src/auth/privy-identity.ts`, `src/api/{me,guardian,managed-people,notifications}.ts`, `src/contracts/http.ts`, `src/server.ts` | Preserve DID evidence; add profiles, invitation/decision/revoke, and narrow managed-read contracts. |
| `src/conversations/confirmation-arbiter.ts`, `src/livekit/{create-agent-session,voice-decision-gate,worker}.ts` | Add exclusive invitation window, canonical narration, verified playout, and shared screen/voice decision service. |
| `apps/nana-wallet/src/{lib,routes,features}/` | Mirror contracts; role choice, invitation-first startup, profile selector, subject-labelled read views, and actor/subject/relation-version query keys. |

## Interfaces and Failure Handling

`ManagedCapability` initially contains `contacts.read | history.read | limits.read`. Mutations require `Idempotency-Key` and expected version; stale state is `409`, absent capability `403`, inaccessible subject `404`, invalid input `422`, and unverifiable Privy/TTS dependency `503`. Email lookup failure reveals nothing; interrupted audio leaves the invitation pending; replay returns the prior decision; remote history failure does not weaken authorization. Logs carry actor, subject, relation, version, capability, decision origin, and refusal code, never email/token/transcript/address. Metrics count lifecycle transitions, denied capability calls, CAS conflicts, verified/failed playout, and revocation latency.

## Security and Migration

No guardian policy is added to wallet/data tables. Guardian metadata RLS permits only its parties; system access is limited to verified-email invitation resolution. Existing rows, wallets, caps, signers, and policies are unchanged; relationships start empty. Roll out schema, read-only APIs, UI, then voice behind separate flags. Rollback disables flags and voice windows while retaining audit rows. Policy migrations and rollout require a later approved amendment/spec/design update.

## Testing Strategy

- Unit: email normalization, lifecycle/CAS, capability matrix, arbiter cross-kind isolation, pre/interrupted playout refusal.
- Integration with Postgres: mirrored migrations, forced RLS, two-DID isolation, expiry/replay, accept/revoke races, and no managed access to transfer/grant/room-token routes.
- Frontend: invitation-first ordering, cache cancellation on subject/logout/revoke, accessible labels, and no money controls.
- E2E: browser two-DID invite/accept/read/revoke; LiveKit canonical narration then ordinary “sí”; owner Solana transfer regression. Policy-write E2E is blocked by the pending amendment.

## Threat Matrix

N/A — no shell, subprocess, VCS/PR automation, executable classification, or process-integration boundary.

## Inputs for Task Planning

Plan read-only onboarding in reviewable slices: schema/services, HTTP/UI reads, then voice. Treat approval of `onboarding-roles-consent-boundary-r2` plus a managed-policy spec/design delta and controlled Privy capability proof as hard prerequisites for every policy-write task.
