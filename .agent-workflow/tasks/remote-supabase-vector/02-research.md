# Current evidence

- New nana-dev-stack backend had exited with unhandled pg Client error: Connection terminated unexpectedly. Exit code 1, OOMKilled false. Root source and durable recovery behavior remain to investigate.
- Its configuration targets the linked Nana Wallet pooler, with postgres.jnhemqouecznsziytzhm and sslmode=verify-full. A read-only TLS-verified query confirms remote pgvector 0.8.2. recipients and user_memories have no rows yet.
- Old nana-privy-impl backend used compose-local db with pgvector 0.8.1. Its existence alone did not establish what the frontend domain used; prior conversational claim was corrected.
- Managed frontend state originally referenced the stopped new backend. Restarting that backend changed its Docker-published port, leaving the frontend proxy stale. Restoration retargets the launcher-owned frontend and restarts its sidecar, while the complete launcher rebuild continues.
- Legacy nana-privy-impl app services, its local DB and LiveKit, nana-e2e voice worker, and nani-greeting worker were stopped to prevent stale local runtimes consuming voice jobs. Volumes/data were retained. Other projects and isolated test DBs remain untouched.
- Legacy app DB inventory before stop: 465 users, 101 contacts, zero user_memories, 448 conversations. These aggregate counts do not prove which rows are real; no rows were copied or deleted.
- Existing local embeddings use sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2 with 384 dimensions. Supabase stores vectors but does not automatically move that model into its runtime.
- Supabase CLI 2.113.0 can list functions for the linked project; none are deployed.
- Supabase Edge Runtime built-in inference currently supports gte-small; its model card explicitly limits it to English. It is unsuitable as an unreviewed replacement for Spanish recipient retrieval. Official sources: https://supabase.com/docs/guides/ai/quickstarts/generate-text-embeddings and https://huggingface.co/Supabase/gte-small .

## Completed runtime restoration

The main checkout's existing npm run dev:stack completed successfully, printing Stack listo: https://nana-privy.localhost. Its readiness passed frontend/API HTTPS, binding unauthenticated 401, signaling WSS, remote DB schema/TLS, capable API/worker signers and current worker registration. Manual same-origin probes also returned frontend 200, API 200, signer verified, binding 401. A read-only vector query executed through the runtime backend returned vector_dims=384 and cosine self_distance=0. No remote data was written by these probes.

The complete image rebuild replaced the manually restarted containers and recreated sidecars. Final backend and worker connection probes verify linked Nana Wallet pooler, sslmode=verify-full and pgvector 0.8.2. Application source and main branch remain unchanged; restoration used existing approved tooling. Connection-crash source fix and remote embedding inference remain future implementation work.

Concrete inference candidate: OpenAI text-embedding-3-small with dimensions=384 via authenticated Supabase Edge Function. Official docs establish multilingual performance and configurable dimensions: https://developers.openai.com/api/docs/guides/embeddings . This changes the model identity and requires retrieval validation/threshold assessment; it is not yet approved or implemented.

## Automatic generation capability inventory

Remote read-only pg_available_extensions confirms vector 0.8.2 and supabase_vault 0.3.1 installed. pg_net 0.20.4, pg_cron 1.6.4 and pgmq 1.5.1 are available but not enabled. Both embedding and embedding_model_revision columns on recipients/user_memories remain NOT NULL. No extensions or schema were changed.
