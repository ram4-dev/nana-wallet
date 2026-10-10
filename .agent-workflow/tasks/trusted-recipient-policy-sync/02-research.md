# Current-state evidence — revision 1

Source inspected at commit 9eccee1. No application-code changes made during mapping.

| Entry or responsibility | Current path | Observed behavior / missing connection |
| --- | --- | --- |
| Trusted recipients UI | apps/nana-wallet/src/features/wallet/AddTrustedRecipient.tsx:50 | POST/create and DELETE/archive through API; no policy sync. UI still defaults to EVM and offers a network selection despite Solana-only deployment. |
| HTTP writes | src/api/contacts.ts:110 | Create/edit/archive use ContactsRepository and embeddings; dependencies contain no wallet or Privy service. |
| Contact persistence | src/memory/contacts-repository.ts:102 | Versioned recipient projection; archive is soft deletion. No remote policy projection. |
| Initial permission consent | apps/nana-wallet/src/features/wallet/WalletLifecycle.tsx:232 | Contacts submitted only when preparing initial permission. |
| Permission snapshot | src/wallet/embedded.ts:902 | Builds enrollment policy and saves allowlisted_recipients and policy_hash in signer_grants. No later contact reconciliation. |
| Agent tools | src/agent/definition.ts:615 | stage_user_memory and write_user_memory exist for new recipient/fact; no contact edit/archive tool exposed here. |
| Agent validation | src/agent/definition.ts:220; src/memory/tools.ts:17; src/memory/service.ts:188 | Recipient draft/write still rejects Solana via isValidEvmAddress. Selected-address lookup also EVM-only. |
| Agent persistence | src/memory/repository.ts:110 | Separate insertRecipient path, bypassing ContactsRepository; network defaults to null when omitted. |
| Text confirmation | src/agent/wallet-agent.ts:382; src/conversations/session-state.ts:94 | Explicit phrase in a later user turn confirms staged memory before one-use consume. |
| Voice confirmation | src/livekit/voice-decision-transcripts.ts:9 | Listener binds final authenticated speech only to transfer preview gate. No memory-write confirmation binding found in inspected voice paths; actual agent recipient voice creation remains unvalidated. |
| Delegated policy writer | src/wallet/grants/solana-policy-provisioner.ts:247 | Replaces complete policy rules with active delegated-grant union. Adding an independent contact-only writer would overwrite grants; existing grant recompute can overwrite enrollment rules. |
| Remote admin wiring | src/wallet/grants/privy-policy-runtime.ts:185 | Requires configured signed authorization client and quorum. Does not project trusted contacts. |
| Empty contacts | src/wallet/grants/solana-enrollment-rules.ts:39 | Enrollment builder rejects empty recipient set. Last-recipient removal needs explicit composition behavior. |
| Tests | tests/integration/api-contacts.test.ts; frontend AddTrustedRecipient tests | CRUD/refetch coverage, no assertion that contact changes update attached Privy policy. |

## Prior runtime evidence (not re-read in this mapping)
Solana permission was created on October 8 with only the wallet's own address; Test1 was created October 9. Privy policy did not receive Test1 until the separately authorized manual update. The remote policy now includes Test1 while local signer_grants snapshot still contains only the original address. Backend lacked authorization signer URL/token; the temporary signer sidecar serves the worker, not backend loopback. Live call subsequently transferred 0.001 SOL successfully. See openspec/changes/voice-live-call-recovery/policy-runtime-evidence.md for policy update provenance.

## Unresolved verification
Exact effective Privy semantics for an empty composed policy, signer binding under current runtime, rules/ownership conflict behavior, and a contact operation through real voice must be validated during implementation. No network research, runtime mutation, or test execution was needed for this source mapping. One attempted source read referenced nonexistent src/agent/memory-write.ts; actual confirmation implementation is session-state.ts. No findings depend on that missing path.
