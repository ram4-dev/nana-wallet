# WDK Blockchain Evidence Specification

## Purpose

Define reproducible Track 1 WDK MCP evidence for Developer B.

## Requirements

### Requirement: WDK-EVID-001 Runtime and MCP

Evidence MUST prove Node.js >=22.18.0 and direct dependencies exactly `@tetherto/wdk@1.0.0-beta.14` and `@tetherto/wdk-cli@1.0.0-beta.2`. Bundled `wdk-mcp` MUST be the MCP boundary. Discovered raw tools, schemas, and results MUST be authoritative; fields MUST NOT be invented.

#### Scenario: Discovery

- GIVEN the installed project
- WHEN runtime, dependencies, and MCP tools are inspected
- THEN compliant versions and bundled boundary are proven
- AND required schemas are captured

#### Scenario: Incompatibility

- GIVEN a version, boundary, tool, or field is noncompliant
- WHEN discovery completes
- THEN the discrepancy is recorded
- AND downstream success is not claimed

### Requirement: WDK-EVID-002 Limited Wallet

Creation, import, funding, unlock, and lock MUST remain human-operated. A dedicated limited-funds testnet wallet MUST use finite unlock TTL. Evidence MUST distinguish locked, expired, and underfunded states.

#### Scenario: Unavailable

- GIVEN the wallet is locked, expired, or underfunded
- WHEN an affected operation runs
- THEN it fails without broadcast and records that state

### Requirement: WDK-EVID-003 Sepolia USD₮

Sepolia test USD₮ MUST supply balance, preview, and broadcast evidence. ETH MUST be gas-only; native-asset product fallback MUST NOT occur. Address, balance, and history MUST preserve raw WDK semantics. History MUST distinguish unavailable, stale, empty, and non-empty results.

#### Scenario: Wallet facts

- GIVEN an unlocked wallet with Sepolia test USD₮
- WHEN address, USD₮ balance, and history are read
- THEN sanitized raw outputs preserve WDK semantics
- AND unavailable or stale history differs from empty history

#### Scenario: USD₮ unavailable

- GIVEN test USD₮ configuration or funds are unavailable
- WHEN balance or transfer evidence is attempted
- THEN Track 1 fails without native-asset substitution

### Requirement: WDK-EVID-004 Dry-Run Proof

Every candidate MUST first call `send_token` for Sepolia test USD₮ with `dryRun: true`. Evidence MUST link recipient, token, amount, network, and fee to the preview and prove no broadcast resulted.

#### Scenario: Preview

- GIVEN a valid small USD₮ transfer
- WHEN its dry-run executes
- THEN the preview and required fields are captured
- AND no broadcast exists

### Requirement: WDK-EVID-005 Gated Broadcast

At most one small `dryRun: false` Sepolia test USD₮ transfer MAY follow explicit human preview approval. Parameters MUST match. Success MUST include the real hash and available explorer or history evidence.

#### Scenario: Broadcast

- GIVEN an approved successful preview
- WHEN the matching transfer broadcasts once
- THEN its result contains a real hash
- AND confirmation or its documented unavailability is captured

#### Scenario: Approval is invalid

- GIVEN approval is absent, stale, rejected, or mismatched
- WHEN broadcast is considered
- THEN no `dryRun: false` call occurs

### Requirement: WDK-EVID-006 Failures

Discovery, connection, RPC/indexer, schema, validation, gas, USD₮ funds, wallet, preview, and broadcast failures MUST record stage, sanitized raw error, and broadcast status without claiming success. Artifacts MUST exclude secrets, credentials, and secret configuration. After capture or abort, the wallet MUST be locked or expire.

#### Scenario: Failure

- GIVEN an operation fails or a secret is detected
- WHEN evidence is evaluated
- THEN sanitized evidence remains and unsafe artifacts are rejected

#### Scenario: Closure

- GIVEN capture completed or aborted
- WHEN a human locks the wallet or TTL expires
- THEN protected use fails and closure is recorded

### Requirement: WDK-EVID-007 Fixture Handoff

Developer B MUST receive sanitized raw fixtures for discovery, reads, history variants, preview, broadcast, failures, and closure. Each MUST preserve version, raw outcome, broadcast status, recipient, token, amount, network, and fee fields needed by spending-cap, allowlist, and confirmation controls. Developer 1 MUST NOT implement those guardrails or API, agent, session, or normalized contracts.

#### Scenario: Handoff

- GIVEN the run is closed and sanitized
- WHEN fixtures reach Developer B
- THEN outcomes and transfer fields are traceable
- AND product guardrail behavior remains outside Developer 1 scope
