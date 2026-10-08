# Spec Delta: solana-devnet-provider

## ADDED Requirements

### Requirement: Devnet-only Solana provider through the WalletProvider seam

The system SHALL provide a `SolanaDevnetProvider` implementing
`src/wallet/provider.ts`'s `WalletProvider` interface that operates
exclusively on the `solana-devnet` network and refuses every other network.

#### Scenario: Provider refuses non-devnet networks

- **Given** a `SolanaDevnetProvider` instance
- **When** any method receives `network` other than `solana-devnet`
  (including `solana-mainnet`, `sepolia`, `arc-testnet`)
- **Then** the call throws before any RPC or signer call is made

#### Scenario: Provider advertises devnet

- **Given** a healthy devnet RPC
- **When** `listNetworks` is called
- **Then** it returns exactly `[{ network: 'solana-devnet', kind: 'testnet' }]`

### Requirement: Balance and address reads on devnet

The provider SHALL read the wallet address from the Privy embedded wallet
record and the SOL balance from the devnet JSON-RPC, returning the normalized
`WalletBalance` shape.

#### Scenario: Balance read is normalized

- **Given** a devnet address with a lamport balance returned by RPC
- **When** `getBalance({ network: 'solana-devnet', wallet })` is called
- **Then** the result contains `network: 'solana-devnet'`, the wallet's
  base58 address, and the balance as a decimal SOL string converted from
  lamports

#### Scenario: Invalid RPC response fails closed

- **Given** the RPC returns a malformed or non-string balance
- **When** `getBalance` is called
- **Then** the provider throws instead of returning a fabricated value

### Requirement: Transfer preview with fee evidence

The provider SHALL produce a `TransferPreview` for devnet transfers only for
valid base58 recipients, including fee evidence subject to a documented
policy ceiling.

#### Scenario: Preview for a valid devnet transfer

- **Given** a transfer request on `solana-devnet` with a valid base58
  recipient and amount
- **When** `previewTransfer` is called
- **Then** the preview echoes network, token, recipient, amount, and an
  estimated fee derived from RPC lamports-per-signature evidence, and the
  fee does not exceed the policy ceiling

#### Scenario: Preview refuses invalid recipients

- **Given** a recipient that is not valid base58, or the zero/burn-style
  system address, or the sender itself
- **When** `previewTransfer` is called
- **Then** the provider throws and no preview is produced

### Requirement: Broadcast outcomes are honest and idempotent

The provider SHALL execute devnet transfers exclusively by invoking the
Privy `signAndSendTransaction` wallet RPC — Privy evaluates the bound
policy, signs, and broadcasts atomically — and SHALL return a strict
`BroadcastOutcome`. The provider never holds signed bytes to submit: the
RPC read interface exposes no send capability, and no code path may
broadcast Privy-signed bytes independently.

#### Scenario: Successful broadcast

- **Given** a valid transfer and a `signAndSend` client that returns
  `data.hash` + `transaction_id`
- **When** `broadcastTransfer` is called
- **Then** the outcome is `kind: 'submitted'` with the base58 signature,
  `network: 'solana-devnet'`, and the devnet explorer URL — broadcast only,
  never finality

#### Scenario: Signer rejection is not dispatched

- **Given** the Privy `signAndSendTransaction` request is definitively
  rejected (policy denial or signer error)
- **When** `broadcastTransfer` is called
- **Then** the outcome is `kind: 'not_dispatched'` with the reason, and no
  further dispatch is attempted

#### Scenario: Ambiguous dispatch never duplicates

- **Given** a `signAndSend` request that timed out or failed after leaving
  our process (signing/broadcast state unknown), with the upstream
  preview id persisted as Privy `reference_id` (unique, ≤64 chars)
- **When** `broadcastTransfer` is called
- **Then** the outcome is `kind: 'uncertain'` with a reason naming
  reconciliation by `reference_id`, and any subsequent reconciliation call
  reuses the same `reference_id` — the provider never re-signs, re-sends, or
  self-broadcasts the returned `signed_transaction` within the same call or
  across calls

#### Scenario: Missing persisted preview never dispatches

- **Given** `broadcastTransfer` receives a missing or blank preview ID
- **When** it is asked to sign and send a Solana transfer
- **Then** it returns `kind: 'not_dispatched'` before requesting a blockhash or calling the signer
- **And** it does not synthesize a time-based Privy `reference_id`

#### Scenario: Execution rides only the policy-evaluated path

- **Given** the provider's injected dependencies
- **When** `broadcastTransfer` executes a transfer
- **Then** the only dispatch route is the Privy `signAndSendTransaction`
  wallet RPC (`method: 'signAndSendTransaction'`,
  `caip2: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1'` devnet,
  `params.transaction` base64 + `encoding: 'base64'`) whose enclave policy
  evaluation happens before signing; the RPC read interface exposes no send
  capability, and no code path broadcasts Privy-signed bytes independently
  (regression-guarded by test)

#### Scenario: Synchronous success means broadcast, not finality

- **Given** Privy returned a synchronous success with `data.hash` and
  `transaction_id`
- **When** the provider builds the outcome
- **Then** it reports `kind: 'submitted'` only (broadcast happened, finality
  is NOT implied); finality is established exclusively by
  `waitForFinality` polling

### Requirement: Finality mapping from confirmation statuses

The provider SHALL poll `getSignatureStatuses` on devnet and map
confirmation statuses to `FinalityOutcome`.

#### Scenario: Finalized transaction confirms

- **Given** a submitted transaction whose signature reaches
  `confirmationStatus: 'finalized'` with `err: null`
- **When** `waitForFinality` is called
- **Then** the outcome is `status: 'confirmed'` with the signature and
  `network: 'solana-devnet'`

#### Scenario: On-chain failure reverts

- **Given** a status entry with a non-null `err`
- **When** `waitForFinality` is called
- **Then** the outcome is `status: 'reverted'`

#### Scenario: Unknown signature is receipt-invalid

- **Given** `getSignatureStatuses` returns `null` for the signature
- **When** `waitForFinality` is called
- **Then** the outcome is `status: 'receipt_invalid'` only when a
  `getSignaturesForAddress` read proves the signature is absent from the
  wallet's history (outside the status window); without that proof, polling
  continues until the deadline and then throws — never a fabricated
  confirmation

#### Scenario: Finality poll honors deadline and abort

- **Given** a signature that never reaches finality
- **When** `waitForFinality` runs past its deadline or the signal aborts
- **Then** the provider throws instead of hanging or claiming confirmation

### Requirement: Additive wiring with fail-closed boot guard

The system SHALL select `SolanaDevnetProvider` only when
`WDK_TOOLS_SOURCE=solana-devnet`, SHALL keep every other selection branch
byte-for-byte behavior-identical, and SHALL refuse to boot when
`WDK_NETWORK`/`WDK_TOKEN` contradict the devnet contract.

#### Scenario: Solana devnet selection routes execution and reads

- **Given** `WDK_TOOLS_SOURCE=solana-devnet`
- **When** `createWalletProvider` runs and core dependencies are built
- **Then** `wallet` and `walletReads` both resolve to the
  `SolanaDevnetProvider` instance (never the legacy WDK tool source), and
  other branches remain unchanged

#### Scenario: Selection returns live provider

- **Given** `WDK_TOOLS_SOURCE=solana-devnet`
- **When** `createWalletProvider` runs
- **Then** it returns a `SolanaDevnetProvider` with `mode: 'live'`

#### Scenario: Existing selections unchanged

- **Given** `WDK_TOOLS_SOURCE` of `circle-arc`, `live`, or unset
- **When** `createWalletProvider` runs
- **Then** the returned provider type matches the current behavior exactly

#### Scenario: Contradicting network config fails at boot

- **Given** `WDK_TOOLS_SOURCE=solana-devnet` and `WDK_NETWORK=arc-testnet`
- **When** `createWalletProvider` runs
- **Then** a configuration error is thrown before any server work starts

### Requirement: Devnet explorer registration

The system SHALL register the devnet explorer URL so transaction results
carry a working explorer link.

#### Scenario: Explorer URL for devnet signatures

- **Given** a devnet transaction signature
- **When** the provider builds a `TransactionResult`
- **Then** `explorerUrl` points to the Solana devnet explorer with that
  signature, consistent with `explorerUrlFor('solana-devnet', signature)`

### Requirement: Solana grant policy provisioning makes grants policyReady

The system SHALL replace Slice 1's fail-closed provisioner stub for the
Solana path with a real provisioner implementing a **composed signer
policy** (ADR-2: one Privy policy per wallet signer — the platform allows
only one override policy per signer and one `policy_ids` entry per wallet),
recomputed as the union of conditioned ALLOW rules over all ledger `active`
grants and updated via `PATCH /v1/policies/{policy_id}`. Per-grant rules use
the documented Solana DSL: `chain_type: 'solana'`, method
`signAndSendTransaction`, `field_source: solana_system_program_instruction`
with `Transfer.to` and `Transfer.lamports`, plus `field_source: 'system'`,
field `current_unix_timestamp`, operator `lt`, and stored grant expiry.
Per-grant conditions are conjunctive, so
per-transfer/recipient isolation survives composition; NO cumulative-cap
rule is fabricated (Privy has no rolling window — the ledger is the sole
cumulative authority). `PrivyPolicySyncService`'s fail-closed lifecycle,
auditing, and single-binding semantics are preserved. A grant MUST remain
non-executable (`policyReady: false`, engine `policy_not_ready`) until the
composed policy has been read back (exact expected rules via
`GET /v1/policies/{policy_id}`) AND the wallet readback shows that policy on
the correct signer.

For a native-SOL transfer grant, `chain: 'solana'` means that persisted
`maxPerTransfer`, `maxCumulative`, and consumption amounts are lamports. A
Solana `maxPerTransfer` MUST be positive and at most `10000000` lamports
(0.01 SOL); smaller grant-specific limits are allowed. The policy's
`Transfer.lamports lte` MUST equal the grant's exact lamport value. API values
remain integer decimal strings in lamports; the UI MUST render them as SOL by
dividing by `1000000000` and MUST show that no single transfer can exceed
0.01 SOL. EVM grant units and behavior remain unchanged.

#### Scenario: Solana grant enforces the fixed native-SOL ceiling

- **Given** a `chain: 'solana'` delegated-grant request with integer lamport
  amounts
- **When** `maxPerTransfer` is greater than `10000000`
- **Then** the API rejects it before persistence or policy mutation
- **And** values at or below `10000000` remain lamports in the ledger and
  Privy policy, and the UI displays their SOL decimal with the 0.01 SOL ceiling

The correct signer SHALL be identified by a canonical
`user_wallets.provider_signer_id` captured only from trusted Privy wallet
readback. The authorization key-quorum id, signer list order, and another
grant's current lifecycle state MUST NOT be used as signer identity. The local
wallet UUID SHALL resolve to the exact provider wallet id plus provider signer
id before any policy create, attach, or PATCH mutation.

#### Scenario: Grant reaches policyReady on Solana

- **Given** an active `solana`-family grant with recipients, per-transfer
  cap, and expiry in the ledger, the selected devnet provider, and a Privy wallet whose server signer
  carries the composed policy
- **When** `syncGrant` runs
- **Then** the policy rules are recomputed to include this grant's
  conditioned ALLOW rules, PATCHed, read back exactly, the signer binding is
  verified, a `policy_synced` audit row is appended, and the grant reports
  `policyReady: true`

#### Scenario: Policy uses documented Solana instruction conditions

- **Given** active grants with recipient allowlists, per-transfer caps, and
  stored expiries
- **When** the composed policy is created or patched
- **Then** each ALLOW rule uses `Transfer.to in`,
  `Transfer.lamports lte`, and `system.current_unix_timestamp lt` with the
  matching grant values; every instruction must match an ALLOW rule
- **And** transactions containing address lookup tables are rejected before
  Privy dispatch when recipient policy evaluation could depend on ALT addresses

#### Scenario: Exact persisted signer is the only policy target

- **Given** a ready wallet with a readback-verified `provider_signer_id`, a
  different authorization key-quorum id, and multiple Privy additional signers
- **When** policy sync creates, attaches, updates, or verifies the policy
- **Then** only the signer whose `signer_id` equals the persisted binding is
  targeted, unrelated signers are preserved, and that exact binding must read
  back before `policyReady: true`

#### Scenario: Missing or ambiguous signer binding fails closed

- **Given** the persisted signer id is NULL, historical verified signer ids
  conflict, or remote readback has zero or multiple matching signer entries
- **When** policy sync runs
- **Then** no provider mutation is attempted, `policy_sync_failed` is audited,
  and all active wallet grants remain `policy_not_ready`

#### Scenario: Provisioning failure stays fail-closed

- **Given** policy creation, attach, PATCH, or readback fails or is
  ambiguous (uncertain outcome) during a recompute of the shared composed
  policy
- **When** `syncGrant` or `syncRevocation` runs
- **Then** the binding stays unchanged/NULL, `policy_sync_failed` is
  audited with wallet/policy scope, and EVERY active grant on that wallet
  is non-executable until a verified re-sync: engine decision is `degrade`
  with reason `policy_not_ready`

#### Scenario: Revocation removes the grant's enforcement rules

- **Given** a revoked grant whose rules are part of the composed policy,
  with sibling grants still active on the same wallet
- **When** `syncRevocation` runs
- **Then** the provisioner recomputes the rules as the union over remaining
  active grants (the revoked grant's rules disappear, siblings' rules stay
  intact, the shared policy id is unchanged), PATCHes with readback
  verification; the composed policy is NEVER deleted while any sibling
  grant is active (empty-rules PATCH is the last-grant outcome); an
  uncertain revoke keeps the binding (retryable) while grant state blocks
  execution regardless; success clears the revoked grant's binding and
  audits `policy_synced`

#### Scenario: Concurrent grant syncs serialize per wallet

- **Given** two grants for the same wallet syncing simultaneously —
  including a provision sync for one grant racing a revoke sync for another
- **When** both recompute the composed policy
- **Then** a per-wallet advisory lock serializes the read-modify-write so
  neither update overwrites the other's rules

#### Scenario: No execution while policy is not ready

- **Given** a grant whose wallet lacks a verified composed policy binding
- **When** a covered execution is attempted
- **Then** the engine degrades to preview+confirm with reason
  `policy_not_ready` — the hybrid enforcement (ledger plane AND provider
  policy plane) is never bypassed

### Requirement: Per-user Solana wallet binding through the walletForUser seam

The system SHALL resolve each authenticated user's Solana devnet wallet via
the `walletForUser(userId, chain)` seam, discovering the user's single embedded
Privy Solana wallet and binding a `SolanaDevnetProvider` to that wallet —
never a process-global sender address. Wallet discovery MUST fail closed
when the local binding is missing, not ready, duplicated, or mismatched with
Privy's record.

Wallet HTTP routes, conversation turns, and LiveKit sessions SHALL propagate a
chain hint derived from the requested network into `walletForUser`; a multi-chain
resolver MUST NOT default a missing or unknown hint to another chain family.

#### Scenario: Financial callers propagate Solana chain intent

- **Given** a wallet API request, conversation transfer, or LiveKit tool call
  whose requested network is `solana-devnet`
- **When** it resolves the authenticated user's wallet
- **Then** it passes the Solana chain hint and cannot reach the EVM resolver

#### Scenario: User with one ready Solana wallet gets a bound provider

- **Given** an authenticated user with exactly one ready `user_wallets` row
  (`chain_family: 'solana'`, `state: 'ready'`) whose `provider_wallet_id` and
  `address` equal exactly one active Privy Solana wallet's id and address
  (both compared independently), plus any number of stale non-ready rows
- **When** financial routes resolve `walletForUser(userId, 'solana')`
- **Then** a `SolanaDevnetProvider` bound to that wallet id and address is
  returned (no global sender); the stale non-ready rows do not invalidate
  the binding

#### Scenario: Missing, not-ready, duplicate, or mismatched wallet fails closed

- **Given** a user with zero ready `solana` bindings, more than one ready
  binding, or a Privy Solana wallet that does not equal the local binding's
  `provider_wallet_id` OR its `address`
- **When** `walletForUser(userId, 'solana')` resolves
- **Then** a `wallet_not_ready` / `wallet_config_error` failure is thrown
  and no provider is constructed

#### Scenario: Ethereum discovery path unchanged

- **Given** the existing EVM/Arc `createPrivyWalletForUserResolver` flow
- **When** any Ethereum-chain wallet resolution runs
- **Then** behavior is identical to before this change (generalized chain
  listing is additive)

#### Scenario: Privy discovery outage fails closed as wallet_unavailable

- **Given** an authenticated user with exactly one ready local `solana`
  binding, whose Privy wallet listing request fails (network or 5xx error)
- **When** `walletForUser(userId, 'solana')` resolves
- **Then** a `wallet_unavailable` failure is thrown, no provider is
  constructed, and the local binding is left unchanged

### Requirement: Authenticated chain-aware Solana wallet sync creates the ready row

The system SHALL extend wallet sync with chain-aware authenticated discovery
for Solana: listing only the authenticated Privy user's wallets, filtered to
`chain_type: 'solana'`. When exactly one such wallet with a valid base58
address exists, sync SHALL upsert a ready `user_wallets` row with
`chain_family: 'solana'` and that record's `provider_wallet_id` and `address`.
Discovery SHALL NOT write `provider_signer_id`: the canonical signer binding is
persisted only by verified enrollment readback. Existing Ethereum sync
filtering, reconciliation, demotion, and upsert semantics and all existing
`arc` rows SHALL remain unchanged. Zero or multiple Solana wallets, or a Privy
listing failure, SHALL fail closed without promoting, deleting, or fabricating
any binding.

#### Scenario: Exactly one Solana wallet is provisioned as ready

- **Given** an authenticated user whose authenticated Privy wallet list
  contains exactly one `chain_type: 'solana'` wallet with a valid base58
  address
- **When** wallet sync runs for that user
- **Then** a ready `user_wallets` row with `chain_family: 'solana'` and that
  exact `provider_wallet_id`/`address` is upserted, `provider_signer_id` is
  left unchanged (NULL unless verified enrollment readback set it), and no
  `arc` row is modified

#### Scenario: Zero, multiple, or unavailable Solana wallets fail closed

- **Given** a user whose authenticated Privy list has zero or multiple
  `chain_type: 'solana'` wallets, or whose listing request fails
- **When** wallet sync runs for that user
- **Then** no ready Solana row is created, existing bindings are neither
  promoted nor deleted, and the outcome is an honest failure state
  (`unprovisioned`/`conflict`) or `wallet_unavailable` — never a fabricated
  binding

#### Scenario: Ethereum sync behavior unchanged

- **Given** the existing authenticated Ethereum sync flow
- **When** any Ethereum-chain sync runs
- **Then** its filtering, reconciliation, demotion, and upsert semantics are
  identical to before this change

### Requirement: Solana signer enrollment is consented, exact, and retryable

The system SHALL request user consent through Privy's chain-aware
`delegateWallet` action for the authenticated user's embedded Solana wallet.
The browser SHALL send no signer identity. Prepare SHALL retain a stable
pending grant and persist a snapshot of current signer ids in
`signer_grants.signer_enrollment_snapshot`. Complete SHALL read back
the same authenticated wallet and resolve identity from an already verified
`user_wallets.provider_signer_id`, or require exactly one remote signer id
absent from the prepare snapshot. It SHALL attach the pending policy through
the signed server-side mutation, read back the exact signer/policy binding,
and only then persist the canonical signer id. Zero new ids remain pending;
multiple new ids are a conflict. Every retry SHALL remain idempotent and
fail closed on owner, chain, address, signer, or policy mismatch.
Solana enrollment SHALL store its cap in `per_transfer_lamports` as
`10000000`; the EVM `per_transfer_atomic6` field remains unchanged. The
permission API SHALL return `perTransferSol: '0.01'` and an empty
`perTransferUsdc` for Solana, and the UI SHALL label the cap `0.01 SOL`.

#### Scenario: First consent discovers and binds exactly one new signer

- **Given** an authenticated user with one ready Solana wallet, no canonical
  signer id, and a prepare snapshot of its existing additional signers
- **When** the user consents with `delegateWallet({address, chainType:
  'solana'})` and complete reads back exactly one new signer
- **Then** the server attaches the pending policy to that exact signer,
  reads back the signer id and policy id, and only then stores the remote
  `signer_id` in `user_wallets.provider_signer_id`
- **And** it never uses the authorization quorum id, list position, or a
  browser-supplied signer id

#### Scenario: Existing verified signer supports another grant

- **Given** the ready wallet already has a readback-verified canonical signer
- **When** a new prepare/complete cycle runs and the user delegation is already
  present
- **Then** complete reuses only that exact stored signer after remote readback;
  it does not require a new signer id or select another signer

#### Scenario: Prepare and complete retries preserve exact identity

- **Given** a pending Solana enrollment whose user consent succeeded but whose
  complete request did not finish
- **When** prepare or complete is retried
- **Then** prepare preserves the original pending grant and signer snapshot,
  and complete either verifies the one new signer or reuses the canonical id
  after readback; it creates no duplicate grant or signer binding

#### Scenario: Signer snapshot survives process restart

- **Given** prepare stored a pending grant and its signer snapshot before
  user consent
- **When** the service restarts before complete is called
- **Then** retry reads the original snapshot from the pending grant and does
  not replace it with the post-consent signer list

#### Scenario: Zero or multiple new signers fail closed

- **Given** no new signer appeared, more than one new signer appeared, or the
  authenticated wallet/address/chain differs from the pending enrollment
- **When** complete runs
- **Then** zero stays pending, ambiguity/mismatch becomes a conflict, and no
  canonical signer id is written

#### Scenario: Policy attachment or readback failure writes no binding

- **Given** the exact signer is discovered but signed policy attachment fails
  or its readback is missing, ambiguous, or mismatched
- **When** complete runs
- **Then** enrollment remains non-ready and
  `user_wallets.provider_signer_id` is unchanged

## MODIFIED Requirements

None.

## REMOVED Requirements

None.
