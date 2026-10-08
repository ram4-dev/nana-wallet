# Voice Transfer Confirmation Requirements

## Requirement: Explicit confirmation is authorized by final user speech

The LiveKit session MUST record final user transcript evidence independently of model tool selection. For an uncovered transfer, the service MUST NOT broadcast unless an exact supported confirmation phrase was received after the active persisted preview was created, the server-controlled read-back audio finished without interruption, and the evidence is consumed for that preview exactly once. The voice session MUST arm evidence only after reloading the ID of the persisted preview and completing that read-back. Interim transcripts, previous-turn confirmations, model calls without evidence, and evidence for another or stale preview MUST fail closed. Decision evidence MUST come only from the authenticated room participant; a room/runtime that cannot prove the source participant MUST fail closed. The worker MUST NOT also route the same decision transcript through a second generic conversation path.

Supported standalone confirmations MUST include the unambiguous localized `yes` and `sí`/`si`, consistent with the tool prompt; exact cancellation remains a separate phrase set.

### Scenario: Current spoken confirmation broadcasts once

- **GIVEN** a Solana preview is pending and its amount, recipient name, and fee were read back
- **WHEN** the user speaks a supported exact confirmation and the realtime model calls `confirm_transfer`
- **THEN** the server consumes that final transcript for the active preview and broadcasts at most once
- **AND** the provider finality result is recorded and surfaced

### Scenario: Model tool call without fresh speech is rejected

- **GIVEN** a pending preview and no final confirmation transcript after it was created
- **WHEN** the model calls `confirm_transfer`
- **THEN** the tool returns a confirmation-required error
- **AND** no claim or provider broadcast occurs

### Scenario: Confirmation before complete preview narration is ignored

- **GIVEN** a preview has persisted but its exact server-controlled read-back is still playing or was interrupted
- **WHEN** the user speaks an exact confirmation
- **THEN** that transcript cannot authorize the preview
- **AND** a new exact confirmation is required after uninterrupted read-back completes

### Scenario: Old, partial, replayed, or mismatched speech cannot authorize

- **GIVEN** a preview has just been created
- **WHEN** confirmation speech is only interim, predates the preview, was already consumed, or belongs to a replaced preview
- **THEN** confirmation fails closed and the provider is not called

## Requirement: Spoken cancellation is preview-bound

The server MUST require a final supported cancellation phrase after the active preview's server-controlled read-back audio has completed without interruption, and MUST cancel only that preview. Cancellation MUST never call the provider broadcast method.

### Scenario: User cancels the active preview

- **GIVEN** an active pending preview
- **WHEN** the user speaks an exact supported cancellation phrase and the model calls `cancel_transfer`
- **THEN** that preview is cancelled once and no broadcast occurs

## Requirement: Voice uses versioned chain-scoped saved contacts

Realtime tools MUST accept only a saved contact ID and exact version for the configured chain. Voice input MUST NOT accept an arbitrary address. Solana contact writes and reads MUST require a canonical Solana public key scoped to `solana-devnet`; EVM defaults and behavior MUST remain compatible.

### Scenario: Solana contact resolution succeeds

- **GIVEN** a current, active versioned contact explicitly scoped to `solana-devnet`
- **WHEN** the user requests a transfer to that contact
- **THEN** the provider preview uses its validated address and the model receives only the contact display name

### Scenario: Invalid, changed, ambiguous, or wrong-chain contact is rejected

- **GIVEN** a recipient is malformed, stale, ambiguous, or scoped to another chain
- **WHEN** voice preview is requested
- **THEN** the flow asks for clarification or returns a typed error and never broadcasts

## Requirement: Preview narration includes exact amount, destination label, and fee

The voice preview MUST state the exact amount and token, saved recipient name, and provider estimated fee before asking for confirmation. It MUST NOT expose raw recipient addresses to the model. Solana amounts MUST be validated with exact lamport precision against the configured live maximum; the 10,000,000-lamport grant ceiling applies only to delegated grants.

### Scenario: Solana preview reads back relevant facts

- **GIVEN** a valid Solana devnet contact and amount at or below `WDK_MAX_TRANSFER_AMOUNT`
- **WHEN** the provider returns a preview and estimated fee
- **THEN** voice narrates amount in SOL, contact name, estimated fee in SOL, and asks for explicit confirmation
- **AND** tool output contains no recipient address

### Scenario: Amount above configured live maximum is rejected

- **GIVEN** a Solana transfer amount greater than the configured `WDK_MAX_TRANSFER_AMOUNT`
- **WHEN** the preview is evaluated
- **THEN** the service returns a policy error before storing or broadcasting it

### Scenario: Terminal state links to Solana explorer

- **GIVEN** a confirmed Solana devnet transfer
- **WHEN** the conversation state projection is read
- **THEN** its transaction link targets Solana Explorer with the devnet cluster parameter

## Requirement: Stale preview and provider uncertainty remain fail-closed

The current preview ID, recipient version, and provider outcome MUST be revalidated at decision time. A stale preview MUST NOT broadcast. Uncertain dispatch MUST NOT be automatically retried from voice.

### Scenario: Contact changes after preview

- **GIVEN** a pending preview whose recipient version is changed before confirmation
- **WHEN** the user confirms
- **THEN** the old preview is rejected and no provider dispatch occurs

### Scenario: Provider dispatch is uncertain

- **GIVEN** the provider reports an uncertain broadcast outcome
- **WHEN** the user or model retries the same voice decision
- **THEN** the system returns the canonical uncertain outcome and does not create a second transfer

### Scenario: Missing idempotency preview ID fails closed

- **GIVEN** a Solana provider broadcast request without its persisted preview ID
- **WHEN** dispatch is attempted
- **THEN** the provider rejects it before signing or submission and does not create a synthetic retry key
