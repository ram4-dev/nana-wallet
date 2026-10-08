# Privy Embedded Wallets Specification

Revision 2026-09-08-r3. Product choices resolved: limited backend signer, Privy recovery, Arc Testnet. r3 incorporates the controlling user decision on permission semantics: the permission is indefinite and user-revocable; limits are 10 USDC per transfer and 50 USDC accumulated per rolling 3600 seconds; enforcement is ONLY through Privy policy configuration, with no local SQL spending cap and no independent enforcement architecture; the documented aggregate concurrency limitation is accepted. Fee accounting remains an open product question (Q2); the recorded implementation assumption is that transfer caps count transfer amount only, with fees displayed and bounded separately by Privy gas policy — this is not a user-approved product decision. The r2 spec content superseded by r3 (finite expiry, lifetime cumulative allowance, local budget reservation) is historical.

## ADDED Requirements

### Requirement: PEW-001 Identity prerequisite

The system MUST require the verified internal UUID and isolation guarantees of privy-multi-user-foundation before resolving a wallet. Fixture MUST remain the default and a shared funded wallet MUST NOT be selected in Privy mode.

#### Scenario: identity prerequisite

- GIVEN an invalid token or a missing per-user binding
- WHEN a wallet read or payment is requested
- THEN authentication fails or wallet readiness is unavailable; no singleton sender is used

### Requirement: PEW-002 Verified user ownership

The backend MUST verify that the embedded wallet owner is the authenticated Privy user using a trusted server response or cryptographically verified proof with sufficient ownership claims. Client-supplied address, wallet ID or user ID MUST NOT establish ownership.

#### Scenario: verified user ownership

- GIVEN A submits B's wallet address or a forged wallet object
- WHEN wallet synchronization runs
- THEN no binding is created or changed and no B wallet data is returned

### Requirement: PEW-003 Idempotent provisioning

Provisioning MUST reconcile existing Privy wallets before creating another, enforce unique provider wallet and active user/chain-family bindings, and handle concurrent login and partial DB/provider failures. Multiple eligible wallets MUST produce an explicit conflict rather than automatic selection.

#### Scenario: idempotent provisioning

- GIVEN two simultaneous logins and a provider success followed by a local write failure
- WHEN both flows retry
- THEN one verified wallet is bound and no duplicate wallet is created because of the missing local row

### Requirement: PEW-004 Per-user wallet isolation

Wallet binding, balance, history, preview, signing and receipt queries MUST use the authenticated UUID and owned wallet. Voice MUST use the same resolved UUID from its authorized signed binding. Caches and provider instances MUST NOT mix identities.

#### Scenario: per-user wallet isolation

- GIVEN users A and B with distinct wallets and concurrent text/voice sessions
- WHEN A performs wallet operations and probes B's resource IDs
- THEN only A's wallet is used and foreign resources have the same response as missing resources

### Requirement: PEW-005 Independent login and wallet readiness

The UI MUST distinguish authenticated identity from wallet states unprovisioned, provisioning, ready, recovery_required, conflict and unavailable. Reads or payments MUST NOT proceed with an unverified wallet.

#### Scenario: independent login and wallet readiness

- GIVEN login succeeds but provider verification is unavailable
- WHEN the user opens the wallet or retries
- THEN identity remains valid, wallet readiness is explained, and no shared or new replacement wallet is silently selected

### Requirement: PEW-006 Exact preview and confirmation

Every payment MUST bind user, wallet, chain, token, recipient/address version, amount, fee ceiling, expiry, conversation and preview ID to an explicit confirmation and durable idempotency key. A change MUST require a new preview. Authentication or signer enrollment MUST NOT count as payment confirmation.

#### Scenario: exact preview and confirmation

- GIVEN a preview for A's wallet is altered, expires or is presented after logout
- WHEN signing is requested
- THEN the request is rejected before signing or dispatch

### Requirement: PEW-007 Explicit signing model

The backend MUST sign through Privy only under a user-granted, revocable permission plus explicit per-payment confirmation. The permission MUST be indefinite by default and revocable by the user at any time; it MUST NOT carry a scheduled expiry. The user MUST remain wallet owner. The signer MUST NOT export keys, change owners or widen its policy. Every active permission MUST bind a recipient allowlist, Arc/USDC only, a 10 USDC per-transfer cap and a 50 USDC cap accumulated per rolling 3600-second window, and a native gas ceiling — all configured and enforced through Privy policy configuration exclusively. The system MUST NOT implement a local SQL spending cap or any independent cumulative-limit enforcement, and MUST NOT describe local checks as protection against a compromised signing backend; the provider's documented post-signing aggregate update behavior permits concurrent requests to exceed the rolling window before counters record them, and this limitation is accepted. Missing or unverified provider restrictions MUST disable signing. Neither login nor LLM output MAY grant signing authority.

#### Scenario: explicit signing model

- GIVEN a user is logged in but has not confirmed a payment
- WHEN the agent attempts a signing action using the backend signer
- THEN no signing request is executed

#### Scenario: privilege is indefinite and revocable

- GIVEN an active permission with no scheduled expiry
- WHEN the user revokes it or it becomes unavailable at the provider
- THEN new signing claims are blocked while already signed or submitted operations retain their actual status and remain reconcilable

### Requirement: PEW-008 Durable dispatch and uncertain outcomes

An atomic per-user operation claim MUST prevent concurrent signing attempts across tabs/workers. Definitive rejection, submission uncertainty, submission and receipt finality MUST be distinct. After an ambiguous dispatch the system MUST reconcile the recorded attempt before considering any retry. A hash provided by the client MUST NOT alone establish success.

#### Scenario: durable dispatch and uncertain outcomes

- GIVEN Nana itself broadcasts: the backend signs through Privy and submits the raw transaction to Arc RPC itself
- WHEN the signing response is lost after Privy may have signed, or the Arc RPC response is lost after dispatch
- THEN the two cases are distinguished by their known operation, payload hash and (after submission) transaction hash
- AND the same durable attempt is reconciled without a second automatic dispatch, re-signing, or a new nonce; success requires a matching confirmed receipt

### Requirement: PEW-009 Account transitions

Logout and account switch MUST abort new wallet actions and discard old sync/signing callbacks through the foundation session-generation boundary. Backend reconciliation of already submitted attempts MUST continue under the original user.

#### Scenario: account transitions

- GIVEN A opens a signing request and B logs in before the callback
- WHEN A's callback arrives
- THEN it cannot update B's data or initiate a payment as B; any submitted A operation remains scoped to A

### Requirement: PEW-010 Recovery preserves wallet identity

The Privy-managed recovery flow MUST preserve the existing verified wallet binding and address on a new device. Recovery failure MUST NOT delete users, replace wallets or promise access without supported recovery factors.

#### Scenario: recovery preserves wallet identity

- GIVEN a user opens a clean browser and completes the supported recovery flow
- WHEN wallet synchronization and signing readiness are checked
- THEN the same address is restored; a failed recovery remains blocked without creating a replacement

### Requirement: PEW-011 Pinned testnet and secrets

The provider MUST use Arc Testnet chain ID 5042002, USDC ERC-20 0x3600000000000000000000000000000000000000 with 6 decimals and separate 18-decimal native gas accounting. It MUST verify RPC chain ID and token decimals before enabling operations. Mainnet and unknown networks MUST reject. Wallet private material MUST never enter Nana logs, DB, agent context or application responses; server credentials MUST be provisioned through vault-env.

#### Scenario: pinned testnet and secrets

- GIVEN the client or agent proposes mainnet, an unknown chain or a different token contract
- WHEN the operation is validated
- THEN it is rejected before signing and no fallback network is selected

### Requirement: PEW-012 Observable delivery evidence

Delivery MUST include backend lint/typecheck/test/eval/build, frontend lint/typecheck/test/build, two-user browser E2E through the real fixture backend, ownership/concurrency/uncertainty regressions and a separately authorized live Privy/testnet smoke. External blockers MUST be recorded with skipped scenarios. Front and back HTTP examples MUST validate independently without cross-project imports.

#### Scenario: observable delivery evidence

- GIVEN fixture checks pass but live credentials, OTP access or test funds are missing
- WHEN verification is reported
- THEN deterministic checks are recorded as passed and live scenarios as blocked, never as completed

### Requirement: PEW-013 Permission Revocation and Non-Escalation

Enrollment MUST be an explicit user action separate from login and payment confirmation. Effective provider owner, signer and policy settings MUST be verified before activation. The spending credential MUST NOT remove or weaken limits. Revoking/expired/unavailable grants MUST block new claims. Revocation MUST NOT be reported as canceling already issued signatures or reversing submitted payments; those operations MUST remain reconcilable.

#### Scenario: signer attempts escalation or use after revocation

- GIVEN an active grant that is revoked or whose spending key attempts to alter its policy
- WHEN a new signing operation is requested
- THEN escalation and new signatures are rejected, and any prior signed attempt retains its actual status

### Requirement: PEW-014 Exact Signed Payload and Operation Claims

The backend MUST atomically claim an owned confirmed operation and coordinate the wallet nonce before requesting eth_signTransaction; it MUST serialize nonce use per wallet. Privy policy configuration MUST enforce the per-transfer and rolling-window limits and the gas ceiling; local checks alone MUST NOT be described as provider protection, and no local cumulative spending cap MUST be implemented. The provider's post-signing aggregate update behavior MAY allow concurrent requests to pass before counters are recorded; this aggregate overshoot is accepted and MUST be reported as a provider limitation, never hidden. Returned signed bytes MUST be decoded and checked against sender, chain, nonce, fees, contract and exact transfer calldata before persistence and broadcast. They MUST stay in restricted backend storage. A lost signing response or a lost broadcast response MUST be reconciled against the recorded attempt; a retry MUST reuse only identical persisted signing intent and transaction bytes, never a different transaction, a new nonce, or a fee bump, and MUST NOT release any uncertainty as success. Local checks MUST cover intent validity (confirmed preview, allowed recipient, positive amount within the per-transfer cap, chain and contract) but MUST NOT be claimed as spending-limit enforcement.

#### Scenario: concurrent claims and lost responses

- GIVEN two confirmed operations claimed concurrently and one RPC response lost after dispatch
- WHEN workers claim, sign and reconcile
- THEN each operation signs only its own claimed intent, nonce use is serialized per wallet, and the uncertain attempt reconciles only against identical persisted transaction bytes
- AND the provider rolling-window policy enforces the 50 USDC per 3600 seconds limit with its documented non-atomic aggregate behavior
- AND no signed bytes or signing secrets enter the frontend, logs or agent context
