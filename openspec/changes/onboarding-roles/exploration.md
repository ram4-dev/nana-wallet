## Exploration: onboarding roles and managed profiles

### Current State

Nana currently has one authenticated Privy path. The frontend sends every visitor from `apps/nana-wallet/src/routes/login.tsx` directly to the Privy login button; `apps/nana-wallet/src/routes/__root.tsx` redirects authenticated users to the same application shell and configures embedded wallet creation for all users in `apps/nana-wallet/src/features/wallet/privy-config.ts`. The backend verifies a Privy DID, resolves it to one internal `users.id`, and derives every route subject from that authenticated user (`src/auth/privy-identity.ts`, `src/server.ts`, `src/api/me.ts`). There is no guardian/beneficiary relation, invitation, role context, or managed subject.

All existing data access is owner-scoped. Contacts and recipient policy routes call `resolveUserId` and operate through RLS transactions (`src/api/contacts.ts`, `src/wallet/policy/service.ts`, `src/db/client.ts`). `wallet_notifications` is also owner-only and currently admits only wallet/assistant transfer categories (`src/api/notifications.ts`, `src/db/migrations/013_wallet_notifications.sql`). This is a useful boundary for adding narrow managed-profile services, but it means a guardian cannot be enabled by changing only a route parameter or a generic RLS policy.

Trusted-recipient policy synchronization already has a durable desired/applied revision, a single composer, leases, readback, and fail-closed status projection (`src/wallet/policy/{composer,service,repository,reconciler}.ts`, migrations `015` and `016`). The composer currently rejects every ordinary cap except the constant `SOLANA_MAX_PER_TRANSFER_LAMPORTS` and always emits a Solana rule with `Transfer.lamports` (`src/wallet/policy/composer.ts`). The current service writes only for the authenticated wallet owner. The design's `capped/unlimited` limit therefore requires a typed persisted state and a provider capability proof; it cannot be implemented as a sentinel numeric value.

Voice sessions are bound to the authenticated conversation subject in `src/livekit/room-conversation.ts` and `src/livekit/worker.ts`. The worker creates the normal wallet tool catalog, including transfer tools, and starts a model-generated balance greeting through `src/livekit/create-agent-session.ts`. The existing voice gate is specifically a transfer gate (`src/livekit/voice-decision-gate.ts`, `src/conversations/confirmation-arbiter.ts`); it has no invitation decision kind or startup invitation prompt. The current agent definition exposes wallet and trusted-recipient tools without a guardian-specific catalog (`src/agent/definition.ts`, `src/livekit/realtime-tools/create-realtime-tools.ts`).

The repository has strong focused coverage for identity, cross-user contacts/policy isolation, policy composition and readback, notifications, voice gates, and LiveKit worker behavior (`tests/unit/privy-identity.test.ts`, `tests/integration/api-contacts-policy-cross-user.test.ts`, `tests/unit/policy-composer*.test.ts`, `tests/integration/notifications-feed.test.ts`, `tests/unit/livekit/voice-decision-gate*.test.ts`). There is no onboarding or managed-profile implementation or test fixture yet. Database migrations have two mirrors: `src/db/migrations/` for the local runner and `supabase/migrations/` for deployed schema; existing tables use forced RLS and owner-specific policies.

### Affected Areas

- `src/db/migrations/` and `supabase/migrations/` — add invitation, relationship, policy-authorization, audit/intention, and notification projection state without reassigning existing users or wallets; preserve forced RLS and mirror parity.
- `src/auth/privy-identity.ts`, `src/db/client.ts`, and a new managed-access service — keep `actorUserId` from the verified DID and authorize an explicit `subjectUserId` only through an active relationship and capability; serialize revocation with reads and writes.
- `src/api/` and `src/contracts/http.ts` — add invitation/profile/revocation endpoints plus narrow managed contacts, history, and ordinary-limit endpoints; retain self-only wallet, room-token, conversation, grant, and transfer routes. Frontend types must mirror the backend contract.
- `src/wallet/policy/composer.ts`, `service.ts`, `repository.ts`, `reconciler.ts`, and `src/wallet/embedded.ts` — represent `capped` versus `unlimited`, preserve allowlists, grants, signers, and unknown restrictions, and expose desired/applied/readback status for guardian mutations.
- `src/api/notifications.ts`, `src/notifications/`, and notification migrations — make invitation and policy-change events durable, owner-visible, independently readable, and distinct from invitation acceptance or transfer confirmation.
- `apps/nana-wallet/src/routes/login.tsx`, `__root.tsx`, `index.tsx`, `perfil.tsx`, `lib/api.ts`, `lib/api-types.ts`, and new managed-profile features — add role choice, invitation-first startup, subject switching, cache isolation, managed read views, policy controls, revoke handling, and explicit subject identity.
- `src/livekit/worker.ts`, `create-agent-session.ts`, `room-conversation.ts`, `src/livekit/voice-decision-gate.ts`, and `src/agent/definition.ts` — narrate the canonical invitation before the regular greeting, add an exclusive one-use invitation decision window after verified playout, and build a guardian tool catalog with no transfer/signature/grant tools.
- Existing tests and E2E harnesses — extend database migration/RLS, two-DID authorization, browser, LiveKit, policy capability, and full-flow coverage; run backend and frontend checks at each affected slice.

### Approaches

1. **Narrow managed-profile service with explicit subject and capability checks** — introduce invitation and relationship tables plus a `ManagedAccessService` that authorizes each operation, then call existing owner-scoped repositories/policy services inside a subject transaction.
   - Pros: preserves the current owner/RLS boundary; makes actor versus subject auditable; keeps transfer, room-token, grant, and wallet routes self-only; reuses the existing policy composer/reconciler and notification feed.
   - Cons: requires new transactional helpers, migrations, contracts, UI cache keys, and many two-DID tests; policy writes need an explicit provider-consent capability proof before activation.
   - Effort: High

2. **Generalize all existing routes with an optional `subjectId` or role parameter** — let current contacts, wallets, conversations, and voice routes resolve an alternate subject from request context.
   - Pros: fewer apparent endpoint names and some shared UI paths.
   - Cons: expands the attack surface across money-moving and room-binding code; risks turning a navigation choice or email into authority; weakens the current self-only RLS contract; makes it difficult to prove that a guardian cannot transfer or sign. It also couples unrelated wallet and conversation flows to relationship semantics.
   - Effort: High

3. **Provider-native Privy delegation as the application authorization model** — store little local relationship state and rely on Privy policy/delegation objects for access.
   - Pros: may align policy changes with the wallet provider and reduce some local policy plumbing.
   - Cons: Privy access tokens prove the DID, not the invited email; provider policy capabilities for one-time owner consent, unlimited Solana allowlists, managed reads, and revocation are unverified. Local invitation lifecycle, audit, notification, subject switching, and UI authorization would still be required, while relying on provider delegation could accidentally expose transfer/signature authority.
   - Effort: High

### Recommendation

Use Approach 1. Keep the authenticated DID and wallet ownership model intact, add a local many-to-many invitation/relationship model, and expose only narrow managed-profile methods. Make every managed operation carry both actor and subject identity, check the relationship and capability in the same transaction, and route contact/limit mutations through the existing policy service. Add the invitation voice decision as a separate arbiter kind after a server-authored prompt has completed playout. Keep guardian voice tools read/policy-only and reject forbidden transfer paths in the backend even when called directly.

Implement vertically in the approved order: first prove Privy linked-email, owner-consent, unlimited-allowlist, and LiveKit playout capabilities without mutating a real wallet; then invitations/relationships and RLS; managed reads and frontend isolation; narrated invitation; policy authority and `capped/unlimited`; finally guardian agent tools and full E2E. If Privy cannot prove the required one-time consent or unlimited rule, leave relationships read-only in `accepted_pending_policy_authorization` and stop before enabling writes.

### Risks

- Privy access-token claims do not establish the invited email; accepting by browser-supplied email would create account enumeration or unauthorized links. The server must inspect verified linked accounts and fail closed when that evidence is unavailable.
- Existing forced owner RLS does not support a broad guardian policy safely. Subject-scoped access needs a tightly bounded transaction/service seam and tests for pending, active, revoking, and revoked relationships.
- `unlimited` may not be representable or provable by the installed Privy policy API. Omitting `Transfer.lamports` must preserve `Transfer.to`, signers, grants, and unrelated restrictions; otherwise the mutation must remain blocked.
- Invitation acceptance and transfer confirmation are separate decisions. A shared affirmative, model-generated phrase, pre-playout transcript, interruption, or wrong participant must never authorize either action.
- The current embedded-wallet configuration creates wallets for every Privy login. Guardian onboarding must verify whether incidental wallet creation can be disabled or safely left unlinked and non-signing.
- Policy application already has pending, ambiguous, lease, and readback states. Guardian mutations must not report a remote change as applied without the same evidence and must serialize revocation against in-flight work.
- Frontend query keys and LiveKit bindings are currently user-scoped. A subject switch or logout must cancel requests and clear caches so one beneficiary's contacts, history, limits, or voice context cannot appear under another.
- The backend and Supabase migration mirrors can drift; every schema change must be applied and tested in both paths before deployment.

### Ready for Proposal

Yes. The approved PRD, system/program design, and outline are concrete enough to write the SDD proposal. The proposal should preserve the five vertical slices, make the capability probes a hard precondition for policy writes, and include rollback for relationship/policy schema changes. No product code or remote wallet/policy state was changed during this exploration.
