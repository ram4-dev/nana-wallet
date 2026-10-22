# Research questions

1. Which operations in `SolanaDevnetProvider.broadcastTransfer` can throw before the single `signAndSend` call, and how can their causes be mapped without catching post-dispatch ambiguity?
2. Can the conversation service distinguish wallet-resolution failure from an exception raised by a provider after dispatch may have begun?
3. Does the production Privy SDK path support an authoritative lookup by `reference_id`, or can any available evidence prove that an ambiguous attempt was never submitted?
4. What existing tests and local runtime harnesses prove the safe and ambiguous sides of those boundaries?

Scope exclusions: do not change payment policy, retries, reconciliation worker behavior, live networking, the frontend contract, or sibling worktrees.
