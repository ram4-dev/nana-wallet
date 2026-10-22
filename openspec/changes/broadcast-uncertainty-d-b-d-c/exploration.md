## Exploration: Truthful broadcast outcomes for D-B and D-C

### Current State
`SolanaDevnetProvider.broadcastTransfer` validates the network, preview identity,
recipient, amount, bound wallet identity, recent blockhash, and unsigned
transaction serialization before the sole `signAndSend` invocation
(`src/wallet/solana-devnet-provider.ts:387-423`). The dispatch `try/catch` starts
at line 417, so request validation, `bound()`, `requireRecentBlockhash()`, and
transaction construction currently throw out of the provider. Only the missing
preview identity already returns a typed `not_dispatched/invalid_request`
outcome. The provider catch keeps untyped failures from `signAndSend` as
`uncertain`; typed `PayloadSignerError` and policy denials are already treated as
definitive because the installed Privy SDK prepares authorization (including
`sign_fns`) before its HTTP request (`node_modules/@privy-io/node/src/lib/authorization.ts:157-199`,
`src/wallet/solana-devnet-provider.ts:438-462`).

The conversation service creates a lazy per-user binding. `bindWalletForUser`
awaits the resolver only when `broadcastTransfer` is called
(`src/wallet/user-wallet.ts:32-44,87-92`). The production resolver first checks
the user's ready Solana binding, then lists and validates the matching Privy
wallet before constructing the provider (`src/wallet/solana-user-wallet.ts:48-155`).
Known resolver failures are typed `PrivyWalletRuntimeError` values, but the
conversation layer currently catches every resolver/provider exception and
converts it to `uncertain` (`src/conversations/service.ts:1331-1343`). This loses
the pre-provider evidence for known resolver failures while retaining the safe
behavior for unknown exceptions.

`reconcileBroadcast` has one exact positive path: an optional
`findByReference` can return a hash and produce `submitted`; missing capability,
null, or an empty result produces `uncertain` and never dispatches again
(`src/wallet/solana-devnet-provider.ts:472-505`). The production
`createPrivySignAndSendClient` deliberately does not implement that optional
lookup. The current SDK wallet-history endpoint supports cursor, chain, token,
and transaction-hash filters but does not expose `reference_id` on its history
entries (`node_modules/@privy-io/node/src/resources/wallets/transactions.ts:25-122`).
The top-level transaction resource includes `reference_id`, but it can only be
queried after a transaction ID is known (`node_modules/@privy-io/node/src/resources/transactions.ts:11-27,46-67`).
Therefore the current production path cannot prove absence from a preview ID.
The provider's bounded history paging is for finality of an already known
signature and returns unresolved at its safety cap; it is not an absence proof
for an ambiguous broadcast (`src/wallet/solana-devnet-provider.ts:541-610`).

Existing tests cover missing preview IDs, generic dispatch timeout ambiguity,
typed signer failures, no-lookup reconciliation, and an injected authoritative
positive lookup (`tests/unit/solana-devnet-provider.test.ts:89-311,806-1043`).
They do not yet cover provider preparation failures or lazy resolver failures at
the conversation boundary.

The existing change documents contain two claims that need tightening. The
proposal/spec describe pre-dispatch validation outcomes as if they already
exist, but the current provider still rejects invalid networks, recipients, and
amounts; the spec scenario and current tests are therefore inconsistent
(`openspec/changes/broadcast-uncertainty-d-b-d-c/specs/wallet-broadcast-outcomes/spec.md`,
`tests/unit/solana-devnet-provider.test.ts:154-202`). Also, saying that the
Privy transaction surface has no `reference_id` is too broad: individual
transaction records do carry it. The accurate limitation is that the available
wallet-history query cannot locate a record by the preview reference, and an
ambiguous attempt does not provide the transaction ID needed for the individual
lookup. The D-C safe conclusion remains unchanged.

### Affected Areas
- `src/wallet/solana-devnet-provider.ts` — isolate request validation and transaction preparation from the dispatch call and classify only proven pre-dispatch failures.
- `src/wallet/user-wallet.ts` — preserve the lazy resolver boundary so resolution errors can be identified before a provider broadcast exists.
- `src/wallet/solana-user-wallet.ts` — retain the existing typed errors for missing, conflicting, unavailable, or mismatched user wallet bindings.
- `src/conversations/service.ts` — map only known `PrivyWalletRuntimeError` resolution failures to `not_dispatched/provider_unavailable`; keep arbitrary resolver/provider errors `uncertain`.
- `tests/unit/solana-devnet-provider.test.ts` — add no-signer-call assertions for network, request, identity, blockhash, and transaction-preparation failures while retaining generic dispatch ambiguity tests.
- `tests/unit/conversation-service.test.ts` — add typed lazy-resolution versus generic resolver/provider exception cases.
- `openspec/changes/broadcast-uncertainty-d-b-d-c/specs/wallet-broadcast-outcomes/spec.md` — reconcile the required validation outcome with the current reject-based tests during the proposal/spec follow-up.
- `odd/tasks/broadcast-uncertain-defects.md` — correct the D-C wording so bounded or indexed history is never described as proving absence.

### Approaches
1. **Explicit pre-dispatch preparation boundary** — run request validation and provider preparation in a dedicated pre-dispatch section, returning typed causes (`invalid_request` for malformed request data and `provider_unavailable` for identity/RPC/preparation failures), then invoke the existing dispatch `try/catch` unchanged. Map only typed `PrivyWalletRuntimeError` values at the conversation boundary.
   - Pros: the control-flow boundary is visible; generic errors after entering `signAndSend` remain `uncertain`; resolver failures cannot be confused with provider dispatch failures; tests can assert the signer was never called.
   - Cons: requires an explicit classifier for preparation stages and a decision about which transaction-construction failures are provider versus request failures.
   - Effort: Medium

2. **One broad provider catch with a dispatch-entered flag** — wrap preparation and dispatch together, set a flag immediately before calling `signAndSend`, and classify errors only while the flag is false; add a separate typed resolver catch in the conversation service.
   - Pros: small structural change and a direct proof that the dispatch call was not entered.
   - Cons: broad catches can accidentally classify errors from evaluation or future SDK call setup; the flag does not make an arbitrary provider error semantically typed; it can hide which validation cause should reach the user.
   - Effort: Low/Medium

3. **Leave D-B/D-C behavior unchanged and document the limitation** — preserve all current throws and `uncertain` outcomes until a future authoritative adapter exists.
   - Pros: no regression risk and no dependency on SDK behavior.
   - Cons: leaves the known D-B misclassification in the conversation path unresolved and does not meet the existing D-B acceptance criteria.
   - Effort: Low

### Recommendation
Use Approach 1 for D-B. Keep network, preview, recipient, and amount validation
as explicit `invalid_request` outcomes; classify missing bound identity, missing
or failed recent-blockhash retrieval, and other provider-owned preparation
failures as `provider_unavailable` only while execution is structurally before
`signAndSend`. Preserve the current dispatch catch so every generic dispatch
exception remains `uncertain`, with no retry or re-sign. At the service boundary,
recognize only the existing typed `PrivyWalletRuntimeError` family as a known
pre-provider failure; leave untyped database or resolver exceptions uncertain.

Keep D-C behavior unchanged. A future adapter may add `findByReference` only
when it can return a contract with explicit `found`, `absent`, and `unknown`
semantics backed by authoritative Privy evidence. A missing method, null result,
bounded history page, or transaction listing without reference correlation must
remain `uncertain` and must never trigger a second dispatch. Update the proposal
and task wording to reflect that D-C is a safe open disposition rather than an
absence inference.

### Risks
- A catch that spans the SDK call could misclassify a post-submission failure; the implementation must keep the dispatch invocation outside the pre-dispatch classifier.
- `SolanaDevnetConfigError` is used for several conditions, so cause mapping must be stage-based or use typed errors rather than matching message text.
- Treating every resolver exception as unavailable would turn database or unexpected runtime failures into false certainty; only known typed resolver failures should map to `not_dispatched`.
- The installed Privy SDK surface may evolve; any D-C lookup must be re-verified against the exact adapter contract and must not infer absence from a partial history view.
- The current OpenSpec validation scenarios and existing reject-based tests disagree; proposal/spec work must settle that contract before implementation.

### Ready for Proposal
Yes for a bounded D-B proposal and a D-C open disposition. The proposal should
state the exact pre-dispatch stages and causes, preserve the generic dispatch
ambiguity rule, add the missing lazy-resolution test boundary, and correct the
overbroad D-C SDK wording. Implementation should remain gated by the existing
independent outline review and human approval recorded in the RPI artifacts.
