# Remote Supabase runtime and embeddings

User priority, 2026-10-23: make the app use remote Supabase instead of local application databases and local embedding computation, before CI remediation.
Workspace: /Users/ramiro/Desktop/projects/colloseum.feat-remote-supabase-vector; branch feat/remote-supabase-vector; base main cd306e9; created through Worktrunk. CI remediation worktree remains preserved and its implementation gate remains pending.
Current phase: RPI research/design. Existing remote-runtime launcher restoration is authorized by the prior approved local-privy-stack-start design and the current user instruction. New inference/provider/code changes require a design decision and reviewed implementation outline.
Boundaries: Nana Wallet project jnhemqouecznsziytzhm only; Nana Landing excluded. No database/volume deletion, no copying synthetic local data to the remote project, no tests against remote DB, no financial operations.

Scope correction from explicit user decision: keep current embedding generation for now. Remote inference/Edge Function implementation is excluded. Remote runtime database and pgvector use were restored and verified; no further generation architecture approval is pending.
