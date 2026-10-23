# Design discussion revision 1 (proposed)

## Runtime database
Use only the existing Nana Wallet remote database for interactive app runtime, retaining verify-full TLS and owner-scoped database queries. Restore the managed domain-to-backend path and retire duplicate local application workers. Local disposable databases remain for CI/integration tests as required by AGENTS.md. Preserve all prior local volumes; data migration scope needs a separate inventory and explicit decision.

## Embedding generation
To remove the local model while preserving Spanish retrieval, propose a Supabase Edge Function that calls a remote multilingual embedding API. Authenticate server-to-function requests; never expose service credentials to the frontend. Document model identity, dimensions, timeouts/retries and failure behavior. Contact and query embeddings must use the same model/version. Never compare incompatible old/new vectors. If any existing remote rows appear before rollout, stop for a model migration/backfill plan.
Supabase native gte-small alone is rejected for now because its published language support is English only. A remote multilingual provider/model, credentials, data handling and cost remain to select; user asked asynchronously whether to accept this architecture. No generation changes are approved yet.

## Reliability
Investigate the observed connection-termination crash and provide a bounded recovery path without obscuring uncertain payment outcomes. Any source changes follow SDD and the reviewed implementation outline. Verify behavior against an isolated local database and inspect the real remote connection read-only after deployment.

## Acceptance
Frontend HTTPS 200, same-origin API health 200, binding request unauthenticated 401, signer and worker health; actual backend and worker target the linked remote database with TLS. No local app DB is used. Remote vector query works. Embedding generation moves off backend only after the provider design and complete validation pass. No live test transfers.

Approval: database/runtime restoration authorized by current user request and existing design; inference design pending user response. Outline not yet drafted or reviewed.

Concrete proposed provider: OpenAI text-embedding-3-small, API dimensions=384, behind the Supabase Edge Function. This keeps the existing vector column size, but does not make old and new model vectors compatible. Validate Spanish contact resolution, ambiguity and false positives; do not mechanically reuse old score thresholds. Provision credentials through vault-env and Supabase secret management, never frontend/env commits. No provider call or function deployment has occurred.
