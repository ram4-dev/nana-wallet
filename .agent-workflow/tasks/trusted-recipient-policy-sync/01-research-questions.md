# Research questions — revision 1

1. Which paths create, edit, archive, or confirm recipients from UI, HTTP, text, and voice?
2. Which paths mutate the attached Privy policy, and which persisted records own its rules?
3. Where are Solana validation and authenticated confirmation missing?
4. How are signer identity, recipient snapshots, policy readback, and delegated grants represented?
5. What behavior exists for concurrent writes, timeout, restart, no wallet, and removing the last recipient?
6. What checks cover CRUD versus actual authorization, and what must E2E observe?

Evidence: contacts routes/repository; frontend contact and lifecycle components; memory service/tools/repository; agent definitions/text handler; LiveKit transcript binding; enrollment rules/service; delegated policy provisioner/runtime. Existing read-only runtime findings from the previous investigation are labeled separately; do not treat them as refreshed observations.
