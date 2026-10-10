# Tasks: Managed Profile Onboarding and Responsible Access

This task plan implements the approved onboarding, invitation, managed-read, revocation, and voice behavior. It deliberately stops before managed policy writes: the consent-boundary amendment is still proposed, and no policy-write task may be applied until that amendment and the corresponding OpenSpec proposal, specs, and design are approved and updated.

## Review Workload Forecast

The user authorized implementation to completion in the isolated `feat/onboarding-roles` worktree. Deliver the slices as reviewable work-unit commits on this branch. No PR or push is required for this execution. The work is larger than 400 changed lines, so keep each commit focused and verify each unit before continuing. The separate consent-boundary decision still blocks policy writes.

## Threat and safety boundary

The approved design marks the threat matrix N/A for shell, subprocess, VCS/PR automation, executable classification, and process-integration boundaries. No threat-matrix RED tasks are therefore required. The security scenarios in the three delta specs are still explicit test tasks below.

Every task in Phases 1–3 is limited to identity, invitations, relationship lifecycle, managed reads, revocation, UI isolation, or invitation voice. The responsible context MUST NOT receive transfer, preview, confirmation, signing, grant, signer, wallet-reassignment, or room-token tools. No task below these phases may add `contacts.write`, `limits.write`, `guardian_policy_authorizations`, a Privy PATCH, or a remote policy mutation.

## Suggested Work Units

| Unit | Goal | Likely PR | Dependencies | Focused test command | Runtime harness | Rollback boundary |
|------|------|-----------|--------------|----------------------|-----------------|-------------------|
| 1 | Add verified-DID invitation and relationship persistence, lifecycle, and narrow HTTP decisions | Commit group 1 | None; baseline database and Privy identity behavior | `npm test -- tests/unit/guardians tests/integration/guardian-relationships.test.ts tests/integration/guardian-invitations.test.ts` | Isolated Postgres migrated from empty and current schema; two fake Privy DIDs with verified/unverified emails | Revert guardian migration and `src/guardians/`/invitation route files; preserve existing tables and wallets |
| 2 | Add managed read authorization, profiles, subject-explicit reads, revocation enforcement, and frontend role/read-only surfaces | Commit group 2 | Unit 1 | Backend focused tests plus `cd apps/nana-wallet && npm test -- src/features/managed src/routes` | Browser E2E with one responsible DID, two beneficiaries, and one unrelated DID; no live wallet writes | Disable managed-read routes and remove new frontend routes/features; keep relationship rows for audit and leave owner routes unchanged |
| 3 | Add canonical invitation narration, verified playout gate, and responsible read-only voice catalog | Commit group 3 | Units 1–2; LiveKit/TTS capability probe | `npm test -- tests/unit/livekit tests/integration/livekit-worker-fake.e2e.test.ts && npm run eval` | Fake LiveKit worker for deterministic coverage, then opt-in local LiveKit audio E2E | Disable invitation voice flag and responsible catalog; screen invitation remains usable and relationship data stays intact |
| 4 | Add managed policy authority and `capped`/`unlimited` writes | Commit group 4, blocked | Explicit approval of `onboarding-roles-consent-boundary-r2`, controlled Privy capability proof, and updated proposal/spec/design | No command until the gate is approved and new specs are written; then focused policy tests plus full required checks | Controlled Privy transport/readback fixture first; real-wallet mutation requires a separate reviewed authorization | Freeze managed writes and reconciliation; retain restrictive policy, audit rows, and relationship state; never detach signers or alter funds |

## Phase 0: Capability and baseline preflight

- [ ] 0.1 **Record the implementation baseline and service prerequisites.** Verify the current branch, clean/owned worktree, Node dependencies, Postgres migration path, frontend/backend package scripts, and the existing Solana-only transfer regression. Record command output and known pre-existing failures in `.agent-workflow/tasks/onboarding-roles/90-verification.md`; do not change source, migrations, policies, wallets, or credentials.
  - **Dependencies:** None.
  - **Likely files:** `.agent-workflow/tasks/onboarding-roles/90-verification.md` only.
  - **Acceptance evidence:** The record names the database instance, migration source, exact commands, results, and every skipped external E2E with its blocker; no secrets or token values appear.
  - **Verification:** `npm run lint && npm run typecheck && npm run build && npm test`; `cd apps/nana-wallet && npm run lint && npm run typecheck && npm run build && npm test`; run the existing browser/LiveKit commands only when their documented dependencies are available.
  - **Rollback boundary:** Revert the verification-document change only; no runtime state is changed.

- [ ] 0.2 **Probe installed Privy and LiveKit capabilities without mutating remote state.** Add or run read-only probes for verified `linked_accounts` email evidence, role-specific embedded-wallet configuration, Solana allowlist rule shape, and `SpeechHandle.waitForPlayout()`/TTS interruption behavior. The policy and wallet probes MUST use mocked or controlled transport and MUST NOT PATCH a real policy or move funds.
  - **Dependencies:** 0.1.
  - **Likely files:** `src/auth/privy-identity.ts` tests or a dedicated `tests/unit/privy-capabilities.test.ts`; `tests/unit/livekit/tts-capability.test.ts`; probe notes in `.agent-workflow/tasks/onboarding-roles/06-privy-consent-amendment.md` or `90-verification.md`.
  - **Acceptance evidence:** The result distinguishes verified DID from verified email, records whether role-specific wallet creation can be controlled, proves or rejects the allowlist-without-amount shape in the controlled transport, and proves whether playout completion is observable. A failed consent probe leaves policy writes blocked.
  - **Verification:** `npm test -- tests/unit/privy-capabilities.test.ts tests/unit/livekit/tts-capability.test.ts`; `npm run typecheck`.
  - **Rollback boundary:** Remove only the probe tests/notes; no provider request beyond controlled reads is retained.

## Phase 1: Identity, invitation, and relationship foundation

- [ ] 1.1 **Create additive mirrored invitation and relationship migrations with forced RLS.** Add `guardian_invitations` and `guardian_relationships`, their status/version/expiry/idempotency constraints, indexes, unique non-revoked pair rule, self-link prohibition, and invitation/relationship notification values. Keep the migration copies byte-equivalent in intent between `src/db/migrations/` and `supabase/migrations/`; do not add policy-authority or wallet-policy tables in this phase.
  - **Dependencies:** 0.1.
  - **Likely files:** `src/db/migrations/017_guardian_relationships.sql`; `supabase/migrations/20261010000100_guardian_relationships.sql`; migration schema tests under `tests/integration/`.
  - **Acceptance evidence:** Empty-schema and current-schema migrations both succeed; RLS is forced; guardian parties can see only their relationship metadata; unrelated users cannot enumerate invitations or subjects; migration parity is checked structurally.
  - **Verification:** `npm run db:migrate`; `npm test -- tests/integration/guardian-migrations.test.ts tests/integration/guardian-rls.test.ts`.
  - **Rollback boundary:** Revert only the additive migration before deployment; if deployed, disable new routes and retain audit/relationship rows rather than deleting them.

- [ ] 1.2 **Expose verified Privy identity and normalized email evidence through a server adapter.** Extend the internal identity result with the authenticated DID and implement a server-only adapter that reads verified linked email accounts from Privy. Browser email text and access-token claims MUST NOT be treated as proof; adapter failures MUST fail closed without account enumeration.
  - **Dependencies:** 0.2, 1.1.
  - **Likely files:** `src/auth/privy-identity.ts`; new `src/guardians/privy-email.ts`; `tests/unit/privy-identity.test.ts`; `tests/unit/guardians/privy-email.test.ts`.
  - **Acceptance evidence:** Tests cover normalized casing/whitespace, multiple verified emails, unverified email exclusion, missing linked accounts, provider failure, and DID-only sessions. No email/token/transcript is logged.
  - **Verification:** `npm test -- tests/unit/privy-identity.test.ts tests/unit/guardians/privy-email.test.ts && npm run lint && npm run typecheck`.
  - **Rollback boundary:** Remove the adapter wiring and leave existing DID-only owner authentication intact.

- [ ] 1.3 **Implement invitation and relationship repositories with single-use lifecycle transitions.** Create closed repository methods for opaque invitation creation, verified-email listing, seven-day expiry, accept/decline CAS, duplicate-pair prevention, multi-party relationships, and beneficiary revocation. Acceptance MUST return `accepted_pending_policy_authorization` and MUST NOT grant policy writes or transfer authority.
  - **Dependencies:** 1.1, 1.2.
  - **Likely files:** `src/guardians/repository.ts`; `src/guardians/invitation-service.ts`; `src/guardians/relationship-service.ts`; `tests/unit/guardians/invitation-service.test.ts`; `tests/integration/guardian-invitations.test.ts`; `tests/integration/guardian-relationships.test.ts`.
  - **Acceptance evidence:** Tests prove opaque invite responses, idempotency replay, expiry, stale version rejection, accept/decline replay, concurrent decision serialization, multiple relationships, and revocation that leaves other relationships unaffected.
  - **Verification:** `npm test -- tests/unit/guardians/invitation-service.test.ts tests/integration/guardian-invitations.test.ts tests/integration/guardian-relationships.test.ts` with Postgres available.
  - **Rollback boundary:** Revert service/route callers while retaining additive lifecycle rows; no owner wallet or policy record is touched.

- [ ] 1.4 **Add narrow invitation, profile, and revocation contracts and HTTP routes.** Implement `GET /v1/me/profiles`, `POST /v1/guardian/invitations`, `GET /v1/me/invitations`, `POST /v1/me/invitations/:id/decision`, and `POST /v1/me/relationships/:id/revoke` with bearer identity, idempotency, version checks, opaque not-found behavior, and the specified 401/403/404/409/422/503 mapping. Mirror backend Zod contracts in `apps/nana-wallet/src/lib/api-types.ts` and `api.ts`; do not add policy-write routes.
  - **Dependencies:** 1.2, 1.3.
  - **Likely files:** `src/api/me.ts`; new `src/api/guardian.ts`; `src/api/notifications.ts` if notification projection needs a narrow read; `src/contracts/http.ts`; `src/server.ts`; `apps/nana-wallet/src/lib/api.ts`; `apps/nana-wallet/src/lib/api-types.ts`; route and integration tests.
  - **Acceptance evidence:** Two authenticated DIDs can invite, verify, decide, list profiles, and revoke through HTTP. An unrelated DID receives the same inaccessible response regardless of subject existence. Marking a notification read does not accept an invitation. Existing owner routes remain self-scoped.
  - **Verification:** `npm test -- tests/unit/api-guardian.test.ts tests/integration/api-guardian.test.ts tests/integration/api-owner-scope.test.ts && npm run lint && npm run typecheck`.
  - **Rollback boundary:** Disable the new HTTP registration and frontend callers; existing `/v1/contacts`, `/v1/wallet*`, `/v1/conversations*`, `/v1/voice*`, and grants routes remain unchanged.

## Phase 2: Managed read authorization and frontend onboarding

- [ ] 2.1 **Implement the closed managed-access service and subject-scoped read repositories.** Authorize actor, subject, relationship status/version, and exact `contacts.read`, `history.read`, or `limits.read` capability in the same transaction that sets the subject RLS scope. Add dedicated `GET /v1/managed-people/:subjectId/{contacts,transactions,limits}` routes; never add a generic guardian RLS policy or accept a subject override on owner routes.
  - **Dependencies:** 1.3, 1.4.
  - **Likely files:** `src/guardians/access-service.ts`; new `src/api/managed-people.ts`; bounded repository adapters near `src/api/contacts.ts`, wallet/history repositories, and `src/contracts/http.ts`; `tests/unit/guardians/access-service.test.ts`; `tests/integration/managed-people-access.test.ts`.
  - **Acceptance evidence:** Authorized reads return only the selected subject; pending/revoking/revoked/declined/expired relationships return no subject data; forged subject IDs do not enumerate; accepted-pending policy authorization permits reads only; transfer, grant, signer, wallet, conversation, and room-token endpoints remain denied.
  - **Verification:** `npm test -- tests/unit/guardians/access-service.test.ts tests/integration/managed-people-access.test.ts tests/integration/contacts-cross-user.test.ts && npm run lint && npm run typecheck`.
  - **Rollback boundary:** Disable managed-read route registration and service calls; retain invitation/revocation lifecycle and preserve owner RLS.

- [ ] 2.2 **Add notification projections and actor/subject/version response metadata for read-only lifecycle events.** Extend the notification feed with invitation and relationship state while keeping invitation decisions independent from read markers. Ensure logs and response payloads contain safe subject labels, relation versions, capabilities, and refusal codes without email, token, transcript, or address leakage.
  - **Dependencies:** 1.1, 1.4, 2.1.
  - **Likely files:** `src/notifications/notification-repository.ts`; `src/notifications/assistant-state-mapping.ts`; `src/api/notifications.ts`; notification migration/test fixtures; `apps/nana-wallet/src/features/notifications/useNotificationsFeed.ts`; backend/frontend notification tests.
  - **Acceptance evidence:** Invitation appears unread until explicitly marked; marking read never invokes decision; revocation removes or invalidates subject data on the next fetch; notification deduplication remains intact.
  - **Verification:** `npm test -- tests/unit/notifications tests/integration/notifications-feed.test.ts tests/integration/notifications-schema.test.ts && cd apps/nana-wallet && npm test -- src/features/notifications`.
  - **Rollback boundary:** Revert new notification categories/projections while leaving relationship state authoritative and readable through its dedicated endpoint.

- [ ] 2.3 **Add role entry before Privy login without changing identity or wallet ownership.** Present “Uso mi billetera” and “Soy responsable” as navigation choices, preserve existing Privy login and self-service behavior, and ensure the responsible path creates/loads only the responsible profile. Verify the installed embedded-wallet behavior; do not attach or activate a beneficiary wallet and do not introduce a chain switch.
  - **Dependencies:** 0.2, 1.4.
  - **Likely files:** `apps/nana-wallet/src/routes/login.tsx`; `apps/nana-wallet/src/routes/__root.tsx`; `apps/nana-wallet/src/lib/api.ts`; `apps/nana-wallet/src/lib/api-types.ts`; role-entry tests.
  - **Acceptance evidence:** Both paths are visible before authentication; an existing wallet user keeps their wallet and transfer flow; a responsible session cannot select a beneficiary wallet as its own; absent provider support for role-specific wallet creation is recorded and handled without linking wallets.
  - **Verification:** `cd apps/nana-wallet && npm test -- src/routes/login.test.tsx src/routes/__root.test.tsx && npm run lint && npm run typecheck && npm run build`.
  - **Rollback boundary:** Remove the pre-login role selector and route state; retain the original Privy provider and owner wallet lifecycle.

- [ ] 2.4 **Build invitation-first startup and the responsible read-only profile selector.** Add the invitation card/list in creation order before normal greeting/balance, screen accept/decline actions, profile selection, subject-labelled contacts/transactions/limits views, safe loading/error states, and cache keys containing actor, subject, and relation version. No contact or limit mutation controls are permitted in this task.
  - **Dependencies:** 1.4, 2.1, 2.2, 2.3.
  - **Likely files:** `apps/nana-wallet/src/routes/index.tsx`; `apps/nana-wallet/src/routes/perfil.tsx`; `apps/nana-wallet/src/features/managed-profile/`; `apps/nana-wallet/src/features/invitations/`; `apps/nana-wallet/src/lib/api.ts`; `apps/nana-wallet/src/lib/api-types.ts`.
  - **Acceptance evidence:** Pending invitation is first in startup; read markers do not decide it; switching subjects cancels/clears prior queries; revocation invalidates the open subject; screens visibly identify the subject and expose no balance transfer controls, signatures, grants, or room tokens.
  - **Verification:** `cd apps/nana-wallet && npm test -- src/features/managed-profile src/features/invitations src/routes/index.test.tsx src/routes/perfil.test.tsx && npm run lint && npm run typecheck && npm run build`.
  - **Rollback boundary:** Remove managed-profile/invitation components and query wiring while leaving the owner profile and notification feed available.

- [ ] 2.5 **Prove browser isolation and owner-transfer regression for read-only onboarding.** Add a browser E2E journey with one responsible DID, two accepted beneficiaries, and one unrelated DID: invite, accept, switch subjects, verify subject-labelled reads, revoke with panel open, and verify the next read is denied. Include the beneficiary’s normal Solana-devnet preview/confirmation path as a regression, with no policy write or real-fund mutation.
  - **Dependencies:** 1.4, 2.1–2.4.
  - **Likely files:** `tests/e2e/browser/managed-profile-onboarding.mjs` or the repository’s browser harness; `scripts/run-managed-profile-browser-e2e.mjs`; fixtures under `tests/fixtures/`.
  - **Acceptance evidence:** The journey cannot read the unrelated subject, cannot reuse cached data after switching/revocation, and demonstrates that owner transfer confirmation remains unchanged. Screenshots/logs identify the selected subject and do not contain secrets.
  - **Verification:** `npm run test:e2e:browser` with the managed-profile scenario enabled, plus `npm test -- tests/integration/managed-people-access.test.ts`.
  - **Rollback boundary:** Remove only the new browser scenario and runner wiring; no production route or data is deleted.

## Phase 3: Invitation voice and responsible read-only agent

- [ ] 3.1 **Add a typed invitation decision window to the confirmation arbiter.** Extend the shared decision service with `ActionKind = invitation`, binding invitation ID/version, actor, conversation, and authenticated participant. Open it only after a canonical TTS handle completes `waitForPlayout`; keep it exclusive with `transfer` and `contact`, final-only, participant-bound, and one-use via persisted CAS.
  - **Dependencies:** 1.3, 1.4, 0.2.
  - **Likely files:** `src/conversations/confirmation-arbiter.ts`; `src/livekit/voice-decision-gate.ts`; `src/livekit/voice-decision-transcripts.ts`; `src/livekit/create-agent-session.ts`; `tests/unit/confirmation-arbiter.test.ts`; `tests/unit/livekit/voice-decision-gate.test.ts`; new invitation-gate tests.
  - **Acceptance evidence:** RED/green cases cover pre-playout, interrupted, non-final, wrong participant, repeated, wrong-kind, and post-restart transcripts; only the bound final affirmative accepts one invitation and cannot satisfy transfer/contact confirmation.
  - **Verification:** `npm test -- tests/unit/confirmation-arbiter.test.ts tests/unit/livekit/voice-decision-gate.test.ts tests/unit/livekit/voice-decision-transcripts.test.ts`.
  - **Rollback boundary:** Disable invitation voice windows and retain screen decisions; owner transfer arbiter behavior must remain byte-for-byte contract-compatible.

- [ ] 3.2 **Wire canonical invitation narration before the normal LiveKit greeting.** Have the worker select one pending invitation in creation order, speak server-authored inviter/scope text through the installed TTS path, await verified playout, then open only the invitation window. Missing TTS, interruption, audio failure, or unverified playout leaves the invitation pending and the screen card available.
  - **Dependencies:** 1.4, 2.2, 3.1.
  - **Likely files:** `src/livekit/worker.ts`; `src/livekit/create-agent-session.ts`; `src/livekit/voice-decision-gate.ts`; `src/livekit/realtime-latency-logger.ts` if metrics are required; `tests/integration/livekit-worker-fake.e2e.test.ts`; LiveKit unit tests.
  - **Acceptance evidence:** Fake worker logs show canonical invitation text before greeting/balance; multiple invites are one-at-a-time in creation order; an interrupted or unavailable playout never opens a decision; no model-generated paraphrase becomes authoritative.
  - **Verification:** `npm test -- tests/integration/livekit-worker-fake.e2e.test.ts tests/unit/livekit && npm run typecheck && npm run build`.
  - **Rollback boundary:** Disable invitation narration/startup phase and fall back to the persisted screen card; do not alter transfer startup.

- [ ] 3.3 **Add a dedicated responsible-person read-only tool catalog with per-call authorization.** Bind the selected subject and relationship version to every managed read tool. Exclude `send_token`, transfer confirmation, signing, grants, signer administration, wallet reassignment, and room-token tools both from advertised schemas and from forged direct invocations; recheck relationship state and capability on every call.
  - **Dependencies:** 2.1, 2.4, 3.1.
  - **Likely files:** `src/agent/definition.ts`; `src/agent/wallet-agent.ts`; `src/livekit/realtime-tools/create-realtime-tools.ts`; `src/livekit/worker.ts`; `tests/unit/agent-tools-parity.test.ts`; new responsible-catalog tests; integration tests for revocation during a session.
  - **Acceptance evidence:** Catalog matrix allows only approved contacts/history/limits reads for accepted relationships; pending/revoked relationships are denied; HTTP/text/voice direct bypasses cannot create previews, transfer attempts, signatures, grants, or room tokens; owner catalog still supports normal transfer flow.
  - **Verification:** `npm test -- tests/unit/agent-tools-parity.test.ts tests/unit/responsible-tool-catalog.test.ts tests/integration/livekit-responsible-tools.test.ts && npm run eval`.
  - **Rollback boundary:** Remove the responsible catalog and stop managed voice sessions; preserve the owner agent definition and existing transfer tools for self context.

- [ ] 3.4 **Prove voice invitation isolation and responsible-session revocation.** Run deterministic fake-worker coverage plus opt-in LiveKit E2E: canonical invitation narration, ordinary “sí” after playout, refusal of pre-playout/other-window affirmatives, fallback card after TTS failure, read-only responsible request, and denial after relationship revocation while a session remains open.
  - **Dependencies:** 3.1–3.3.
  - **Likely files:** `tests/integration/livekit-responsible-tools.test.ts`; `tests/e2e/livekit-managed-profile.e2e.test.ts`; `evals/` dataset/scenarios for invitation and responsible contexts; `.agent-workflow/tasks/onboarding-roles/90-verification.md`.
  - **Acceptance evidence:** Logs and test receipts show the invitation decision is consumed once, cannot confirm a transfer, and cannot return subject data after revocation. Any unavailable cloud/audio dependency is reported with its exact blocker rather than counted as passing.
  - **Verification:** `npm run test:e2e:livekit-fake`; `npm run eval`; `npm run test:e2e:livekit-smoke` when LiveKit credentials/network are available.
  - **Rollback boundary:** Remove only the managed voice E2E/eval cases and disable the managed session flag; screen and owner voice paths remain.

## Phase 4: Blocked managed-policy authority (future amendment required)

The following tasks are intentionally not executable in the current change state. They require an explicit approval of `onboarding-roles-consent-boundary-r2`, a controlled Privy capability proof, and updated `proposal.md`, a new/updated managed-policy spec, and `design.md` that record the approved trust boundary. Until those artifacts are approved, relationships remain `accepted_pending_policy_authorization`, managed APIs remain read-only, and no Privy PATCH or real-wallet policy test is permitted.

- [ ] 4.1 **[BLOCKED] Approve and encode the consent boundary before any write code.** Resolve `.agent-workflow/tasks/onboarding-roles/06-privy-consent-amendment.md`; update `.agent-workflow/tasks/onboarding-roles/04-tdd.md`, `.agent-workflow/tasks/onboarding-roles/05-structure-outline.md`, `openspec/changes/onboarding-roles/proposal.md`, `openspec/changes/onboarding-roles/design.md`, and add/update the managed-policy delta spec. Record the exact scope, owner consent evidence, revocation behavior, and provider proof. No source code or remote policy mutation belongs in this task.
  - **Dependencies:** 0.2, Phases 1–3 complete enough to validate the boundary.
  - **Acceptance evidence:** Approved gate ID, trusted identity, timestamp, updated spec scenarios, and a controlled transport receipt proving verified readback without secrets. A failed probe leaves this task open and keeps all subsequent tasks blocked.
  - **Verification:** OpenSpec/spec consistency check plus `git diff --check`; no runtime write command.
  - **Rollback boundary:** Revert only planning-artifact changes; no database, wallet, Privy policy, or funds change.

- [ ] 4.2 **[BLOCKED] Add consent, policy-intent, typed-limit, and audit persistence after the amendment.** Add mirrored additive migrations for owner consent evidence, policy authorization/relation version, typed `capped`/`unlimited` ordinary limit, desired/applied intent, readback, actor audit, and policy-change notification projection. Preserve existing 0.01 SOL defaults and all existing signer/grant restrictions.
  - **Dependencies:** 4.1 and the approved managed-policy spec/design delta.
  - **Likely files:** new mirrored SQL migrations; `src/wallet/policy/repository.ts`; policy migration tests; notification schemas.
  - **Acceptance evidence:** Empty/current migrations pass; no sentinel value represents unlimited; revocation serializes with pending application; audit rows contain actor/subject/relation/version and no secrets.
  - **Verification:** `npm run db:migrate && npm test -- tests/integration/recipient-policy-migration.test.ts tests/integration/recipient-policy-migration-rls.test.ts tests/integration/guardian-policy-authorization.test.ts`.
  - **Rollback boundary:** Freeze policy writes and reconciliation while retaining restrictive policy and audit rows; never drop signers or delete funds.

- [ ] 4.3 **[BLOCKED] Implement policy composition and reconciliation for `capped` and `unlimited`.** Extend the single policy composer/service/reconciler path only after the approved consent check. `unlimited` MUST omit only `Transfer.lamports`, preserve `Transfer.to`, grants, signers, and unknown restrictions, perform GET-before-retry/readback, and classify rejected versus ambiguous outcomes truthfully.
  - **Dependencies:** 4.2 plus controlled Privy allowlist/readback proof.
  - **Likely files:** `src/wallet/policy/composer.ts`; `service.ts`; `reconciler.ts`; `readback.ts`; `repository.ts`; `src/wallet/embedded.ts`; relevant grant rule files; focused policy unit/integration tests.
  - **Acceptance evidence:** RED/green tests cover finite/unlimited composition, rule preservation, stale versions, concurrent changes, revocation in flight, definitive refusal, uncertain outcome, and no false applied state. No live wallet mutation is used for the first proof.
  - **Verification:** `npm test -- tests/unit/policy-composer.test.ts tests/unit/policy-readback.test.ts tests/unit/policy-apply-transport.test.ts tests/integration/recipient-policy-service.test.ts tests/integration/recipient-policy-reconciler.test.ts`.
  - **Rollback boundary:** Disable the managed mutation entry point and preserve the prior restrictive applied policy; do not implement unlimited by deleting policies or unpinning signers.

- [ ] 4.4 **[BLOCKED] Add responsible contact/limit mutations, before/after review, and beneficiary notifications.** Expose only the approved `contacts.write` and `limits.write` routes with idempotency/expected-version checks, actor audit, explicit desired/applied state, and notification projection. Keep grants, signer management, transfers, and owner confirmation untouched.
  - **Dependencies:** 4.3.
  - **Likely files:** `src/api/managed-people.ts`; `src/contracts/http.ts`; `apps/nana-wallet/src/lib/api.ts`; `api-types.ts`; managed profile UI; policy and notification services/tests.
  - **Acceptance evidence:** Responsible can request a contact/ordinary-limit change only with an active authorized relationship; beneficiary receives before/after and pending/applied notification; stale/revoked/ambiguous requests do not appear applied; UI has no payment controls.
  - **Verification:** Backend lint/typecheck/build/unit/integration and frontend `npm run lint && npm run typecheck && npm run build && npm test`; focused managed-policy HTTP tests.
  - **Rollback boundary:** Freeze managed writes and reconcile pending state; retain applied policy and audit/notification history without silently reverting it.

- [ ] 4.5 **[BLOCKED] Run controlled policy E2E and obtain separate authorization for any real-wallet mutation.** Prove contact add/remove, finite limit, unlimited limit, readback, notification, revocation race, and owner transfer regression with a controlled Privy transport. A real wallet test is a separate reviewable action and must name the exact policy diff and target before execution.
  - **Dependencies:** 4.1–4.4.
  - **Likely files:** policy E2E fixtures/scripts; `tests/e2e/managed-policy.e2e.test.ts`; `.agent-workflow/tasks/onboarding-roles/90-verification.md`.
  - **Acceptance evidence:** Controlled transport receipt proves preservation of allowlist, grants, signer, and unknown restrictions; no real Solana balance changes; verification report distinguishes passed, blocked, and pre-existing failures.
  - **Verification:** `npm run test:e2e:browser` with managed-policy scenario, focused policy integration suite, and full required lint/typecheck/build/test/eval commands.
  - **Rollback boundary:** Stop managed policy writes and retain restrictive policy/audit state; never reset or delete wallet state.

## Phase 5: Cross-slice verification and handoff

- [ ] 5.1 **Run the full required validation matrix for the slices actually implemented.** Backend changes require `npm run lint`, `npm run typecheck`, `npm run build`, `npm test`, and `npm run eval`; frontend changes require the corresponding lint/typecheck/build/test commands from `apps/nana-wallet/`; database changes require a fresh and current migration; agent changes require fake LiveKit E2E and evals; end-to-end behavior requires browser and LiveKit E2E when dependencies are available.
  - **Dependencies:** All unblocked implementation tasks.
  - **Likely files:** `.agent-workflow/tasks/onboarding-roles/90-verification.md`; no production file changes.
  - **Acceptance evidence:** Report exact command/result/environment, separates pre-existing failures from regressions, records unavailable external services, and confirms no remote policy/funds mutation occurred in read-only slices.
  - **Verification:** Use the exact commands listed above; do not report an interrupted or dependency-skipped suite as passed.
  - **Rollback boundary:** Revert verification notes only; preserve implementation commits for the chosen review chain.

- [ ] 5.2 **Run the complete acceptance journey and document the final stop conditions.** Prove role entry, two-DID invitation, verified-email matching, narrated invitation/fallback card, one-use acceptance, read-only managed profiles, subject/cache isolation, revocation, responsible transfer refusal, and beneficiary owner-transfer regression. If Phase 4 remains blocked, explicitly report policy management as unavailable rather than simulating success.
  - **Dependencies:** 5.1 and all completed unblocked slices.
  - **Likely files:** `.agent-workflow/tasks/onboarding-roles/90-verification.md`; E2E receipt locations.
  - **Acceptance evidence:** The final report states what was observed, what was skipped, every blocker, and the exact next gate for policy writes; no claim of unlimited policy or remote Privy application is made without the approved amendment and readback evidence.
  - **Verification:** Browser E2E, `npm run test:e2e:livekit-fake`, `npm run eval`, and opt-in live smoke commands where the documented environment is present.
  - **Rollback boundary:** Documentation-only rollback; do not mutate relationships, policies, wallets, or funds as part of reporting.

## Recommended execution order

Run 0.1, then 0.2. Execute Phase 1 in order because routes depend on verified identity and lifecycle CAS. Phase 2.1 and 2.2 may be developed in parallel after 1.4, while 2.3 can proceed after the capability probe; 2.4 and 2.5 wait for the backend contracts and read service. Phase 3.1 can proceed after 1.4 and 0.2, but 3.2–3.4 wait for the invitation contract and managed read catalog. Phase 4 is blocked as a whole until the consent amendment, controlled proof, and updated spec/design are approved. Finish with Phase 5 for the slices that actually ran.

## Explicit non-goals for this task plan

- No implementation, migration execution, Privy PATCH, real-wallet policy mutation, seed/private-key/credential access, EVM/mainnet mode, chain switch, push, merge, or PR creation is authorized by this artifact.
- No policy-write task can be marked complete based on invitation acceptance, a successful GET/readback alone, or a simulated transport without an approved consent-boundary design.
- The existing owner preview and authenticated post-preview confirmation invariant remains outside the managed responsible context and must pass regression checks.
