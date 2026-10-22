# Specification: Wallet broadcast outcomes

## ADDED Requirements

### Requirement: Report known pre-dispatch failures truthfully

The system MUST report a failure as `not_dispatched` only when control flow proves the transfer did not enter the dispatch operation. It MUST identify malformed requests as `invalid_request` and unavailable provider preparation or wallet resolution as `provider_unavailable`.

#### Scenario: Provider preparation fails before dispatch

- **GIVEN** a valid persisted preview and a provider preparation failure before `signAndSend`
- **WHEN** the transfer is broadcast
- **THEN** the provider returns `not_dispatched` with `provider_unavailable`
- **AND** the signer is not called

#### Scenario: Request validation fails before dispatch

- **GIVEN** an invalid network, recipient, amount, or required preview identity
- **WHEN** the transfer is broadcast
- **THEN** the provider returns `not_dispatched` with `invalid_request`
- **AND** the signer is not called

### Requirement: Preserve ambiguous dispatch outcomes

The system MUST keep a generic exception from the dispatch operation as `uncertain`. It MUST NOT retry, re-sign, or infer that the transfer did not occur from a transport error or an incomplete history scan.

#### Scenario: Dispatch call fails ambiguously

- **GIVEN** the request entered `signAndSend`
- **WHEN** that call fails without a typed definitive pre-dispatch signal
- **THEN** the result remains `uncertain`
- **AND** no second dispatch occurs

### Requirement: Reconciliation needs authoritative absence evidence

The system MUST keep an unresolved reference `uncertain` unless an authoritative lookup correlates that reference and explicitly proves the transaction was not dispatched. A missing lookup capability, null lookup result, or bounded history page MUST NOT be treated as proof of absence.

#### Scenario: Production lookup cannot find by reference

- **GIVEN** the Privy SDK path has no lookup-by-reference capability
- **WHEN** reconciliation cannot resolve the reference
- **THEN** the result remains `uncertain`
- **AND** reconciliation does not broadcast again

#### Scenario: Bounded history does not contain the transaction

- **GIVEN** the history scan stops at a page cap or incomplete cursor
- **WHEN** the transaction is not found in scanned pages
- **THEN** the result remains unresolved
- **AND** the system does not report `not_dispatched`
